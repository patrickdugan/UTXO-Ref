'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { outpoint, serializeWitnessTx } = require('./tradelayer_taproot');
const { hashPnlSettlementSnapshot, buildPnlSettlementBatch } = require('./tradelayer_pnl_batch_settlement');
const { POLICY_KIND, buildPnlBatchTransaction, hashPnlBatchTransactionPolicy } = require('./tradelayer_pnl_batch_transaction');
const { canonicalJson } = require('./dlc_canonical_json');
const { RECORD_KIND, hashLedgerState, ledgerFromSnapshot, assertSnapshotContinuesLedger,
  deriveNextLedger, PnlBatchStateStore, isPnlBatchStateStore } = require('./tradelayer_pnl_batch_state_store');

const BOOK = 'dd'.repeat(32);
const fixture = require('./artifacts/fixtures/pnl_batch_settlement_v1.snapshot.json');
const copy = (value) => JSON.parse(JSON.stringify(value));
const durableTest = (name, fn) => test(name, {
  skip: process.platform === 'win32'
    ? 'Durable PnL authorization requires POSIX directory fsync; Windows fails closed.' : false
}, fn);

function planFrom(snapshot) {
  const batch = buildPnlSettlementBatch(snapshot);
  const transactionPolicy = { kind: POLICY_KIND, network: snapshot.network, version: 2,
    locktime: 0, inputSequences: batch.transaction.inputs.map(({ txid, vout }) => ({ txid, vout, sequence: 6 })) };
  const transaction = buildPnlBatchTransaction({ batch,
    settlementContext: { snapshot, expectedSnapshotHash: hashPnlSettlementSnapshot(snapshot) }, transactionPolicy });
  const plan = { snapshot, batch, unsignedTxHex: transaction.unsignedTxHex, txid: transaction.txid,
    checkpointHash: '11'.repeat(32), transactionPolicyHash: hashPnlBatchTransactionPolicy(transactionPolicy) };
  // These intentionally synthetic witnesses test byte persistence only. The
  // store delegates signature validity and chain truth to root's observer.
  const signedTxHex = serializeWitnessTx(transaction.version,
    transaction.prevouts.map((input) => ({ outpoint: outpoint(input.txid, input.vout),
      sequence: input.sequence, witness: ['22'.repeat(64)] })),
    transaction.outputs.map(({ sats, scriptPubKey }) => ({ valueSats: BigInt(sats), script: scriptPubKey })), transaction.locktime);
  return { plan, signedTxHex, transaction };
}

function setup() {
  const snapshot = copy(fixture);
  const ledger = ledgerFromSnapshot(snapshot, { previousEpochId: '0' });
  snapshot.previousStateRoot = hashLedgerState(ledger);
  return { ledger, snapshot, ...planFrom(snapshot) };
}

function storeFor(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-state-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new PnlBatchStateStore(path.join(directory, 'books'), BOOK);
  const data = setup();
  const initial = store.initialize(data.ledger, { expectedHeadHash: null });
  return { ...data, directory, store, initial };
}

function confirmed(txid) {
  return { txid, blockHash: '33'.repeat(32), blockHeight: 100, confirmations: 6 };
}

function successor(ledger) {
  return { kind: 'tradelayer_pnl_batch_snapshot_v1', network: ledger.network,
    epochId: (BigInt(ledger.epochId) + 1n).toString(), previousStateRoot: hashLedgerState(ledger),
    nettingSets: copy(ledger.nettingSets), vaults: ledger.vaults.map((vault) => ({ ...copy(vault), feeSats: '100' })),
    accounts: ledger.accounts.map((account) => ({ ...copy(account), payoutSats: '0' })),
    routes: copy(ledger.routes), obligations: [], consumedObligationIds: copy(ledger.consumedObligationIds),
    spentOutpoints: copy(ledger.spentOutpoints) };
}

