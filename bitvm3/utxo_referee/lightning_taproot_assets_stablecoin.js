/**
 * Taproot Assets / RFQ / Lightning stablecoin liquidity prototype.
 *
 * This does not implement tapd or litd. It models the evidence bundle a wallet
 * or watchtower would verify when an Edge node offers asset/BTC conversion plus
 * Lightning liquidity under externally enforceable BitVM/DLC terms.
 */

const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');
const { buildJurassicMechanismRefs } = require('./jurassic_bitvm_mechanisms');

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

function normalizeUint(value, fieldName) {
  const normalized = BigInt(value);
  if (normalized < 0n) throw new Error(`${fieldName} must be non-negative`);
  return normalized;
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
  const amountUnits = normalizeUint(options.amountUnits || 25000000n, 'amountUnits');
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
  const assetAmountUnits = normalizeUint(options.assetAmountUnits || assetProof.proofCore.amountUnits, 'assetAmountUnits');
  const btcRouteSats = normalizeAmountSats(options.btcRouteSats || 25000n, 'btcRouteSats');
  const maxSpreadPpm = Number(options.maxSpreadPpm ?? 5000);
  const quotedSpreadPpm = Number(options.quotedSpreadPpm ?? 3000);
  const maxRoutingFeePpm = Number(options.maxRoutingFeePpm ?? 1200);
  const quotedRoutingFeePpm = Number(options.quotedRoutingFeePpm ?? 900);
  const expiryBlock = Number(options.expiryBlock || 250);
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

function buildStablecoinSettlementEvidence(options = {}) {
  const asset = options.asset || buildTaprootAssetDescriptor(options);
  const assetProof = options.assetProof || buildTaprootAssetProofCommitment({ ...options, asset });
  const rfqQuote = options.rfqQuote || buildStablecoinRfqQuote({ ...options, asset, assetProof });
  const liquidityLease = options.liquidityLease || null;
  const htlcProof = options.htlcProof || {};
  const deliveredBtcSats = normalizeAmountSats(options.deliveredBtcSats || rfqQuote.quoteCore.btcRouteSats, 'deliveredBtcSats');
  const observedSpreadPpm = Number(options.observedSpreadPpm ?? rfqQuote.quoteCore.quotedSpreadPpm);
  const observedRoutingFeePpm = Number(options.observedRoutingFeePpm ?? rfqQuote.quoteCore.quotedRoutingFeePpm);
  const observedBlock = Number(options.observedBlock || 0);
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
    checks: {
      assetProofMatchesQuote: assetProof.proofCore.assetId === rfqQuote.quoteCore.assetId,
      deliveredAmountMet: deliveredBtcSats >= BigInt(rfqQuote.quoteCore.btcRouteSats),
      spreadCeilingMet: observedSpreadPpm <= rfqQuote.quoteCore.maxSpreadPpm,
      routingFeeCeilingMet: observedRoutingFeePpm <= rfqQuote.quoteCore.maxRoutingFeePpm,
      paymentHashMatched: observedPaymentHashHex === paymentHashHex,
      quoteNotExpired: observedBlock <= rfqQuote.quoteCore.expiryBlock,
      bitvmLeaseVerified: Boolean(liquidityLease && liquidityLease.verification && liquidityLease.verification.ok)
    }
  };
}

function buildStablecoinChallengeEvidence(options = {}) {
  const rfqQuote = options.rfqQuote || buildStablecoinRfqQuote(options);
  const observedAssetId = options.observedAssetId || rfqQuote.quoteCore.assetId;
  const deliveredBtcSats = normalizeAmountSats(options.deliveredBtcSats ?? 0n, 'deliveredBtcSats');
  const observedSpreadPpm = Number(options.observedSpreadPpm ?? rfqQuote.quoteCore.maxSpreadPpm + 1);
  const observedRoutingFeePpm = Number(options.observedRoutingFeePpm ?? rfqQuote.quoteCore.maxRoutingFeePpm + 1);
  const observedBlock = Number(options.observedBlock || rfqQuote.quoteCore.expiryBlock + 1);

  const violations = [];
  if (observedAssetId !== rfqQuote.quoteCore.assetId) violations.push('asset_id_mismatch');
  if (deliveredBtcSats < BigInt(rfqQuote.quoteCore.btcRouteSats)) violations.push('btc_route_amount_shortfall');
  if (observedSpreadPpm > rfqQuote.quoteCore.maxSpreadPpm) violations.push('spread_ppm_above_quote');
  if (observedRoutingFeePpm > rfqQuote.quoteCore.maxRoutingFeePpm) violations.push('routing_fee_ppm_above_quote');
  if (observedBlock > rfqQuote.quoteCore.expiryBlock) violations.push('quote_expired_before_settlement');

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
  for (const [name, passed] of Object.entries(bundle.settlementEvidence.checks || {})) {
    if (!passed) return { ok: false, reason: `settlement evidence failed: ${name}` };
  }
  if (!bundle.challengeEvidence.slashable) {
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
