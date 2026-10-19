/**
 * Taproot Assets / RFQ / Lightning stablecoin liquidity prototype.
 *
 * This does not implement tapd or litd. It models the evidence bundle a wallet
 * or watchtower would verify when an Edge node offers asset/BTC conversion plus
 * Lightning liquidity under externally enforceable BitVM/DLC terms.
 */

const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');
const { toInt, heightOf } = require('./money');
const { buildJurassicMechanismRefs } = require('./jurassic_bitvm_mechanisms');
const { verifyLiquidityLeaseBundle } = require('./lightning_liquidity_lease');

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

function normalizeOutpoint(value, fieldName) {
  const normalized = normalizeString(value, fieldName);
  const parts = normalized.split(':');
  if (parts.length !== 2 || !HEX_32_RE.test(parts[0]) || !/^[0-9]+$/.test(parts[1])) {
    throw new Error(`${fieldName} must be txid:vout`);
  }
  return `${parts[0].toLowerCase()}:${Number(parts[1])}`;
}

function buildTaprootAssetDescriptor(options = {}) {
  const ticker = normalizeString(options.ticker || 'USDSIM', 'ticker');
  const decimalDisplay = Number(options.decimalDisplay ?? 6);
  const assetId = normalizeHex32(options.assetId || sha256Hex(`tap-asset:${ticker}`), 'assetId');
  const genesisPoint = normalizeOutpoint(
    options.genesisPoint || `${sha256Hex(`genesis:${ticker}`)}:0`,
    'genesisPoint'
  );
  const groupKey = normalizeHex32(options.groupKey || sha256Hex(`group:${ticker}`), 'groupKey');

  const descriptorCore = {
    protocol: 'taproot_assets',
    ticker,
    decimalDisplay,
    assetId,
    genesisPoint,
    groupKey,
    issuer: normalizeString(options.issuer || 'regtest-stablecoin-issuer', 'issuer')
  };

  return {
    kind: 'taproot_asset_stablecoin_descriptor',
    descriptorId: hashCanonical(descriptorCore),
    descriptorCore
  };
}

function buildTaprootAssetProofCommitment(options = {}) {
  const asset = options.asset || buildTaprootAssetDescriptor(options);
  const amountUnits = toInt(options.amountUnits || 25000000n, 'amountUnits');
  const anchorOutpoint = normalizeOutpoint(
    options.anchorOutpoint || `${sha256Hex(`anchor:${asset.descriptorId}`)}:1`,
    'anchorOutpoint'
  );
  const scriptKey = normalizeHex32(options.scriptKey || sha256Hex(`script-key:${anchorOutpoint}`), 'scriptKey');
  const universeRoot = normalizeHex32(
    options.universeRoot || sha256Hex(`universe:${asset.descriptorCore.assetId}:${amountUnits}`),
    'universeRoot'
  );
  const proofRoot = normalizeHex32(
    options.proofRoot || sha256Hex(`proof:${asset.descriptorCore.assetId}:${anchorOutpoint}:${scriptKey}`),
    'proofRoot'
  );

  const proofCore = {
    version: 1,
    assetId: asset.descriptorCore.assetId,
    amountUnits: amountUnits.toString(),
    anchorOutpoint,
    scriptKey,
    universeHost: normalizeString(options.universeHost || 'regtest-universe.local', 'universeHost'),
    universeRoot,
    proofRoot,
    proofTransport: 'tapd_exported_proof_or_universe_proof'
  };

  return {
    kind: 'taproot_asset_proof_commitment',
    proofId: hashCanonical(proofCore),
    proofCore
  };
}