test('canonical ledger hash normalizes ordering and numeric amounts', () => {
  const { ledger } = setup();
  const shuffled = copy(ledger);
  shuffled.accounts.reverse(); shuffled.vaults.reverse(); shuffled.routes.reverse();
  shuffled.accounts[0].equitySats = Number(shuffled.accounts[0].equitySats);
  assert.equal(hashLedgerState(ledger), hashLedgerState(shuffled));
  assert(Object.isFrozen(ledger.accounts[0]));
  assert.throws(() => hashLedgerState({ ...ledger, unexpected: true }), /unexpected/);
});

test('continuity permits only current obligations, payouts and fee instructions to vary', () => {
  const { ledger, snapshot } = setup();
  const changed = copy(snapshot);
  changed.accounts[1].payoutSats = '2000'; changed.vaults[0].feeSats = '100';
  changed.obligations[0].sats = '9000';
  assert.equal(assertSnapshotContinuesLedger(ledger, changed).ledgerHash, hashLedgerState(ledger));
  for (const mutate of [
    (s) => { s.accounts[0].equitySats = '100001'; },
    (s) => { s.accounts[0].lockedSats = '1'; },
    (s) => { s.accounts[1].payoutScriptPubKey = `0014${'44'.repeat(20)}`; },
    (s) => { s.vaults[0].protectedSats = '1'; },
    (s) => { s.vaults[0].changeScriptPubKey = `5120${'44'.repeat(32)}`; },
    (s) => { s.vaults[0].utxos[0].txid = '44'.repeat(32); },
    (s) => { s.routes[0].capacitySats = '3999'; },
    (s) => { s.consumedObligationIds.push('invented-history'); },
    (s) => { s.spentOutpoints.push(`${'99'.repeat(32)}:0`); }
  ]) {
    const candidate = copy(snapshot); mutate(candidate);
    assert.throws(() => assertSnapshotContinuesLedger(ledger, candidate), /changes prior|cross-set|unknown/);
  }
});

test('root labels and skipped or reused epochs cannot bypass actual pre-state continuity', () => {
  const { ledger, snapshot } = setup();
  for (const epochId of ['0', '2', '3']) {
    assert.throws(() => assertSnapshotContinuesLedger(ledger, { ...snapshot, epochId }), /immediate ledger successor/);
  }
  assert.throws(() => assertSnapshotContinuesLedger(ledger, { ...snapshot, previousStateRoot: 'ff'.repeat(32) }), /actual ledger hash/);
  assert.throws(() => ledgerFromSnapshot(snapshot, { previousEpochId: '7' }), /immediate ledger successor/);
});

test('next ledger binds precise residual output indices and excludes direct payouts', () => {
  const { ledger, snapshot, plan, transaction } = setup();
  const outputs = transaction.outputs.map(({ sats, scriptPubKey }) => ({ sats, scriptPubKey }));
  const next = deriveNextLedger(ledger, { snapshot, batch: plan.batch, txid: plan.txid, outputs });
  assert.equal(next.epochId, '1');
  assert.deepEqual(next.vaults.map((vault) => vault.utxos[0].vout), [1, 2]);
  assert.deepEqual(next.vaults.map((vault) => vault.utxos[0].sats), ['99500', '110500']);
  assert(next.vaults.every((vault) => vault.utxos[0].txid === plan.txid));
  assert.deepEqual(next.accounts.map((account) => account.equitySats), ['90000', '106000']);
  assert.deepEqual(next.consumedObligationIds, ['synthetic-close-A-B']);
  assert.equal(next.spentOutpoints.length, 2);
  assert.throws(() => deriveNextLedger(ledger, { snapshot, batch: plan.batch, txid: plan.txid,
    outputs: [...outputs].reverse() }), /differ from the fully rebuilt/);
  const forged = copy(plan.batch); forged.nextAccountingState.accounts[0].equitySats = '999999';
  assert.throws(() => deriveNextLedger(ledger, { snapshot, batch: forged, txid: plan.txid, outputs }), /invalid batch/);
});

