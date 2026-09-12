'use strict';

const crypto = require('crypto');
const { canonicalJson } = require('./dlc_contract_state');

const KIND = 'utxoref_dlc_journal_checkpoint_v1';
const STORE_KINDS = Object.freeze([
  'contract-state',
  'oracle-event',
  'peer-session',
  'watchtower'
]);
const CHECKPOINT_FIELDS = Object.freeze([
  'checkpointHash', 'headRecordHash', 'kind', 'recordCount', 'storeKey', 'storeKind'
]);

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requireHash(value, fieldName) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${fieldName} must be lowercase 32-byte hex`);
  }
  return value;
}

function checkpointHash(checkpoint) {
  const unsigned = { ...checkpoint };
  delete unsigned.checkpointHash;
  return sha256Hex(Buffer.from(canonicalJson(unsigned), 'utf8'));
}

function validateDlcJournalCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint) ||
      JSON.stringify(Object.keys(checkpoint).sort()) !== JSON.stringify(CHECKPOINT_FIELDS) ||
      checkpoint.kind !== KIND || !STORE_KINDS.includes(checkpoint.storeKind) ||
      !Number.isSafeInteger(checkpoint.recordCount) || checkpoint.recordCount < 1) {
    throw new Error('invalid DLC journal checkpoint');
  }
  requireHash(checkpoint.storeKey, 'checkpoint.storeKey');
  requireHash(checkpoint.headRecordHash, 'checkpoint.headRecordHash');
  requireHash(checkpoint.checkpointHash, 'checkpoint.checkpointHash');
  if (checkpoint.checkpointHash !== checkpointHash(checkpoint)) {
    throw new Error('DLC journal checkpoint hash mismatch');
  }
  return true;
}

function createDlcJournalCheckpoint({ storeKind, storeKey, recordCount, headRecordHash }) {
  const unsigned = { kind: KIND, storeKind, storeKey, recordCount, headRecordHash };
  const checkpoint = Object.freeze({ ...unsigned, checkpointHash: checkpointHash(unsigned) });
  validateDlcJournalCheckpoint(checkpoint);
  return checkpoint;
}

function assertDlcJournalCheckpoint(expected, {
  storeKind,
  storeKey,
  currentRecordCount,
  recordHashAtCheckpoint
}) {
  validateDlcJournalCheckpoint(expected);
  if (expected.storeKind !== storeKind || expected.storeKey !== storeKey) {
    throw new Error('DLC journal checkpoint belongs to a different store');
  }
  if (!Number.isSafeInteger(currentRecordCount) || currentRecordCount < 0) {
    throw new Error('current journal record count is invalid');
  }
  if (currentRecordCount < expected.recordCount) {
    throw new Error('DLC journal rollback detected below the pinned checkpoint');
  }
  requireHash(recordHashAtCheckpoint, 'recordHashAtCheckpoint');
  if (recordHashAtCheckpoint !== expected.headRecordHash) {
    throw new Error('DLC journal fork detected at the pinned checkpoint');
  }
  return true;
}

module.exports = {
  KIND,
  STORE_KINDS,
  createDlcJournalCheckpoint,
  validateDlcJournalCheckpoint,
  assertDlcJournalCheckpoint
};
