/**
 * Milestone 1 Challenge Witness Assembly
 *
 * Converts an emitted m1_challenge_bundle artifact into concrete witness inputs
 * for the transition circuit and the surrounding honest/challenged path payloads.
 */

const { toTransitionWitness } = require('./m1_transition_circuit');

const VALID_ROUTES = new Set(['flat', 'pnl', 'settle-loss', 'settle-gain', 'roll']);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function toBigIntStrict(value, field) {
  if (value === null || value === undefined || value === '') {
    throw new Error(`Missing ${field}`);
  }
  return BigInt(value);
}

function normalizeRoute(pathId) {
  const route = String(pathId || '').trim();
  if (!VALID_ROUTES.has(route)) {
    throw new Error(`Unsupported challenge route: ${pathId}`);
  }
  return route;
}

function buildTransitionStateFromChallengeBundle(challengeBundle, overrides = {}) {
  assert(challengeBundle && typeof challengeBundle === 'object', 'challengeBundle is required');
  assert(challengeBundle.binding, 'challengeBundle.binding is required');
  assert(challengeBundle.selectedPath, 'challengeBundle.selectedPath is required');

  const route = normalizeRoute(challengeBundle.selectedPathId || challengeBundle.selectedPath.pathId);
  const fundingOutpoint = challengeBundle.binding.fundingOutpoint || {};
  const selectedPath = challengeBundle.selectedPath || {};

  const collateralSats = overrides.collateralSats !== undefined
    ? BigInt(overrides.collateralSats)
    : toBigIntStrict(fundingOutpoint.valueSats, 'binding.fundingOutpoint.valueSats');
  const dustCarrySats = overrides.dustCarrySats !== undefined
    ? BigInt(overrides.dustCarrySats)
    : BigInt(selectedPath.dustCarrySats ?? challengeBundle.binding.dustCarrySats ?? 0n);
  const actualPayoutSats = overrides.actualPayoutSats !== undefined
    ? BigInt(overrides.actualPayoutSats)
    : BigInt(selectedPath.payoutSats ?? 0n);
  const refundSats = overrides.refundSats !== undefined
    ? BigInt(overrides.refundSats)
    : BigInt(selectedPath.residualSats ?? selectedPath.rolloverCollateralSats ?? 0n);
  const rolloverCollateralSats = overrides.rolloverCollateralSats !== undefined
    ? BigInt(overrides.rolloverCollateralSats)
    : BigInt(selectedPath.rolloverCollateralSats ?? selectedPath.residualSats ?? 0n);
  const feeSats = overrides.feeSats !== undefined
    ? BigInt(overrides.feeSats)
    : BigInt(selectedPath.feeSats ?? 0n);

  return {
    epochId: BigInt(overrides.epochId ?? 0n),
    collateralSats,
    pnlPayoutBps: BigInt(overrides.pnlPayoutBps ?? selectedPath.effectivePnlBps ?? 0n),
    bucketCapBps: BigInt(overrides.bucketCapBps ?? selectedPath.bucketCapBps ?? 0n),
    realizedPnlBps: BigInt(overrides.realizedPnlBps ?? selectedPath.realizedPnlBps ?? 0n),
    effectivePnlBps: BigInt(overrides.effectivePnlBps ?? selectedPath.effectivePnlBps ?? 0n),
    feeBps: BigInt(overrides.feeBps ?? selectedPath.feeBps ?? 0n),
    payoutSats: actualPayoutSats,
    actualPayoutSats,
    feeSats,
    residualSats: refundSats,
    refundSats,
    rolloverCollateralSats,
    dustCarrySats,
    challengeWindowStart: BigInt(overrides.challengeWindowStart ?? 0n),
    challengeWindowLength: BigInt(overrides.challengeWindowLength ?? 0n),
    challengeWindowEnd: BigInt(overrides.challengeWindowEnd ?? 0n)
  };
}

function buildChallengeWitnessBundle(params) {
  const {
    challengeBundle,
    tallyMap,
    claimAccountId,
    oracleSignature,
    cetPreimageOrSig,
    commitmentPackage,
    conflictingSweepData,
    merkleMembershipProofs,
    capResidualChecks,
    transitionState = {}
  } = params || {};

  assert(challengeBundle, 'challengeBundle is required');

  const route = normalizeRoute(challengeBundle.selectedPathId || challengeBundle.selectedPath?.pathId);
  const state = {
    ...buildTransitionStateFromChallengeBundle(challengeBundle, transitionState),
    tallyMap,
    claimAccountId
  };
  const transitionWitness = toTransitionWitness(state, route);

  const requiresOracle = route !== 'roll';
  const messageDigestHex = challengeBundle.oracleBinding?.messageDigestHex || null;
  const messagePayload = challengeBundle.oracleBinding?.messagePayload || null;
  const resolvedOracleSignature = oracleSignature || challengeBundle.oracleBinding?.oracleSignaturePlaceholder || null;
  const resolvedCetPreimageOrSig = cetPreimageOrSig || challengeBundle.selectedPath?.rawTxHex || null;

  if (requiresOracle) {
    assert(messageDigestHex, 'oracle message digest is required for settlement challenge witnesses');
    assert(resolvedOracleSignature, 'oracle signature is required for settlement challenge witnesses');
    assert(resolvedCetPreimageOrSig, 'cetPreimageOrSig is required for settlement challenge witnesses');
  }

  const honestPath = {
    commitmentPackage: commitmentPackage || null,
    selectedPathId: route,
    oracleSignature: resolvedOracleSignature,
    cetPreimageOrSig: resolvedCetPreimageOrSig,
    oracleMessageDigestHex: messageDigestHex,
    oracleMessagePayload: messagePayload
  };

  const challengedPath = {
    conflictingSweepData: conflictingSweepData || null,
    attestationDigest: messageDigestHex,
    oracleSignature: resolvedOracleSignature,
    merkleMembershipProofs: merkleMembershipProofs || null,
    capResidualChecks: capResidualChecks || {
      payoutSats: challengeBundle.selectedPath?.payoutSats ?? null,
      residualSats: challengeBundle.selectedPath?.residualSats ?? null,
      rolloverCollateralSats: challengeBundle.selectedPath?.rolloverCollateralSats ?? null,
      dustCarrySats: challengeBundle.selectedPath?.dustCarrySats ?? challengeBundle.binding?.dustCarrySats ?? null
    }
  };

  return {
    route,
    requiresOracle,
    transitionState: state,
    transitionWitness,
    honestPath,
    challengedPath
  };
}

module.exports = {
  VALID_ROUTES,
  normalizeRoute,
  buildTransitionStateFromChallengeBundle,
  buildChallengeWitnessBundle
};
