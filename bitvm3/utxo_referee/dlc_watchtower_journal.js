'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson, validateDlcContract } = require('./dlc_contract_state');
const { validateDlcTransactionSetCommitments } = require('./dlc_transaction_validator');
const { evaluateDlcChainSnapshot } = require('./dlc_chain_guard');

const KIND = 'utxoref_dlc_watchtower_observation_v1';

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function requireHash(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be lowercase hash`);
  return value;
}
function requireId(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error(`${name} contains unsafe characters`);
  }
  return value;
}
function normalize(value) { return JSON.parse(canonicalJson(value)); }
function asPublicKey(key) {
  return key && key.type === 'public' ? key : crypto.createPublicKey(key);
}
function publicKeyDer(key) {
  const publicKey = asPublicKey(key);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('watchtower key must be Ed25519');
  return publicKey.export({ format: 'der', type: 'spki' });
}
function recordDigest(record) {
  const unsigned = { ...record };
  delete unsigned.recordDigest;
  delete unsigned.signature;
  delete unsigned.recordHash;
  return hash(Buffer.from(canonicalJson(unsigned), 'utf8'));
}
function recordHash(record) {
  const value = { ...record };
  delete value.recordHash;
  return hash(Buffer.from(canonicalJson(value), 'utf8'));
}
function contractKey(contractId) {
  requireId(contractId, 'contractId');
  return hash(Buffer.from(contractId, 'utf8'));
}

function validateObservationRecord(record, publicKey, expected = {}) {
  if (!record || record.kind !== KIND || !['bitcoin-testnet4', 'bitcoin-regtest'].includes(record.network) ||
      !Number.isSafeInteger(record.sequence) || record.sequence < 0 ||
      !Number.isSafeInteger(record.contractRevision) || record.contractRevision < 0 ||
      record.contractKey !== contractKey(record.contractId) ||
      record.previousRecordHash !== null && !/^[0-9a-f]{64}$/.test(record.previousRecordHash || '')) {
    throw new Error('DLC watchtower observation is malformed');
  }
  requireId(record.watchtowerId, 'watchtowerId');
  for (const [name, value] of Object.entries({
    watchtowerKeyId: record.watchtowerKeyId,
    contractDigest: record.contractDigest,
    contractStateRecordHash: record.contractStateRecordHash,
    transactionValidationDigest: record.transactionValidationDigest,
    snapshotDigest: record.snapshotDigest,
    recordDigest: record.recordDigest,
    recordHash: record.recordHash
  })) requireHash(value, name);
  if (!record.snapshot || !record.evaluation || typeof record.evaluation.ok !== 'boolean' ||
      record.evaluation.halt !== !record.evaluation.ok ||
      typeof record.evaluation.status !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(record.evaluation.status) ||
      typeof record.evaluation.reason !== 'string' || record.evaluation.reason.length < 1 || record.evaluation.reason.length > 512 ||
      record.snapshotDigest !== hash(Buffer.from(canonicalJson(record.snapshot), 'utf8'))) {
    throw new Error('DLC watchtower snapshot or evaluation is malformed');
  }
  if ((record.evaluation.halt && (!record.alert || record.alert.code !== record.evaluation.status ||
      record.alert.severity !== 'critical')) || (!record.evaluation.halt && record.alert !== null)) {
    throw new Error('DLC watchtower alert does not match its evaluation');
  }
  const der = publicKeyDer(publicKey);
  const keyId = hash(der);
  if (record.watchtowerKeyId !== keyId || (expected.watchtowerKeyId && expected.watchtowerKeyId !== keyId) ||
      (expected.watchtowerId && record.watchtowerId !== expected.watchtowerId) ||
      (expected.contractId && record.contractId !== expected.contractId) ||
      record.recordDigest !== recordDigest(record) || record.recordHash !== recordHash(record)) {
    throw new Error('DLC watchtower observation commitment mismatch');
  }
  let signature;
  try {
    signature = Buffer.from(record.signature, 'base64');
  } catch (_error) {
    throw new Error('DLC watchtower signature is malformed');
  }
  if (signature.length !== 64 || signature.toString('base64') !== record.signature ||
      !crypto.verify(null, Buffer.from(record.recordDigest, 'hex'), asPublicKey(publicKey), signature)) {
    throw new Error('DLC watchtower observation signature is invalid');
  }
  return true;
}

class DlcWatchtowerJournal {
  constructor(baseDirectory, { watchtowerId, publicKey, privateKey = null }) {
    if (typeof baseDirectory !== 'string' || baseDirectory.length === 0) throw new Error('baseDirectory is required');
    requireId(watchtowerId, 'watchtowerId');
    if (!publicKey && !privateKey) throw new Error('watchtower public key is required');
    const derivedPublicKey = privateKey ? crypto.createPublicKey(privateKey) : null;
    const effectivePublicKey = publicKey || derivedPublicKey;
    const der = publicKeyDer(effectivePublicKey);
    if (derivedPublicKey && !publicKeyDer(derivedPublicKey).equals(der)) throw new Error('watchtower key pair does not match');
    this.baseDirectory = path.resolve(baseDirectory);
    this.watchtowerId = watchtowerId;
    this.publicKey = asPublicKey(effectivePublicKey);
    this.privateKey = privateKey;
    this.watchtowerKeyId = hash(der);
    fs.mkdirSync(this.baseDirectory, { recursive: true, mode: 0o700 });
  }

  _directory(contractId) { return path.join(this.baseDirectory, contractKey(contractId)); }
  _files(contractId) {
    const directory = this._directory(contractId);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter((name) => /^observation-[0-9]{12}\.json$/.test(name)).sort();
  }
  _withLock(contractId, run) {
    const lock = path.join(this.baseDirectory, `.${contractKey(contractId)}.lock`);
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error(`DLC watchtower journal lock is held for ${contractId}`);
      throw error;
    }
    try { return run(); }
    finally { fs.rmSync(lock, { recursive: true, force: true }); }
  }
  _write(record) {
    const directory = this._directory(record.contractId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = `observation-${String(record.sequence).padStart(12, '0')}.json`;
    const finalPath = path.join(directory, name);
    if (fs.existsSync(finalPath)) throw new Error(`DLC watchtower observation ${record.sequence} already exists`);
    const temporaryPath = path.join(directory, `.${name}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    const fd = fs.openSync(temporaryPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try { fs.renameSync(temporaryPath, finalPath); }
    catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch (_cleanupError) {}
      throw error;
    }
  }

  verifyChain(contractId) {
    requireId(contractId, 'contractId');
    const files = this._files(contractId);
    let previous = null;
    const records = [];
    for (let sequence = 0; sequence < files.length; sequence++) {
      const record = JSON.parse(fs.readFileSync(path.join(this._directory(contractId), files[sequence]), 'utf8'));
      validateObservationRecord(record, this.publicKey, {
        watchtowerId: this.watchtowerId,
        watchtowerKeyId: this.watchtowerKeyId,
        contractId
      });
      if (record.sequence !== sequence || record.previousRecordHash !== (previous ? previous.recordHash : null)) {
        throw new Error('DLC watchtower observation chain is not contiguous');
      }
      if (previous && (record.network !== previous.network || record.contractDigest !== previous.contractDigest ||
          record.transactionValidationDigest !== previous.transactionValidationDigest ||
          record.contractRevision < previous.contractRevision)) {
        throw new Error('DLC watchtower contract binding regressed');
      }
      previous = record;
      records.push(Object.freeze(record));
    }
    return Object.freeze({
      ok: true,
      observations: files.length,
      latest: previous,
      records: Object.freeze(records)
    });
  }

  appendObservation({ contractState, transactionSet, snapshot, minConfirmations = 6 }) {
    if (!this.privateKey) throw new Error('watchtower journal is verification-only');
    validateDlcContract(contractState);
    validateDlcTransactionSetCommitments(transactionSet);
    return this._withLock(contractState.contractId, () => {
      const chain = this.verifyChain(contractState.contractId);
      const previous = chain.latest;
      const normalizedSnapshot = normalize(snapshot);
      const evaluation = normalize(evaluateDlcChainSnapshot({
        contractState,
        transactionSet,
        current: normalizedSnapshot,
        previous: previous ? previous.snapshot : null,
        minConfirmations
      }));
      const snapshotDigest = hash(Buffer.from(canonicalJson(normalizedSnapshot), 'utf8'));
      if (previous && previous.snapshotDigest === snapshotDigest &&
          previous.contractStateRecordHash === contractState.recordHash) return previous;
      const unsigned = {
        kind: KIND,
        network: contractState.network,
        watchtowerId: this.watchtowerId,
        watchtowerKeyId: this.watchtowerKeyId,
        contractKey: contractKey(contractState.contractId),
        contractId: contractState.contractId,
        contractDigest: contractState.contractDigest,
        contractStateRecordHash: requireHash(contractState.recordHash, 'contractState.recordHash'),
        contractRevision: contractState.revision,
        transactionValidationDigest: requireHash(transactionSet.validationDigest, 'transactionSet.validationDigest'),
        sequence: chain.observations,
        previousRecordHash: previous ? previous.recordHash : null,
        snapshot: normalizedSnapshot,
        snapshotDigest,
        evaluation,
        alert: evaluation.halt ? { code: evaluation.status, severity: 'critical' } : null
      };
      const digest = recordDigest(unsigned);
      const signed = { ...unsigned, recordDigest: digest };
      signed.signature = crypto.sign(null, Buffer.from(digest, 'hex'), this.privateKey).toString('base64');
      const record = Object.freeze({ ...signed, recordHash: recordHash(signed) });
      validateObservationRecord(record, this.publicKey, { watchtowerId: this.watchtowerId, contractId: contractState.contractId });
      this._write(record);
      return record;
    });
  }

  alerts(contractId) {
    const chain = this.verifyChain(contractId);
    return Object.freeze(chain.records.filter((record) => record.alert !== null).map((record) => Object.freeze({
      contractId: record.contractId,
      sequence: record.sequence,
      recordHash: record.recordHash,
      code: record.alert.code,
      severity: record.alert.severity
    })));
  }
}

module.exports = { KIND, DlcWatchtowerJournal, contractKey, validateObservationRecord };
