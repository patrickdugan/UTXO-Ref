'use strict';

const { validateDlcContract } = require('./dlc_contract_state');
const { validateDlcTransactionSetCommitments } = require('./dlc_transaction_validator');
const MAX_MONEY = 2100000000000000n;

function requireHash(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be lowercase hash`);
  return value;
}
function requireDecimal(value, name) {
  if (typeof value !== 'string' || value.length > 16 || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be canonical decimal sats`);
  }
  const amount = BigInt(value);
  if (amount > MAX_MONEY) throw new Error(`${name} exceeds maximum Bitcoin supply`);
  return amount;
}
function result(ok, status, reason, extra = {}) {
  return Object.freeze({ ok, halt: !ok, status, reason, ...extra });
}
function recoveryCandidate(value, name) {
  if (!value || !Number.isSafeInteger(value.vsize) || value.vsize < 1 || value.vsize > 400000 ||
      !Number.isSafeInteger(value.relayPeers) || value.relayPeers < 0 || value.relayPeers > 1024 ||
      typeof value.signalsRbf !== 'boolean') {
    throw new Error(`${name} is malformed`);
  }
  return Object.freeze({
    txid: requireHash(value.txid, `${name}.txid`),
    feeSats: requireDecimal(value.feeSats, `${name}.feeSats`),
    vsize: value.vsize,
    relayPeers: value.relayPeers,
    signalsRbf: value.signalsRbf === true
  });
}

function settlementAnchor(transactionSet, settlementTxid) {
  validateDlcTransactionSetCommitments(transactionSet);
  requireHash(settlementTxid, 'settlementTxid');
  const matches = [...transactionSet.cets, transactionSet.refund].filter((spend) => spend.txid === settlementTxid);
  if (matches.length !== 1) throw new Error('settlement transaction is not uniquely committed by the DLC transaction set');
  const settlement = matches[0];
  if (!Array.isArray(settlement.outputs) || settlement.outputs.length < 1) throw new Error('settlement outputs are malformed');
  const vout = settlement.outputs.length - 1;
  const anchor = settlement.outputs[vout];
  if (anchor.valueSats !== transactionSet.feePolicy.anchorAmountSats ||
      anchor.scriptPubKeyHex !== transactionSet.feePolicy.anchorScriptPubKeyHex) {
    throw new Error('settlement anchor does not match the signed fee policy');
  }
  return Object.freeze({ txid: settlementTxid, vout, outpoint: `${settlementTxid}:${vout}` });
}

function requireSignedTransactionSet(contractState, transactionSet) {
  validateDlcContract(contractState);
  const canonicalTransition = contractState.history.find((entry) => entry.to === 'CANONICAL_CETS_AND_REFUND');
  if (!canonicalTransition) throw new Error('contract state has no signed canonical transaction transition');
  const receiptDigest = (kind) => canonicalTransition.evidence.find((receipt) => receipt.kind === kind)?.digest;
  if (receiptDigest('funding_template') !== transactionSet.fundingTemplateDigest ||
      receiptDigest('cet_set') !== transactionSet.cetSetDigest ||
      receiptDigest('fee_policy') !== transactionSet.feePolicyDigest ||
      receiptDigest('refund_transaction') !== transactionSet.refundTransactionDigest) {
    throw new Error('anchor recovery transaction set does not match signed contract validation receipts');
  }
}

