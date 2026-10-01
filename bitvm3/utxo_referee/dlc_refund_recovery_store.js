'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalize, canonicalJson, normalizeDlcContract } = require('./dlc_contract_state');
const { parseCanonicalSignedTaprootTransaction, normalizeDlcTransactionSet } = require('./dlc_transaction_validator');
const { verifySettlementWitness } = require('./dlc_signature_validator');
const {
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

const KIND = 'utxoref_dlc_refund_recovery_record_v1';
const MAX_RECORD_BYTES = 131072;

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

function refundKey(contractId) {
  return sha256Hex(Buffer.from(requireId(contractId, 'contractId'), 'utf8'));
}

function recordHash(record) {
  const unsigned = { ...canonicalize(record, 'DLC refund recovery record') };
  delete unsigned.recordHash;
  return sha256Hex(Buffer.from(canonicalJson(unsigned), 'utf8'));
}

function bindTransactionSet(contractState, transactionSet) {
  contractState = normalizeDlcContract(contractState);
  transactionSet = normalizeDlcTransactionSet(transactionSet);
  const recoveryStages = [
    'COUNTERPARTY_SIGNATURES_VERIFIED', 'LOCAL_SIGNATURES_PERSISTED', 'FUNDING_PSBT_APPROVED',
    'FUNDING_BROADCAST', 'CONFIRMED', 'CET_EXECUTED', 'REFUND_EXECUTED'
  ];
  if (!recoveryStages.includes(contractState.stage)) {
    throw new Error('refund recovery is unavailable before counterparty signatures are verified');
  }
  const transition = contractState.history.find((entry) => entry.to === 'CANONICAL_CETS_AND_REFUND');
  const digest = (kind) => transition?.evidence.find((receipt) => receipt.kind === kind)?.digest;
  if (digest('funding_template') !== transactionSet.fundingTemplateDigest ||
      digest('cet_set') !== transactionSet.cetSetDigest ||
      digest('fee_policy') !== transactionSet.feePolicyDigest ||
      digest('refund_transaction') !== transactionSet.refundTransactionDigest) {
    throw new Error('refund recovery transaction set does not match signed contract receipts');
  }
  return contractState;
}

// The stored refund must be broadcastable as-is: the committed CSV refund leaf
// with a valid signature from both parties. A refund signed by one key (or on
// a key path the funding output does not have) is rejected before persistence.
function verifySignedRefund(transactionSet, signedRefundTxHex) {
  const parsed = parseCanonicalSignedTaprootTransaction(signedRefundTxHex);
  if (parsed.strippedRawTxHex !== transactionSet.refund.rawTxHex || parsed.txid !== transactionSet.refund.txid) {
    throw new Error('signed refund does not match the validated unsigned refund');
  }
  try {
    return verifySettlementWitness({ transactionSet, executionType: 'refund', signedTxHex: signedRefundTxHex });
  } catch (error) {
    throw new Error(`signed refund Taproot script-path witness is invalid: ${error.message}`);
  }
}

function validateRecord(record) {
  if (!record || record.kind !== KIND || !['bitcoin-regtest', 'bitcoin-testnet4'].includes(record.network) ||
      record.refundKey !== refundKey(record.contractId) ||
      typeof record.storedAt !== 'string' || !Number.isFinite(Date.parse(record.storedAt)) ||
      typeof record.signedRefundTxHex !== 'string' || !/^[0-9a-f]+$/.test(record.signedRefundTxHex) ||
      record.recordHash !== recordHash(record)) {
    throw new Error('invalid DLC refund recovery record');
  }
  for (const field of ['contractStateRecordHash', 'contractTranscriptHash', 'transactionSetValidationDigest', 'refundTransactionDigest',
    'refundTxid', 'refundWtxid', 'recordHash']) requireHash(record[field], field);
  return true;
}

class DlcRefundRecoveryStore {
  constructor(baseDirectory) {
    if (typeof baseDirectory !== 'string' || baseDirectory.length === 0) throw new Error('baseDirectory is required');
    this.baseDirectory = path.resolve(baseDirectory);
    ensureNonSymlinkDirectory(this.baseDirectory, 'refund recovery base');
  }

  _directory(contractId) { return path.join(this.baseDirectory, refundKey(contractId)); }

  _read(contractId) {
    const directory = this._directory(contractId);
    const recordPath = path.join(directory, 'refund.json');
    if (!fs.existsSync(recordPath)) {
      throw new Error('DLC refund recovery has an incomplete persistence marker; manual recovery is required');
    }
    const record = readBoundedJson(recordPath, {
      maxBytes: MAX_RECORD_BYTES,
      label: 'refund recovery record'
    });
    validateRecord(record);
    if (record.refundKey !== path.basename(directory)) throw new Error('refund recovery directory key mismatch');
    return record;
  }

  _write(directory, record) {
    writeJsonAppendOnce(directory, 'refund.json', record, {
      maxBytes: MAX_RECORD_BYTES,
      label: 'refund recovery record'
    });
  }

  store({ contractState, transactionSet, signedRefundTxHex }) {
    transactionSet = normalizeDlcTransactionSet(transactionSet);
    contractState = bindTransactionSet(contractState, transactionSet);
    if (contractState.stage !== 'COUNTERPARTY_SIGNATURES_VERIFIED') {
      throw new Error('refund must be stored before local signatures are marked persisted');
    }
    const parsed = verifySignedRefund(transactionSet, signedRefundTxHex);
    const directory = this._directory(contractState.contractId);
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = this._read(contractState.contractId);
      if (existing.contractStateRecordHash === contractState.recordHash &&
          existing.transactionSetValidationDigest === transactionSet.validationDigest &&
          existing.signedRefundTxHex === signedRefundTxHex) return existing;
      throw new Error('DLC refund recovery already contains a conflicting contract artifact');
    }
    const unsigned = {
      kind: KIND,
      network: contractState.network,
      refundKey: refundKey(contractState.contractId),
      contractId: contractState.contractId,
      contractStateRecordHash: contractState.recordHash,
      contractTranscriptHash: contractState.transcriptHash,
      transactionSetValidationDigest: transactionSet.validationDigest,
      refundTransactionDigest: transactionSet.refundTransactionDigest,
      refundTxid: parsed.txid,
      refundWtxid: parsed.wtxid,
      signedRefundTxHex,
      storedAt: new Date().toISOString()
    };
    const record = Object.freeze({ ...unsigned, recordHash: recordHash(unsigned) });
    try { this._write(directory, record); } catch (error) {
      throw new Error(`DLC refund recovery could not be persisted: ${error.message}`);
    }
    return this.restore({ contractState, transactionSet });
  }

  restore({ contractState, transactionSet }) {
    transactionSet = normalizeDlcTransactionSet(transactionSet);
    contractState = bindTransactionSet(contractState, transactionSet);
    const record = this._read(contractState.contractId);
    const counterpartyTransition = contractState.history.find((entry) => entry.to === 'COUNTERPARTY_SIGNATURES_VERIFIED');
    if (!counterpartyTransition || record.contractTranscriptHash !== counterpartyTransition.transcriptHash ||
        record.network !== contractState.network || record.transactionSetValidationDigest !== transactionSet.validationDigest ||
        record.refundTransactionDigest !== transactionSet.refundTransactionDigest) {
      throw new Error('restored refund is not bound to the requested contract state and transaction set');
    }
    if (contractState.stage === 'COUNTERPARTY_SIGNATURES_VERIFIED') {
      if (record.contractStateRecordHash !== contractState.recordHash) {
        throw new Error('restored refund is not bound to the current counterparty-verified state');
      }
    } else {
      const localTransition = contractState.history.find((entry) => entry.to === 'LOCAL_SIGNATURES_PERSISTED');
      const restoreReceipt = localTransition?.evidence.find((receipt) => receipt.kind === 'refund_restore_test');
      if (!restoreReceipt || restoreReceipt.digest !== record.recordHash) {
        throw new Error('restored refund does not match the signed refund-restore receipt digest');
      }
    }
    const parsed = verifySignedRefund(transactionSet, record.signedRefundTxHex);
    if (parsed.txid !== record.refundTxid || parsed.wtxid !== record.refundWtxid) {
      throw new Error('restored refund transaction identity mismatch');
    }
    return Object.freeze({ ...record, restoreDigest: record.recordHash });
  }

  checkpoint(contractId) {
    const record = this._read(contractId);
    return createDlcJournalCheckpoint({
      storeKind: 'refund-recovery',
      storeKey: refundKey(contractId),
      recordCount: 1,
      headRecordHash: record.recordHash
    });
  }

  verifyCheckpoint(contractId, expectedCheckpoint) {
    expectedCheckpoint = normalizeDlcJournalCheckpoint(expectedCheckpoint);
    const record = this._read(contractId);
    assertDlcJournalCheckpoint(expectedCheckpoint, {
      storeKind: 'refund-recovery',
      storeKey: refundKey(contractId),
      currentRecordCount: 1,
      recordHashAtCheckpoint: record.recordHash
    });
    return Object.freeze({ ok: true, records: 1, checkpointVerified: expectedCheckpoint.checkpointHash });
  }

  verifySignedCheckpoint(contractId, signedCheckpoint, trustedKeys, expectedEnvelopeHash) {
    const signed = verifySignedDlcJournalCheckpoint(signedCheckpoint, trustedKeys, expectedEnvelopeHash);
    return Object.freeze({
      ...this.verifyCheckpoint(contractId, signed.checkpoint),
      checkpointSignerKeyId: signed.signerKeyId
    });
  }
}

module.exports = { KIND, refundKey, recordHash, validateRecord, DlcRefundRecoveryStore };
