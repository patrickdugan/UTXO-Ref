'use strict';

/**
 * Local, append-only authorization journal for one complete PnL book.
 *
 * The caller authenticates checkpoints, Bitcoin spending policy and current
 * chain evidence before calling this store. This module binds immutable bytes,
 * enforces ledger continuity and reserves the whole book before signing. Its
 * confirmation records contain caller-supplied observations, not chain proofs.
 * Independent expected head hashes are required for every mutation. A pending
 * signing reservation survives failures; there is deliberately no release API.
 * Persistence requires POSIX directory fsync. Windows fails before filesystem
 * creation; other unsupported filesystems fail when their directory flush fails.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { snapshotPlainData, canonicalJson } = require('./dlc_canonical_json');
const { ensureNonSymlinkDirectory, assertNonSymlinkDirectory,
  readBoundedJson, writeJsonAppendOnce } = require('./dlc_durable_json_store');
const { SNAPSHOT_KIND, MAX_SATS, hashPnlSettlementSnapshot,
  buildPnlSettlementBatch, verifyPnlSettlementBatch } = require('./tradelayer_pnl_batch_settlement');
const { parseCanonicalUnsignedTransaction } = require('./dlc_transaction_validator');

const LEDGER_KIND = 'tradelayer_pnl_ledger_state_v1';
const RECORD_KIND = 'tradelayer_pnl_batch_journal_record_v1';
const ZERO32 = '00'.repeat(32);
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 10000;
const LIVE_STORES = new WeakSet();
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort(cmp)) !== canonicalJson([...keys].sort(cmp))) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function amount(value, label) {
  let result;
  if (typeof value === 'bigint') result = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) result = BigInt(value);
  else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) result = BigInt(value);
  else throw new Error(`${label} must be an exact nonnegative integer`);
  if (result < 0n || result > MAX_SATS) throw new Error(`${label} exceeds the amount bound`);
  return result.toString();
}

function hash32(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be lowercase 32-byte hex`);
  }
  return value;
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest(); }
function digest(domain, value) {
  return sha256(Buffer.concat([Buffer.from(`${domain}\0`), Buffer.from(canonicalJson(value))])).toString('hex');
}
function ordered(rows, key) { return [...rows].sort((a, b) => cmp(key(a), key(b))); }
function outpointKey(utxo) { return `${utxo.txid}:${utxo.vout}`; }

// The kernel validates the original full schema before this projection. These
// conversions preserve its canonical numeric, hex and ordering conventions.
function normalizeSnapshot(input) {
  const raw = snapshotPlainData(input, '$.snapshot', true);
  hashPnlSettlementSnapshot(raw);
  const normalizeUtxo = (utxo) => ({ txid: utxo.txid.toLowerCase(), vout: Number(utxo.vout),
    sats: amount(utxo.sats, 'UTXO sats'), scriptPubKey: utxo.scriptPubKey.toLowerCase() });
  return snapshotPlainData({ kind: SNAPSHOT_KIND, network: raw.network,
    epochId: amount(raw.epochId, 'epochId'), previousStateRoot: raw.previousStateRoot.toLowerCase(),
    nettingSets: ordered(raw.nettingSets.map((set) => ({ id: set.id, assetId: set.assetId, unit: set.unit })), (set) => set.id),
    vaults: ordered(raw.vaults.map((vault) => ({ id: vault.id, nettingSetId: vault.nettingSetId,
      assetId: vault.assetId, unit: vault.unit, changeScriptPubKey: vault.changeScriptPubKey.toLowerCase(),
      feeSats: amount(vault.feeSats, 'feeSats'), protectedSats: amount(vault.protectedSats, 'protectedSats'),
      utxos: ordered(vault.utxos.map(normalizeUtxo), (utxo) => `${utxo.txid}:${String(utxo.vout).padStart(10, '0')}`)
    })), (vault) => vault.id),
    accounts: ordered(raw.accounts.map((account) => ({ id: account.id, nettingSetId: account.nettingSetId,
      assetId: account.assetId, unit: account.unit, vaultId: account.vaultId,
      equitySats: amount(account.equitySats, 'equitySats'), lockedSats: amount(account.lockedSats, 'lockedSats'),
      payoutSats: amount(account.payoutSats, 'payoutSats'),
      payoutScriptPubKey: !Object.prototype.hasOwnProperty.call(account, 'payoutScriptPubKey')
        || account.payoutScriptPubKey === null ? null : account.payoutScriptPubKey.toLowerCase()
    })), (account) => account.id),
    obligations: ordered(raw.obligations.map((obligation) => ({ id: obligation.id,
      nettingSetId: obligation.nettingSetId, assetId: obligation.assetId, unit: obligation.unit,
      fromAccountId: obligation.fromAccountId, toAccountId: obligation.toAccountId,
      sats: amount(obligation.sats, 'obligation sats') })), (obligation) => obligation.id),
    routes: ordered(raw.routes.map((route) => ({ fromVaultId: route.fromVaultId,
      toOutputId: route.toOutputId, capacitySats: amount(route.capacitySats, 'capacitySats') })),
    (route) => `${route.fromVaultId}:${route.toOutputId}`),
    consumedObligationIds: [...raw.consumedObligationIds].sort(cmp),
    spentOutpoints: raw.spentOutpoints.map((key) => {
      const [txid, vout] = key.split(':');
      return `${txid.toLowerCase()}:${Number(vout)}`;
    }).sort(cmp)
  }, '$.normalizedSnapshot', false);
}

function projectLedger(snapshot, epochId) {
  return { kind: LEDGER_KIND, version: 1, network: snapshot.network, epochId,
    nettingSets: snapshot.nettingSets,
    accounts: snapshot.accounts.map(({ payoutSats, ...account }) => account),
    vaults: snapshot.vaults.map(({ feeSats, ...vault }) => vault),
    routes: snapshot.routes, consumedObligationIds: snapshot.consumedObligationIds,
    spentOutpoints: snapshot.spentOutpoints };
}

function normalizeLedgerState(input) {
  const raw = snapshotPlainData(input, '$.ledger', true);
  exact(raw, ['kind', 'version', 'network', 'epochId', 'nettingSets', 'accounts', 'vaults',
    'routes', 'consumedObligationIds', 'spentOutpoints'], 'ledger');
  if (raw.kind !== LEDGER_KIND || raw.version !== 1) throw new Error('wrong ledger kind or version');
  if (!Array.isArray(raw.accounts) || !Array.isArray(raw.vaults)) throw new Error('ledger accounts and vaults must be arrays');
  raw.accounts.forEach((account) => exact(account, ['id', 'nettingSetId', 'assetId', 'unit', 'vaultId',
    'equitySats', 'lockedSats', 'payoutScriptPubKey'], 'ledger account'));
  raw.vaults.forEach((vault) => exact(vault, ['id', 'nettingSetId', 'assetId', 'unit',
    'changeScriptPubKey', 'protectedSats', 'utxos'], 'ledger vault'));
  const synthetic = normalizeSnapshot({ kind: SNAPSHOT_KIND, network: raw.network,
    epochId: amount(raw.epochId, 'ledger epochId'), previousStateRoot: ZERO32,
    nettingSets: raw.nettingSets,
    accounts: raw.accounts.map((account) => ({ ...account, payoutSats: '0' })),
    vaults: raw.vaults.map((vault) => ({ ...vault, feeSats: '0' })),
    obligations: [], routes: raw.routes, consumedObligationIds: raw.consumedObligationIds,
    spentOutpoints: raw.spentOutpoints });
  // This identity transition checks current backing and locked equity as well
  // as schema validity. Every live vault UTXO belongs to the supplied ledger.
  buildPnlSettlementBatch(synthetic);
  return snapshotPlainData(projectLedger(synthetic, synthetic.epochId), '$.ledger', false);
}

function hashLedgerState(ledger) { return digest(LEDGER_KIND, normalizeLedgerState(ledger)); }

function ledgerFromSnapshot(input, options) {
  const args = snapshotPlainData(options, '$.ledgerOptions', true);
  exact(args, ['previousEpochId'], 'ledger projection options');
  const previousEpochId = amount(args.previousEpochId, 'previousEpochId');
  const snapshot = normalizeSnapshot(input);
  if (BigInt(snapshot.epochId) !== BigInt(previousEpochId) + 1n) {
    throw new Error('snapshot epoch must be the immediate ledger successor');
  }
  return normalizeLedgerState(projectLedger(snapshot, previousEpochId));
}

function assertSnapshotContinuesLedger(ledgerInput, snapshotInput) {
  const ledger = normalizeLedgerState(ledgerInput);
  const snapshot = normalizeSnapshot(snapshotInput);
  const priorHash = hashLedgerState(ledger);
  if (snapshot.previousStateRoot !== priorHash) throw new Error('snapshot previousStateRoot differs from the actual ledger hash');
  const projection = ledgerFromSnapshot(snapshot, { previousEpochId: ledger.epochId });
  if (canonicalJson(projection) !== canonicalJson(ledger)) {
    throw new Error('snapshot changes prior balances, collateral, policy or replay history');
  }
  return snapshotPlainData({ ledger, snapshot, ledgerHash: priorHash,
    snapshotHash: hashPnlSettlementSnapshot(snapshot) }, '$.continuity', false);
}

function normalizeOutputs(outputs) {
  const plain = snapshotPlainData(outputs, '$.outputs', true);
  if (!Array.isArray(plain)) throw new Error('outputs must be an ordered array');
  return plain.map((output) => {
    exact(output, ['sats', 'scriptPubKey'], 'output');
    if (typeof output.scriptPubKey !== 'string' || !/^(?:[0-9a-f]{2}){1,10000}$/.test(output.scriptPubKey)) {
      throw new Error('output script must be canonical lowercase hex');
    }
    return { sats: amount(output.sats, 'output sats'), scriptPubKey: output.scriptPubKey };
  });
}

function deriveNextLedger(ledgerInput, input) {
  const args = snapshotPlainData(input, '$.nextLedger', true);
  exact(args, ['snapshot', 'batch', 'txid', 'outputs'], 'next ledger arguments');
  const { ledger, snapshot, snapshotHash } = assertSnapshotContinuesLedger(ledgerInput, args.snapshot);
  const check = verifyPnlSettlementBatch(args.batch, { snapshot, expectedSnapshotHash: snapshotHash });
  if (!check.ok) throw new Error(`invalid batch: ${check.reason}`);
  const batch = buildPnlSettlementBatch(snapshot);
  if (batch.transaction.kind !== 'atomic-spend-proposal') throw new Error('accounting-only execution is unsupported by the journal adapter');
  const txid = hash32(args.txid, 'settlement txid');
  const outputs = normalizeOutputs(args.outputs);
  if (canonicalJson(outputs) !== canonicalJson(batch.transaction.outputs.map(({ sats, scriptPubKey }) => ({ sats, scriptPubKey })))) {
    throw new Error('transaction outputs differ from the fully rebuilt batch');
  }
  const equities = new Map(batch.accountStates.map((account) => [account.accountId, account.afterEquitySats]));
  const residuals = new Map(batch.transaction.outputs.map((output, vout) => [output.id,
    { txid, vout, sats: output.sats, scriptPubKey: output.scriptPubKey }]));
  return normalizeLedgerState({ ...ledger, epochId: snapshot.epochId,
    accounts: ledger.accounts.map((account) => ({ ...account, equitySats: equities.get(account.id) })),
    vaults: ledger.vaults.map((vault) => ({ ...vault,
      utxos: residuals.has(`vault:${vault.id}`) ? [residuals.get(`vault:${vault.id}`)] : [] })),
    consumedObligationIds: batch.nextAccountingState.consumedObligationIds,
    spentOutpoints: batch.nextAccountingState.spentOutpoints });
}

function normalizePlan(ledger, input) {
  const args = snapshotPlainData(input, '$.reservation', true);
  exact(args, ['snapshot', 'batch', 'unsignedTxHex', 'txid', 'checkpointHash',
    'transactionPolicyHash'], 'reservation plan');
  const { snapshot, snapshotHash } = assertSnapshotContinuesLedger(ledger, args.snapshot);
  if (typeof args.unsignedTxHex !== 'string' || args.unsignedTxHex.length > 8 * 1024 * 1024
    || !/^(?:[0-9a-f]{2})+$/.test(args.unsignedTxHex)) throw new Error('unsigned transaction must be bounded canonical hex');
  const tx = parseCanonicalUnsignedTransaction(args.unsignedTxHex);
  const txid = Buffer.from(sha256(sha256(Buffer.from(args.unsignedTxHex, 'hex')))).reverse().toString('hex');
  if (txid !== hash32(args.txid, 'transaction txid')) throw new Error('reserved txid differs from the exact unsigned bytes');
  const batch = buildPnlSettlementBatch(snapshot);
  const check = verifyPnlSettlementBatch(args.batch, { snapshot, expectedSnapshotHash: snapshotHash });
  if (!check.ok) throw new Error(`invalid reserved batch: ${check.reason}`);
  const expectedInputs = batch.transaction.inputs;
  if (tx.inputs.length !== expectedInputs.length) throw new Error('transaction inputs differ from the batch');
  for (let index = 0; index < expectedInputs.length; index++) {
    const key = outpointKey(tx.inputs[index]);
    if (key !== outpointKey(expectedInputs[index])) throw new Error('transaction input order or outpoint differs from the batch');
  }
  const outputs = tx.outputs.map((output) => ({ sats: output.valueSats.toString(), scriptPubKey: output.scriptPubKeyHex }));
  const nextLedger = deriveNextLedger(ledger, { snapshot, batch, txid, outputs });
  return snapshotPlainData({ snapshot, snapshotHash, batch, batchHash: batch.batchHash,
    unsignedTxHex: args.unsignedTxHex, unsignedTransactionSha256: sha256(Buffer.from(args.unsignedTxHex, 'hex')).toString('hex'),
    txid, checkpointHash: hash32(args.checkpointHash, 'checkpointHash'),
    transactionPolicyHash: hash32(args.transactionPolicyHash, 'transactionPolicyHash'),
    nextLedger, nextLedgerHash: hashLedgerState(nextLedger) }, '$.reservation', false);
}

function assertActive(state) {
  if (!state) throw new Error('book is uninitialized');
  if (state.frozen) throw new Error(`book is frozen: ${state.frozen.reason}`);
}

// A complete state is replayed from each append-only event. Every reserve is a
// permanent signing tombstone, including failures before the signer returns.
function reduceState(previous, action, input, revision) {
  const data = snapshotPlainData(input, '$.journalEvent', false);
  if (action === 'INITIALIZE') {
    if (previous !== null || revision !== 0) throw new Error('book is already initialized');
    exact(data, ['ledger'], 'initialization event');
    const ledger = normalizeLedgerState(data.ledger);
    return { ledger, ledgerHash: hashLedgerState(ledger), pending: null, frozen: null,
      signingTombstones: [], lastConfirmation: null };
  }
  assertActive(previous);
  if (action === 'RESERVE') {
    if (previous.pending) throw new Error('book has an unresolved signing reservation');
    const plan = normalizePlan(previous.ledger, data);
    const tombstone = { epochId: plan.snapshot.epochId, batchHash: plan.batchHash,
      checkpointHash: plan.checkpointHash, transactionPolicyHash: plan.transactionPolicyHash,
      txid: plan.txid, unsignedTransactionSha256: plan.unsignedTransactionSha256,
      obligationIds: plan.snapshot.obligations.map((obligation) => obligation.id),
      outpoints: plan.batch.transaction.inputs.map(outpointKey), reservedRevision: revision };
    return { ...previous, pending: { status: 'RESERVED_BEFORE_SIGN', ...plan,
      signedTxHex: null, wtxid: null, rawTransactionSha256: null },
    signingTombstones: [...previous.signingTombstones, tombstone] };
  }
  if (action === 'SIGNED') {
    exact(data, ['signedTxHex'], 'signed transaction event');
    if (previous.pending?.status !== 'RESERVED_BEFORE_SIGN') throw new Error('a new pending reservation is required before recording signed bytes');
    // Parsing binds the witnessed envelope to already-reserved bytes. Root's
    // verifier/Core guard establishes signature validity and chain authority.
    const { parsePnlBatchSignedEnvelope } = require('./tradelayer_pnl_batch_transaction');
    const parsed = parsePnlBatchSignedEnvelope(data.signedTxHex, previous.pending.unsignedTxHex);
    if (parsed.txid !== previous.pending.txid) throw new Error('signed transaction txid differs from reservation');
    return { ...previous, pending: { ...previous.pending, status: 'SIGNED',
      signedTxHex: data.signedTxHex, wtxid: parsed.wtxid,
      rawTransactionSha256: parsed.rawTransactionSha256 } };
  }
  if (action === 'COMMIT') {
    exact(data, ['txid', 'blockHash', 'blockHeight', 'confirmations'], 'confirmation event');
    if (previous.pending?.status !== 'SIGNED') throw new Error('signed pending transaction is required for commit');
    if (hash32(data.txid, 'confirmed txid') !== previous.pending.txid) throw new Error('confirmation names a different transaction');
    hash32(data.blockHash, 'confirmation block hash');
    for (const field of ['blockHeight', 'confirmations']) {
      if (!Number.isSafeInteger(data[field]) || data[field] < (field === 'confirmations' ? 1 : 0)) {
        throw new Error(`confirmation ${field} must be a bounded integer`);
      }
    }
    return { ...previous, ledger: previous.pending.nextLedger, ledgerHash: previous.pending.nextLedgerHash,
      pending: null, lastConfirmation: { ...data, batchHash: previous.pending.batchHash } };
  }
  if (action === 'FREEZE') {
    exact(data, ['reason'], 'freeze event');
    if (typeof data.reason !== 'string' || data.reason.length < 1 || data.reason.length > 512) throw new Error('freeze reason must contain 1..512 characters');
    return { ...previous, frozen: { reason: data.reason, revision } };
  }
  throw new Error('unknown journal action');
}

function fsyncDirectory(directory) {
  assertNonSymlinkDirectory(directory, 'PnL journal');
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0)
    | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function recordHash(record) {
  const core = { ...record };
  delete core.headHash;
  return digest(RECORD_KIND, core);
}

function assertStoreReceiver(value) {
  if (!isPnlBatchStateStore(value)) throw new Error('a live branded PnL state store is required');
}

class PnlBatchStateStore {
  constructor(baseDirectory, bookId) {
    if (typeof baseDirectory !== 'string' || baseDirectory.length < 1) throw new Error('baseDirectory is required');
    hash32(bookId, 'bookId');
    if (process.platform === 'win32') {
      const error = new Error('PnL durable journal requires POSIX directory fsync; Windows authorization is unsupported');
      Object.defineProperty(error, 'code', { value: 'PNL_JOURNAL_UNSUPPORTED_PLATFORM' });
      throw error;
    }
    this.baseDirectory = path.resolve(baseDirectory);
    this.bookId = bookId;
    this.directory = path.join(this.baseDirectory, bookId);
    this.lockDirectory = path.join(this.baseDirectory, `.${bookId}.lock`);
    // Creating several previously absent ancestors would require flushing each
    // ancestor's parent. Require a prepared parent for this bounded store.
    assertNonSymlinkDirectory(path.dirname(this.baseDirectory), 'PnL journal parent');
    ensureNonSymlinkDirectory(this.baseDirectory, 'PnL journal base');
    fsyncDirectory(path.dirname(this.baseDirectory));
    ensureNonSymlinkDirectory(this.directory, 'PnL journal book');
    fsyncDirectory(this.baseDirectory);
    LIVE_STORES.add(this);
    Object.freeze(this);
  }

  _assertReceiver() {
    assertStoreReceiver(this);
  }

  _withLock(run) {
    assertStoreReceiver(this);
    assertNonSymlinkDirectory(this.baseDirectory, 'PnL journal base');
    try { fs.mkdirSync(this.lockDirectory, { mode: 0o700 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('PnL book lock is held; incomplete locks require explicit recovery');
      throw error;
    }
    try {
      fsyncDirectory(this.baseDirectory);
      return run();
    } finally {
      fs.rmdirSync(this.lockDirectory);
      fsyncDirectory(this.baseDirectory);
    }
  }

  _readChain() {
    assertStoreReceiver(this);
    assertNonSymlinkDirectory(this.directory, 'PnL journal book');
    const names = fs.readdirSync(this.directory).sort(cmp);
    if (names.some((name) => !/^revision-[0-9]{12}\.json$/.test(name))) {
      throw new Error('PnL journal contains incomplete or unexpected publication files');
    }
    if (names.length > MAX_RECORDS) throw new Error('PnL journal exceeds record bound');
    let previous = null;
    let previousHash = ZERO32;
    for (let revision = 0; revision < names.length; revision++) {
      if (names[revision] !== `revision-${String(revision).padStart(12, '0')}.json`) throw new Error('PnL journal revisions are not contiguous');
      const record = snapshotPlainData(readBoundedJson(path.join(this.directory, names[revision]),
        { maxBytes: MAX_RECORD_BYTES, label: 'PnL journal revision' }), '$.record', false);
      exact(record, ['kind', 'version', 'bookId', 'revision', 'previousHeadHash', 'action', 'data', 'state', 'headHash'], 'journal record');
      if (record.kind !== RECORD_KIND || record.version !== 1 || record.bookId !== this.bookId
        || record.revision !== revision || record.previousHeadHash !== previousHash
        || record.headHash !== recordHash(record)) throw new Error('PnL journal record hash or linkage mismatch');
      const state = reduceState(previous, record.action, record.data, revision);
      if (canonicalJson(state) !== canonicalJson(record.state)) throw new Error('PnL journal state differs from replayed transition');
      previous = state;
      previousHash = record.headHash;
    }
    return names.length ? { bookId: this.bookId, revision: names.length - 1,
      headHash: previousHash, ...previous } : null;
  }

  read(options = {}) {
    assertStoreReceiver(this);
    const args = snapshotPlainData(options, '$.readOptions', false);
    if (Object.keys(args).some((key) => key !== 'expectedHeadHash')) throw new Error('unknown read option');
    const current = this._readChain();
    if (!current) throw new Error('PnL book is uninitialized');
    if (Object.prototype.hasOwnProperty.call(args, 'expectedHeadHash')
      && current.headHash !== hash32(args.expectedHeadHash, 'expectedHeadHash')) {
      throw new Error('PnL journal head differs from the independent expected head');
    }
    return snapshotPlainData(current, '$.book', false);
  }

  // Holds the lock through the callback's synchronous invocation only. A
  // returned Promise settles after the lock is released. Orchestration must
  // recheck the independently pinned head and active state after each await
  // before releasing results or initiating another external capability.
  withHead(expectedHeadHash, callback) {
    assertStoreReceiver(this);
    hash32(expectedHeadHash, 'expectedHeadHash');
    if (typeof callback !== 'function') throw new Error('withHead callback must be a function');
    return this._withLock(() => {
      const current = this.read({ expectedHeadHash });
      assertActive(current);
      return callback(current);
    });
  }

  _append(expectedHeadHash, action, data) {
    assertStoreReceiver(this);
    return this._withLock(() => {
      const current = this._readChain();
      if (action === 'INITIALIZE') {
        if (expectedHeadHash !== null) throw new Error('initialization requires an explicit null expectedHeadHash');
        if (current) throw new Error('PnL book already exists');
      } else {
        hash32(expectedHeadHash, 'expectedHeadHash');
        if (!current || current.headHash !== expectedHeadHash) throw new Error('stale or rolled-back PnL journal head');
      }
      const revision = current ? current.revision + 1 : 0;
      if (revision >= MAX_RECORDS) throw new Error('PnL journal exceeds record bound');
      const previousState = current ? {
        ledger: current.ledger, ledgerHash: current.ledgerHash, pending: current.pending,
        frozen: current.frozen, signingTombstones: current.signingTombstones,
        lastConfirmation: current.lastConfirmation } : null;
      const plainData = snapshotPlainData(data, '$.journalEvent', false);
      const state = reduceState(previousState, action, plainData, revision);
      const core = { kind: RECORD_KIND, version: 1, bookId: this.bookId, revision,
        previousHeadHash: current?.headHash || ZERO32, action, data: plainData, state };
      const record = { ...core, headHash: recordHash(core) };
      writeJsonAppendOnce(this.directory, `revision-${String(revision).padStart(12, '0')}.json`, record,
        { maxBytes: MAX_RECORD_BYTES, label: 'PnL journal revision', canonical: true });
      // The directory flush persists the newly published name before a caller
      // can release a signature. Unsupported directory fsync fails closed.
      fsyncDirectory(this.directory);
      return snapshotPlainData({ bookId: this.bookId, revision, headHash: record.headHash,
        ...state }, '$.book', false);
    });
  }

  initialize(ledger, options) {
    assertStoreReceiver(this);
    const args = snapshotPlainData(options, '$.initializeOptions', false);
    exact(args, ['expectedHeadHash'], 'initialization options');
    return this._append(args.expectedHeadHash, 'INITIALIZE', { ledger: normalizeLedgerState(ledger) });
  }

  reserve(expectedHeadHash, plan) {
    assertStoreReceiver(this);
    const current = this.read({ expectedHeadHash });
    const normalized = normalizePlan(current.ledger, plan);
    return this._append(expectedHeadHash, 'RESERVE', {
      snapshot: normalized.snapshot, batch: normalized.batch, unsignedTxHex: normalized.unsignedTxHex,
      txid: normalized.txid, checkpointHash: normalized.checkpointHash,
      transactionPolicyHash: normalized.transactionPolicyHash });
  }

  recordSigned(expectedHeadHash, input) {
    assertStoreReceiver(this);
    return this._append(expectedHeadHash, 'SIGNED', input);
  }
  commit(expectedHeadHash, input) {
    assertStoreReceiver(this);
    return this._append(expectedHeadHash, 'COMMIT', input);
  }
  freeze(expectedHeadHash, input) {
    assertStoreReceiver(this);
    return this._append(expectedHeadHash, 'FREEZE', input);
  }
}

function isPnlBatchStateStore(value) {
  return LIVE_STORES.has(value) && Object.getPrototypeOf(value) === PnlBatchStateStore.prototype;
}
Object.freeze(PnlBatchStateStore.prototype);

module.exports = { LEDGER_KIND, RECORD_KIND, MAX_RECORD_BYTES, normalizeLedgerState,
  hashLedgerState, ledgerFromSnapshot, assertSnapshotContinuesLedger, deriveNextLedger,
  PnlBatchStateStore, isPnlBatchStateStore };