function evaluateDlcAnchorRecovery({
  contractState,
  transactionSet,
  settlementTxid,
  snapshot,
  expectedRecoveryTxids = [],
  incrementalRelayFeeSatPerVb = 1
}) {
  const anchor = settlementAnchor(transactionSet, settlementTxid);
  requireSignedTransactionSet(contractState, transactionSet);
  if (!snapshot || snapshot.anchorOutpoint !== anchor.outpoint || typeof snapshot.anchorPresent !== 'boolean' ||
      typeof snapshot.fullRbf !== 'boolean' ||
      !Array.isArray(expectedRecoveryTxids) || new Set(expectedRecoveryTxids).size !== expectedRecoveryTxids.length ||
      !Number.isSafeInteger(incrementalRelayFeeSatPerVb) || incrementalRelayFeeSatPerVb < 1 ||
      incrementalRelayFeeSatPerVb > 1000) {
    throw new Error('DLC anchor recovery policy or snapshot is malformed');
  }
  const expected = new Set(expectedRecoveryTxids.map((txid, index) => requireHash(txid, `expectedRecoveryTxids[${index}]`)));
  const observedSpend = snapshot.observedSpend === null ? null : recoveryCandidate(snapshot.observedSpend, 'observedSpend');
  const proposedRecovery = snapshot.proposedRecovery === null ? null : recoveryCandidate(snapshot.proposedRecovery, 'proposedRecovery');
  if (snapshot.anchorPresent && observedSpend) throw new Error('anchor cannot be both present and spent');

  const maxFee = requireDecimal(transactionSet.feePolicy.maxRecoveryFeeSats, 'feePolicy.maxRecoveryFeeSats');
  const maxFeerate = transactionSet.feePolicy.maxRecoveryFeerateSatPerVb;
  const minPeers = transactionSet.feePolicy.minRelayPeers;
  if (!Number.isSafeInteger(maxFeerate) || maxFeerate < 1 || !Number.isSafeInteger(minPeers) || minPeers < 1) {
    throw new Error('signed DLC anchor recovery limits are malformed');
  }
  const budgetCheck = (candidate) => {
    if (candidate.feeSats > maxFee || candidate.feeSats > BigInt(maxFeerate) * BigInt(candidate.vsize)) {
      return result(false, 'RECOVERY_BUDGET_HALT', 'recovery transaction exceeds the signed fee budget', {
        txid: candidate.txid,
        maxRecoveryFeeSats: maxFee.toString(),
        maxRecoveryFeerateSatPerVb: maxFeerate
      });
    }
    if (candidate.relayPeers < minPeers) {
      return result(false, 'RECOVERY_PROPAGATION_HALT', 'recovery transaction lacks the signed relay quorum', {
        txid: candidate.txid,
        relayPeers: candidate.relayPeers,
        requiredRelayPeers: minPeers
      });
    }
    return null;
  };

  if (snapshot.anchorPresent) {
    if (!proposedRecovery) return result(true, 'ANCHOR_AVAILABLE', 'committed settlement anchor remains unspent', anchor);
    const rejected = budgetCheck(proposedRecovery);
    return rejected || result(true, 'RECOVERY_READY', 'recovery transaction is inside the signed budget and relay quorum', {
      txid: proposedRecovery.txid,
      anchorOutpoint: anchor.outpoint
    });
  }
  if (!observedSpend) return result(false, 'ANCHOR_MISSING_HALT', 'settlement anchor is absent and no spending transaction was identified');
  if (expected.has(observedSpend.txid)) {
    const rejected = budgetCheck(observedSpend);
    return rejected || result(true, 'RECOVERY_OBSERVED', 'expected anchor recovery transaction reached the relay quorum', {
      txid: observedSpend.txid,
      relayPeers: observedSpend.relayPeers
    });
  }
  if (!proposedRecovery) {
    return result(false, 'FEE_PIN_HALT', 'settlement anchor is occupied by an uncommitted conflicting transaction', {
      pinTxid: observedSpend.txid,
      pinFeeSats: observedSpend.feeSats.toString()
    });
  }
  const rejected = budgetCheck(proposedRecovery);
  if (rejected) return rejected;
  if (!snapshot.fullRbf && !observedSpend.signalsRbf) {
    return result(false, 'FEE_PIN_HALT', 'conflicting anchor spend is not replaceable under the observed node policy', {
      pinTxid: observedSpend.txid,
      recoveryTxid: proposedRecovery.txid
    });
  }
  const minimumReplacementFee = observedSpend.feeSats + BigInt(incrementalRelayFeeSatPerVb * proposedRecovery.vsize) + 1n;
  if (proposedRecovery.feeSats < minimumReplacementFee) {
    return result(false, 'FEE_PIN_HALT', 'proposed recovery does not pay the conflicting fee plus incremental relay delta', {
      pinTxid: observedSpend.txid,
      recoveryTxid: proposedRecovery.txid,
      minimumReplacementFeeSats: minimumReplacementFee.toString()
    });
  }
  return result(true, 'FEE_PIN_RESCUE_READY', 'recovery clears the signed budget and observed replacement-policy fee delta', {
    pinTxid: observedSpend.txid,
    recoveryTxid: proposedRecovery.txid,
    minimumReplacementFeeSats: minimumReplacementFee.toString()
  });
}

module.exports = { settlementAnchor, evaluateDlcAnchorRecovery };
