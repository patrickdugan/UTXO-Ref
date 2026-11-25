#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const referee = '../bitvm3/utxo_referee/';
const { xOnlyPubkey, N, bytes32, buildDlcOracle, dlcAttest } = require(referee + 'tradelayer_dlc_adaptor_sig');
const { writeJsonAppendOnce, readBoundedJson } = require(referee + 'dlc_durable_json_store');
const { validateFundingPrebroadcastPolicy } = require(referee + 'dlc_funding_prebroadcast_guard');
const { validateExecutionPrebroadcastPolicy } = require(referee + 'dlc_execution_prebroadcast_guard');
const { buildContractPlan } = require('./src/contract');
const {
  buildSettlementPackage, finalizeRecoveryPackage, verifyRecoveryPackage, completeSettlement
} = require('./src/settlement');
const { withRegtestCore, sats, btc, outputs } = require('./src/regtest-core');
const { prepareFunding, signFunding, ownAddress } = require('./src/regtest-funding');
const { withResearchPartySigners } = require('./src/regtest-signer');
const { digest, evidence, createRegtestState, createWatchtower } = require('./src/regtest-state');

const MAX_JSON_BYTES = 1024 * 1024;
const FEE_SHARE_SATS = 750;
const INPUT_SATS = 1_000_000;
const write = (directory, name, record) => writeJsonAppendOnce(directory, name, record, { maxBytes: MAX_JSON_BYTES });
const read = (filename) => readBoundedJson(filename, { maxBytes: MAX_JSON_BYTES });
const txDigest = (rawTxHex) => createHash('sha256').update(Buffer.from(rawTxHex, 'hex')).digest('hex');
const pubkey = (secret) => xOnlyPubkey(secret).toString('hex');

function disposableScalar() {
  for (;;) {
    const scalar = BigInt('0x' + randomBytes(32).toString('hex'));
    if (scalar > 0n && scalar < N) return scalar;
  }
}

function walletAddress(rpc, wallet, label, type) {
  const address = rpc('getnewaddress', [label, type], wallet);
  return { address, script: ownAddress(rpc, wallet, address) };
}

function makeParty(rpc, wallet, minerWallet, exitBudgetSats) {
  const payout = walletAddress(rpc, wallet, 'payout', 'bech32m');
  const change = walletAddress(rpc, wallet, 'funding-change', 'bech32');
  const deposit = walletAddress(rpc, wallet, 'funding-input', 'bech32');
  const txid = rpc('sendtoaddress', [deposit.address, btc(INPUT_SATS)], minerWallet);
  const matched = outputs(rpc('getrawtransaction', [txid, true]))
    .map((output, vout) => ({ ...output, vout })).filter((output) => output.scriptPubKeyHex === deposit.script);
  assert.equal(matched.length, 1, 'expected a unique wallet deposit');
  assert.equal(matched[0].valueSats, INPUT_SATS);
  return {
    wallet, payoutAddress: payout.address, payoutScript: payout.script, changeAddress: change.address, changeScript: change.script,
    input: { txid, vout: matched[0].vout, address: deposit.address, scriptPubKey: deposit.script, valueSats: INPUT_SATS },
    contributionSats: 200_000 + exitBudgetSats, feeSats: FEE_SHARE_SATS
  };
}

function restoreFresh(walletPath, pinsPath, attestationsPath, outcomeId) {
  const pins = read(pinsPath);
  const args = ['--package', walletPath, '--plan-digest', pins.expectedPlanId, '--recovery-digest', pins.expectedRecoveryDigest];
  if (attestationsPath) args.push('--outcome', outcomeId, '--attestations', attestationsPath);
  else args.push('--refund');
  const restored = spawnSync(process.execPath, [path.join(__dirname, 'restore.js'), ...args], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * MAX_JSON_BYTES, windowsHide: true,
    env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}
  });
  if (restored.error) throw restored.error;
  assert.equal(restored.status, 0, restored.stderr);
  return JSON.parse(restored.stdout);
}

