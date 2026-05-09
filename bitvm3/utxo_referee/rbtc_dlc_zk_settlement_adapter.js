const fs = require('fs');
const crypto = require('crypto');
const { canonicalStringify } = require('./m1_spec');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value) {
  return sha256Hex(canonicalStringify(value));
}

function loadRbtcDlcZkSettlementBundle(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function buildRbtcDlcBitvmSettlementReceipt(bundle) {
  const verification = verifyRbtcDlcBitvmSettlementReceipt({
    kind: 'utxoref_rbtc_dlc_bitvm_settlement_receipt',
    receiptCore: {
      version: 1,
      protocol: 'utxoref_rbtc_dlc_bitvm_settlement_receipt',
      sourceBundleId: bundle?.bundleId || null,
      tlzkClaimId: bundle?.claim?.claimId || null,
      tlzkReceiptId: bundle?.receipt?.receiptId || null,
      proofType: bundle?.receipt?.receiptCore?.proofType || null,
      tx12TransitionId: bundle?.claim?.claimCore?.publicInputs?.tx12TransitionId || null,
      btcPayoutTxid: bundle?.claim?.claimCore?.publicInputs?.btcPayoutTxid || null,
      expectedPayoutRoot: bundle?.claim?.claimCore?.publicInputs?.expectedPayoutRoot || null,
      observedPayoutRoot: bundle?.claim?.claimCore?.publicInputs?.observedPayoutRoot || null,
      escrowManifestId: bundle?.claim?.claimCore?.publicInputs?.escrowManifestId || null,
      selectedEscrowPath: bundle?.claim?.claimCore?.publicInputs?.selectedEscrowPath || null,
      bitvmAction: 'authorize_dlc_escrow_release_if_roots_match'
    },
    sourceBundle: bundle
  });
  const receiptCore = verification.receiptCore;
  return {
    kind: 'utxoref_rbtc_dlc_bitvm_settlement_receipt',
    receiptId: hashCanonical(receiptCore),
    receiptCore,
    sourceBundle: bundle,
    verification: {
      ok: verification.ok,
      reason: verification.reason || null
    }
  };
}

function verifyRbtcDlcBitvmSettlementReceipt(receipt) {
  if (!receipt || receipt.kind !== 'utxoref_rbtc_dlc_bitvm_settlement_receipt') {
    return { ok: false, reason: 'wrong rBTC DLC BitVM receipt kind' };
  }
  const core = receipt.receiptCore || {};
  if (!core.sourceBundleId || !core.tlzkClaimId || !core.tlzkReceiptId) {
    return { ok: false, reason: 'missing TLZK proof identifiers', receiptCore: core };
  }
  if (core.expectedPayoutRoot !== core.observedPayoutRoot) {
    return { ok: false, reason: 'DLC payout root mismatch', receiptCore: core };
  }
  const bundle = receipt.sourceBundle;
  if (bundle) {
    if (bundle.bundleId !== core.sourceBundleId) return { ok: false, reason: 'source bundle id mismatch' };
    if (bundle.claim?.claimId !== core.tlzkClaimId) return { ok: false, reason: 'source claim id mismatch' };
    if (bundle.receipt?.receiptId !== core.tlzkReceiptId) return { ok: false, reason: 'source receipt id mismatch' };
    if (bundle.receipt?.receiptCore?.ok !== true) return { ok: false, reason: 'TLZK receipt is not ok' };
  }
  if (receipt.receiptId && receipt.receiptId !== hashCanonical(core)) {
    return { ok: false, reason: 'receipt id mismatch', receiptCore: core };
  }
  return { ok: true, receiptCore: core };
}

function buildRbtcDlcBitvmChallenge(receipt, options = {}) {
  const core = receipt.receiptCore || {};
  const observedPayoutRoot = options.observedPayoutRoot || sha256Hex(`wrong:${core.tlzkClaimId}`);
  const challengeCore = {
    version: 1,
    protocol: 'utxoref_rbtc_dlc_bitvm_settlement_challenge',
    tlzkClaimId: core.tlzkClaimId,
    expectedPayoutRoot: core.expectedPayoutRoot,
    observedPayoutRoot,
    violation: observedPayoutRoot === core.expectedPayoutRoot ? 'none' : 'wrong_payout_root'
  };
  return {
    kind: 'utxoref_rbtc_dlc_bitvm_settlement_challenge',
    challengeId: hashCanonical(challengeCore),
    challengeCore,
    slashable: challengeCore.violation !== 'none'
  };
}

module.exports = {
  loadRbtcDlcZkSettlementBundle,
  buildRbtcDlcBitvmSettlementReceipt,
  verifyRbtcDlcBitvmSettlementReceipt,
  buildRbtcDlcBitvmChallenge
};
