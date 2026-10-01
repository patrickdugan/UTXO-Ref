/**
 * End-to-end LN-BTC -> tlUSD -> liquidity patch staking prototype.
 *
 * This composes the earlier primitives into one wallet/operator flow:
 * LN-BTC funds UTXORef, a BTC/USD-backed tlUSD Taproot Asset position is
 * externalized, and that tlUSD position is staked into a liquidity-patching
 * pool whose routing surface is managed by Ark and enforced by BitVM/UTXORef.
 */

const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');
const {
  buildTaprootAssetsStablecoinBundle,
  verifyTaprootAssetsStablecoinBundle
} = require('./lightning_taproot_assets_stablecoin');
const {
  buildArkLiquidityGraftManagerBundle,
  verifyArkLiquidityGraftManagerBundle
} = require('./ark_liquidity_graft_manager');

const HEX_32_RE = /^[0-9a-f]{64}$/i;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value) {
  return sha256Hex(canonicalStringify(value));
}

function normalizeString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeHex32(value, fieldName) {
  const normalized = normalizeString(value, fieldName).toLowerCase();
  if (!HEX_32_RE.test(normalized)) {
    throw new Error(`${fieldName} must be a 32-byte hex string`);
  }
  return normalized;
}

function normalizeUnits(value, fieldName) {
  const normalized = BigInt(value);
  if (normalized < 0n) throw new Error(`${fieldName} must be non-negative`);
  return normalized;
}

function usdUnitsFromBtcSats(btcSats, btcUsdPriceMicros) {
  return (normalizeAmountSats(btcSats, 'btcSats') * normalizeUnits(btcUsdPriceMicros, 'btcUsdPriceMicros')) / 100000000n;
}

function buildLnBtcToTlUsdConversion(options = {}) {
  const htlcProof = options.htlcProof || {};
  const liquidityLease = options.liquidityLease || null;
  const lnbtcSats = normalizeAmountSats(
    options.lnbtcSats || (htlcProof.dlcFunding && htlcProof.dlcFunding.outputAmountSats) || 50000n,
    'lnbtcSats'
  );
  const btcUsdPriceMicros = normalizeUnits(options.btcUsdPriceMicros || 100000000000n, 'btcUsdPriceMicros');
  const tlusdUnits = normalizeUnits(options.tlusdUnits || usdUnitsFromBtcSats(lnbtcSats, btcUsdPriceMicros), 'tlusdUnits');
  const preimageHex = normalizeHex32(
    options.preimageHex ||
      (htlcProof.lightning && (htlcProof.lightning.paymentPreimageHex || htlcProof.lightning.preimageHex)) ||
      sha256Hex('lnbtc-tlusd-preimage'),
    'preimageHex'
  );
  const paymentHashHex = normalizeHex32(
    options.paymentHashHex ||
      (htlcProof.lightning && htlcProof.lightning.paymentHashHex) ||
      sha256Hex(Buffer.from(preimageHex, 'hex')),
    'paymentHashHex'
  );

  const stablecoin = buildTaprootAssetsStablecoinBundle({
    ...options,
    ticker: options.ticker || 'TLUSD',
    issuer: options.issuer || 'tradelayer-utxoref-regtest',
    decimalDisplay: options.decimalDisplay ?? 6,
    amountUnits: tlusdUnits,
    assetAmountUnits: tlusdUnits,
    btcRouteSats: lnbtcSats,
    deliveredBtcSats: options.deliveredBtcSats || lnbtcSats,
    btcUsdPriceMicros: btcUsdPriceMicros.toString(),
    paymentHashHex,
    preimageHex,
    htlcProof,
    liquidityLease,
    maxSpreadPpm: options.maxSpreadPpm ?? 4500,
    quotedSpreadPpm: options.quotedSpreadPpm ?? 1200,
    maxRoutingFeePpm: options.maxRoutingFeePpm ?? 1200,
    quotedRoutingFeePpm: options.quotedRoutingFeePpm ?? 800,
    expiryBlock: options.expiryBlock || 360,
    observedBlock: options.observedBlock || 240,
    challengeObservedBlock: options.challengeObservedBlock || 361,
    challengeObservedSpreadPpm: options.challengeObservedSpreadPpm || 9000,
    challengeObservedRoutingFeePpm: options.challengeObservedRoutingFeePpm || 2500
  });
  const stablecoinVerification = verifyTaprootAssetsStablecoinBundle(stablecoin);

  const conversionCore = {
    version: 1,
    protocol: 'lnbtc_to_tlusd_utxoref_conversion',
    lnbtcSats: lnbtcSats.toString(),
    btcUsdPriceMicros: btcUsdPriceMicros.toString(),
    tlusdUnits: tlusdUnits.toString(),
    assetDescriptorId: stablecoin.asset.descriptorId,
    assetProofId: stablecoin.assetProof.proofId,
    rfqQuoteId: stablecoin.rfqQuote.quoteId,
    settlementId: stablecoin.settlementEvidence.settlementId,
    subswapFundingTxid: htlcProof.swap && htlcProof.swap.fundingTxid,
    dlcFundingTxid: htlcProof.dlcFunding && htlcProof.dlcFunding.claimTxid,
    liquidityLeaseBundleId: liquidityLease && liquidityLease.bundleId
  };

  return {
    kind: 'lnbtc_to_tlusd_conversion',
    conversionId: hashCanonical(conversionCore),
    conversionCore,
    stablecoin,
    stablecoinVerification,
    checks: {
      stablecoinVerified: stablecoinVerification.ok,
      assetTickerIsTlUsd: stablecoin.asset.descriptorCore.ticker === 'TLUSD',
      btcRouteMatchesLnFunding: BigInt(stablecoin.rfqQuote.quoteCore.btcRouteSats) === lnbtcSats,
      tlusdUnitsPositive: tlusdUnits > 0n,
      paymentHashBound: stablecoin.rfqQuote.quoteCore.paymentHashHex === paymentHashHex
    }
  };
}