function verifyWalletRecovery(directory, settlementPackage, recoveryPackage) {
  const { plan, fundingOutpoint, transactionSet } = settlementPackage;
  const pins = {
    expectedPlanId: plan.planDigest, expectedRecoveryDigest: recoveryPackage.recoveryDigest, fundingOutpoint
  };
  const packagePath = path.join(directory, 'recovery-package.json');
  const pinsPath = path.join(directory, 'wallet-pins.json');
  write(directory, 'recovery-package.json', recoveryPackage);
  write(directory, 'wallet-pins.json', pins);
  const saved = read(packagePath);
  assert.deepEqual(saved.settlementPackage.fundingOutpoint, fundingOutpoint);
  const refund = restoreFresh(packagePath, pinsPath);
  assert.equal(refund.rawTxHex, recoveryPackage.signedRefundTxHex);
  assert.equal(refund.txid, transactionSet.refund.txid);
  return { packagePath, pinsPath, refund, receipt: { ...pins, refundTxid: refund.txid, refundWtxid: refund.wtxid } };
}

function confirmedTransaction(rpc, blockHash, txid) {
  const block = rpc('getblock', [blockHash, 3]);
  const tx = block.tx.find((entry) => entry.txid === txid);
  assert(block.confirmations > 0 && tx, 'expected transaction in an active-chain block: ' + txid);
  const txOutputs = outputs(tx);
  const actualFeeSats = tx.vin.reduce((sum, input) => sum + sats(input.prevout.value), 0) -
    txOutputs.reduce((sum, output) => sum + output.valueSats, 0);
  assert.equal(sats(tx.fee), actualFeeSats, 'input-derived fee must match Core block fee');
  return {
    txid: tx.txid, wtxid: tx.hash, blockHash, height: block.height, feeSats: actualFeeSats, vsize: tx.vsize,
    inputs: tx.vin.map(({ txid: prevTxid, vout, sequence, prevout }) => ({
      txid: prevTxid, vout, sequence, valueSats: sats(prevout.value), scriptPubKeyHex: prevout.scriptPubKey.hex
    })),
    outputs: txOutputs, locktime: tx.locktime
  };
}

function recordWalletPayouts(rpc, parties, confirmed, plan, row) {
  return parties.map((party, vout) => {
    const expectedSats = Number(row[party.wallet + 'PayoutSats']);
    const expectedScript = plan.terms[party.wallet + 'PayoutScript'];
    assert.deepEqual(confirmed.outputs[vout], { valueSats: expectedSats, scriptPubKeyHex: expectedScript });
    const utxos = rpc('listunspent', [1, 9999999, [party.payoutAddress]], party.wallet);
    const exact = utxos.filter((utxo) => utxo.txid === confirmed.txid && utxo.vout === vout);
    assert.equal(exact.length, 1, party.wallet + ' must receive its exact payout UTXO');
    const [utxo] = exact;
    assert(utxo.spendable && utxo.confirmations >= 1);
    assert.equal(sats(utxo.amount), expectedSats);
    assert.equal(utxo.scriptPubKey, expectedScript);
    return { wallet: party.wallet, txid: confirmed.txid, vout, address: party.payoutAddress,
      amountSats: expectedSats, scriptPubKeyHex: expectedScript, confirmations: utxo.confirmations };
  });
}

function assertPolicyReject(rpc, rawTxHex, expected) {
  const [result] = rpc('testmempoolaccept', [[rawTxHex]]);
  assert.equal(result.allowed, false, 'transaction unexpectedly passed Core policy');
  assert.match(result['reject-reason'], expected);
  return result;
}

