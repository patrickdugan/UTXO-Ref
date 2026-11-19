'use strict';

/**
 * Offline Bitcoin transaction construction for the LNMarkets prototype.
 *
 * The research signing entry point uses UTXORef's JavaScript reference
 * signer with caller-supplied fixture keys. It accepts bitcoin-regtest plans
 * and an explicit acknowledgement. No function opens a socket, funds an
 * output, broadcasts a transaction, or authorizes the existing funded lane.
 *
 * Recovery packages contain public announcements, adaptor presignatures and
 * a fully signed refund. Completing a CET needs two oracle attestations;
 * it needs neither the venue nor either party's private key at that time.
 * Verification checks bytes and signatures. Bitcoin Core policy, chain
 * state, timelock maturity and independent oracle operation remain separate.
 */

const crypto = require('node:crypto');
const core = '../../bitvm3/utxo_referee/';
const { canonicalize, canonicalJson } = require(`${core}dlc_canonical_json`);
const { buildDlcFundingOutput, dlcFundingFields } = require(`${core}dlc_funding_output`);
const { serializeUnsignedTx, outpoint } = require(`${core}tradelayer_taproot`);
const { validateDlcTransactionSet } = require(`${core}dlc_transaction_validator`);
const {
  cetIdentity,
  validateCetAdaptorSignatures,
  validateRefundSignature,
  settlementSighashForTransactionSet,
  assembleSignedSettlement,
  verifySettlementWitness
} = require(`${core}dlc_signature_validator`);
const {
  xOnlyPubkey, adaptorSign, adaptorComplete, schnorrSign, N
} = require(`${core}tradelayer_dlc_adaptor_sig`);
const { normalizeOracleAnnouncements } = require(`${core}dlc_signing_target`);
const {
  validateOracleSet, buildThresholdOutcomeSets, combineThresholdAttestations
} = require(`${core}dlc_threshold_oracle`);
const { validateContractPlan } = require('./contract');

const SETTLEMENT_KIND = 'lnmarkets_offline_settlement_package_v1';
const SIGNATURE_KIND = 'lnmarkets_research_party_signatures_v1';
const RECOVERY_KIND = 'lnmarkets_offline_recovery_package_v1';
const RECOVERY_FEE_CAP_SATS = 10000n;
const RECOVERY_FEERATE_CAP = 50;
const CACHE_LIMIT = 8;
const settlementCache = new Map();
const pointCache = new Map();
const partyCache = new Map();
const recoveryCache = new Map();