durableTest('brand, frozen instance and required initialization pin prevent counterfeit stores', (t) => {
  const { store, ledger } = storeFor(t);
  assert.equal(isPnlBatchStateStore(store), true);
  assert(Object.isFrozen(store));
  const fake = Object.create(PnlBatchStateStore.prototype);
  assert.equal(isPnlBatchStateStore(fake), false);
  assert.throws(() => fake.read(), /live branded/);
  assert.throws(() => { store.reserve = () => ({}); }, TypeError);
  assert.throws(() => store.initialize(ledger, { expectedHeadHash: null }), /already exists/);
  assert.throws(() => new PnlBatchStateStore(store.baseDirectory, '../escape'), /bookId/);
});

durableTest('reservation persists exact plan and tombstone before any signing result', (t) => {
  const { store, initial, plan } = storeFor(t);
  const reserved = store.reserve(initial.headHash, plan);
  assert.equal(reserved.pending.status, 'RESERVED_BEFORE_SIGN');
  assert.equal(reserved.ledgerHash, initial.ledgerHash);
  assert.equal(reserved.ledger.epochId, '0');
  assert.equal(reserved.signingTombstones.length, 1);
  assert.equal(reserved.signingTombstones[0].checkpointHash, plan.checkpointHash);
  assert.equal(reserved.signingTombstones[0].transactionPolicyHash, plan.transactionPolicyHash);
  assert.equal(store.read({ expectedHeadHash: reserved.headHash }).pending.unsignedTxHex, plan.unsignedTxHex);
  assert.throws(() => store.reserve(reserved.headHash, plan), /unresolved signing reservation/);
  assert.throws(() => store.reserve(initial.headHash, plan), /independent expected head/);
  assert.throws(() => store.recordSigned(undefined, { signedTxHex: '00' }), /expectedHeadHash/);
});

durableTest('reserve checks exact bytes, input/output ordering, txid and required audit bindings', (t) => {
  const { store, initial, plan } = storeFor(t);
  const noCheckpoint = copy(plan); delete noCheckpoint.checkpointHash;
  assert.throws(() => store.reserve(initial.headHash, noCheckpoint), /missing fields/);
  assert.throws(() => store.reserve(initial.headHash, { ...plan, txid: 'aa'.repeat(32) }), /txid differs/);
  const changed = copy(plan); changed.unsignedTxHex += '00';
  assert.throws(() => store.reserve(initial.headHash, changed), /trailing bytes/);
  const badBatch = copy(plan); badBatch.batch.executionVerified = true;
  assert.throws(() => store.reserve(initial.headHash, badBatch), /invalid reserved batch/);
  assert.equal(store.read({ expectedHeadHash: initial.headHash }).pending, null);
});

durableTest('matching signed bytes stay pending and duplicate or different bodies are rejected', (t) => {
  const { store, initial, plan, signedTxHex } = storeFor(t);
  const reserved = store.reserve(initial.headHash, plan);
  const wrong = `${signedTxHex.slice(0, -8)}01000000`;
  assert.throws(() => store.recordSigned(reserved.headHash, { signedTxHex: wrong }), /locktime differs/);
  assert.equal(store.read({ expectedHeadHash: reserved.headHash }).pending.status, 'RESERVED_BEFORE_SIGN');
  const signed = store.recordSigned(reserved.headHash, { signedTxHex });
  assert.equal(signed.pending.status, 'SIGNED');
  assert.equal(signed.ledger.epochId, '0');
  assert.equal(signed.pending.rawTransactionSha256, crypto.createHash('sha256').update(Buffer.from(signedTxHex, 'hex')).digest('hex'));
  assert.throws(() => store.recordSigned(signed.headHash, { signedTxHex }), /new pending reservation/);
  assert.equal(Object.prototype.hasOwnProperty.call(signed, 'executionVerified'), false);
});