async function prepareContract({ rpc, directory, type, parties, oracleSecrets, anchorAddress, fundingHeight }) {
  return withResearchPartySigners(async (keys, sign) => {
    const plan = buildContractPlan({
      schemaVersion: 1, network: 'bitcoin-regtest',
      quoteId: 'regtest-' + type, market: { venue: 'lnmarkets', instrument: 'inverse_perp', pair: 'btc_usd' },
      side: 'long', entryPriceUsdCents: '10000000', notionalUsdCents: '100000',
      traderCollateralSats: '200000', makerCollateralSats: '200000',
      settlementFeeSats: '1000', anchorSats: '330', minimumPayoutSats: '1000',
      traderPayoutScript: parties[0].payoutScript, makerPayoutScript: parties[1].payoutScript,
      anchorScript: ownAddress(rpc, 'trader', anchorAddress),
      traderPubkeyX: keys[0], makerPubkeyX: keys[1],
      maturityHeight: fundingHeight + 2, refundHeight: fundingHeight + 4,
      refundCsvBlocks: type === 'cet' ? 1 : 7,
      oracleEventId: 'lnmarkets/regtest/' + type + '/' + randomBytes(16).toString('hex'),
      settlementPricesUsdCents: ['9000000', '10000000', '11000000'],
      oracleThreshold: 2, oraclePubkeys: oracleSecrets.map(pubkey)
    });
    const oracles = oracleSecrets.map((secret) => buildDlcOracle(secret, disposableScalar(), {
      eventId: plan.terms.oracleEventId,
      outcomeMessages: plan.outcomes.map(({ outcomeMessage }) => Buffer.from(outcomeMessage, 'hex'))
    }));
    const state = createRegtestState(directory, plan);
    const funding = prepareFunding(rpc, plan, parties);
    const fundingOutpoint = { txid: funding.template.txid, vout: 0 };
    const settlementPackage = buildSettlementPackage({ plan, oracleAnnouncements: oracles, fundingOutpoint });
    const { transactionSet } = settlementPackage;
    assert.equal(transactionSet.funding.scriptPubKeyHex, funding.template.outputs[0].scriptPubKeyHex);
    assert.equal(transactionSet.funding.valueSats, plan.fundingValueSats);
    state.advance('AUTHENTICATED_ORACLES', { oracle_policy: evidence(settlementPackage.oracleAnnouncements) });
    state.advance('CANONICAL_CETS_AND_REFUND', {
      cet_set: { digest: transactionSet.cetSetDigest }, fee_policy: { digest: transactionSet.feePolicyDigest },
      funding_template: { digest: transactionSet.fundingTemplateDigest },
      refund_transaction: { digest: transactionSet.refundTransactionDigest }
    });

    // The disposable party keys stay in two one-shot subprocesses. Both
    // subprocesses have exited before either funding wallet releases a signature.
    const partySignatures = await sign(settlementPackage);
    const [trader, maker] = partySignatures;
    assert.throws(() => finalizeRecoveryPackage({ settlementPackage, partySignatures: [maker] }));
    const recoveryPackage = finalizeRecoveryPackage({ settlementPackage, partySignatures });
    state.advance('COUNTERPARTY_SIGNATURES_VERIFIED', {
      counterparty_cet_signatures: evidence(maker.cetSignatures),
      counterparty_refund_signature: evidence(maker.refundSignature),
      peer_accept_transcript: evidence({ settlementPackage: settlementPackage.packageDigest, maker })
    });
    const copies = parties.map(({ wallet }) => {
      const walletDirectory = path.join(directory, wallet);
      fs.mkdirSync(walletDirectory, { mode: 0o700 });
      return verifyWalletRecovery(walletDirectory, settlementPackage, recoveryPackage);
    });
    const recoveryReceipts = copies.map((copy, index) => ({ wallet: parties[index].wallet, ...copy.receipt }));
    write(directory, 'wallet-recovery-receipts.json', recoveryReceipts);
    state.advance('LOCAL_SIGNATURES_PERSISTED', {
      local_cet_signatures: evidence(trader.cetSignatures), local_refund_signature: evidence(trader.refundSignature),
      peer_sign_transcript: evidence({ recoveryDigest: recoveryPackage.recoveryDigest, trader }),
      refund_restore_test: evidence(recoveryReceipts)
    });

    const signed = signFunding(rpc, funding, plan, parties);
    const [policy] = rpc('testmempoolaccept', [[signed.rawTxHex]]);
    assert.equal(policy.allowed, true, JSON.stringify(policy));
    assert.equal(policy.txid, fundingOutpoint.txid);
    assert.equal(sats(policy.fees.base), 2 * FEE_SHARE_SATS);
    const validation = {
      psbt: signed.combinedPsbt, template: funding.template, recoveryReceipts,
      contributions: parties.map(({ wallet, input, contributionSats, feeSats }) => ({ wallet, input, contributionSats, feeSats }))
    };
    write(directory, 'funding-psbt-validation.json', validation);
    state.advance('FUNDING_PSBT_APPROVED', {
      bitcoin_core_policy: evidence({ txid: policy.txid, wtxid: policy.wtxid, allowed: policy.allowed, feeSats: sats(policy.fees.base) }), funding_psbt_validation: evidence(validation),
      signer_separation: evidence({ fundingWallets: parties.map(({ wallet }) => wallet), dlcKeys: keys, oneShotSignersExited: true })
    });
    const guard = validateFundingPrebroadcastPolicy({ contractState: state.current, rawTxHex: signed.rawTxHex, rpc });
    write(directory, 'funding-core-policy.json', guard.record);
    state.broadcast({
      rpc, to: 'FUNDING_BROADCAST', rawTxHex: signed.rawTxHex, expectedTxid: fundingOutpoint.txid,
      receipts: {
        broadcast_transaction: { digest: txDigest(signed.rawTxHex) },
        host_broadcast_approval: evidence({ chain: 'regtest', fundingOutpoint, recoveryReceipts }),
        prebroadcast_bitcoin_core_policy: { digest: guard.policyDigest, metadata: guard.receiptMetadata }
      }
    });
    return { plan, state, settlementPackage, funding, recoveryPackage, fundingOutpoint, oracles, copies };
  });
}

