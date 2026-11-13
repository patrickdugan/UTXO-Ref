'use strict';

/**
 * Experimental regtest/testnet4 signing and execution boundary for typed PnL.
 *
 * An independently configured Core RPC and signer are capabilities, never
 * candidate fields. The journal reserves the complete book before invoking
 * the signer and retains the reservation after any ambiguous failure. Signed
 * bytes are persisted before broadcast. Only an observed active-chain inclusion
 * commits account equity and the concrete residual outpoints.
 *
 * This local protocol cannot make a filesystem commit and Bitcoin consensus
 * atomic. An unresolved transaction blocks the next epoch. Reorg detection
 * freezes the book while preserving signing tombstones. Expected journal heads
 * must be pinned outside the journal to detect rollback of local storage.
 */
const { types: utilTypes } = require('util');
const { snapshotOwnDataArguments, snapshotPlainData, canonicalJson } = require('./dlc_canonical_json');
const { verifyUtxoRefPnlBatchSettlementV2 } = require('./utxoref_v2_pnl_batch');
const { verifyPnlBatchSignedTransaction } = require('./tradelayer_pnl_batch_transaction');
const { PnlBatchStateStore, isPnlBatchStateStore, assertSnapshotContinuesLedger } = require('./tradelayer_pnl_batch_state_store');