durableTest('commit requires signed pending bytes and records root-supplied observation without asserting chain truth', (t) => {
  const { store, initial, plan, signedTxHex } = storeFor(t);
  const reserved = store.reserve(initial.headHash, plan);
  assert.throws(() => store.commit(reserved.headHash, confirmed(plan.txid)), /signed pending transaction/);
  const signed = store.recordSigned(reserved.headHash, { signedTxHex });
  assert.throws(() => store.commit(signed.headHash, confirmed('ff'.repeat(32))), /different transaction/);
  assert.throws(() => store.commit(signed.headHash, { ...confirmed(plan.txid), confirmations: 0 }), /confirmations/);
  const committed = store.commit(signed.headHash, confirmed(plan.txid));
  assert.equal(committed.pending, null);
  assert.equal(committed.ledger.epochId, '1');
  assert.equal(committed.ledgerHash, signed.pending.nextLedgerHash);
  assert.equal(committed.signingTombstones.length, 1);
  assert.equal(committed.lastConfirmation.txid, plan.txid);
  assert.throws(() => store.commit(committed.headHash, confirmed(plan.txid)), /signed pending transaction/);
});

durableTest('second epoch consumes exact prior residual outpoints and preserves replay history', (t) => {
  const { store, initial, plan, signedTxHex } = storeFor(t);
  const reserved = store.reserve(initial.headHash, plan);
  const signed = store.recordSigned(reserved.headHash, { signedTxHex });
  const settled = store.commit(signed.headHash, confirmed(plan.txid));
  const nextSnapshot = successor(settled.ledger);
  const next = planFrom(nextSnapshot);
  const second = store.reserve(settled.headHash, next.plan);
  assert.equal(second.pending.snapshot.epochId, '2');
  assert.equal(second.signingTombstones.length, 2);
  assert(second.pending.batch.transaction.inputs.every((input) => input.txid === plan.txid));
  assert.deepEqual(second.pending.nextLedger.consumedObligationIds, settled.ledger.consumedObligationIds);
  const forgotten = copy(nextSnapshot); forgotten.consumedObligationIds = [];
  assert.throws(() => assertSnapshotContinuesLedger(settled.ledger, forgotten), /changes prior/);
});

durableTest('reorg freeze retains pending signed transaction and every authorization tombstone', (t) => {
  const { store, initial, plan, signedTxHex } = storeFor(t);
  const reserved = store.reserve(initial.headHash, plan);
  const signed = store.recordSigned(reserved.headHash, { signedTxHex });
  const frozen = store.freeze(signed.headHash, { reason: 'active-chain anchor changed' });
  assert.equal(frozen.pending.signedTxHex, signedTxHex);
  assert.deepEqual(frozen.signingTombstones, signed.signingTombstones);
  for (const action of [
    () => store.reserve(frozen.headHash, plan),
    () => store.recordSigned(frozen.headHash, { signedTxHex }),
    () => store.commit(frozen.headHash, confirmed(plan.txid))
  ]) assert.throws(action, /frozen/);
});

durableTest('a settled book can freeze after confirmation is reorged without restoring old spend authority', (t) => {
  const { store, initial, plan, signedTxHex } = storeFor(t);
  const reserved = store.reserve(initial.headHash, plan);
  const signed = store.recordSigned(reserved.headHash, { signedTxHex });
  const committed = store.commit(signed.headHash, confirmed(plan.txid));
  const frozen = store.freeze(committed.headHash, { reason: 'settlement confirmation was removed' });
  assert.equal(frozen.ledgerHash, committed.ledgerHash);
  assert.equal(frozen.signingTombstones.length, 1);
  assert.equal(frozen.lastConfirmation.txid, plan.txid);
});