function buildTlUsdLiquidityStake(options = {}) {
  const conversion = options.conversion || buildLnBtcToTlUsdConversion(options);
  const stakeId = normalizeString(options.stakeId || 'tlusd-liquidity-stake-regtest-1', 'stakeId');
  const ownerNodeId = normalizeString(options.ownerNodeId || 'wallet-liquidity-provider-regtest', 'ownerNodeId');
  const poolId = normalizeString(options.poolId || 'ln-liquidity-patch-pool-regtest', 'poolId');
  const stakedTlUsdUnits = normalizeUnits(
    options.stakedTlUsdUnits || conversion.conversionCore.tlusdUnits,
    'stakedTlUsdUnits'
  );
  const routingNotionalSats = normalizeAmountSats(
    options.routingNotionalSats || conversion.conversionCore.lnbtcSats,
    'routingNotionalSats'
  );
  const lockBlocks = Number(options.lockBlocks || 1008);
  const targetYieldPpm = Number(options.targetYieldPpm ?? 4200);
  const slashReserveUnits = normalizeUnits(options.slashReserveUnits || stakedTlUsdUnits / 20n, 'slashReserveUnits');
  const stakeCore = {
    version: 1,
    protocol: 'tlusd_liquidity_patch_stake',
    stakeId,
    ownerNodeId,
    poolId,
    assetId: conversion.stablecoin.asset.descriptorCore.assetId,
    assetTicker: conversion.stablecoin.asset.descriptorCore.ticker,
    assetProofId: conversion.stablecoin.assetProof.proofId,
    conversionId: conversion.conversionId,
    stakedTlUsdUnits: stakedTlUsdUnits.toString(),
    routingNotionalSats: routingNotionalSats.toString(),
    lockBlocks,
    targetYieldPpm,
    slashReserveUnits: slashReserveUnits.toString(),
    rewardSource: 'ln_routing_fees_and_liquidity_patch_premiums',
    exitRule: 'unstake after lock or challenge if Ark/LSP patch obligation fails'
  };

  return {
    kind: 'tlusd_liquidity_patch_stake',
    stakeCommitmentId: hashCanonical(stakeCore),
    stakeCore,
    checks: {
      conversionVerified: Object.values(conversion.checks).every(Boolean),
      stakeDoesNotExceedTlUsdBalance: stakedTlUsdUnits <= BigInt(conversion.conversionCore.tlusdUnits),
      routingNotionalBackedByLnBtc: routingNotionalSats <= BigInt(conversion.conversionCore.lnbtcSats),
      slashReservePresent: slashReserveUnits > 0n
    }
  };
}