const NETWORKS = Object.freeze({ 'bitcoin-regtest': 'regtest', 'bitcoin-testnet4': 'testnet4' });
const MAX_MONEY = 2100000000000000n;
const MAX_ATTEMPTS = 3;
const COMMON_FIELDS = Object.freeze(['settlement', 'trustPolicy', 'transactionPolicy',
  'expectedTransactionPolicyHash', 'executionPolicy', 'store', 'expectedHeadHash', 'rpc']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function fail(message, headHash) {
  const error = new Error(message);
  if (headHash) Object.defineProperty(error, 'headHash', { value: headHash, enumerable: true });
  throw error;
}
function hash32(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(`${label} must be lowercase 32-byte hex`);
  return value;
}
function integer(value, label, min = 0, max = 0xffffffff) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) fail(`${label} is out of range`);
  return value;
}
function exact(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...fields].sort())) fail(`${label} has unexpected or missing fields`);
}
function dataField(value, field, label) {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be a plain RPC record`);
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) fail(`${label}.${field} must be an own data field`);
  return descriptor.value;
}
function btcToSats(value, label) {
  let text;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) && value >= 0 && value <= 21000000) {
    text = value.toFixed(8);
    if (Number(text) !== value) fail(`${label} has sub-satoshi precision`);
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(value)) text = value;
  else fail(`${label} must be an exact Bitcoin decimal`);
  const [whole, fraction = ''] = text.split('.');
  const sats = BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'));
  if (sats > MAX_MONEY) fail(`${label} exceeds Bitcoin money bounds`);
  return sats;
}
function normalizePolicy(value) {
  exact(value, ['minFundingConfirmations', 'minSettlementConfirmations', 'maxFeeSats', 'maxFeeRateSatsPerVbyte'], 'execution policy');
  integer(value.minFundingConfirmations, 'minFundingConfirmations', 1, 1000000);
  integer(value.minSettlementConfirmations, 'minSettlementConfirmations', 1, 1000000);
  integer(value.maxFeeRateSatsPerVbyte, 'maxFeeRateSatsPerVbyte', 1, 1000000);
  if (typeof value.maxFeeSats !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.maxFeeSats)
    || BigInt(value.maxFeeSats) > MAX_MONEY) fail('maxFeeSats must be a bounded decimal satoshi amount');
  return value;
}
function argumentsFor(input, signing = false) {
  const fields = [...COMMON_FIELDS, ...(signing ? ['signer'] : [])];
  const args = snapshotOwnDataArguments(input, fields, '$.execution');
  for (const key of fields) if (!own(args, key)) fail(`execution.${key} is required`);
  if (!isPnlBatchStateStore(args.store)) fail('execution requires a live branded PnL state store');
  if (typeof args.rpc !== 'function' || signing && typeof args.signer !== 'function') fail('execution requires configured RPC/signer capabilities');
  const data = snapshotPlainData({ settlement: args.settlement, trustPolicy: args.trustPolicy,
    transactionPolicy: args.transactionPolicy, expectedTransactionPolicyHash: args.expectedTransactionPolicyHash,
    executionPolicy: args.executionPolicy, expectedHeadHash: args.expectedHeadHash }, '$.executionData', false);
  normalizePolicy(data.executionPolicy);
  hash32(data.expectedHeadHash, 'expectedHeadHash');
  hash32(data.expectedTransactionPolicyHash, 'expectedTransactionPolicyHash');
  const network = dataField(data.trustPolicy, 'network', 'trust policy');
  const contractId = dataField(data.trustPolicy, 'contractId', 'trust policy');
  hash32(dataField(data.trustPolicy, 'chainGenesisHash', 'trust policy'), 'trusted genesis hash');
  const envelope = dataField(data.settlement, 'stateEnvelope', 'settlement');
  const body = dataField(envelope, 'body', 'checkpoint');
  integer(dataField(body, 'snapshotHeight', 'checkpoint body'), 'checkpoint snapshotHeight');
  if (!own(NETWORKS, network)) fail('funded batch execution is restricted to regtest and testnet4');
  if (args.store.bookId !== contractId) fail('state store book differs from the authenticated contract');
  return { ...data, store: args.store, rpc: args.rpc, ...(signing ? { signer: args.signer } : {}) };
}
function readBook(args) {
  const state = PnlBatchStateStore.prototype.read.call(args.store, { expectedHeadHash: args.expectedHeadHash });
  if (state.frozen) fail(`PnL book is frozen: ${state.frozen.reason}`, state.headHash);
  if (state.ledger.network !== args.trustPolicy.network) fail('ledger and trusted chain network differ');
  return state;
}
function withPendingHead(args, expectedHeadHash, status, txid, callback) {
  // The book lock covers the current-head check and capability invocation.
  // An asynchronous callback's later completion requires another head check.
  return PnlBatchStateStore.prototype.withHead.call(args.store, expectedHeadHash, (state) => {
    if (state.pending?.status !== status || state.pending.txid !== txid) {
      fail('pending authorization changed before capability use', state.headHash);
    }
    return callback(state);
  });
}
async function rpcCall(args, method, params = []) { return await args.rpc(method, params); }
async function chainTip(args) {
  const raw = await rpcCall(args, 'getblockchaininfo');
  if (dataField(raw, 'chain', 'chain info') !== NETWORKS[args.trustPolicy.network]) fail('Core chain differs from trusted network');
  return { height: integer(dataField(raw, 'blocks', 'chain info'), 'Core height'),
    hash: hash32(dataField(raw, 'bestblockhash', 'chain info'), 'Core best block hash') };
}
async function mempoolSequence(args) {
  const raw = await rpcCall(args, 'getrawmempool', [false, true]);
  return integer(dataField(raw, 'mempool_sequence', 'mempool'), 'mempool sequence', 0, Number.MAX_SAFE_INTEGER);
}
async function checkAnchor(args, state, tip) {
  if (!state.lastConfirmation) return;
  const anchor = state.lastConfirmation;
  const active = tip.height >= anchor.blockHeight
    ? hash32(await rpcCall(args, 'getblockhash', [anchor.blockHeight]), 'active confirmation block hash') : null;
  if (active !== anchor.blockHash) {
    const frozen = PnlBatchStateStore.prototype.freeze.call(args.store, state.headHash,
      { reason: 'previous committed settlement left the active chain' });
    fail('confirmed PnL state was reorganized; book frozen for recovery', frozen.headHash);
  }
}
async function chainContext(args, state, tip) {
  const genesis = hash32(await rpcCall(args, 'getblockhash', [0]), 'Core genesis hash');
  if (genesis !== args.trustPolicy.chainGenesisHash) fail('Core genesis differs from independently trusted genesis');
  await checkAnchor(args, state, tip);
  const body = args.settlement.stateEnvelope.body;
  const height = integer(body.snapshotHeight, 'checkpoint snapshotHeight');
  if (height > tip.height) fail('checkpoint height exceeds active chain');
  return { snapshotBlockHash: hash32(await rpcCall(args, 'getblockhash', [height]), 'active snapshot block hash') };
}
function verifyForBook(args, state, tip, context, historical = false) {
  if (historical && (!state.pending || state.pending.checkpointHash !== args.settlement.stateEnvelope.bodyHash)) {
    fail('historical verification requires the original persisted reservation');
  }
  // Freshness is checked when reserving a new signing authority. Confirmation
  // and exact-byte rebroadcast recover that authority without expiring it or
  // creating another signature. Its checkpoint must still be on the active chain.
  const currentHeight = historical ? args.settlement.stateEnvelope.body.snapshotHeight : tip.height;
  const result = verifyUtxoRefPnlBatchSettlementV2(args.settlement, {
    stateVerification: { trustPolicy: args.trustPolicy, expectedPreviousStateRoot: state.ledgerHash,
      expectedEpochId: (BigInt(state.ledger.epochId) + 1n).toString(), currentHeight,
      expectedSnapshotBlockHash: context.snapshotBlockHash },
    transactionPolicy: args.transactionPolicy, expectedTransactionPolicyHash: args.expectedTransactionPolicyHash
  });
  if (!result.ok) fail(result.reason);
  assertSnapshotContinuesLedger(state.ledger, result.settlement.stateEnvelope.body.snapshot);
  const tx = result.settlement.transaction;
  if (BigInt(tx.feeSats) > BigInt(args.executionPolicy.maxFeeSats)) fail('batch fee exceeds independent execution policy');
  if (historical && (state.pending.txid !== tx.txid || state.pending.unsignedTxHex !== tx.unsignedTxHex
    || state.pending.transactionPolicyHash !== tx.transactionPolicyHash
    || state.pending.batchHash !== result.settlement.batch.batchHash)) fail('settlement differs from persisted signing reservation');
  return result;
}
function signedContext(args, validated) {
  const settlement = validated.settlement;
  return { batch: settlement.batch,
    settlementContext: { snapshot: settlement.stateEnvelope.body.snapshot, expectedSnapshotHash: validated.snapshotHash },
    transactionPolicy: args.transactionPolicy, expectedTransactionPolicyHash: args.expectedTransactionPolicyHash };
}
function verifySigned(args, validated, signedTxHex) {
  const checked = verifyPnlBatchSignedTransaction(signedTxHex, signedContext(args, validated));
  if (!checked.ok) fail(`signed batch rejected: ${checked.reason}`);
  if (BigInt(checked.feeSats) > BigInt(checked.vsize) * BigInt(args.executionPolicy.maxFeeRateSatsPerVbyte)) {
    fail('signed batch fee rate exceeds independent execution policy');
  }
  return checked;
}
async function coreAccept(args, signed) {
  const raw = await rpcCall(args, 'testmempoolaccept', [[signed.signedTxHex],
    (args.executionPolicy.maxFeeRateSatsPerVbyte / 100000).toFixed(8)]);
  if (!Array.isArray(raw) || utilTypes.isProxy(raw) || raw.length !== 1) fail('Core returned an invalid acceptance result');
  const itemDescriptor = Object.getOwnPropertyDescriptor(raw, '0');
  if (!itemDescriptor || !own(itemDescriptor, 'value')) fail('Core acceptance entry must be plain data');
  const item = itemDescriptor.value;
  if (dataField(item, 'txid', 'Core acceptance') !== signed.txid
    || dataField(item, 'wtxid', 'Core acceptance') !== signed.wtxid) fail('Core acceptance identifies different signed bytes');
  if (dataField(item, 'allowed', 'Core acceptance') !== true) fail('Core rejected the exact signed batch');
  if (dataField(item, 'vsize', 'Core acceptance') !== signed.vsize) fail('Core and local parser disagree on virtual size');
  const fees = dataField(item, 'fees', 'Core acceptance');
  if (btcToSats(dataField(fees, 'base', 'Core fees'), 'Core base fee') !== BigInt(signed.feeSats)) {
    fail('Core and declared prevouts disagree on the transaction fee');
  }
}
async function fundingView(args, state, { historical = false, signedTxHex = null } = {}) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const before = await chainTip(args);
    const sequenceBefore = await mempoolSequence(args);
    const context = await chainContext(args, state, before);
    const validated = verifyForBook(args, state, before, context, historical);
    const tx = validated.settlement.transaction;
    let fundingFailure = null;
    for (const prevout of tx.prevouts) {
      const coin = await rpcCall(args, 'gettxout', [prevout.txid, prevout.vout, true]);
      if (coin === null) { fundingFailure = 'a selected funding outpoint is spent or unavailable'; continue; }
      if (dataField(coin, 'bestblock', 'funding UTXO') !== before.hash) { fundingFailure = 'funding view crossed chain tips'; continue; }
      const confirmations = integer(dataField(coin, 'confirmations', 'funding UTXO'), 'funding confirmations');
      if (confirmations < args.executionPolicy.minFundingConfirmations) fundingFailure = 'funding confirmations are insufficient';
      if (btcToSats(dataField(coin, 'value', 'funding UTXO'), 'funding amount') !== BigInt(prevout.sats)) fundingFailure = 'funding amount differs from the authenticated snapshot';
      const script = dataField(dataField(coin, 'scriptPubKey', 'funding UTXO'), 'hex', 'funding script');
      if (script !== prevout.scriptPubKey) fundingFailure = 'funding script differs from the authenticated snapshot';
      const coinbase = dataField(coin, 'coinbase', 'funding UTXO');
      if (typeof coinbase !== 'boolean') fail('funding coinbase flag must be boolean');
      if (coinbase && confirmations < 100) fundingFailure = 'funding coinbase is immature';
    }
    const signed = signedTxHex === null ? null : verifySigned(args, validated, signedTxHex);
    if (!fundingFailure && signed) await coreAccept(args, signed);
    const sequenceAfter = await mempoolSequence(args);
    const after = await chainTip(args);
    if (before.hash !== after.hash || before.height !== after.height || sequenceBefore !== sequenceAfter) continue;
    if (fundingFailure) fail(fundingFailure);
    return { validated, signed, tip: after, mempoolSequence: sequenceAfter };
  }
  fail('Core chain or mempool changed throughout funding validation');
}

async function signPnlBatchSettlementV2(input) {
  const args = argumentsFor(input, true);
  const state = readBook(args);
  if (state.pending) fail('book has an unresolved signing reservation', state.headHash);
  const observed = await fundingView(args, state);
  const settlement = observed.validated.settlement;
  let current = PnlBatchStateStore.prototype.reserve.call(args.store, state.headHash, {
    snapshot: settlement.stateEnvelope.body.snapshot, batch: settlement.batch,
    unsignedTxHex: settlement.transaction.unsignedTxHex, txid: settlement.transaction.txid,
    checkpointHash: observed.validated.checkpointHash,
    transactionPolicyHash: settlement.transaction.transactionPolicyHash
  });
  try {
    const request = snapshotPlainData({ unsignedTxHex: settlement.transaction.unsignedTxHex,
      txid: settlement.transaction.txid, prevouts: settlement.transaction.prevouts,
      transactionHash: settlement.transaction.transactionHash, checkpointHash: observed.validated.checkpointHash }, '$.signerRequest', false);
    const signedTxHex = await withPendingHead(args, current.headHash, 'RESERVED_BEFORE_SIGN', request.txid,
      () => args.signer(request));
    const signed = verifySigned(args, observed.validated, signedTxHex);
    current = PnlBatchStateStore.prototype.recordSigned.call(args.store, current.headHash, { signedTxHex: signed.signedTxHex });
    const checked = await fundingView(args, current, { historical: true, signedTxHex: signed.signedTxHex });
    return withPendingHead(args, current.headHash, 'SIGNED', signed.txid, () => snapshotPlainData({ ok: true, headHash: current.headHash, txid: signed.txid,
      wtxid: signed.wtxid, signedTxHex: signed.signedTxHex, ledgerHash: current.ledgerHash,
      pendingLedgerHash: current.pending.nextLedgerHash, chainTip: checked.tip.hash,
      chainHeight: checked.tip.height, stateAuthenticated: true, priorStateOpeningVerified: true,
      transactionBytesVerified: true, corePolicyVerified: true, signingAuthorizationConsumed: true,
      executionVerified: false, zkProofVerified: false }, '$.signingResult', false));
  } catch (error) {
    const message = error && typeof error === 'object' && !utilTypes.isProxy(error)
      ? Object.getOwnPropertyDescriptor(error, 'message') : null;
    fail(message && own(message, 'value') && typeof message.value === 'string' ? message.value : 'signing failed with a retained reservation', current.headHash);
  }
}

async function knownTransaction(args, txid) {
  try { return await rpcCall(args, 'getrawtransaction', [txid, true]); }
  catch (error) {
    const code = error && typeof error === 'object' && !utilTypes.isProxy(error)
      ? Object.getOwnPropertyDescriptor(error, 'code') : null;
    if (code && own(code, 'value') && code.value === -5) return null;
    throw error;
  }
}
async function broadcastPnlBatchSettlementV2(input) {
  const args = argumentsFor(input);
  const state = readBook(args);
  if (state.pending?.status !== 'SIGNED') fail('broadcast requires durably stored signed bytes', state.headHash);
  const tip = await chainTip(args);
  const context = await chainContext(args, state, tip);
  const validated = verifyForBook(args, state, tip, context, true);
  const signed = verifySigned(args, validated, state.pending.signedTxHex);
  const known = await knownTransaction(args, signed.txid);
  if (known !== null) {
    if (dataField(known, 'hex', 'known transaction') !== signed.signedTxHex
      || dataField(known, 'txid', 'known transaction') !== signed.txid
      || dataField(known, 'hash', 'known transaction') !== signed.wtxid) fail('known transaction differs from reserved signed bytes');
    return withPendingHead(args, state.headHash, 'SIGNED', signed.txid, () => ({ ok: true,
      headHash: state.headHash, txid: signed.txid, alreadyKnown: true, executionVerified: false, zkProofVerified: false }));
  }
  await fundingView(args, state, { historical: true, signedTxHex: signed.signedTxHex });
  // This is the only broadcast call in the adapter. The bytes come from the
  // durable reservation and have just passed independent Core execution checks.
  const txid = await withPendingHead(args, state.headHash, 'SIGNED', signed.txid,
    () => rpcCall(args, 'sendrawtransaction', [signed.signedTxHex,
      (args.executionPolicy.maxFeeRateSatsPerVbyte / 100000).toFixed(8)]));
  if (txid !== signed.txid) fail('Core broadcast acknowledgement differs from reserved txid', state.headHash);
  return withPendingHead(args, state.headHash, 'SIGNED', signed.txid, () => ({ ok: true,
    headHash: state.headHash, txid, alreadyKnown: false, executionVerified: false, zkProofVerified: false }));
}

async function confirmPnlBatchSettlementV2(input) {
  const args = argumentsFor(input);
  const state = readBook(args);
  if (state.pending?.status !== 'SIGNED') fail('confirmation requires the pending signed batch', state.headHash);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const before = await chainTip(args);
    const context = await chainContext(args, state, before);
    const validated = verifyForBook(args, state, before, context, true);
    const signed = verifySigned(args, validated, state.pending.signedTxHex);
    const transaction = await knownTransaction(args, signed.txid);
    if (transaction === null) fail('pending transaction is absent from Core');
    if (dataField(transaction, 'hex', 'confirmed transaction') !== signed.signedTxHex
      || dataField(transaction, 'txid', 'confirmed transaction') !== signed.txid
      || dataField(transaction, 'hash', 'confirmed transaction') !== signed.wtxid) fail('confirmed transaction differs from persisted bytes');
    const blockHash = hash32(dataField(transaction, 'blockhash', 'confirmed transaction'), 'confirmation block hash');
    const header = await rpcCall(args, 'getblockheader', [blockHash]);
    const blockHeight = integer(dataField(header, 'height', 'confirmation header'), 'confirmation height');
    const confirmations = before.height - blockHeight + 1;
    if (confirmations < args.executionPolicy.minSettlementConfirmations
      || dataField(header, 'confirmations', 'confirmation header') !== confirmations
      || dataField(transaction, 'confirmations', 'confirmed transaction') !== confirmations
      || await rpcCall(args, 'getblockhash', [blockHeight]) !== blockHash) fail('settlement lacks required active-chain confirmations');
    const after = await chainTip(args);
    if (before.hash !== after.hash || before.height !== after.height) continue;
    const committed = PnlBatchStateStore.prototype.commit.call(args.store, state.headHash,
      { txid: signed.txid, blockHash, blockHeight, confirmations });
    return snapshotPlainData({ ok: true, headHash: committed.headHash, ledgerHash: committed.ledgerHash,
      epochId: committed.ledger.epochId, txid: signed.txid, blockHash, blockHeight, confirmations,
      scope: 'trusted-bitcoin-core-confirmed-test-network-batch', priorStateOpeningVerified: true,
      executionVerified: true, zkProofVerified: false, productionReady: false }, '$.confirmedBatch', false);
  }
  fail('Core chain changed throughout confirmation validation');
}

module.exports = { MAX_ATTEMPTS, btcToSats, signPnlBatchSettlementV2,
  broadcastPnlBatchSettlementV2, confirmPnlBatchSettlementV2 };