durableTest('restart recovers complete reservations and externally pinned head rejects truncation', (t) => {
  const { store, initial, plan } = storeFor(t);
  const reserved = store.reserve(initial.headHash, plan);
  const reopened = new PnlBatchStateStore(store.baseDirectory, BOOK);
  assert.equal(reopened.read({ expectedHeadHash: reserved.headHash }).pending.txid, plan.txid);
  fs.unlinkSync(path.join(store.directory, 'revision-000000000001.json'));
  assert.throws(() => reopened.read({ expectedHeadHash: reserved.headHash }), /independent expected head/);
  assert.throws(() => reopened.freeze(reserved.headHash, { reason: 'rollback' }), /rolled-back/);
});

durableTest('append-chain replay rejects forged state even after a local hash is recomputed', (t) => {
  const { store, initial } = storeFor(t);
  const file = path.join(store.directory, 'revision-000000000000.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.state.ledger.accounts[0].equitySats = '1';
  const { headHash, ...core } = record;
  record.headHash = crypto.createHash('sha256').update(`${RECORD_KIND}\0${canonicalJson(core)}`).digest('hex');
  fs.writeFileSync(file, JSON.stringify(record));
  assert.throws(() => store.read({ expectedHeadHash: initial.headHash }), /replayed transition/);
});

durableTest('partial publication and persistent abandoned book locks fail closed', (t) => {
  const { store, initial, plan } = storeFor(t);
  const incomplete = path.join(store.directory, '.pending.tmp');
  fs.writeFileSync(incomplete, '{}');
  assert.throws(() => store.read({ expectedHeadHash: initial.headHash }), /incomplete/);
  fs.unlinkSync(incomplete);
  fs.mkdirSync(store.lockDirectory);
  assert.throws(() => store.reserve(initial.headHash, plan), /lock is held/);
  assert(fs.existsSync(store.lockDirectory));
});

durableTest('journal reads reject symbolic links and hard-linked revision files', (t) => {
  const { store, initial, directory } = storeFor(t);
  const revision = path.join(store.directory, 'revision-000000000000.json');
  const linked = path.join(directory, 'linked.json');
  fs.linkSync(revision, linked);
  assert.throws(() => store.read({ expectedHeadHash: initial.headHash }), /bounded regular file/);
  fs.unlinkSync(linked);
  fs.renameSync(revision, linked); fs.symlinkSync(linked, revision);
  assert.throws(() => store.read({ expectedHeadHash: initial.headHash }), /bounded regular file/);
});

durableTest('unsupported directory fsync prevents opening an authorizing store', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-state-fsync-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('directory fsync unsupported'), { code: 'ENOTSUP' });
    return original(fd);
  };
  try { assert.throws(() => new PnlBatchStateStore(path.join(directory, 'books'), BOOK), /directory fsync unsupported/); }
  finally { fs.fsyncSync = original; }
});

durableTest('a failed publication flush returns no signing authorization and retains the pending tombstone', (t) => {
  const { store, initial, plan } = storeFor(t);
  const reservedPath = path.join(store.directory, 'revision-000000000001.json');
  const original = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = (fd) => {
    if (!injected && fs.fstatSync(fd).isDirectory() && fs.existsSync(reservedPath)) {
      injected = true;
      throw Object.assign(new Error('injected directory flush failure'), { code: 'EIO' });
    }
    return original(fd);
  };
  try { assert.throws(() => store.reserve(initial.headHash, plan), /directory flush failure/); }
  finally { fs.fsyncSync = original; }
  assert.equal(injected, true);
  assert.throws(() => store.read({ expectedHeadHash: initial.headHash }), /independent expected head/);
  const recovered = store.read();
  assert.equal(recovered.pending.status, 'RESERVED_BEFORE_SIGN');
  assert.equal(recovered.signingTombstones.length, 1);
  assert.throws(() => store.reserve(recovered.headHash, plan), /unresolved signing reservation/);
});