function attest(oracle, outcome) {
  return { oraclePubkeyX: oracle.px, scalarHex: bytes32(dlcAttest(oracle, Buffer.from(outcome, 'hex'))).toString('hex') };
}

function checkRecoveryAttacks(instance, outcome, attestations, disagrees) {
  const recoveryPackage = instance.recoveryPackage;
  const pins = read(instance.copies[0].pinsPath);
  const changedOutpoint = structuredClone(recoveryPackage);
  changedOutpoint.settlementPackage.fundingOutpoint.vout += 1;
  assert.throws(() => verifyRecoveryPackage(changedOutpoint, pins), /match|differ/);
  const missingSignature = structuredClone(recoveryPackage);
  missingSignature.partySignatures[0].cetSignatures.pop();
  assert.throws(() => verifyRecoveryPackage(missingSignature, pins), /signature/i);
  const recover = (entries) => completeSettlement({ recoveryPackage, ...pins, outcomeId: outcome, attestations: entries });
  assert.throws(() => recover([attestations[0], disagrees]), /attestation/i);
  assert.throws(() => recover([attestations[0], attestations[0]]), /unique|distinct|duplicate/i);
  return ['altered funding outpoint', 'missing CET signature', 'incompatible oracle outcomes', 'duplicated attestation'];
}

function cpfp(rpc, watchtower, state, exit, trader, mine) {
  // Keep the parent unconfirmed at submission. The extra input is the already
  // confirmed change output from trader's collaborative funding input.
  const changeScript = trader.changeScript;
  const [extra] = rpc('listunspent', [1, 9999999, [trader.changeAddress]], 'trader');
  assert(extra?.spendable && extra.scriptPubKey === changeScript);
  const anchor = exit.outputs[2];
  const destination = walletAddress(rpc, 'trader', 'cpfp-change', 'bech32').address;
  const childFee = 2400;
  const input = (txid, vout) => ({ txid, vout, sequence: 0xfffffffd });
  const child = rpc('createrawtransaction', [[input(exit.txid, 2), input(extra.txid, extra.vout)],
    [{ [destination]: btc(Number(anchor.valueSats) + sats(extra.amount) - childFee) }], 0, true]);
  const signed = rpc('signrawtransactionwithwallet', [child], 'trader');
  assert.equal(signed.complete, true);
  const proposed = watchtower.observeAnchor(state.current, exit.txid, { proposedRecoveryRawTxHex: signed.hex });
  assert.equal(proposed.evaluation.status, 'RECOVERY_READY');
  assert.equal(Number(proposed.snapshot.proposedRecovery.feeSats), childFee);
  const childTxid = proposed.snapshot.proposedRecovery.txid;
  assert.equal(rpc('sendrawtransaction', [signed.hex]), childTxid);
  const seen = watchtower.observeAnchor(state.current, exit.txid, { expectedRecoveryTxids: [childTxid] });
  assert.equal(seen.evaluation.status, 'RECOVERY_PROPAGATION_HALT', 'one isolated node cannot meet a two-node relay quorum');
  const [blockHash] = mine(1);
  const confirmed = confirmedTransaction(rpc, blockHash, childTxid);
  assert.equal(confirmed.feeSats, childFee);
  const observed = watchtower.observeAnchor(state.current, exit.txid, { expectedRecoveryTxids: [childTxid] });
  assert.equal(observed.evaluation.status, 'RECOVERY_CONFIRMED');
  return { blockHash, child: confirmed, statuses: [proposed.evaluation.status, seen.evaluation.status, observed.evaluation.status],
    packageFeeSats: childFee + Number(exit.feeSats), childTxid };
}

