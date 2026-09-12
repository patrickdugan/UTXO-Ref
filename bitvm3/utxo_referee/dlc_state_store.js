'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateDlcContract, transitionDlcContract } = require('./dlc_contract_state');

function requireContractId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error('contractId contains unsafe path characters');
  }
  return value;
}

class DlcStateStore {
  constructor(baseDirectory) {
    if (typeof baseDirectory !== 'string' || baseDirectory.length === 0) throw new Error('baseDirectory is required');
    this.baseDirectory = path.resolve(baseDirectory);
    fs.mkdirSync(this.baseDirectory, { recursive: true, mode: 0o700 });
  }

  _contractDirectory(contractId) {
    return path.join(this.baseDirectory, requireContractId(contractId));
  }

  _lockDirectory(contractId) {
    return path.join(this.baseDirectory, `.${requireContractId(contractId)}.lock`);
  }

  _withLock(contractId, run) {
    const lockDirectory = this._lockDirectory(contractId);
    try {
      fs.mkdirSync(lockDirectory, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`DLC state store lock is held for ${contractId}`);
      throw error;
    }
    try {
      fs.writeFileSync(path.join(lockDirectory, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      fs.rmSync(lockDirectory, { recursive: true, force: true });
      throw error;
    }
    try {
      return run();
    } finally {
      fs.rmSync(lockDirectory, { recursive: true, force: true });
    }
  }

  _revisionFiles(contractId) {
    const directory = this._contractDirectory(contractId);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter((name) => /^revision-[0-9]{12}\.json$/.test(name))
      .sort();
  }

  _writeRevision(record) {
    validateDlcContract(record);
    const directory = this._contractDirectory(record.contractId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = `revision-${String(record.revision).padStart(12, '0')}.json`;
    const finalPath = path.join(directory, name);
    if (fs.existsSync(finalPath)) throw new Error(`DLC state revision ${record.revision} already exists`);
    const tempPath = path.join(directory, `.${name}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    const fd = fs.openSync(tempPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tempPath, finalPath);
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch (_cleanupError) {}
      throw error;
    }
  }

  create(record) {
    validateDlcContract(record);
    return this._withLock(record.contractId, () => {
      if (this._revisionFiles(record.contractId).length !== 0) throw new Error('DLC contract already exists');
      this._writeRevision(record);
      return record;
    });
  }

  read(contractId) {
    return this.verifyChain(contractId).latest;
  }

  transition(contractId, expectedRevision, request) {
    requireContractId(contractId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('expectedRevision must be non-negative');
    return this._withLock(contractId, () => {
      const current = this.read(contractId);
      const next = transitionDlcContract(current, request);
      if (next === current) return current;
      if (current.revision !== expectedRevision) {
        throw new Error(`stale DLC state revision: expected ${expectedRevision}, current ${current.revision}`);
      }
      this._writeRevision(next);
      return next;
    });
  }

  verifyChain(contractId) {
    const files = this._revisionFiles(contractId);
    if (files.length === 0) throw new Error(`DLC contract ${contractId} does not exist`);
    let previous = null;
    for (let index = 0; index < files.length; index++) {
      const record = JSON.parse(fs.readFileSync(path.join(this._contractDirectory(contractId), files[index]), 'utf8'));
      validateDlcContract(record);
      if (record.revision !== index) throw new Error('DLC state revision file sequence is not contiguous');
      if (previous && (record.history.length !== previous.history.length + 1 ||
          record.history.slice(0, -1).map((entry) => entry.requestHash).join(':') !==
          previous.history.map((entry) => entry.requestHash).join(':'))) {
        throw new Error('DLC state revision history is not append-only');
      }
      previous = record;
    }
    return { ok: true, revisions: files.length, latest: previous };
  }
}

module.exports = { DlcStateStore };
