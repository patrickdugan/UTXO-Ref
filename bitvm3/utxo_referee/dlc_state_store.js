'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateDlcContract, transitionDlcContract } = require('./dlc_contract_state');
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

const MAX_REVISION_BYTES = 4194304;

function requireContractId(value) {
  if (typeof value !== 'string' || value === '.' || value === '..' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error('contractId contains unsafe path characters');
  }
  return value;
}

function contractKey(contractId) {
  return crypto.createHash('sha256').update(Buffer.from(requireContractId(contractId), 'utf8')).digest('hex');
}

class DlcStateStore {
  constructor(baseDirectory) {
    if (typeof baseDirectory !== 'string' || baseDirectory.length === 0) throw new Error('baseDirectory is required');
    this.baseDirectory = path.resolve(baseDirectory);
    ensureNonSymlinkDirectory(this.baseDirectory, 'DLC state store');
  }

  _contractDirectory(contractId) {
    return path.join(this.baseDirectory, contractKey(contractId));
  }

  _lockDirectory(contractId) {
    return path.join(this.baseDirectory, `.${contractKey(contractId)}.lock`);
  }

  _withLock(contractId, run) {
    const lockDirectory = this._lockDirectory(contractId);
    const ownerPath = path.join(lockDirectory, 'owner.json');
    try {
      fs.mkdirSync(lockDirectory, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`DLC state store lock is held for ${contractId}`);
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

  _revisionFiles(contractId) {
    const directory = this._contractDirectory(contractId);
    if (!fs.existsSync(directory)) return [];
    assertNonSymlinkDirectory(directory, 'DLC state contract');
    return fs.readdirSync(directory)
      .filter((name) => /^revision-[0-9]{12}\.json$/.test(name))
      .sort();
  }

  _writeRevision(record) {
    validateDlcContract(record);
    const directory = this._contractDirectory(record.contractId);
    ensureNonSymlinkDirectory(directory, 'DLC state contract');
    const name = `revision-${String(record.revision).padStart(12, '0')}.json`;
    try {
      writeJsonAppendOnce(directory, name, record, {
        maxBytes: MAX_REVISION_BYTES,
        label: 'DLC state revision'
      });
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`DLC state revision ${record.revision} already exists`);
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
    const directory = this._contractDirectory(contractId);
    for (let index = 0; index < files.length; index++) {
      if (files[index] !== `revision-${String(index).padStart(12, '0')}.json`) {
        throw new Error('DLC state revision filename sequence is not contiguous');
      }
      const record = readBoundedJson(path.join(directory, files[index]), {
        maxBytes: MAX_REVISION_BYTES,
        label: 'DLC state revision'
      });
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

  checkpoint(contractId) {
    const chain = this.verifyChain(contractId);
    return createDlcJournalCheckpoint({
      storeKind: 'contract-state',
      storeKey: contractKey(contractId),
      recordCount: chain.revisions,
      headRecordHash: chain.latest.recordHash
    });
  }

  verifyCheckpoint(contractId, expectedCheckpoint) {
    expectedCheckpoint = normalizeDlcJournalCheckpoint(expectedCheckpoint);
    const chain = this.verifyChain(contractId);
    let recordHashAtCheckpoint = null;
    if (chain.revisions >= expectedCheckpoint.recordCount) {
      const record = readBoundedJson(path.join(
        this._contractDirectory(contractId),
        `revision-${String(expectedCheckpoint.recordCount - 1).padStart(12, '0')}.json`
      ), { maxBytes: MAX_REVISION_BYTES, label: 'DLC state checkpoint revision' });
      validateDlcContract(record);
      recordHashAtCheckpoint = record.recordHash;
    }
    assertDlcJournalCheckpoint(expectedCheckpoint, {
      storeKind: 'contract-state',
      storeKey: contractKey(contractId),
      currentRecordCount: chain.revisions,
      recordHashAtCheckpoint
    });
    return Object.freeze({ ...chain, checkpointVerified: expectedCheckpoint.checkpointHash });
  }

  verifySignedCheckpoint(contractId, signedCheckpoint, trustedKeys) {
    const signed = verifySignedDlcJournalCheckpoint(signedCheckpoint, trustedKeys);
    return Object.freeze({
      ...this.verifyCheckpoint(contractId, signed.checkpoint),
      checkpointSignerKeyId: signed.signerKeyId
    });
  }
}

module.exports = { MAX_REVISION_BYTES, contractKey, DlcStateStore };
