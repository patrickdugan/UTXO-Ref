'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalize, canonicalJson } = require('./dlc_contract_state');
const {
  assertNonSymlinkDirectory,
  ensureNonSymlinkDirectory,
  readBoundedJson,
  writeJsonAppendOnce
} = require('./dlc_durable_json_store');
const {
  createDlcJournalCheckpoint,
  normalizeDlcJournalCheckpoint,
  assertDlcJournalCheckpoint,
  verifySignedDlcJournalCheckpoint
} = require('./dlc_journal_checkpoint');

const KIND = 'utxoref_dlc_signing_authorization_consumption_v1';
const MAX_RECORD_BYTES = 32768;
const LIVE_AUTHORIZATION_STORES = new WeakSet();

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requireHash(value, fieldName) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${fieldName} must be lowercase 32-byte hex`);
  }
  return value;
}

function requireId(value, fieldName) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error(`${fieldName} must contain 1..128 safe identifier characters`);
  }
  return value;
}

function consumptionKey(contractId, authorizationId) {
  requireId(contractId, 'contractId');
  requireId(authorizationId, 'authorizationId');
  return sha256Hex(Buffer.from(`${contractId}:${authorizationId}`, 'utf8'));
}

function recordHash(record) {
  const unsigned = { ...canonicalize(record, 'DLC signing authorization record') };
  delete unsigned.recordHash;
  return sha256Hex(Buffer.from(canonicalJson(unsigned), 'utf8'));
}

function validateConsumptionRecord(record) {
  if (!record || record.kind !== KIND ||
      !['bitcoin-regtest', 'bitcoin-testnet4'].includes(record.network) ||
      record.status !== 'CONSUMED_BEFORE_SIGN' ||
      record.consumptionKey !== consumptionKey(record.contractId, record.authorizationId) ||
      typeof record.consumedAt !== 'string' || !Number.isFinite(Date.parse(record.consumedAt)) ||
      record.consumedByPid !== null && (!Number.isSafeInteger(record.consumedByPid) || record.consumedByPid < 1) ||
      record.recordHash !== recordHash(record)) {
    throw new Error('invalid DLC signing authorization consumption record');
  }
  requireHash(record.stateRecordHash, 'stateRecordHash');
  requireHash(record.authorizationDigest, 'authorizationDigest');
  requireHash(record.providerIdentity, 'providerIdentity');
  return true;
}

class DlcSigningAuthorizationStore {
  constructor(baseDirectory) {
    if (typeof baseDirectory !== 'string' || baseDirectory.length === 0) throw new Error('baseDirectory is required');
    this.baseDirectory = path.resolve(baseDirectory);
    ensureNonSymlinkDirectory(this.baseDirectory, 'DLC signing authorization base');
    LIVE_AUTHORIZATION_STORES.add(this);
    Object.freeze(this);
  }

  _directory(contractId, authorizationId) {
    return path.join(this.baseDirectory, consumptionKey(contractId, authorizationId));
  }

  _readDirectory(directory) {
    assertNonSymlinkDirectory(directory, 'DLC signing authorization consumption marker');
    const recordPath = path.join(directory, 'consumed.json');
    if (!fs.existsSync(recordPath)) {
      throw new Error('DLC signing authorization has an incomplete consumption marker; manual recovery is required');
    }
    const record = readBoundedJson(recordPath, {
      maxBytes: MAX_RECORD_BYTES,
      label: 'DLC signing authorization consumption record'
    });
    validateConsumptionRecord(record);
    if (record.consumptionKey !== path.basename(directory)) {
      throw new Error('DLC signing consumption directory key mismatch');
    }
    return record;
  }

  _writeAtomic(directory, record) {
    writeJsonAppendOnce(directory, 'consumed.json', record, {
      maxBytes: MAX_RECORD_BYTES,
      label: 'DLC signing authorization consumption record'
    });
  }

  consume({ network, contractId, authorizationId, stateRecordHash, authorizationDigest, providerIdentity }) {
    if (!['bitcoin-regtest', 'bitcoin-testnet4'].includes(network)) {
      throw new Error('signing authorization store is restricted to Bitcoin regtest and testnet4');
    }
    const key = consumptionKey(contractId, authorizationId);
    requireHash(stateRecordHash, 'stateRecordHash');
    requireHash(authorizationDigest, 'authorizationDigest');
    requireHash(providerIdentity, 'providerIdentity');
    const directory = this._directory(contractId, authorizationId);
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = this._readDirectory(directory);
      throw new Error(
        existing.authorizationDigest === authorizationDigest
          ? 'DLC adaptor signing authorization was already durably consumed'
          : 'DLC adaptor signing authorization ID conflicts with a different durable request'
      );
    }
    const unsigned = {
      kind: KIND,
      network,
      consumptionKey: key,
      contractId,
      authorizationId,
      stateRecordHash,
      authorizationDigest,
      providerIdentity,
      status: 'CONSUMED_BEFORE_SIGN',
      consumedAt: new Date().toISOString(),
      consumedByPid: Number.isSafeInteger(process.pid) && process.pid > 0 ? process.pid : null
    };
    const record = Object.freeze({ ...unsigned, recordHash: recordHash(unsigned) });
    try {
      this._writeAtomic(directory, record);
    } catch (error) {
      throw new Error(`DLC signing authorization consumption could not be persisted: ${error.message}`);
    }
    return record;
  }

  read(contractId, authorizationId) {
    return this._readDirectory(this._directory(contractId, authorizationId));
  }

  verifyAll() {
    let records = 0;
    for (const name of fs.readdirSync(this.baseDirectory).sort()) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      const directory = path.join(this.baseDirectory, name);
      assertNonSymlinkDirectory(directory, 'DLC signing authorization consumption marker');
      const record = this._readDirectory(directory);
      records++;
    }
    return Object.freeze({ ok: true, records });
  }

  checkpoint(contractId, authorizationId) {
    const record = this.read(contractId, authorizationId);
    return createDlcJournalCheckpoint({
      storeKind: 'signing-authorization',
      storeKey: consumptionKey(contractId, authorizationId),
      recordCount: 1,
      headRecordHash: record.recordHash
    });
  }

  verifyCheckpoint(contractId, authorizationId, expectedCheckpoint) {
    expectedCheckpoint = normalizeDlcJournalCheckpoint(expectedCheckpoint);
    const record = this.read(contractId, authorizationId);
    assertDlcJournalCheckpoint(expectedCheckpoint, {
      storeKind: 'signing-authorization',
      storeKey: consumptionKey(contractId, authorizationId),
      currentRecordCount: 1,
      recordHashAtCheckpoint: record.recordHash
    });
    return Object.freeze({ ok: true, records: 1, checkpointVerified: expectedCheckpoint.checkpointHash });
  }

  verifySignedCheckpoint(contractId, authorizationId, signedCheckpoint, trustedKeys, expectedEnvelopeHash) {
    const signed = verifySignedDlcJournalCheckpoint(signedCheckpoint, trustedKeys, expectedEnvelopeHash);
    return Object.freeze({
      ...this.verifyCheckpoint(contractId, authorizationId, signed.checkpoint),
      checkpointSignerKeyId: signed.signerKeyId
    });
  }
}

function isDlcSigningAuthorizationStore(value) {
  return LIVE_AUTHORIZATION_STORES.has(value) &&
    Object.getPrototypeOf(value) === DlcSigningAuthorizationStore.prototype;
}

module.exports = {
  KIND,
  MAX_RECORD_BYTES,
  consumptionKey,
  recordHash,
  validateConsumptionRecord,
  isDlcSigningAuthorizationStore,
  DlcSigningAuthorizationStore
};
