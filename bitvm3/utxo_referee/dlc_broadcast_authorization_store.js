'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalize, canonicalJson, transitionDlcContract, normalizeDlcContract } = require('./dlc_contract_state');
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

const KIND = 'utxoref_dlc_broadcast_authorization_consumption_v1';
const MAX_RECORD_BYTES = 32768;
const MAX_RAW_TRANSACTION_BYTES = 400000;
const MAX_FUTURE_CLOCK_SKEW_SECONDS = 5;

function sha256Hex(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

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

function authorizationKey(contractId, idempotencyKey, requestHash) {
  requireId(contractId, 'contractId');
  requireId(idempotencyKey, 'idempotencyKey');
  requireHash(requestHash, 'requestHash');
  return sha256Hex(Buffer.from(`${contractId}:${idempotencyKey}:${requestHash}`, 'utf8'));
}

function recordHash(record) {
  const unsigned = { ...canonicalize(record, 'DLC broadcast authorization record') };
  delete unsigned.recordHash;
  return sha256Hex(Buffer.from(canonicalJson(unsigned), 'utf8'));
}

function validateRecord(record) {
  if (!record || record.kind !== KIND || !['bitcoin-regtest', 'bitcoin-testnet4'].includes(record.network) ||
      record.status !== 'CONSUMED_BEFORE_BROADCAST' ||
      record.authorizationKey !== authorizationKey(record.contractId, record.transitionIdempotencyKey,
        record.transitionRequestHash) ||
      !['FUNDING_PSBT_APPROVED', 'CONFIRMED'].includes(record.fromStage) ||
      !['FUNDING_BROADCAST', 'CET_EXECUTED', 'REFUND_EXECUTED'].includes(record.toStage) ||
      !((record.fromStage === 'FUNDING_PSBT_APPROVED' && record.toStage === 'FUNDING_BROADCAST') ||
        (record.fromStage === 'CONFIRMED' && ['CET_EXECUTED', 'REFUND_EXECUTED'].includes(record.toStage))) ||
      !Number.isSafeInteger(record.issuedAtUnixSeconds) || record.issuedAtUnixSeconds < 0 ||
      !Number.isSafeInteger(record.expiresAtUnixSeconds) || record.expiresAtUnixSeconds <= record.issuedAtUnixSeconds ||
      record.expiresAtUnixSeconds - record.issuedAtUnixSeconds > 30 ||
      !Number.isSafeInteger(record.consumedAtUnixSeconds) ||
      record.consumedAtUnixSeconds < record.issuedAtUnixSeconds - MAX_FUTURE_CLOCK_SKEW_SECONDS ||
      record.consumedAtUnixSeconds > record.expiresAtUnixSeconds ||
      record.consumedByPid !== null && (!Number.isSafeInteger(record.consumedByPid) || record.consumedByPid < 1) ||
      record.recordHash !== recordHash(record)) {
    throw new Error('invalid DLC broadcast authorization consumption record');
  }
  for (const field of [
    'fromRecordHash', 'toRecordHash', 'contractTranscriptHash', 'transitionRequestHash', 'policyReceiptDigest',
    'rawTransactionSha256', 'txid', 'wtxid', 'recordHash'
  ]) requireHash(record[field], field);
  requireHash(record.chainTip, 'chainTip');
  if (!Number.isSafeInteger(record.chainHeight) || record.chainHeight < 0 ||
      !Number.isSafeInteger(record.mempoolSequence) || record.mempoolSequence < 0) {
    throw new Error('invalid DLC broadcast authorization chain observation');
  }
  requireId(record.policyReceiptKind, 'policyReceiptKind');
  return true;
}

function targetKinds(target) {
  if (target === 'FUNDING_BROADCAST') {
    return Object.freeze({ broadcast: 'broadcast_transaction', policy: 'prebroadcast_bitcoin_core_policy' });
  }
  if (target === 'CET_EXECUTED') {
    return Object.freeze({ broadcast: 'cet_broadcast_transaction', policy: 'cet_prebroadcast_bitcoin_core_policy' });
  }
  if (target === 'REFUND_EXECUTED') {
    return Object.freeze({ broadcast: 'refund_broadcast_transaction', policy: 'refund_prebroadcast_bitcoin_core_policy' });
  }
  throw new Error('broadcast authorization target is unsupported');
}

function unixSeconds(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('now must be a valid Date');
  return Math.floor(now.getTime() / 1000);
}

class DlcBroadcastAuthorizationStore {
  constructor(baseDirectory) {
    if (typeof baseDirectory !== 'string' || baseDirectory.length === 0) throw new Error('baseDirectory is required');
    this.baseDirectory = path.resolve(baseDirectory);
    ensureNonSymlinkDirectory(this.baseDirectory, 'broadcast authorization base');
  }

  _directory(key) { return path.join(this.baseDirectory, key); }

  _read(key) {
    const directory = this._directory(key);
    assertNonSymlinkDirectory(directory, 'broadcast authorization marker');
    const recordPath = path.join(directory, 'consumed.json');
    if (!fs.existsSync(recordPath)) {
      throw new Error('DLC broadcast authorization has an incomplete consumption marker; manual recovery is required');
    }
    const record = readBoundedJson(recordPath, {
      maxBytes: MAX_RECORD_BYTES,
      label: 'broadcast authorization record'
    });
    validateRecord(record);
    if (record.authorizationKey !== key) throw new Error('broadcast authorization directory key mismatch');
    return record;
  }

  _write(directory, record) {
    writeJsonAppendOnce(directory, 'consumed.json', record, {
      maxBytes: MAX_RECORD_BYTES,
      label: 'broadcast authorization record'
    });
  }

  consume({ contractState, transitionRequest, rawTxHex, now = new Date() }) {
    contractState = normalizeDlcContract(contractState);
    if (!transitionRequest || typeof transitionRequest !== 'object') throw new Error('transitionRequest is required');
    const currentUnixSeconds = unixSeconds(now);
    const nextContractState = transitionDlcContract(contractState, transitionRequest);
    const transition = nextContractState.history[nextContractState.history.length - 1];
    if (!transition || transition.from !== contractState.stage || transition.idempotencyKey !== transitionRequest.idempotencyKey) {
      throw new Error('broadcast authorization requires a new transition from the supplied contract state');
    }
    const kinds = targetKinds(transition.to);
    const broadcastReceipt = transition.evidence.find((receipt) => receipt.kind === kinds.broadcast);
    const policyReceipt = transition.evidence.find((receipt) => receipt.kind === kinds.policy);
    const metadata = policyReceipt && policyReceipt.metadata;
    if (!broadcastReceipt || !policyReceipt || !metadata) throw new Error('broadcast transition lacks signed policy evidence');
    if (currentUnixSeconds < metadata.issuedAtUnixSeconds - MAX_FUTURE_CLOCK_SKEW_SECONDS) {
      throw new Error('DLC broadcast authorization is future-dated');
    }
    if (currentUnixSeconds > metadata.expiresAtUnixSeconds) {
      throw new Error('DLC broadcast authorization has expired');
    }
    if (typeof rawTxHex !== 'string' || rawTxHex.length < 20 || (rawTxHex.length & 1) !== 0 ||
        rawTxHex.length > MAX_RAW_TRANSACTION_BYTES * 2 || !/^[0-9a-f]+$/.test(rawTxHex)) {
      throw new Error('broadcast transaction must be bounded canonical lowercase hex');
    }
    const rawTransactionSha256 = sha256Hex(Buffer.from(rawTxHex, 'hex'));
    if (rawTransactionSha256 !== broadcastReceipt.digest || rawTransactionSha256 !== metadata.rawTransactionSha256) {
      throw new Error('broadcast authorization does not match the exact transaction bytes');
    }

    const key = authorizationKey(contractState.contractId, transition.idempotencyKey, transition.requestHash);
    const directory = this._directory(key);
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = this._read(key);
      throw new Error(existing.transitionRequestHash === transition.requestHash
        ? 'DLC broadcast authorization was already durably consumed'
        : 'DLC broadcast authorization conflicts with a different durable request');
    }
    const unsigned = {
      kind: KIND,
      network: contractState.network,
      authorizationKey: key,
      contractId: contractState.contractId,
      transitionIdempotencyKey: transition.idempotencyKey,
      fromStage: transition.from,
      toStage: transition.to,
      fromRecordHash: contractState.recordHash,
      toRecordHash: nextContractState.recordHash,
      contractTranscriptHash: contractState.transcriptHash,
      transitionRequestHash: transition.requestHash,
      policyReceiptKind: policyReceipt.kind,
      policyReceiptDigest: policyReceipt.digest,
      rawTransactionSha256,
      txid: metadata.txid,
      wtxid: metadata.wtxid,
      chainTip: metadata.chainTip,
      chainHeight: metadata.chainHeight,
      mempoolSequence: metadata.mempoolSequence,
      issuedAtUnixSeconds: metadata.issuedAtUnixSeconds,
      expiresAtUnixSeconds: metadata.expiresAtUnixSeconds,
      status: 'CONSUMED_BEFORE_BROADCAST',
      consumedAtUnixSeconds: currentUnixSeconds,
      consumedByPid: Number.isSafeInteger(process.pid) && process.pid > 0 ? process.pid : null
    };
    const record = Object.freeze({ ...unsigned, recordHash: recordHash(unsigned) });
    try { this._write(directory, record); } catch (error) {
      throw new Error(`DLC broadcast authorization consumption could not be persisted: ${error.message}`);
    }
    return Object.freeze({ consumption: this._read(key), nextContractState });
  }

  read(contractId, idempotencyKey, requestHash) {
    return this._read(authorizationKey(contractId, idempotencyKey, requestHash));
  }

  verifyAll() {
    let records = 0;
    for (const name of fs.readdirSync(this.baseDirectory).sort()) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      const record = this._read(name);
      if (record.authorizationKey !== name) throw new Error('broadcast authorization directory key mismatch');
      records++;
    }
    return Object.freeze({ ok: true, records });
  }

  checkpoint(contractId, idempotencyKey, requestHash) {
    const key = authorizationKey(contractId, idempotencyKey, requestHash);
    const record = this._read(key);
    return createDlcJournalCheckpoint({
      storeKind: 'broadcast-authorization',
      storeKey: key,
      recordCount: 1,
      headRecordHash: record.recordHash
    });
  }

  verifyCheckpoint(contractId, idempotencyKey, requestHash, expectedCheckpoint) {
    expectedCheckpoint = normalizeDlcJournalCheckpoint(expectedCheckpoint);
    const key = authorizationKey(contractId, idempotencyKey, requestHash);
    const record = this._read(key);
    assertDlcJournalCheckpoint(expectedCheckpoint, {
      storeKind: 'broadcast-authorization',
      storeKey: key,
      currentRecordCount: 1,
      recordHashAtCheckpoint: record.recordHash
    });
    return Object.freeze({ ok: true, records: 1, checkpointVerified: expectedCheckpoint.checkpointHash });
  }

  verifySignedCheckpoint(contractId, idempotencyKey, requestHash, signedCheckpoint, trustedKeys, expectedEnvelopeHash) {
    const signed = verifySignedDlcJournalCheckpoint(signedCheckpoint, trustedKeys, expectedEnvelopeHash);
    return Object.freeze({
      ...this.verifyCheckpoint(contractId, idempotencyKey, requestHash, signed.checkpoint),
      checkpointSignerKeyId: signed.signerKeyId
    });
  }
}

module.exports = {
  KIND,
  MAX_FUTURE_CLOCK_SKEW_SECONDS,
  authorizationKey,
  recordHash,
  validateRecord,
  DlcBroadcastAuthorizationStore
};