test('zero-input accounting cycles remain outside the execution journal relation', () => {
  const snapshot = copy(fixture);
  snapshot.vaults.forEach((vault) => { vault.utxos = []; vault.feeSats = '0'; });
  snapshot.accounts.forEach((account) => { account.equitySats = '0'; account.payoutSats = '0'; });
  snapshot.obligations.push({ ...copy(snapshot.obligations[0]), id: 'reverse',
    fromAccountId: 'trader-B', toAccountId: 'trader-A' });
  const ledger = ledgerFromSnapshot(snapshot, { previousEpochId: '0' });
  snapshot.previousStateRoot = hashLedgerState(ledger);
  const batch = buildPnlSettlementBatch(snapshot);
  assert.equal(batch.transaction.kind, 'accounting-only');
  assert.throws(() => deriveNextLedger(ledger, { snapshot, batch, txid: '11'.repeat(32), outputs: [] }), /accounting-only execution is unsupported/);
});

test('own-data projection rejects getters and ignores inherited optional destination getters', () => {
  const snapshot = copy(fixture);
  let calls = 0;
  Object.defineProperty(Object.prototype, 'payoutScriptPubKey', { configurable: true,
    get() { calls++; throw new Error('inherited destination getter ran'); } });
  try {
    assert.doesNotThrow(() => ledgerFromSnapshot(snapshot, { previousEpochId: '0' }));
    assert.equal(calls, 0);
  } finally { delete Object.prototype.payoutScriptPubKey; }
  const bad = copy(fixture);
  Object.defineProperty(bad.accounts[0], 'equitySats', { enumerable: true,
    get() { throw new Error('accessor ran'); } });
  assert.throws(() => ledgerFromSnapshot(bad, { previousEpochId: '0' }), /data property/);
});

durableTest('journal initialization and reservation never call inherited toJSON getters', (t) => {
  for (const prototype of [Object.prototype, Array.prototype]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-state-canonical-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = new PnlBatchStateStore(path.join(directory, 'books'), BOOK);
    const { ledger, plan } = setup();
    let calls = 0;
    Object.defineProperty(prototype, 'toJSON', { configurable: true,
      get() { calls++; throw new Error('inherited toJSON executed'); } });
    try {
      const initial = store.initialize(ledger, { expectedHeadHash: null });
      const reserved = store.reserve(initial.headHash, plan);
      assert.equal(store.read({ expectedHeadHash: reserved.headHash }).pending.txid, plan.txid);
      assert.equal(calls, 0);
    } finally { delete prototype.toJSON; }
  }
});

test('canonical durable serialization is opt-in and preserves default caller behavior', (t) => {
  const { writeJsonAppendOnce } = require('./dlc_durable_json_store');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-codec-option-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const legacy = { toJSON() { calls++; return { legacy: true }; } };
  writeJsonAppendOnce(directory, 'legacy.json', legacy, { maxBytes: 1024 });
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(path.join(directory, 'legacy.json'), 'utf8'), '{\n  "legacy": true\n}\n');
  writeJsonAppendOnce(directory, 'canonical.json', { z: 1, a: ['b'] }, { maxBytes: 1024, canonical: true });
  assert.equal(fs.readFileSync(path.join(directory, 'canonical.json'), 'utf8'), '{"a":["b"],"z":1}\n');
  let inheritedCalls = 0;
  Object.defineProperty(Object.prototype, 'canonical', { configurable: true,
    get() { inheritedCalls++; throw new Error('inherited canonical option ran'); } });
  try {
    writeJsonAppendOnce(directory, 'default.json', { ordinary: true }, { maxBytes: 1024 });
    assert.equal(inheritedCalls, 0);
  } finally { delete Object.prototype.canonical; }
  let ownCalls = 0;
  const accessorOptions = { maxBytes: 1024 };
  Object.defineProperty(accessorOptions, 'canonical', {
    get() { ownCalls++; return true; } });
  assert.throws(() => writeJsonAppendOnce(directory, 'accessor.json', {}, accessorOptions), /own data property/);
  assert.equal(ownCalls, 0);
});

