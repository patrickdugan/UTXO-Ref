'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  xOnlyPubkey,
  buildDlcOracle,
  verifyDlcOracleAnnouncement,
  dlcAttest,
  sealDlcOracleSignerState,
  restoreDlcOracleSignerState,
  bytes32
} = require('./tradelayer_dlc_adaptor_sig');
const { canonicalJson } = require('./dlc_contract_state');
const {
  assertNonSymlinkDirectory,
  ensureNonSymlinkDirectory,
  readBoundedJson,
  writeJsonAppendOnce
} = require('./dlc_durable_json_store');

const KIND = 'utxoref_dlc_oracle_event_record_v1';
const MAX_RECORD_BYTES = 1048576;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function eventKey(oraclePubkey, eventId) {
  if (typeof oraclePubkey !== 'string' || !/^[0-9a-f]{64}$/.test(oraclePubkey)) {
    throw new Error('oraclePubkey must be lowercase 32-byte hex');
  }
  if (typeof eventId !== 'string' || Buffer.byteLength(eventId, 'utf8') < 1 || Buffer.byteLength(eventId, 'utf8') > 256) {
    throw new Error('eventId must be 1..256 UTF-8 bytes');
  }
  return sha256Hex(Buffer.concat([
    Buffer.from(oraclePubkey, 'hex'),
    Buffer.from(eventId, 'utf8')
  ]));
}

function recordHash(record) {
  const copy = { ...record };
  delete copy.recordHash;
  return sha256Hex(canonicalJson(copy));
}

function validateRecord(record) {
  if (!record || record.kind !== KIND || !['bitcoin-regtest', 'bitcoin-testnet4'].includes(record.network) ||
      !Number.isSafeInteger(record.revision) || record.revision < 0 ||
      typeof record.previousRecordHash !== (record.revision === 0 ? 'object' : 'string') ||
      (record.revision === 0 ? record.previousRecordHash !== null : !/^[0-9a-f]{64}$/.test(record.previousRecordHash)) ||
      typeof record.recordHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.recordHash) ||
      (record.lastAttestedOutcome !== null &&
        (typeof record.lastAttestedOutcome !== 'string' || !/^[0-9a-f]{64}$/.test(record.lastAttestedOutcome)))) {
    throw new Error('invalid oracle event record');
  }
  const key = eventKey(record.oraclePubkey, record.eventId);
  if (record.eventKey !== key || !record.announcement || record.announcement.px !== record.oraclePubkey ||
      record.announcement.eventId !== record.eventId || !verifyDlcOracleAnnouncement(record.announcement)) {
    throw new Error('oracle event record announcement mismatch');
  }
  if (record.lastAttestedOutcome !== null && !record.announcement.outcomeMessages.includes(record.lastAttestedOutcome)) {
    throw new Error('oracle event record outcome was not announced');
  }
  if (!record.sealedSignerState || record.sealedSignerState.kind !== 'tradelayer_dlc_oracle_signer_sealed_v1') {
    throw new Error('oracle event record has no sealed signer state');
  }
  if (recordHash(record) !== record.recordHash) throw new Error('oracle event record hash mismatch');
  return true;
}

class DlcOracleEventStore {
  constructor({ baseDirectory, wrappingKey, network }) {
    if (!['bitcoin-regtest', 'bitcoin-testnet4'].includes(network)) {
      throw new Error('oracle event store is restricted to Bitcoin regtest and testnet4');
    }
    if (!Buffer.isBuffer(wrappingKey) || wrappingKey.length !== 32) {
      throw new Error('oracle event store requires a 32-byte wrapping key');
    }
    if (typeof baseDirectory !== 'string' || baseDirectory.length === 0) throw new Error('baseDirectory is required');
    this.baseDirectory = path.resolve(baseDirectory);
    this.wrappingKey = Buffer.from(wrappingKey);
    this.network = network;
    this.closed = false;
    ensureNonSymlinkDirectory(this.baseDirectory, 'DLC oracle event store');
  }

  _requireOpen() {
    if (this.closed) throw new Error('oracle event store is closed');
  }

  _directory(key) { return path.join(this.baseDirectory, key); }
  _lockDirectory(key) { return path.join(this.baseDirectory, `.${key}.lock`); }

  _withLock(key, run) {
    this._requireOpen();
    const lockDirectory = this._lockDirectory(key);
    const ownerPath = path.join(lockDirectory, 'owner.json');
    try {
      fs.mkdirSync(lockDirectory, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`oracle event store lock is held for ${key}`);
      throw error;
    }
    try {
      fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      try { fs.unlinkSync(ownerPath); } catch (_cleanupError) {}
      try { fs.rmdirSync(lockDirectory); } catch (_cleanupError) {}
      throw error;
    }
    try {
      return run();
    } finally {
      try { fs.unlinkSync(ownerPath); } finally { fs.rmdirSync(lockDirectory); }
    }
  }