// Only verified public values enter these bounded caches. Keys hash the
// entire fresh immutable snapshot under an explicit versioned domain;
// caller-provided digest fields alone never select a cached result. Pins
// are checked before a recovery cache lookup. No private scalar is cached.
function cacheKey(domain, value) { return digest({ domain: `${domain}:v1`, value }); }
function remember(cache, key, value) {
  if (cache.size >= CACHE_LIMIT && !cache.has(key)) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function requireHex32(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be lowercase 32-byte hex`);
  }
  return value;
}

function normalizedPlan(input) {
  const plan = canonicalize(input, 'LNMarkets contract plan');
  validateContractPlan(plan);
  if (plan.terms.network !== 'bitcoin-regtest') {
    throw new Error('offline settlement prototype accepts bitcoin-regtest only');
  }
  return plan;
}

function pinnedPlan(plan, expectedPlanId) {
  requireHex32(expectedPlanId, 'expectedPlanId');
  if (plan.planDigest !== expectedPlanId) {
    throw new Error('recovery package differs from the independently pinned plan digest');
  }
}

function normalizedOutpoint(input) {
  const value = canonicalize(input, 'fundingOutpoint');
  if (Object.keys(value).sort().join(',') !== 'txid,vout' ||
      !Number.isSafeInteger(value.vout) || value.vout < 0 || value.vout > 0xffffffff) {
    throw new Error('fundingOutpoint must contain a txid and a uint32 vout');
  }
  requireHex32(value.txid, 'fundingOutpoint.txid');
  return value;
}

function boundAnnouncements(plan, input) {
  const announcements = normalizeOracleAnnouncements(input);
  const terms = plan.terms;
  const policy = validateOracleSet(announcements, terms.oracleThreshold, terms.oraclePubkeys);
  if (policy.eventId !== terms.oracleEventId ||
      canonicalJson(policy.outcomeMessages) !== canonicalJson(plan.outcomes.map((row) => row.outcomeMessage))) {
    throw new Error('oracle announcements do not commit to this plan event and ordered outcomes');
  }
  return announcements;
}

function thresholdPoints(plan, announcements) {
  const key = cacheKey('lnmarkets-threshold-points', { plan, announcements });
  if (pointCache.has(key)) return pointCache.get(key);
  const points = plan.outcomes.flatMap((row) => buildThresholdOutcomeSets({
    announcements,
    threshold: plan.terms.oracleThreshold,
    pinnedPubkeys: plan.terms.oraclePubkeys,
    outcomeMsg32: Buffer.from(row.outcomeMessage, 'hex')
  }).map((subset) => Object.freeze({ outcomeMessage: row.outcomeMessage, ...subset })));
  return remember(pointCache, key, Object.freeze(points));
}

function outputsFor(plan, row) {
  return [
    { valueSats: BigInt(row.traderPayoutSats), scriptPubKeyHex: plan.terms.traderPayoutScript },
    { valueSats: BigInt(row.makerPayoutSats), scriptPubKeyHex: plan.terms.makerPayoutScript },
    { valueSats: BigInt(plan.terms.anchorSats), scriptPubKeyHex: plan.terms.anchorScript }
  ];
}

/** Build actual unsigned Bitcoin CET/refund bytes for one fixed outpoint. */
function buildSettlementPackage({ plan: inputPlan, oracleAnnouncements, fundingOutpoint }) {
  const plan = normalizedPlan(inputPlan);
  const announcements = boundAnnouncements(plan, oracleAnnouncements);
  const point = normalizedOutpoint(fundingOutpoint);
  const terms = plan.terms;
  const output = buildDlcFundingOutput({
    partyPubkeyXs: [terms.traderPubkeyX, terms.makerPubkeyX].sort(),
    refundCsvBlocks: terms.refundCsvBlocks
  });
  const funding = {
    ...point,
    valueSats: BigInt(plan.fundingValueSats),
    ...dlcFundingFields(output)
  };
  const serialize = (outputs, locktime, sequence) => serializeUnsignedTx(2,
    [{ outpoint: outpoint(point.txid, point.vout), sequence }],
    outputs.map((item) => ({ valueSats: item.valueSats, script: item.scriptPubKeyHex })),
    locktime
  );
  const points = thresholdPoints(plan, announcements);
  const rows = new Map(plan.outcomes.map((row) => [row.outcomeMessage, row]));
  const cets = points.map((subset, index) => {
    const outputs = outputsFor(plan, rows.get(subset.outcomeMessage));
    // The core validator requires unique txids, including for oracle subsets
    // that pay the same outcome. All sequences disable BIP68, keep nLockTime
    // active and signal replacement. No payout depends on the subset.
    const sequence = 0xfffffffd - index;
    return {
      outcomeMessage: subset.outcomeMessage,
      oraclePubkeys: [...subset.oraclePubkeys],
      rawTxHex: serialize(outputs, terms.maturityHeight, sequence),
      expectedOutputs: outputs,
      locktime: terms.maturityHeight
    };
  });
  const refundOutputs = outputsFor(plan, plan.refund);
  const transactionSet = validateDlcTransactionSet({
    funding,
    cets,
    refund: {
      rawTxHex: serialize(refundOutputs, terms.refundHeight, terms.refundCsvBlocks),
      expectedOutputs: refundOutputs,
      locktime: terms.refundHeight
    },
    minFeeSats: BigInt(terms.settlementFeeSats),
    maxFeeSats: BigInt(terms.settlementFeeSats),
    feePolicy: {
      strategy: 'cpfp-anchor-v1',
      anchorAmountSats: BigInt(terms.anchorSats),
      anchorScriptPubKeyHex: terms.anchorScript,
      maxRecoveryFeeSats: RECOVERY_FEE_CAP_SATS,
      maxRecoveryFeerateSatPerVb: RECOVERY_FEERATE_CAP,
      minRelayPeers: 2
    }
  });
  const unsigned = {
    kind: SETTLEMENT_KIND,
    evidenceTier: 'LOCAL_SIMULATION',
    fundedExecutionAllowed: false,
    plan,
    oracleAnnouncements: announcements,
    fundingOutpoint: point,
    transactionSet
  };
  const value = canonicalize({ ...unsigned, packageDigest: digest(unsigned) });
  return remember(settlementCache, cacheKey('lnmarkets-settlement-package', value), value);
}

// Rebuilding matters: a self-consistent unkeyed digest is not authorization
// to change the payout, funding outpoint, oracle event, or Bitcoin script.
function verifySettlementPackage(input) {
  const value = canonicalize(input, 'offline settlement package');
  if (value.kind !== SETTLEMENT_KIND) throw new Error('invalid settlement package kind');
  const key = cacheKey('lnmarkets-settlement-package', value);
  if (settlementCache.has(key)) return settlementCache.get(key);
  const rebuilt = buildSettlementPackage({
    plan: value.plan,
    oracleAnnouncements: value.oracleAnnouncements,
    fundingOutpoint: value.fundingOutpoint
  });
  if (canonicalJson(value) !== canonicalJson(rebuilt)) {
    throw new Error('settlement package does not match transactions rebuilt from its committed plan');
  }
  return remember(settlementCache, key, rebuilt);
}

/** Fixture-only signing, using a caller-owned disposable key. */
function createResearchPartySignatures({ settlementPackage, partySecret, acknowledgeResearchCrypto }) {
  if (acknowledgeResearchCrypto !== true) {
    throw new Error('acknowledgeResearchCrypto: true is required for reference signing with disposable fixture keys');
  }
  const packageValue = verifySettlementPackage(settlementPackage);
  const { transactionSet, plan, oracleAnnouncements } = packageValue;
  const signerPubkeyX = xOnlyPubkey(partySecret).toString('hex');
  if (!transactionSet.funding.partyPubkeyXs.includes(signerPubkeyX)) {
    throw new Error('research signing key is not a party to the committed contract');
  }
  const points = new Map(thresholdPoints(plan, oracleAnnouncements).map((entry) => [
    `${entry.outcomeMessage}:${entry.oraclePubkeys.join(':')}`, entry.outcomePoint
  ]));
  const cetSignatures = transactionSet.cets.map((cet) => ({
    identity: cetIdentity(cet),
    signerPubkeyX,
    presignature: adaptorSign(partySecret, settlementSighashForTransactionSet({
      transactionSet, executionType: 'cet', cetTxid: cet.txid
    }), points.get(`${cet.outcomeMessage}:${cet.oraclePubkeys.join(':')}`))
  }));
  const refundSignature = schnorrSign(partySecret, settlementSighashForTransactionSet({
    transactionSet, executionType: 'refund'
  })).toString('hex');
  const bundle = canonicalize({
    kind: SIGNATURE_KIND,
    packageDigest: packageValue.packageDigest,
    signerPubkeyX,
    cetSignatures,
    refundSignature
  });
  validatePartySignatures(packageValue, bundle);
  return bundle;
}

function validatePartySignatures(packageValue, input) {
  const bundle = canonicalize(input, 'research party signature bundle');
  const fields = ['kind', 'packageDigest', 'signerPubkeyX', 'cetSignatures', 'refundSignature'].sort();
  if (Object.keys(bundle).sort().join(',') !== fields.join(',') ||
      bundle.kind !== SIGNATURE_KIND || bundle.packageDigest !== packageValue.packageDigest) {
    throw new Error('party signature bundle does not bind this settlement package');
  }
  if (!Array.isArray(bundle.cetSignatures) || bundle.cetSignatures.some((entry) =>
    !entry || typeof entry !== 'object' ||
    Object.keys(entry).sort().join(',') !== 'identity,presignature,signerPubkeyX')) {
    throw new Error('CET signature entries must contain only identity, presignature and signerPubkeyX');
  }
  const key = cacheKey('lnmarkets-party-signatures', { packageValue, bundle });
  if (partyCache.has(key)) return partyCache.get(key);
  const { transactionSet, plan, oracleAnnouncements } = packageValue;
  const funding = { ...transactionSet.funding, valueSats: BigInt(transactionSet.funding.valueSats) };
  validateCetAdaptorSignatures({
    transactionSet, funding, signerPubkeyX: bundle.signerPubkeyX,
    signatures: bundle.cetSignatures,
    thresholdOutcomeSets: thresholdPoints(plan, oracleAnnouncements)
  });
  validateRefundSignature({
    transactionSet, funding, signerPubkeyX: bundle.signerPubkeyX,
    signature: bundle.refundSignature
  });
  return remember(partyCache, key, bundle);
}

/** Verify both parties' complete signature sets and assemble the refund. */
function finalizeRecoveryPackage({ settlementPackage, partySignatures }) {
  const packageValue = verifySettlementPackage(settlementPackage);
  if (!Array.isArray(partySignatures) || partySignatures.length !== 2) {
    throw new Error('recovery requires signature bundles from both parties');
  }
  const parties = partySignatures.map((bundle) => validatePartySignatures(packageValue, bundle))
    .sort((left, right) => left.signerPubkeyX.localeCompare(right.signerPubkeyX));
  if (parties[0].signerPubkeyX === parties[1].signerPubkeyX ||
      canonicalJson(parties.map((party) => party.signerPubkeyX)) !==
        canonicalJson(packageValue.transactionSet.funding.partyPubkeyXs)) {
    throw new Error('recovery requires one distinct signature bundle from each committed party');
  }
  const signedRefundTxHex = assembleSignedSettlement({
    transactionSet: packageValue.transactionSet,
    executionType: 'refund',
    signatures: Object.fromEntries(parties.map((party) => [party.signerPubkeyX, party.refundSignature]))
  });
  const unsigned = {
    kind: RECOVERY_KIND,
    evidenceTier: 'LOCAL_SIMULATION',
    fundedExecutionAllowed: false,
    settlementPackage: packageValue,
    partySignatures: parties,
    signedRefundTxHex
  };
  const value = canonicalize({ ...unsigned, recoveryDigest: digest(unsigned) });
  return remember(recoveryCache, cacheKey('lnmarkets-recovery-package', value), value);
}

/**
 * Preserve both pins outside the package before funding. expectedPlanId is
 * plan.planDigest; expectedRecoveryDigest additionally fixes the outpoint,
 * oracle nonces, exact signature shares and signed refund bytes.
 */
function verifyRecoveryPackage(input, { expectedPlanId, expectedRecoveryDigest }) {
  const value = canonicalize(input, 'offline recovery package');
  if (value.kind !== RECOVERY_KIND) throw new Error('invalid recovery package kind');
  pinnedPlan(value.settlementPackage.plan, expectedPlanId);
  requireHex32(expectedRecoveryDigest, 'expectedRecoveryDigest');
  if (value.recoveryDigest !== expectedRecoveryDigest) {
    throw new Error('recovery package differs from the independently pinned recovery digest');
  }
  const key = cacheKey('lnmarkets-recovery-package', value);
  if (recoveryCache.has(key)) return recoveryCache.get(key);
  const rebuilt = finalizeRecoveryPackage({
    settlementPackage: value.settlementPackage,
    partySignatures: value.partySignatures
  });
  if (canonicalJson(value) !== canonicalJson(rebuilt)) {
    throw new Error('recovery package bytes or digest differ from the verified signature package');
  }
  return remember(recoveryCache, key, rebuilt);
}

/** Complete a CET from the saved public package and exactly two attestations. */
function completeSettlement({ recoveryPackage, expectedPlanId, expectedRecoveryDigest, outcomeId, attestations }) {
  const recovery = verifyRecoveryPackage(recoveryPackage, { expectedPlanId, expectedRecoveryDigest });
  const { transactionSet, plan, oracleAnnouncements } = recovery.settlementPackage;
  requireHex32(outcomeId, 'outcomeId');
  if (!plan.outcomes.some((row) => row.outcomeMessage === outcomeId)) {
    throw new Error('selected outcome is outside the committed payoff table');
  }
  const entries = canonicalize(attestations, 'oracle attestations');
  if (!Array.isArray(entries) || entries.length !== plan.terms.oracleThreshold) {
    throw new Error('exactly two distinct pinned oracle attestations are required');
  }
  const normalized = entries.map((entry) => {
    if (Object.keys(entry).sort().join(',') !== 'oraclePubkeyX,scalarHex') {
      throw new Error('attestation must contain oraclePubkeyX and scalarHex');
    }
    requireHex32(entry.oraclePubkeyX, 'oraclePubkeyX');
    requireHex32(entry.scalarHex, 'scalarHex');
    const scalar = BigInt(`0x${entry.scalarHex}`);
    if (scalar === 0n || scalar >= N) throw new Error('attestation scalar is outside the curve range');
    return { ...entry, scalar };
  }).sort((left, right) => left.oraclePubkeyX.localeCompare(right.oraclePubkeyX));
  const oraclePubkeys = normalized.map((entry) => entry.oraclePubkeyX);
  const combined = combineThresholdAttestations({
    announcements: oracleAnnouncements,
    threshold: plan.terms.oracleThreshold,
    pinnedPubkeys: plan.terms.oraclePubkeys,
    outcomeMsg32: Buffer.from(outcomeId, 'hex'),
    attestations: normalized.map((entry) => entry.scalar),
    oraclePubkeys
  });
  const cet = transactionSet.cets.find((entry) => entry.outcomeMessage === outcomeId &&
    canonicalJson(entry.oraclePubkeys) === canonicalJson(oraclePubkeys));
  if (!cet) throw new Error('oracle subset has no committed CET');
  const signatures = Object.fromEntries(recovery.partySignatures.map((party) => {
    const entry = party.cetSignatures.find((signature) => signature.identity === cetIdentity(cet));
    if (!entry) throw new Error('recovery package lacks the selected party presignature');
    return [party.signerPubkeyX, adaptorComplete(entry.presignature, combined.scalar).toString('hex')];
  }));
  const rawTxHex = assembleSignedSettlement({
    transactionSet, executionType: 'cet', cetTxid: cet.txid, signatures
  });
  const parsed = verifySettlementWitness({
    transactionSet, executionType: 'cet', cetTxid: cet.txid, signedTxHex: rawTxHex
  });
  return canonicalize({
    executionType: 'cet',
    evidenceTier: 'LOCAL_SIMULATION',
    fundedExecutionAllowed: false,
    planDigest: plan.planDigest,
    outcomeId,
    oraclePubkeys,
    txid: parsed.txid,
    wtxid: parsed.wtxid,
    rawTxHex,
    outputs: cet.outputs,
    feeSats: cet.feeSats,
    maturityHeight: cet.locktime,
    chainMaturityVerified: false
  });
}

/** Return the already signed refund; this performs no maturity or RPC check. */
function getRefundTransaction({ recoveryPackage, expectedPlanId, expectedRecoveryDigest }) {
  const recovery = verifyRecoveryPackage(recoveryPackage, { expectedPlanId, expectedRecoveryDigest });
  const { transactionSet, plan } = recovery.settlementPackage;
  const parsed = verifySettlementWitness({
    transactionSet, executionType: 'refund', signedTxHex: recovery.signedRefundTxHex
  });
  return canonicalize({
    executionType: 'refund',
    evidenceTier: 'LOCAL_SIMULATION',
    fundedExecutionAllowed: false,
    planDigest: plan.planDigest,
    txid: parsed.txid,
    wtxid: parsed.wtxid,
    rawTxHex: recovery.signedRefundTxHex,
    outputs: transactionSet.refund.outputs,
    feeSats: transactionSet.refund.feeSats,
    refundHeight: transactionSet.refund.locktime,
    refundCsvBlocks: transactionSet.funding.refundCsvBlocks,
    chainMaturityVerified: false
  });
}

module.exports = {
  SETTLEMENT_KIND,
  SIGNATURE_KIND,
  RECOVERY_KIND,
  RECOVERY_FEE_CAP_SATS,
  RECOVERY_FEERATE_CAP,
  buildSettlementPackage,
  verifySettlementPackage,
  createResearchPartySignatures,
  finalizeRecoveryPackage,
  verifyRecoveryPackage,
  completeSettlement,
  getRefundTransaction
};
