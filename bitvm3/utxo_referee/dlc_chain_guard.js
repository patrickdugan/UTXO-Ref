'use strict';

const { normalizeDlcContract } = require('./dlc_contract_state');
const { validateDlcTransactionSetCommitments } = require('./dlc_transaction_validator');

function requireHash(value, fieldName) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${fieldName} must be lowercase 32-byte hex`);
  }
  return value;
}

function normalizeSnapshot(snapshot, fieldName) {
  if (!snapshot || !Number.isSafeInteger(snapshot.height) || snapshot.height < 0 ||
      typeof snapshot.fundingPresent !== 'boolean' ||
      !Number.isSafeInteger(snapshot.fundingConfirmations) || snapshot.fundingConfirmations < 0 ||
      snapshot.fundingConfirmations > snapshot.height + 1 ||
      typeof snapshot.fundingOutpoint !== 'string' ||
      !/^[0-9a-f]{64}:[0-9]+$/.test(snapshot.fundingOutpoint)) {
    throw new Error(`${fieldName} is malformed`);
  }
  requireHash(snapshot.bestBlockHash, `${fieldName}.bestBlockHash`);
  const ancestorHashAtPreviousHeight = snapshot.ancestorHashAtPreviousHeight === undefined
    ? null
    : requireHash(snapshot.ancestorHashAtPreviousHeight, `${fieldName}.ancestorHashAtPreviousHeight`);
  if (snapshot.fundingPresent && snapshot.observedSpend !== null) {
    throw new Error(`${fieldName} cannot contain both funding UTXO and its spend`);
  }
  if (!snapshot.fundingPresent && snapshot.fundingConfirmations !== 0) {
    throw new Error(`${fieldName} absent funding must have zero confirmations`);
  }
  let observedSpend = null;
  if (snapshot.observedSpend !== null) {
    if (!snapshot.observedSpend || !Number.isSafeInteger(snapshot.observedSpend.height) ||
        snapshot.observedSpend.height < 0 || snapshot.observedSpend.height > snapshot.height) {
      throw new Error(`${fieldName}.observedSpend is malformed`);
    }
    observedSpend = {
      txid: requireHash(snapshot.observedSpend.txid, `${fieldName}.observedSpend.txid`),
      height: snapshot.observedSpend.height
    };
  }
  return {
    height: snapshot.height,
    bestBlockHash: snapshot.bestBlockHash,
    ancestorHashAtPreviousHeight,
    fundingOutpoint: snapshot.fundingOutpoint,
    fundingPresent: snapshot.fundingPresent,
    fundingConfirmations: snapshot.fundingConfirmations,
    observedSpend
  };
}

function result(ok, status, reason, extra = {}) {
  return Object.freeze({ ok, halt: !ok, status, reason, ...extra });
}

function evaluateDlcChainSnapshot({ contractState, transactionSet, current, previous = null, minConfirmations = 6 }) {
  contractState = normalizeDlcContract(contractState);
  if (!transactionSet || !transactionSet.funding || !Array.isArray(transactionSet.cets) || !transactionSet.refund ||
      !Number.isSafeInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 1000) {
    throw new Error('chain guard policy is malformed');
  }
  for (const name of ['fundingTemplateDigest', 'cetSetDigest', 'refundTransactionDigest', 'feePolicyDigest', 'validationDigest']) {
    requireHash(transactionSet[name], `transactionSet.${name}`);
  }
  validateDlcTransactionSetCommitments(transactionSet);
  const canonicalTransition = contractState.history.find((entry) => entry.to === 'CANONICAL_CETS_AND_REFUND');
  if (!canonicalTransition) throw new Error('contract state has no signed canonical transaction transition');
  const receiptDigest = (kind) => canonicalTransition.evidence.find((receipt) => receipt.kind === kind)?.digest;
  if (receiptDigest('funding_template') !== transactionSet.fundingTemplateDigest ||
      receiptDigest('cet_set') !== transactionSet.cetSetDigest ||
      receiptDigest('fee_policy') !== transactionSet.feePolicyDigest ||
      receiptDigest('refund_transaction') !== transactionSet.refundTransactionDigest) {
    throw new Error('transaction set does not match signed contract validation receipts');
  }
  const fundingOutpoint = `${requireHash(transactionSet.funding.txid, 'funding txid')}:${transactionSet.funding.vout}`;
  const now = normalizeSnapshot(current, 'current snapshot');
  const before = previous === null ? null : normalizeSnapshot(previous, 'previous snapshot');
  if (now.fundingOutpoint !== fundingOutpoint || (before && before.fundingOutpoint !== fundingOutpoint)) {
    throw new Error('chain snapshot monitors the wrong funding outpoint');
  }
  const reorg = before !== null && (
    now.height < before.height ||
    now.ancestorHashAtPreviousHeight === null ||
    now.ancestorHashAtPreviousHeight !== before.bestBlockHash ||
    (now.fundingPresent && before.fundingPresent && now.fundingConfirmations < before.fundingConfirmations)
  );
  if (reorg) return result(false, 'REORG_HALT', 'chain history or funding confirmations regressed', { reorg: true });

  const cetTxids = new Set(transactionSet.cets.map((cet) => requireHash(cet.txid, 'CET txid')));
  const refundTxid = requireHash(transactionSet.refund.txid, 'refund txid');
  if (now.observedSpend) {
    const { txid, height } = now.observedSpend;
    if (txid === refundTxid) {
      if (!Number.isSafeInteger(transactionSet.refund.locktime) || transactionSet.refund.locktime <= 0 ||
          transactionSet.refund.locktime >= 500000000 || height < transactionSet.refund.locktime ||
          !['CONFIRMED', 'REFUND_EXECUTED'].includes(contractState.stage)) {
        return result(false, 'PREMATURE_REFUND_HALT', 'refund spend is immature or inconsistent with the signed contract stage');
      }
      return result(true, 'REFUND_OBSERVED', 'validated refund transaction observed', { txid, spendHeight: height });
    }
    if (cetTxids.has(txid)) {
      if (!['CONFIRMED', 'CET_EXECUTED'].includes(contractState.stage)) {
        return result(false, 'PREMATURE_CET_HALT', `CET spend observed while contract state is ${contractState.stage}`);
      }
      return result(true, 'CET_OBSERVED', 'validated CET transaction observed', { txid, spendHeight: height });
    }
    return result(false, 'UNKNOWN_SPEND_HALT', 'funding outpoint was spent by an uncommitted transaction', { txid });
  }

  if (!now.fundingPresent) {
    return result(false, 'MISSING_FUNDING_HALT', 'funding outpoint is absent and no committed spend was observed');
  }
  if (now.fundingConfirmations < minConfirmations) {
    return result(true, 'FUNDING_UNCONFIRMED', 'funding is present but below the confirmation threshold', {
      confirmations: now.fundingConfirmations,
      requiredConfirmations: minConfirmations
    });
  }
  return result(true, 'FUNDING_CONFIRMED', 'funding outpoint reached the confirmation threshold', {
    confirmations: now.fundingConfirmations,
    requiredConfirmations: minConfirmations
  });
}

module.exports = { evaluateDlcChainSnapshot };