  _files(key) {
    const directory = this._directory(key);
    if (!fs.existsSync(directory)) return [];
    assertNonSymlinkDirectory(directory, 'DLC oracle event');
    return fs.readdirSync(directory).filter((name) => /^revision-[0-9]{12}\.json$/.test(name)).sort();
  }

  _write(record) {
    validateRecord(record);
    const directory = this._directory(record.eventKey);
    ensureNonSymlinkDirectory(directory, 'DLC oracle event');
    const name = `revision-${String(record.revision).padStart(12, '0')}.json`;
    try {
      writeJsonAppendOnce(directory, name, record, {
        maxBytes: MAX_RECORD_BYTES,
        label: 'DLC oracle event record'
      });
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`oracle event revision ${record.revision} already exists`);
      throw error;
    }
  }

  _readLatestByKey(key) {
    const files = this._files(key);
    if (files.length === 0) throw new Error('oracle event does not exist');
    let previous = null;
    const directory = this._directory(key);
    for (let index = 0; index < files.length; index++) {
      const record = readBoundedJson(path.join(directory, files[index]), {
        maxBytes: MAX_RECORD_BYTES,
        label: 'DLC oracle event record'
      });
      validateRecord(record);
      if (record.revision !== index || (previous && record.previousRecordHash !== previous.recordHash)) {
        throw new Error('oracle event revision chain is not contiguous');
      }
      previous = record;
    }
    return previous;
  }

  createEvent({ oracleSecret, nonceSeed, eventId, outcomeMessages }) {
    this._requireOpen();
    const oraclePubkey = xOnlyPubkey(oracleSecret).toString('hex');
    const key = eventKey(oraclePubkey, eventId);
    return this._withLock(key, () => {
      if (this._files(key).length !== 0) throw new Error('oracle event already exists');
      const announcement = buildDlcOracle(oracleSecret, nonceSeed, { eventId, outcomeMessages });
      const unsigned = {
        kind: KIND,
        network: this.network,
        eventKey: key,
        oraclePubkey,
        eventId,
        revision: 0,
        previousRecordHash: null,
        lastAttestedOutcome: null,
        announcement,
        sealedSignerState: sealDlcOracleSignerState(announcement, this.wrappingKey)
      };
      const record = Object.freeze({ ...unsigned, recordHash: recordHash(unsigned) });
      this._write(record);
      return record.announcement;
    });
  }

  getAnnouncement({ oraclePubkey, eventId }) {
    this._requireOpen();
    return this._readLatestByKey(eventKey(oraclePubkey, eventId)).announcement;
  }

  attest({ oraclePubkey, eventId, outcomeMsg32 }) {
    this._requireOpen();
    if (!Buffer.isBuffer(outcomeMsg32) || outcomeMsg32.length !== 32) throw new Error('outcomeMsg32 must be 32 bytes');
    const key = eventKey(oraclePubkey, eventId);
    return this._withLock(key, () => {
      const current = this._readLatestByKey(key);
      const restored = restoreDlcOracleSignerState(current.announcement, current.sealedSignerState, this.wrappingKey);
      const outcomeHex = outcomeMsg32.toString('hex');
      const attestation = dlcAttest(restored, outcomeMsg32);
      if (current.lastAttestedOutcome === outcomeHex) return attestation;
      const unsigned = {
        ...current,
        revision: current.revision + 1,
        previousRecordHash: current.recordHash,
        lastAttestedOutcome: outcomeHex,
        announcement: restored,
        sealedSignerState: sealDlcOracleSignerState(restored, this.wrappingKey)
      };
      delete unsigned.recordHash;
      const next = Object.freeze({ ...unsigned, recordHash: recordHash(unsigned) });
      this._write(next);
      return attestation;
    });
  }

  verifyChain({ oraclePubkey, eventId }) {
    this._requireOpen();
    const key = eventKey(oraclePubkey, eventId);
    const files = this._files(key);
    if (files.length === 0) throw new Error('oracle event does not exist');
    let previous = null;
    const directory = this._directory(key);
    for (let index = 0; index < files.length; index++) {
      const record = readBoundedJson(path.join(directory, files[index]), {
        maxBytes: MAX_RECORD_BYTES,
        label: 'DLC oracle event record'
      });
      validateRecord(record);
      if (record.revision !== index || (previous && record.previousRecordHash !== previous.recordHash)) {
        throw new Error('oracle event revision chain is not contiguous');
      }
      previous = record;
    }
    return { ok: true, revisions: files.length, latestRecordHash: previous.recordHash };
  }

  close() {
    if (!this.closed) this.wrappingKey.fill(0);
    this.closed = true;
  }
}

module.exports = { KIND, MAX_RECORD_BYTES, eventKey, validateRecord, DlcOracleEventStore };