function buildStablecoinRfqQuote(options = {}) {
  const asset = options.asset || buildTaprootAssetDescriptor(options);
  const assetProof = options.assetProof || buildTaprootAssetProofCommitment({ ...options, asset });
  const edgeNodeId = normalizeString(options.edgeNodeId || 'tap-edge-node-regtest', 'edgeNodeId');
  const clientNodeId = normalizeString(options.clientNodeId || 'tap-client-regtest', 'clientNodeId');
  const assetAmountUnits = toInt(options.assetAmountUnits || assetProof.proofCore.amountUnits, 'assetAmountUnits');
  const btcRouteSats = normalizeAmountSats(options.btcRouteSats || 25000n, 'btcRouteSats');
  const maxSpreadPpm = heightOf(options.maxSpreadPpm ?? 5000, 'maxSpreadPpm');
  const quotedSpreadPpm = heightOf(options.quotedSpreadPpm ?? 3000, 'quotedSpreadPpm');
  const maxRoutingFeePpm = heightOf(options.maxRoutingFeePpm ?? 1200, 'maxRoutingFeePpm');
  const quotedRoutingFeePpm = heightOf(options.quotedRoutingFeePpm ?? 900, 'quotedRoutingFeePpm');
  const expiryBlock = heightOf(options.expiryBlock ?? 250, 'expiryBlock');
  const paymentHashHex = normalizeHex32(options.paymentHashHex || sha256Hex(`tap-rfq:${assetProof.proofId}`), 'paymentHashHex');
  const jurassicMechanisms = buildJurassicMechanismRefs('taproot_assets', {
    contractId: assetProof.proofId,
    applicationIntent: 'Taproot Assets proof anchor relay and RFQ proof package variants',
    route: 'taproot_asset_rfq_settle_or_challenge',
    amountSats: btcRouteSats,
    settlementEpoch: `tap-asset:${asset.descriptorCore.assetId}`,
    challengeWindowBlocks: expiryBlock
  });

  const quoteCore = {
    version: 1,
    protocol: 'taproot_assets_rfq_over_bolt08',
    assetId: asset.descriptorCore.assetId,
    assetTicker: asset.descriptorCore.ticker,
    clientNodeId,
    edgeNodeId,
    assetAmountUnits: assetAmountUnits.toString(),
    btcRouteSats: btcRouteSats.toString(),
    maxSpreadPpm,
    quotedSpreadPpm,
    maxRoutingFeePpm,
    quotedRoutingFeePpm,
    expiryBlock,
    paymentHashHex,
    jurassicMechanisms,
    proofAnchorHandleId: jurassicMechanisms.primaryPublicHandleId,
    proofCarrierCommitmentId: jurassicMechanisms.primaryCarrierCommitmentId,
    proofTranscriptDigest: jurassicMechanisms.primaryTranscriptDigest
  };

  return {
    kind: 'taproot_asset_lightning_rfq_quote',
    quoteId: hashCanonical(quoteCore),
    quoteCore,
    commitment: {
      assetProofId: assetProof.proofId,
      obligation:
        'Edge node swaps the Taproot Asset amount into a BTC Lightning payment under the quoted spread and routing fee limits.'
    }
  };
}

// The settlement checks the quote, the asset proof and the settlement core determine.
// The lease check is passed in: only the caller holds the lease bundle it is read from.
function stablecoinSettlementChecks(proofAssetId, quoteCore, core, leaseVerified) {
  return {
    assetProofMatchesQuote: proofAssetId === quoteCore.assetId,
    deliveredAmountMet: BigInt(core.deliveredBtcSats) >= BigInt(quoteCore.btcRouteSats),
    spreadCeilingMet: core.observedSpreadPpm <= quoteCore.maxSpreadPpm,
    routingFeeCeilingMet: core.observedRoutingFeePpm <= quoteCore.maxRoutingFeePpm,
    paymentHashMatched: core.preimageHashHex === core.paymentHashHex,
    quoteNotExpired: core.observedBlock <= quoteCore.expiryBlock,
    bitvmLeaseVerified: leaseVerified
  };
}

// The violations a challenge core shows against the quote. Builder and verifier both call this.
function stablecoinViolations(quoteCore, core) {
  const violations = [];
  if (core.observedAssetId !== quoteCore.assetId) violations.push('asset_id_mismatch');
  if (BigInt(core.deliveredBtcSats) < BigInt(quoteCore.btcRouteSats)) violations.push('btc_route_amount_shortfall');
  if (core.observedSpreadPpm > quoteCore.maxSpreadPpm) violations.push('spread_ppm_above_quote');
  if (core.observedRoutingFeePpm > quoteCore.maxRoutingFeePpm) violations.push('routing_fee_ppm_above_quote');
  if (core.observedBlock > quoteCore.expiryBlock) violations.push('quote_expired_before_settlement');
  return violations;
}

