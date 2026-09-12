'use strict';

const crypto = require('crypto');
const { types: utilTypes } = require('util');
const { canonicalJson } = require('./dlc_contract_state');

const KIND = 'utxoref_dlc_journal_checkpoint_v1';
const STORE_KINDS = Object.freeze([
  'contract-state',
  'oracle-event',
  'peer-session',
  'signing-authorization',
  'refund-recovery',
  'broadcast-authorization',
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

function normalizeDlcJournalCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object' || utilTypes.isProxy(checkpoint) || Array.isArray(checkpoint) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(checkpoint))) {
    throw new Error('invalid DLC journal checkpoint');
  }
  const descriptors = Object.getOwnPropertyDescriptors(checkpoint);
  if (JSON.stringify(Object.keys(descriptors).sort()) !== JSON.stringify(CHECKPOINT_FIELDS) ||
      Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) {
    throw new Error('DLC journal checkpoint must contain only plain data properties');
  }
  const normalized = Object.freeze(Object.fromEntries(
    CHECKPOINT_FIELDS.map((field) => [field, descriptors[field].value])
  ));
  if (
      normalized.kind !== KIND || !STORE_KINDS.includes(normalized.storeKind) ||
      !Number.isSafeInteger(normalized.recordCount) || normalized.recordCount < 1) {
    throw new Error('invalid DLC journal checkpoint');
  }
  requireHash(normalized.storeKey, 'checkpoint.storeKey');
  requireHash(normalized.headRecordHash, 'checkpoint.headRecordHash');
  requireHash(normalized.checkpointHash, 'checkpoint.checkpointHash');
  if (normalized.checkpointHash !== checkpointHash(normalized)) {
    throw new Error('DLC journal checkpoint hash mismatch');
  }
  return normalized;
}

function validateDlcJournalCheckpoint(checkpoint) {
  normalizeDlcJournalCheckpoint(checkpoint);
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
  const normalized = normalizeDlcJournalCheckpoint(expected);
  if (normalized.storeKind !== storeKind || normalized.storeKey !== storeKey) {
    throw new Error('DLC journal checkpoint belongs to a different store');
  }
  if (!Number.isSafeInteger(currentRecordCount) || currentRecordCount < 0) {
    throw new Error('current journal record count is invalid');
  }
  if (currentRecordCount < normalized.recordCount) {
    throw new Error('DLC journal rollback detected below the pinned checkpoint');
  }
  requireHash(recordHashAtCheckpoint, 'recordHashAtCheckpoint');
  if (recordHashAtCheckpoint !== normalized.headRecordHash) {
    throw new Error('DLC journal fork detected at the pinned checkpoint');
  }
  return true;
}

module.exports = {
  KIND,
  STORE_KINDS,
  createDlcJournalCheckpoint,
  normalizeDlcJournalCheckpoint,
  validateDlcJournalCheckpoint,
  assertDlcJournalCheckpoint
};