function buildLiquidityPatchMandate(options = {}) {
  const conversion = options.conversion || buildLnBtcToTlUsdConversion(options);
  const stake = options.stake || buildTlUsdLiquidityStake({ ...options, conversion });
  const manager = options.manager || buildArkLiquidityGraftManagerBundle({
    ...options,
    managerId: options.managerId || 'tlusd-ark-liquidity-patch-manager',
    aspId: options.aspId || 'ark-asp-regtest',
    templateId: options.templateId || 'ark-template-tlusd-patch-v1',
    vtxoAmountsSats: options.vtxoAmountsSats || [
      BigInt(stake.stakeCore.routingNotionalSats),
      BigInt(stake.stakeCore.routingNotionalSats),
      BigInt(stake.stakeCore.routingNotionalSats) / 2n
    ],
    routeIntents: options.routeIntents || [
      {
        routeId: 'tlusd-edge-a-patch',
        edgeNodeId: 'ldk-tlusd-edge-a',
        requestedInboundSats: BigInt(stake.stakeCore.routingNotionalSats) / 2n,
        priority: 3,
        maxFeePpm: 900
      },
      {
        routeId: 'tlusd-edge-b-patch',
        edgeNodeId: 'ldk-tlusd-edge-b',
        requestedInboundSats: BigInt(stake.stakeCore.routingNotionalSats) / 2n,
        priority: 2,
        maxFeePpm: 1000
      }
    ],
    routeObservations: options.routeObservations || [
      {
        routeId: 'tlusd-edge-b-patch',
        deliveredInboundSats: BigInt(stake.stakeCore.routingNotionalSats) / 4n,
        observedFeePpm: 1500,
        observedCltvDelta: 60,
        missingForfeitPath: true
      }
    ],
    liquidityLease: options.liquidityLease,
    htlcProof: options.htlcProof,
    maxAspExposureSats: options.maxAspExposureSats || BigInt(stake.stakeCore.routingNotionalSats) * 4n,
    bitvmChallengeReserveSats: options.bitvmChallengeReserveSats || 25000n
  });
  const managerVerification = verifyArkLiquidityGraftManagerBundle(manager);
  const mandateCore = {
    version: 1,
    protocol: 'tlusd_ark_ln_liquidity_patch_mandate',
    conversionId: conversion.conversionId,
    stakeCommitmentId: stake.stakeCommitmentId,
    managerBundleId: manager.bundleId,
    policyId: manager.policy.policyId,
    allocationId: manager.allocation.allocationId,
    requestedInboundSats: manager.allocation.totals.requestedInboundSats,
    assignedInboundSats: manager.allocation.totals.assignedInboundSats,
    slashableAssignments: manager.allocation.totals.slashableAssignments
  };

  return {
    kind: 'tlusd_ark_ln_liquidity_patch_mandate',
    mandateId: hashCanonical(mandateCore),
    mandateCore,
    manager,
    managerVerification,
    checks: {
      stakeVerified: Object.values(stake.checks).every(Boolean),
      managerVerified: managerVerification.ok,
      assignedLiquidityPresent: BigInt(manager.allocation.totals.assignedInboundSats) > 0n,
      assignedLiquidityWithinStakeNotional:
        BigInt(manager.allocation.totals.assignedInboundSats) <= BigInt(stake.stakeCore.routingNotionalSats),
      bitvmChallengeSurfacePresent: Boolean(manager.challengeEvidence && manager.challengeEvidence.challengeId)
    }
  };
}

function buildLnBtcTlUsdLiquidityPatchBundle(options = {}) {
  const conversion = buildLnBtcToTlUsdConversion(options);
  const stake = buildTlUsdLiquidityStake({ ...options, conversion });
  const mandate = buildLiquidityPatchMandate({ ...options, conversion, stake });
  const bundleCore = {
    version: 1,
    protocol: 'lnbtc_tlusd_liquidity_patch_e2e',
    conversionId: conversion.conversionId,
    stakeCommitmentId: stake.stakeCommitmentId,
    mandateId: mandate.mandateId,
    managerBundleId: mandate.manager.bundleId
  };

  return {
    kind: 'lnbtc_tlusd_liquidity_patch_bundle',
    bundleId: hashCanonical(bundleCore),
    bundleCore,
    conversion,
    stake,
    mandate,
    thesis:
      'LN-BTC can fund UTXORef, externalize as BTC-based tlUSD for wallet UX, and be staked into an Ark-managed liquidity patching service with BitVM enforcement.',
    caveats: [
      'This is an evidence-shape prototype; it does not mint production Taproot Assets or execute real Ark rounds.',
      'tlUSD issuer/perp solvency remains a separate risk surface from LN route execution.',
      'The liquidity patch improves deployability and marginal routing cost, but it reallocates pledged liquidity rather than creating net liquidity.'
    ]
  };
}

function verifyLnBtcTlUsdLiquidityPatchBundle(bundle) {
  if (!bundle || bundle.kind !== 'lnbtc_tlusd_liquidity_patch_bundle') {
    return { ok: false, reason: 'wrong bundle kind' };
  }
  if (bundle.bundleId !== hashCanonical(bundle.bundleCore)) {
    return { ok: false, reason: 'bundle id mismatch' };
  }
  if (bundle.conversion.conversionId !== hashCanonical(bundle.conversion.conversionCore)) {
    return { ok: false, reason: 'conversion id mismatch' };
  }
  for (const [name, passed] of Object.entries(bundle.conversion.checks || {})) {
    if (!passed) return { ok: false, reason: `conversion check failed: ${name}` };
  }
  if (bundle.stake.stakeCommitmentId !== hashCanonical(bundle.stake.stakeCore)) {
    return { ok: false, reason: 'stake commitment mismatch' };
  }
  for (const [name, passed] of Object.entries(bundle.stake.checks || {})) {
    if (!passed) return { ok: false, reason: `stake check failed: ${name}` };
  }
  if (bundle.mandate.mandateId !== hashCanonical(bundle.mandate.mandateCore)) {
    return { ok: false, reason: 'mandate id mismatch' };
  }
  for (const [name, passed] of Object.entries(bundle.mandate.checks || {})) {
    if (!passed) return { ok: false, reason: `mandate check failed: ${name}` };
  }
  return { ok: true };
}

module.exports = {
  usdUnitsFromBtcSats,
  buildLnBtcToTlUsdConversion,
  buildTlUsdLiquidityStake,
  buildLiquidityPatchMandate,
  buildLnBtcTlUsdLiquidityPatchBundle,
  verifyLnBtcTlUsdLiquidityPatchBundle
};