async function runInstance({ rpc, root, type, oracleSecrets, mine }) {
  const directory = path.join(root, type);
  fs.mkdirSync(directory, { mode: 0o700 });
  const parties = [makeParty(rpc, 'trader', 'miner', 1330), makeParty(rpc, 'maker', 'miner', 0)];
  const anchorAddress = walletAddress(rpc, 'trader', 'recovery-anchor', 'bech32m').address;
  parties[0].anchorAddress = anchorAddress;
  mine(1);
  const fundingHeight = rpc('getblockcount') + 1;
  const instance = await prepareContract({ rpc, directory, type, parties, anchorAddress, oracleSecrets, fundingHeight });
  const { plan, state, settlementPackage, funding, copies, fundingOutpoint, recoveryPackage, oracles } = instance;
  const { transactionSet } = settlementPackage;
  const [fundingBlock] = mine(1);
  const fundingConfirmed = confirmedTransaction(rpc, fundingBlock, fundingOutpoint.txid);
  assert.equal(fundingConfirmed.height, fundingHeight);
  assert.equal(fundingConfirmed.feeSats, FEE_SHARE_SATS * 2);
  assert.deepEqual(fundingConfirmed.outputs, funding.template.outputs);
  const coin = rpc('gettxout', [fundingOutpoint.txid, fundingOutpoint.vout, false]);
  assert(coin?.confirmations >= 1);
  assert.equal(sats(coin.value), Number(plan.fundingValueSats));
  assert.equal(coin.scriptPubKey.hex, transactionSet.funding.scriptPubKeyHex);
  state.advance('CONFIRMED', { funding_confirmation: evidence(fundingConfirmed) });
  const watchtower = createWatchtower(directory, transactionSet, rpc);
  assert.equal(watchtower.observe(state.current).evaluation.status, 'FUNDING_CONFIRMED');

  const mineTo = (height) => {
    const delta = height - rpc('getblockcount');
    assert(delta >= 0);
    if (delta) mine(delta);
  };
  const earlyRejections = [];
  function rejectEarly(label, raw, pattern) {
    earlyRejections.push({ label, tipHeight: rpc('getblockcount'), ...assertPolicyReject(rpc, raw, pattern) });
  }
  // Both wallets have separate durable copies. During recovery the maker's
  // Core wallet is unloaded and the public-only child gets no signer or RPC.
  rpc('unloadwallet', ['maker']);
  let exit;
  let executionEvidence;
  let attestations;
  let attacks = [];
  const outcome = plan.outcomes[2];
  try {
    if (type === 'cet') {
      attestations = oracles.slice(0, 2).map((oracle) => attest(oracle, outcome.outcomeMessage));
      const attestationsFile = path.join(directory, 'oracle-attestations.json');
      write(directory, 'oracle-attestations.json', attestations);
      const disagrees = attest(oracles[2], plan.outcomes[0].outcomeMessage);
      attacks = checkRecoveryAttacks(instance, outcome.outcomeMessage, attestations, disagrees);
      // Publish early in the rehearsal to prove that even valid signatures
      // cannot spend before the absolute CET lock. The third share is withheld.
      exit = restoreFresh(copies[0].packagePath, copies[0].pinsPath, attestationsFile, outcome.outcomeMessage);
      mineTo(plan.terms.maturityHeight - 1);
      rejectEarly('CET absolute maturity', exit.rawTxHex, /^non-final$/);
      rejectEarly('refund absolute lock with CSV satisfied', copies[0].refund.rawTxHex, /^non-final$/);
      mineTo(plan.terms.maturityHeight);
      const selected = transactionSet.cets.find(({ txid }) => txid === exit.txid);
      rejectEarly('missing CET witness at maturity', selected.rawTxHex, /witness|script/i);
      executionEvidence = { outcomeMessage: outcome.outcomeMessage, attestations };
    } else {
      exit = restoreFresh(copies[0].packagePath, copies[0].pinsPath);
      mineTo(plan.terms.refundHeight - 1);
      rejectEarly('refund absolute lock', exit.rawTxHex, /^non-final$/);
      mineTo(plan.terms.refundHeight);
      rejectEarly('refund CSV with absolute lock satisfied', exit.rawTxHex, /^non-BIP68-final$/);
      mineTo(fundingHeight + plan.terms.refundCsvBlocks - 2);
      rejectEarly('refund one block before CSV eligibility', exit.rawTxHex, /^non-BIP68-final$/);
      mineTo(fundingHeight + plan.terms.refundCsvBlocks - 1);
      executionEvidence = { fundingHeight, tipHeight: rpc('getblockcount'),
        absoluteHeight: plan.terms.refundHeight, csvBlocks: plan.terms.refundCsvBlocks };
    }
    const evidenceKind = type === 'cet' ? 'oracle_threshold_attestation' : 'refund_maturity';
    const executionEvidenceDigest = digest(executionEvidence);
    write(directory, 'execution-evidence.json', executionEvidence);
    const guard = validateExecutionPrebroadcastPolicy({
      contractState: state.current, transactionSet, executionType: type, cetTxid: type === 'cet' ? exit.txid : undefined,
      signedTxHex: exit.rawTxHex, executionEvidenceDigest, rpc
    });
    write(directory, 'execution-core-policy.json', guard.record);
    state.broadcast({
      rpc, to: type === 'cet' ? 'CET_EXECUTED' : 'REFUND_EXECUTED', rawTxHex: exit.rawTxHex, expectedTxid: exit.txid,
      receipts: {
        [type + '_broadcast_transaction']: { digest: txDigest(exit.rawTxHex) },
        [evidenceKind]: { digest: executionEvidenceDigest },
        [guard.record.receiptKind]: { digest: guard.policyDigest, metadata: guard.receiptMetadata }
      }
    });
  } finally {
    rpc('loadwallet', ['maker']);
  }
  const recoveryFee = type === 'cet' ? cpfp(rpc, watchtower, state, exit, parties[0], mine) : null;
  const exitBlock = recoveryFee?.blockHash || mine(1)[0];
  const confirmed = confirmedTransaction(rpc, exitBlock, exit.txid);
  assert.deepEqual(confirmed.inputs.map(({ txid, vout, valueSats, scriptPubKeyHex }) => ({ txid, vout, valueSats, scriptPubKeyHex })),
    [{ ...fundingOutpoint, ...funding.template.outputs[0] }]);
  assert.equal(confirmed.feeSats, Number(plan.terms.settlementFeeSats));
  assert.deepEqual(confirmed.outputs, exit.outputs.map((output) => ({ ...output, valueSats: Number(output.valueSats) })));
  assert.equal(confirmed.wtxid, exit.wtxid);
  assert.equal(rpc('gettxout', [fundingOutpoint.txid, fundingOutpoint.vout, false]), null);
  const payoutRow = type === 'cet' ? outcome : plan.refund;
  const payouts = recordWalletPayouts(rpc, parties, confirmed, plan, payoutRow);
  const terminalStatus = type === 'cet' ? 'CET_OBSERVED' : 'REFUND_OBSERVED';
  assert.equal(watchtower.observe(state.current).evaluation.status, terminalStatus);
  let reorg = null;
  if (type === 'cet') {
    rpc('invalidateblock', [exitBlock]);
    const disconnected = watchtower.observe(state.current);
    assert.equal(disconnected.evaluation.status, 'REORG_HALT');
    const mempool = rpc('getrawmempool');
    assert(mempool.includes(exit.txid) && mempool.includes(recoveryFee.childTxid));
    rpc('reconsiderblock', [exitBlock]);
    const restored = watchtower.observe(state.current);
    assert.equal(restored.evaluation.status, 'CET_OBSERVED');
    assert.equal(confirmedTransaction(rpc, exitBlock, exit.txid).height, confirmed.height);
    const reconsideredMempool = rpc('getrawmempool');
    assert(!reconsideredMempool.includes(exit.txid) && !reconsideredMempool.includes(recoveryFee.childTxid));
    reorg = { invalidatedBlock: exitBlock, disconnectTip: disconnected.snapshot.height,
      disconnectStatus: disconnected.evaluation.status, restoredStatus: restored.evaluation.status,
      recoveredMempoolTxids: [exit.txid, recoveryFee.childTxid] };
  }
  const checks = state.verify();
  assert.equal(checks.authorizations, 2);
  return {
    package: recoveryPackage, pins: read(copies[0].pinsPath), attestations,
    summary: {
      contractId: plan.contractId, planDigest: plan.planDigest, recoveryDigest: recoveryPackage.recoveryDigest,
      maturityHeight: plan.terms.maturityHeight, refundHeight: plan.terms.refundHeight, refundCsvBlocks: plan.terms.refundCsvBlocks,
      funding: { ...fundingConfirmed, contributions: parties.map(({ wallet, contributionSats, feeSats }) => ({ wallet, contributionSats, feeSats })) },
      exit: confirmed, payouts, attacks, coreRejections: earlyRejections, recoveryFee, reorg,
      journals: { ...checks, watchtower: watchtower.verify(plan.contractId), watchtowerPublicKey: watchtower.publicKeySpki }
    }
  };
}