function buildStablecoinSettlementEvidence(options = {}) {
  const asset = options.asset || buildTaprootAssetDescriptor(options);
  const assetProof = options.assetProof || buildTaprootAssetProofCommitment({ ...options, asset });
  const rfqQuote = options.rfqQuote || buildStablecoinRfqQuote({ ...options, asset, assetProof });
  const liquidityLease = options.liquidityLease || null;
  const htlcProof = options.htlcProof || {};
  const deliveredBtcSats = normalizeAmountSats(options.deliveredBtcSats || rfqQuote.quoteCore.btcRouteSats, 'deliveredBtcSats');
  const observedSpreadPpm = heightOf(options.observedSpreadPpm ?? rfqQuote.quoteCore.quotedSpreadPpm, 'observedSpreadPpm');
  const observedRoutingFeePpm = heightOf(options.observedRoutingFeePpm ?? rfqQuote.quoteCore.quotedRoutingFeePpm, 'observedRoutingFeePpm');
  const observedBlock = heightOf(options.observedBlock ?? 0, 'observedBlock');
  const preimageHex = normalizeHex32(
    options.preimageHex ||
      (htlcProof.lightning && (htlcProof.lightning.preimageHex || htlcProof.lightning.paymentPreimageHex)) ||
      sha256Hex('tap-stablecoin-preimage'),
    'preimageHex'
  );
  const paymentHashHex = normalizeHex32(rfqQuote.quoteCore.paymentHashHex, 'paymentHashHex');
  const observedPaymentHashHex = sha256Hex(Buffer.from(preimageHex, 'hex'));

  const settlementCore = {
    version: 1,
    quoteId: rfqQuote.quoteId,
    jurassicMechanismRefId: rfqQuote.quoteCore.jurassicMechanisms.refId,
    proofAnchorHandleId: rfqQuote.quoteCore.proofAnchorHandleId,
    proofCarrierCommitmentId: rfqQuote.quoteCore.proofCarrierCommitmentId,
    proofTranscriptDigest: rfqQuote.quoteCore.proofTranscriptDigest,
    assetProofId: assetProof.proofId,
    liquidityLeaseBundleId: liquidityLease && liquidityLease.bundleId,
    deliveredBtcSats: deliveredBtcSats.toString(),
    observedSpreadPpm,
    observedRoutingFeePpm,
    observedBlock,
    paymentHashHex,
    preimageHashHex: observedPaymentHashHex,
    lnClaimTxid: htlcProof.dlcFunding && htlcProof.dlcFunding.claimTxid,
    channelOrSpliceOutpoint:
      liquidityLease &&
      liquidityLease.successEvidence &&
      liquidityLease.successEvidence.evidenceCore.channelOutpoint
  };

  return {
    kind: 'taproot_asset_lightning_stablecoin_settlement_evidence',
    settlementId: hashCanonical(settlementCore),
    settlementCore,
    checks: stablecoinSettlementChecks(
      assetProof.proofCore.assetId,
      rfqQuote.quoteCore,
      settlementCore,
      Boolean(liquidityLease && verifyLiquidityLeaseBundle(liquidityLease).ok)
    )
  };
}

function buildStablecoinChallengeEvidence(options = {}) {
  const rfqQuote = options.rfqQuote || buildStablecoinRfqQuote(options);
  const observedAssetId = options.observedAssetId || rfqQuote.quoteCore.assetId;
  const deliveredBtcSats = normalizeAmountSats(options.deliveredBtcSats ?? 0n, 'deliveredBtcSats');
  const observedSpreadPpm = heightOf(options.observedSpreadPpm ?? rfqQuote.quoteCore.maxSpreadPpm + 1, 'observedSpreadPpm');
  const observedRoutingFeePpm = heightOf(options.observedRoutingFeePpm ?? rfqQuote.quoteCore.maxRoutingFeePpm + 1, 'observedRoutingFeePpm');
  const observedBlock = heightOf(options.observedBlock ?? rfqQuote.quoteCore.expiryBlock + 1, 'observedBlock');

  const violations = stablecoinViolations(rfqQuote.quoteCore, {
    observedAssetId,
    deliveredBtcSats: deliveredBtcSats.toString(),
    observedSpreadPpm,
    observedRoutingFeePpm,
    observedBlock
  });

  const challengeCore = {
    version: 1,
    quoteId: rfqQuote.quoteId,
    jurassicMechanismRefId: rfqQuote.quoteCore.jurassicMechanisms.refId,
    proofAnchorHandleId: rfqQuote.quoteCore.proofAnchorHandleId,
    proofCarrierCommitmentId: rfqQuote.quoteCore.proofCarrierCommitmentId,
    proofTranscriptDigest: rfqQuote.quoteCore.proofTranscriptDigest,
    observedAssetId,
    deliveredBtcSats: deliveredBtcSats.toString(),
    observedSpreadPpm,
    observedRoutingFeePpm,
    observedBlock,
    violations
  };

  return {
    kind: 'taproot_asset_lightning_stablecoin_challenge',
    challengeId: hashCanonical(challengeCore),
    challengeCore,
    slashable: violations.length > 0
  };
}

