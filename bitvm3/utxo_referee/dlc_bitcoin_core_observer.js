'use strict';

const crypto = require('crypto');
const { validateDlcContract } = require('./dlc_contract_state');
const { validateDlcTransactionSetCommitments } = require('./dlc_transaction_validator');
const { evaluateDlcChainSnapshot } = require('./dlc_chain_guard');
const { settlementAnchor, evaluateDlcAnchorRecovery } = require('./dlc_anchor_recovery_guard');

const MAX_MONEY = 2100000000000000n;

function requireHash(value, fieldName) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${fieldName} must be lowercase 32-byte hex`);
  }
  return value;
}
function requireNodeId(value, fieldName) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error(`${fieldName} contains unsafe characters`);
  }
  return value;
}

function callRpc(rpc, method, params = []) {
  const result = rpc(method, params);
  if (result && typeof result.then === 'function') {
    throw new Error('DLC Bitcoin Core observer requires a synchronous RPC adapter');
  }
  return result;
}

function validateChainInfo(info, contractState) {
  const expected = contractState.network === 'bitcoin-testnet4' ? 'testnet4' : 'regtest';
  if (!info || info.chain !== expected || !Number.isSafeInteger(info.blocks) || info.blocks < 0) {
    throw new Error(`Bitcoin Core must report ${expected} with a valid height`);
  }
  requireHash(info.bestblockhash, 'best block hash');
  return info;
}

function transactionId(transaction) {
  return requireHash(transaction.txid || transaction.hash, 'observed transaction id');
}

function spendsFunding(transaction, funding) {
  return Array.isArray(transaction.vin) && transaction.vin.some((input) =>
    input && input.txid === funding.txid && input.vout === funding.vout);
}

function findObservedSpend({ rpc, funding, height, previous, scanDepth }) {
  let mempool;
  try {
    mempool = callRpc(rpc, 'gettxspendingprevout', [[{ txid: funding.txid, vout: funding.vout }]]);
  } catch (_error) {
    mempool = null;
  }
  const spendingTxid = Array.isArray(mempool) ? mempool[0]?.spendingtxid : null;
  if (spendingTxid) return { txid: requireHash(spendingTxid, 'mempool spending txid'), height };

  const start = Math.max(0, height - scanDepth + 1, previous ? Math.min(previous.height, height) : 0);
  for (let blockHeight = start; blockHeight <= height; blockHeight++) {
    const blockHash = requireHash(callRpc(rpc, 'getblockhash', [blockHeight]), `block hash at ${blockHeight}`);
    const block = callRpc(rpc, 'getblock', [blockHash, 2]);
    if (!block || !Array.isArray(block.tx)) throw new Error(`Bitcoin Core block ${blockHeight} lacks decoded transactions`);
    const spend = block.tx.find((transaction) => spendsFunding(transaction, funding));
    if (spend) return { txid: transactionId(spend), height: blockHeight };
  }
  return null;
}

function btcToSats(value, fieldName) {
  let sats;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const scaled = value * 100000000;
    const rounded = Math.round(scaled);
    if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 0.001) {
      throw new Error(`${fieldName} is not an exact Bitcoin amount`);
    }
    sats = BigInt(rounded);
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(value)) {
    const [whole, fraction = ''] = value.split('.');
    sats = BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'));
  } else {
    throw new Error(`${fieldName} is not a canonical Bitcoin amount`);
  }
  if (sats > MAX_MONEY) throw new Error(`${fieldName} exceeds maximum Bitcoin supply`);
  return sats;
}

function mempoolSequence(rpc, fieldName) {
  const value = callRpc(rpc, 'getrawmempool', [false, true]);
  if (!value || !Number.isSafeInteger(value.mempool_sequence) || value.mempool_sequence < 0) {
    throw new Error(`${fieldName} mempool sequence is unavailable`);
  }
  return value.mempool_sequence;
}

function mempoolCandidate(rpc, txid, relayNodeIds) {
  const entry = callRpc(rpc, 'getmempoolentry', [txid]);
  if (!entry || !Number.isSafeInteger(entry.vsize) || entry.vsize < 1 ||
      typeof entry['bip125-replaceable'] !== 'boolean') {
    throw new Error('Bitcoin Core mempool entry is malformed');
  }
  return Object.freeze({
    txid,
    feeSats: btcToSats(entry.fees?.base, 'mempool base fee').toString(),
    vsize: entry.vsize,
    relayPeers: relayNodeIds.length,
    relayNodeIds: Object.freeze([...relayNodeIds]),
    signalsRbf: entry['bip125-replaceable'],
    confirmed: false
  });
}

function peerMempoolView(rpc, txid, index, contractState, nodeId) {
  const chainBefore = validateChainInfo(callRpc(rpc, 'getblockchaininfo'), contractState);
  const before = mempoolSequence(rpc, `peerRpcs[${index}]`);
  const txids = callRpc(rpc, 'getrawmempool', [false]);
  if (!Array.isArray(txids) || txids.some((entry) => typeof entry !== 'string' || !/^[0-9a-f]{64}$/.test(entry))) {
    throw new Error(`peerRpcs[${index}] mempool inventory is malformed`);
  }
  const present = txids.includes(txid);
  const after = mempoolSequence(rpc, `peerRpcs[${index}]`);
  const chainAfter = validateChainInfo(callRpc(rpc, 'getblockchaininfo'), contractState);
  return Object.freeze({
    stable: before === after && chainBefore.blocks === chainAfter.blocks &&
      chainBefore.bestblockhash === chainAfter.bestblockhash,
    present,
    nodeView: Object.freeze({
      nodeId,
      tipHeight: chainAfter.blocks,
      bestBlockHash: chainAfter.bestblockhash,
      mempoolSequence: after
    })
  });
}

function findConfirmedAnchorSpend({ rpc, anchor, height, scanDepth }) {
  const start = Math.max(0, height - scanDepth + 1);
  for (let blockHeight = start; blockHeight <= height; blockHeight++) {
    const blockHash = requireHash(callRpc(rpc, 'getblockhash', [blockHeight]), `block hash at ${blockHeight}`);
    const block = callRpc(rpc, 'getblock', [blockHash, 2]);
    if (!block || !Array.isArray(block.tx)) throw new Error(`Bitcoin Core block ${blockHeight} lacks decoded transactions`);
    const spend = block.tx.find((transaction) => Array.isArray(transaction.vin) && transaction.vin.some((input) =>
      input && input.txid === anchor.txid && input.vout === anchor.vout));
    if (!spend) continue;
    if (!Number.isSafeInteger(spend.vsize) || spend.vsize < 1 || !Array.isArray(spend.vin) ||
        spend.vin.some((input) => !Number.isSafeInteger(input.sequence) || input.sequence < 0 || input.sequence > 0xffffffff)) {
      throw new Error('confirmed anchor spend is missing vsize or canonical sequences');
    }
    return Object.freeze({
      txid: transactionId(spend),
      feeSats: btcToSats(spend.fee, 'confirmed transaction fee').toString(),
      vsize: spend.vsize,
      relayPeers: 0,
      signalsRbf: spend.vin.some((input) => input.sequence < 0xfffffffe),
      confirmed: true,
      confirmedHeight: blockHeight
    });
  }
  return null;
}

function decodeProposedRecovery({ rpc, rawTxHex, anchor, bestBlockHash }) {
  if (typeof rawTxHex !== 'string' || rawTxHex.length < 20 || rawTxHex.length > 800000 ||
      rawTxHex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(rawTxHex)) {
    throw new Error('proposed recovery raw transaction must be bounded canonical lowercase hex');
  }
  const transaction = callRpc(rpc, 'decoderawtransaction', [rawTxHex]);
  if (!transaction || !Number.isSafeInteger(transaction.vsize) || transaction.vsize < 1 || transaction.vsize > 400000 ||
      !Array.isArray(transaction.vin) || transaction.vin.length < 1 || transaction.vin.length > 1024 ||
      !Array.isArray(transaction.vout) || transaction.vout.length < 1 || transaction.vout.length > 1000) {
    throw new Error('decoded proposed recovery transaction is malformed');
  }
  const txid = requireHash(transaction.txid, 'proposed recovery txid');
  const wtxid = requireHash(transaction.hash, 'proposed recovery wtxid');
  const outpoints = transaction.vin.map((input, index) => {
    if (!input || !Number.isSafeInteger(input.vout) || input.vout < 0 || input.vout > 0xffffffff ||
        !Number.isSafeInteger(input.sequence) || input.sequence < 0 || input.sequence > 0xffffffff) {
      throw new Error(`proposed recovery input ${index} is malformed`);
    }
    return `${requireHash(input.txid, `proposed recovery input ${index} txid`)}:${input.vout}`;
  });
  if (new Set(outpoints).size !== outpoints.length || outpoints.filter((value) => value === anchor.outpoint).length !== 1) {
    throw new Error('proposed recovery must spend the committed anchor exactly once without duplicate inputs');
  }
  let inputValue = 0n;
  for (let index = 0; index < transaction.vin.length; index++) {
    const input = transaction.vin[index];
    if (`${input.txid}:${input.vout}` === anchor.outpoint) {
      inputValue += anchor.valueSats;
      continue;
    }
    const coin = callRpc(rpc, 'gettxout', [input.txid, input.vout, true]);
    if (!coin || coin.bestblock !== bestBlockHash) {
      throw new Error(`proposed recovery input ${index} is not an unspent output on the observed tip`);
    }
    inputValue += btcToSats(coin.value, `proposed recovery input ${index} value`);
  }
  let outputValue = 0n;
  for (let index = 0; index < transaction.vout.length; index++) {
    outputValue += btcToSats(transaction.vout[index]?.value, `proposed recovery output ${index} value`);
    if (outputValue > MAX_MONEY) throw new Error('proposed recovery outputs exceed maximum Bitcoin supply');
  }
  if (outputValue >= inputValue) throw new Error('proposed recovery must pay a positive fee');
  return Object.freeze({
    txid,
    wtxid,
    rawTxDigest: crypto.createHash('sha256').update(Buffer.from(rawTxHex, 'hex')).digest('hex'),
    feeSats: (inputValue - outputValue).toString(),
    vsize: transaction.vsize,
    relayPeers: 0,
    signalsRbf: transaction.vin.some((input) => input.sequence < 0xfffffffe),
    confirmed: false
  });
}

function captureDlcAnchorRecoverySnapshot({
  contractState,
  transactionSet,
  settlementTxid,
  rpc,
  primaryNodeId = 'primary',
  peerNodes = [],
  proposedRecoveryRawTxHex = null,
  expectedRecoveryTxids = [],
  maxAttempts = 3,
  scanDepth = 12
}) {
  validateDlcContract(contractState);
  validateDlcTransactionSetCommitments(transactionSet);
  const anchor = settlementAnchor(transactionSet, settlementTxid);
  requireNodeId(primaryNodeId, 'primaryNodeId');
  if (typeof rpc !== 'function' || !Array.isArray(peerNodes) || peerNodes.length > 15 ||
      peerNodes.some((peer) => !peer || typeof peer.rpc !== 'function') ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10 ||
      !Number.isSafeInteger(scanDepth) || scanDepth < 1 || scanDepth > 144) {
    throw new Error('DLC anchor observer policy is malformed');
  }
  const peerNodeIds = peerNodes.map((peer, index) => requireNodeId(peer.nodeId, `peerNodes[${index}].nodeId`));
  const configuredNodeIds = [primaryNodeId, ...peerNodeIds];
  if (new Set(configuredNodeIds).size !== configuredNodeIds.length) {
    throw new Error('DLC anchor observer node IDs must be unique');
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const before = validateChainInfo(callRpc(rpc, 'getblockchaininfo'), contractState);
    const sequenceBefore = mempoolSequence(rpc, 'primary');
    const policyBefore = callRpc(rpc, 'getmempoolinfo');
    if (!policyBefore || typeof policyBefore.fullrbf !== 'boolean') {
      throw new Error('Bitcoin Core full-RBF policy is unavailable');
    }
    const incrementalRelayFeeSatPerVb = Number((btcToSats(
      policyBefore.incrementalrelayfee,
      'incremental relay fee'
    ) + 999n) / 1000n);
    if (!Number.isSafeInteger(incrementalRelayFeeSatPerVb) || incrementalRelayFeeSatPerVb < 1 ||
        incrementalRelayFeeSatPerVb > 1000) {
      throw new Error('Bitcoin Core incremental relay fee is outside the supported range');
    }
    const coin = callRpc(rpc, 'gettxout', [anchor.txid, anchor.vout, true]);
    if (coin) {
      const coinScript = coin.scriptPubKey?.hex;
      if (coin.bestblock !== before.bestblockhash || !Number.isSafeInteger(coin.confirmations) || coin.confirmations < 0 ||
          btcToSats(coin.value, 'anchor coin value').toString() !== transactionSet.feePolicy.anchorAmountSats ||
          coinScript !== transactionSet.feePolicy.anchorScriptPubKeyHex) continue;
    }
    let observedSpend = null;
    let peerViewsStable = true;
    const peerViews = [];
    if (!coin) {
      let spending;
      try { spending = callRpc(rpc, 'gettxspendingprevout', [[{ txid: anchor.txid, vout: anchor.vout }]]); }
      catch (_error) { spending = null; }
      const mempoolTxid = Array.isArray(spending) && spending[0]?.spendingtxid
        ? requireHash(spending[0].spendingtxid, 'anchor mempool spending txid')
        : null;
      if (mempoolTxid) {
        const relayNodeIds = [primaryNodeId];
        for (let index = 0; index < peerNodes.length; index++) {
          const peerView = peerMempoolView(
            peerNodes[index].rpc,
            mempoolTxid,
            index,
            contractState,
            peerNodeIds[index]
          );
          if (!peerView.stable || peerView.nodeView.tipHeight !== before.blocks ||
              peerView.nodeView.bestBlockHash !== before.bestblockhash) peerViewsStable = false;
          if (peerView.present) relayNodeIds.push(peerNodeIds[index]);
          peerViews.push(peerView.nodeView);
        }
        if (!peerViewsStable) continue;
        try { observedSpend = mempoolCandidate(rpc, mempoolTxid, relayNodeIds); }
        catch (_error) { continue; }
      } else {
        observedSpend = findConfirmedAnchorSpend({ rpc, anchor, height: before.blocks, scanDepth });
      }
    }
    const proposedRecovery = proposedRecoveryRawTxHex === null ? null : decodeProposedRecovery({
      rpc,
      rawTxHex: proposedRecoveryRawTxHex,
      anchor: Object.freeze({
        ...anchor,
        valueSats: BigInt(transactionSet.feePolicy.anchorAmountSats)
      }),
      bestBlockHash: before.bestblockhash
    });
    const sequenceAfter = mempoolSequence(rpc, 'primary');
    const policyAfter = callRpc(rpc, 'getmempoolinfo');
    const after = validateChainInfo(callRpc(rpc, 'getblockchaininfo'), contractState);
    if (!policyAfter || sequenceAfter !== sequenceBefore || after.blocks !== before.blocks ||
        after.bestblockhash !== before.bestblockhash || policyAfter.fullrbf !== policyBefore.fullrbf ||
        policyAfter.incrementalrelayfee !== policyBefore.incrementalrelayfee) continue;
    const snapshot = Object.freeze({
      observer: 'bitcoin-core-rpc-v1',
      tipHeight: after.blocks,
      bestBlockHash: after.bestblockhash,
      mempoolSequence: sequenceAfter,
      settlementTxid,
      anchorOutpoint: anchor.outpoint,
      anchorPresent: !!coin,
      anchorConfirmations: coin ? coin.confirmations : 0,
      fullRbf: policyAfter.fullrbf,
      incrementalRelayFeeSatPerVb,
      observedSpend,
      proposedRecovery,
      expectedRecoveryTxids: Object.freeze([...expectedRecoveryTxids]),
      nodeViews: Object.freeze([
        Object.freeze({
          nodeId: primaryNodeId,
          tipHeight: after.blocks,
          bestBlockHash: after.bestblockhash,
          mempoolSequence: sequenceAfter
        }),
        ...peerViews
      ])
    });
    evaluateDlcAnchorRecovery({
      contractState,
      transactionSet,
      settlementTxid,
      snapshot,
      expectedRecoveryTxids,
      incrementalRelayFeeSatPerVb
    });
    return snapshot;
  }
  throw new Error(`could not capture a stable DLC anchor snapshot after ${maxAttempts} attempts`);
}

function captureDlcChainSnapshot({
  contractState,
  transactionSet,
  rpc,
  previous = null,
  maxAttempts = 3,
  scanDepth = 12
}) {
  validateDlcContract(contractState);
  validateDlcTransactionSetCommitments(transactionSet);
  if (typeof rpc !== 'function' || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10 ||
      !Number.isSafeInteger(scanDepth) || scanDepth < 1 || scanDepth > 144) {
    throw new Error('DLC Bitcoin Core observer policy is malformed');
  }
  const funding = transactionSet.funding;
  const fundingOutpoint = `${funding.txid}:${funding.vout}`;
  if (previous && (!Number.isSafeInteger(previous.height) || previous.height < 0)) {
    throw new Error('previous DLC chain snapshot height is malformed');
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const before = validateChainInfo(callRpc(rpc, 'getblockchaininfo'), contractState);
    const mempoolBefore = callRpc(rpc, 'getrawmempool', [false, true]);
    if (!mempoolBefore || !Number.isSafeInteger(mempoolBefore.mempool_sequence) || mempoolBefore.mempool_sequence < 0) {
      throw new Error('Bitcoin Core mempool sequence is unavailable');
    }
    let ancestorHashAtPreviousHeight;
    if (previous && before.blocks >= previous.height) {
      ancestorHashAtPreviousHeight = requireHash(
        callRpc(rpc, 'getblockhash', [previous.height]),
        `ancestor hash at ${previous.height}`
      );
    }
    const coin = callRpc(rpc, 'gettxout', [funding.txid, funding.vout, true]);
    if (coin && coin.bestblock !== before.bestblockhash) continue;
    const observedSpend = coin ? null : findObservedSpend({
      rpc,
      funding,
      height: before.blocks,
      previous,
      scanDepth
    });
    const mempoolAfter = callRpc(rpc, 'getrawmempool', [false, true]);
    const after = validateChainInfo(callRpc(rpc, 'getblockchaininfo'), contractState);
    if (!mempoolAfter || mempoolAfter.mempool_sequence !== mempoolBefore.mempool_sequence ||
        after.blocks !== before.blocks || after.bestblockhash !== before.bestblockhash) continue;
    const snapshot = {
      height: after.blocks,
      bestBlockHash: after.bestblockhash,
      fundingOutpoint,
      fundingPresent: !!coin,
      fundingConfirmations: coin ? coin.confirmations : 0,
      observedSpend
    };
    if (ancestorHashAtPreviousHeight !== undefined) snapshot.ancestorHashAtPreviousHeight = ancestorHashAtPreviousHeight;
    return Object.freeze(snapshot);
  }
  throw new Error(`could not capture a stable DLC chain snapshot after ${maxAttempts} attempts`);
}

function observeAndEvaluateDlcChain(options) {
  const current = captureDlcChainSnapshot(options);
  return Object.freeze({
    snapshot: current,
    evaluation: evaluateDlcChainSnapshot({
      contractState: options.contractState,
      transactionSet: options.transactionSet,
      current,
      previous: options.previous || null,
      minConfirmations: options.minConfirmations === undefined ? 6 : options.minConfirmations
    })
  });
}

module.exports = { captureDlcChainSnapshot, captureDlcAnchorRecoverySnapshot, observeAndEvaluateDlcChain };