durableTest('withHead holds book lock through synchronous capability invocation', (t) => {
  const { store, initial } = storeFor(t);
  const rival = new PnlBatchStateStore(store.baseDirectory, BOOK);
  let calls = 0;
  const result = PnlBatchStateStore.prototype.withHead.call(store, initial.headHash, (state) => {
    calls++;
    assert(Object.isFrozen(state));
    assert.equal(state.headHash, initial.headHash);
    assert.equal(fs.existsSync(store.lockDirectory), true);
    assert.throws(() => rival.freeze(initial.headHash, { reason: 'racing mutation' }), /lock is held/);
    return 'capability-started';
  });
  assert.equal(calls, 1);
  assert.equal(result, 'capability-started');
  assert.equal(fs.existsSync(store.lockDirectory), false);
  assert.equal(rival.read({ expectedHeadHash: initial.headHash }).frozen, null);
  assert.throws(() => store.withHead(initial.headHash, null), /callback must be a function/);
  assert.throws(() => PnlBatchStateStore.prototype.withHead.call({}, initial.headHash, () => {}), /live branded/);
  const counterfeit = { _assertReceiver() {}, _withLock(fn) { return fn(); },
    read() { return initial; }, _readChain() { return initial; } };
  assert.throws(() => PnlBatchStateStore.prototype.withHead.call(counterfeit, initial.headHash, () => { calls++; }), /live branded/);
  assert.throws(() => PnlBatchStateStore.prototype.read.call(counterfeit), /live branded/);
  const frozen = rival.freeze(initial.headHash, { reason: 'later reorg' });
  assert.throws(() => store.withHead(initial.headHash, () => { calls++; }), /independent expected head/);
  assert.throws(() => store.withHead(frozen.headHash, () => { calls++; }), /frozen/);
  assert.equal(calls, 1);
});

durableTest('withHead releases after invocation and async completion needs a fresh active-head check', async (t) => {
  const { store, initial } = storeFor(t);
  let finish;
  const awaited = new Promise((resolve) => { finish = resolve; });
  const result = store.withHead(initial.headHash, () => awaited);
  assert.equal(fs.existsSync(store.lockDirectory), false);
  const frozen = store.freeze(initial.headHash, { reason: 'reorg during external await' });
  finish('external-result');
  assert.equal(await result, 'external-result');
  assert.throws(() => store.withHead(frozen.headHash, () => 'release-result'), /frozen/);
});

test('Windows constructor fails before creating an authorization directory', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-windows-guard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const baseDirectory = path.join(directory, 'books');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
  try {
    assert.throws(() => new PnlBatchStateStore(baseDirectory, BOOK), (error) => {
      assert.equal(error.code, 'PNL_JOURNAL_UNSUPPORTED_PLATFORM');
      assert.match(error.message, /POSIX directory fsync/);
      return true;
    });
    assert.equal(fs.existsSync(baseDirectory), false);
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});

durableTest('two processes racing one external head create exactly one reservation', async (t) => {
  const { store, initial, plan, directory } = storeFor(t);
  const inputPath = path.join(directory, 'race-input.json');
  fs.writeFileSync(inputPath, JSON.stringify({ baseDirectory: store.baseDirectory,
    bookId: BOOK, expectedHeadHash: initial.headHash, plan }));
  const modulePath = require.resolve('./tradelayer_pnl_batch_state_store');
  const script = `const fs=require('fs'); const {PnlBatchStateStore}=require(process.argv[1]);
    const i=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    try { const s=new PnlBatchStateStore(i.baseDirectory,i.bookId); s.reserve(i.expectedHeadHash,i.plan);
      process.stdout.write('reserved'); } catch(e) { process.stdout.write('rejected'); }`;
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, modulePath, inputPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(error)));
  });
  const results = await Promise.all([launch(), launch()]);
  assert.deepEqual(results.sort(), ['rejected', 'reserved']);
  assert.equal(store.read().signingTombstones.length, 1);
});
