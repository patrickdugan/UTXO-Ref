'use strict';

// Typed V2 batch envelopes deliberately bypass the historical row-only
// checkpoint normalizer. Verification requires the caller's independent pins.
const crypto = require('crypto');
const { snapshotPlainData, canonicalJson } = require('./dlc_canonical_json');
const { buildPnlSettlementBatch } = require('./tradelayer_pnl_batch_settlement');
const { verifySignedPnlBatchCheckpointV2, verifyAuthenticatedPnlBatchV2 } = require('./utxoref_v2_pnl_batch_checkpoint');
const { buildPnlBatchTransaction, verifyPnlBatchTransaction } = require('./tradelayer_pnl_batch_transaction');

const KIND = 'utxoref_pnl_batch_settlement_v2';
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}
function digest(value) {
  return crypto.createHash('sha256').update(`${KIND}\0${canonicalJson(value)}`).digest('hex');
}
function resultFailure(error) {
  const message = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'message') : null;
  return { ok: false, reason: message && Object.hasOwn(message, 'value') && typeof message.value === 'string'
    ? message.value : 'invalid V2 PnL batch settlement' };
}
function checkPolicy(authenticated, transaction, expectedHash) {
  if (transaction.transactionPolicyHash !== expectedHash
    || authenticated.transactionPolicyHash !== expectedHash) {
    throw new Error('signed and independently pinned transaction policies differ');
  }
}

function buildUtxoRefPnlBatchSettlementV2(input) {
  const args = snapshotPlainData(input, '$.pnlBatchBuild', false);
  exact(args, ['stateEnvelope', 'stateVerification', 'transactionPolicy', 'expectedTransactionPolicyHash'], 'V2 batch build');
  const authenticated = verifySignedPnlBatchCheckpointV2(args.stateEnvelope, args.stateVerification);
  if (!authenticated.ok) throw new Error(`batch checkpoint rejected: ${authenticated.reason}`);
  const batch = buildPnlSettlementBatch(authenticated.snapshot);
  const transaction = buildPnlBatchTransaction({ batch, transactionPolicy: args.transactionPolicy,
    settlementContext: { snapshot: authenticated.snapshot, expectedSnapshotHash: authenticated.snapshotHash } });
  checkPolicy(authenticated, transaction, args.expectedTransactionPolicyHash);
  const core = { kind: KIND, version: 2, stateEnvelope: args.stateEnvelope, batch, transaction };
  return snapshotPlainData({ ...core, settlementHash: digest(core) }, '$.pnlBatchSettlement', false);
}

function verifyUtxoRefPnlBatchSettlementV2(candidate, context) {
  try {
    const settlement = snapshotPlainData(candidate, '$.settlement', false);
    const args = snapshotPlainData(context, '$.pnlBatchVerification', false);
    exact(args, ['stateVerification', 'transactionPolicy', 'expectedTransactionPolicyHash'], 'V2 batch verification');
    exact(settlement, ['kind', 'version', 'stateEnvelope', 'batch', 'transaction', 'settlementHash'], 'V2 batch settlement');
    if (settlement.kind !== KIND || settlement.version !== 2) throw new Error('wrong V2 batch settlement kind or version');
    const authenticated = verifyAuthenticatedPnlBatchV2(settlement.batch, settlement.stateEnvelope, args.stateVerification);
    if (!authenticated.ok) throw new Error(`batch checkpoint/accounting rejected: ${authenticated.reason}`);
    const transaction = verifyPnlBatchTransaction(settlement.transaction, {
      batch: settlement.batch, transactionPolicy: args.transactionPolicy,
      expectedTransactionPolicyHash: args.expectedTransactionPolicyHash,
      settlementContext: { snapshot: authenticated.snapshot, expectedSnapshotHash: authenticated.snapshotHash }
    });
    if (!transaction.ok) throw new Error(`batch transaction rejected: ${transaction.reason}`);
    checkPolicy(authenticated, transaction.transaction, args.expectedTransactionPolicyHash);
    const core = { kind: KIND, version: 2, stateEnvelope: settlement.stateEnvelope,
      batch: settlement.batch, transaction: transaction.transaction };
    if (settlement.settlementHash !== digest(core)) throw new Error('V2 batch settlement hash mismatch');
    return snapshotPlainData({ ok: true, settlement, checkpointHash: authenticated.bodyHash,
      snapshotHash: authenticated.snapshotHash, signerKeyIds: authenticated.signerKeyIds,
      stateAuthenticated: true, transactionBytesVerified: true,
      priorStateOpeningVerified: false, executionVerified: false, zkProofVerified: false }, '$.verifiedSettlement', false);
  } catch (error) { return resultFailure(error); }
}

module.exports = { KIND, buildUtxoRefPnlBatchSettlementV2, verifyUtxoRefPnlBatchSettlementV2 };