async function runRegtest({ binaryDir, output }) {
  assert(binaryDir && output, 'Bitcoin Core binary directory and a new output directory are required');
  const directory = path.resolve(output);
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  fs.mkdirSync(directory, { mode: 0o700 });
  return withRegtestCore({
    binaryDir: path.resolve(binaryDir), dataDir: path.join(directory, 'core'),
    async run(rpc, coreVersion) {
      for (const wallet of ['miner', 'trader', 'maker']) rpc('createwallet', [wallet]);
      const minerAddress = walletAddress(rpc, 'miner', 'regtest-miner', 'bech32').address;
      const mine = (count) => rpc('generatetoaddress', [count, minerAddress]);
      mine(101);
      const oracleSecrets = [disposableScalar(), disposableScalar(), disposableScalar()];
      const run = (type) => runInstance({ rpc, root: directory, type, oracleSecrets, minerAddress, mine });
      const cet = await run('cet');
      const refund = await run('refund');
      assert.throws(() => verifyRecoveryPackage(refund.package, cet.pins), /pinned.*plan|plan.*digest/i);
      assert.throws(() => completeSettlement({
        recoveryPackage: refund.package, ...refund.pins, attestations: cet.attestations,
        outcomeId: refund.package.settlementPackage.plan.outcomes[2].outcomeMessage
      }), /attestation/i);
      const result = {
        kind: 'lnmarkets_core_regtest_v1', evidenceTier: 'BITCOIN_CORE_REGTEST', network: 'bitcoin-regtest', coreVersion,
        independentOperators: false, productionSignerUsed: false, venueConnectionUsed: false,
        partySigningProcessesExitedBeforeFunding: true, makerWalletUnloadedDuringRecovery: true,
        attacks: ['substituted valid recovery package', 'attestations replayed across events with the same oracle keys'],
        cet: cet.summary, refund: refund.summary
      };
      write(directory, 'summary.json', result);
      return result;
    }
  });
}

if (require.main === module) {
  const [binFlag, binaryDir, outFlag, output, ...extra] = process.argv.slice(2);
  if (binFlag !== '--bitcoin-bin' || outFlag !== '--out' || !binaryDir || !output || extra.length) {
    console.error('Usage: node LNMarkets/regtest.js --bitcoin-bin DIRECTORY --out NEW_DIRECTORY');
    process.exitCode = 1;
  } else {
    runRegtest({ binaryDir, output }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
      console.error(error.stack);
      process.exitCode = 1;
    });
  }
}

module.exports = { runRegtest };
