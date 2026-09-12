'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson } = require('./dlc_contract_state');

const KIND = 'utxoref_dlc_signing_authorization_consumption_v1';

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
  const unsigned = { ...record };
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
    fs.mkdirSync(this.baseDirectory, { recursive: true, mode: 0o700 });
  }

  _directory(contractId, authorizationId) {
    return path.join(this.baseDirectory, consumptionKey(contractId, authorizationId));
  }

  _readDirectory(directory) {
    const recordPath = path.join(directory, 'consumed.json');
    if (!fs.existsSync(recordPath)) {
      throw new Error('DLC signing authorization has an incomplete consumption marker; manual recovery is required');
    }
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    validateConsumptionRecord(record);
    return record;
  }

  _writeAtomic(directory, record) {
    const finalPath = path.join(directory, 'consumed.json');
    const temporaryPath = path.join(
      directory,
      `.consumed.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
    );
    const fd = fs.openSync(temporaryPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temporaryPath, finalPath);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch (_cleanupError) {}
      throw error;
    }
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
      if (!fs.statSync(directory).isDirectory()) continue;
      const record = this._readDirectory(directory);
      if (record.consumptionKey !== name) throw new Error('DLC signing consumption directory key mismatch');
      records++;
    }
    return Object.freeze({ ok: true, records });
  }
}

module.exports = {
  KIND,
  consumptionKey,
  recordHash,
  validateConsumptionRecord,
  DlcSigningAuthorizationStore
};
