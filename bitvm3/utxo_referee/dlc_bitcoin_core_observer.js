'use strict';

const { validateDlcContract } = require('./dlc_contract_state');
const { validateDlcTransactionSetCommitments } = require('./dlc_transaction_validator');
const { evaluateDlcChainSnapshot } = require('./dlc_chain_guard');

function requireHash(value, fieldName) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${fieldName} must be lowercase 32-byte hex`);
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

module.exports = { captureDlcChainSnapshot, observeAndEvaluateDlcChain };