function buildTaprootAssetsStablecoinBundle(options = {}) {
  const asset = buildTaprootAssetDescriptor(options);
  const assetProof = buildTaprootAssetProofCommitment({ ...options, asset });
  const rfqQuote = buildStablecoinRfqQuote({
    ...options,
    asset,
    assetProof,
    paymentHashHex:
      options.paymentHashHex ||
      (options.htlcProof && options.htlcProof.lightning && options.htlcProof.lightning.paymentHashHex)
  });
  const settlementEvidence = buildStablecoinSettlementEvidence({
    ...options,
    asset,
    assetProof,
    rfqQuote
  });
  const challengeEvidence = buildStablecoinChallengeEvidence({
    rfqQuote,
    deliveredBtcSats: options.challengeDeliveredBtcSats ?? 0n,
    observedSpreadPpm: options.challengeObservedSpreadPpm,
    observedRoutingFeePpm: options.challengeObservedRoutingFeePpm,
    observedBlock: options.challengeObservedBlock
  });

  const bundleCore = {
    assetDescriptorId: asset.descriptorId,
    assetProofId: assetProof.proofId,
    quoteId: rfqQuote.quoteId,
    jurassicMechanismRefId: rfqQuote.quoteCore.jurassicMechanisms.refId,
    proofAnchorHandleId: rfqQuote.quoteCore.proofAnchorHandleId,
    proofCarrierCommitmentId: rfqQuote.quoteCore.proofCarrierCommitmentId,
    settlementId: settlementEvidence.settlementId,
    challengeId: challengeEvidence.challengeId
  };

  return {
    kind: 'taproot_assets_lightning_stablecoin_bitvm_bundle',
    bundleId: hashCanonical(bundleCore),
    bundleCore,
    asset,
    assetProof,
    rfqQuote,
    liquidityLease: options.liquidityLease || null,
    settlementEvidence,
    challengeEvidence,
    thesis:
      'Use BitVM/DLC commitments to make a Taproot Assets Edge-node RFQ and Lightning liquidity promise externally auditable and challengeable.',
    caveats: [
      'The stablecoin issuer remains a separate trust assumption.',
      'This validates evidence shape and commitments; production would verify tapd proofs and litd RFQ messages directly.',
      'The edge node still performs the asset/BTC conversion; ordinary BTC Lightning routers do not need asset awareness.'
    ],
    references: [
      'https://docs.lightning.engineering/the-lightning-network/taproot-assets/taproot-assets-protocol',
      'https://docs.lightning.engineering/the-lightning-network/taproot-assets/edge-nodes',
      'https://docs.lightning.engineering/lightning-network-tools/taproot-assets/rfq'
    ]
  };
}

function verifyTaprootAssetsStablecoinBundle(bundle) {
  if (!bundle || bundle.kind !== 'taproot_assets_lightning_stablecoin_bitvm_bundle') {
    return { ok: false, reason: 'wrong bundle kind' };
  }
  if (bundle.bundleId !== hashCanonical(bundle.bundleCore)) {
    return { ok: false, reason: 'bundle id mismatch' };
  }
  const { rfqQuote, assetProof, liquidityLease, settlementEvidence: evidence, challengeEvidence: challenge } = bundle;
  const quoteCore = rfqQuote.quoteCore;
  if (evidence.settlementId !== hashCanonical(evidence.settlementCore)) {
    return { ok: false, reason: 'settlement id mismatch' };
  }
  if (bundle.bundleCore.settlementId !== evidence.settlementId) {
    return { ok: false, reason: 'bundle does not bind settlement' };
  }
  const leaseVerified = Boolean(liquidityLease)
    && verifyLiquidityLeaseBundle(liquidityLease).ok
    && liquidityLease.bundleId === evidence.settlementCore.liquidityLeaseBundleId;
  const derived = stablecoinSettlementChecks(assetProof.proofCore.assetId, quoteCore, evidence.settlementCore, leaseVerified);
  for (const [name, passed] of Object.entries(derived)) {
    if (!passed) return { ok: false, reason: `settlement evidence failed: ${name}` };
    if ((evidence.checks || {})[name] !== passed) return { ok: false, reason: `settlement check does not follow: ${name}` };
  }
  if (challenge.challengeId !== hashCanonical(challenge.challengeCore)) {
    return { ok: false, reason: 'challenge id mismatch' };
  }
  if (bundle.bundleCore.challengeId !== challenge.challengeId) {
    return { ok: false, reason: 'bundle does not bind the challenge' };
  }
  const violations = stablecoinViolations(quoteCore, challenge.challengeCore);
  if (hashCanonical(violations) !== hashCanonical(challenge.challengeCore.violations)) {
    return { ok: false, reason: 'challenge violations do not follow from its core' };
  }
  if (challenge.slashable !== (violations.length > 0)) {
    return { ok: false, reason: 'challenge slashable flag does not follow from its violations' };
  }
  if (!challenge.slashable) {
    return { ok: false, reason: 'challenge should be slashable in demo bundle' };
  }
  return { ok: true };
}

module.exports = {
  buildTaprootAssetDescriptor,
  buildTaprootAssetProofCommitment,
  buildStablecoinRfqQuote,
  buildStablecoinSettlementEvidence,
  buildStablecoinChallengeEvidence,
  buildTaprootAssetsStablecoinBundle,
  verifyTaprootAssetsStablecoinBundle
};
