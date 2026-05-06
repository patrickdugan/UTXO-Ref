/**
 * Ark-assisted Lightning liquidity graft prototype.
 *
 * The model: an ASP supplies short-lived Ark VTXO liquidity to an LN edge/LSP.
 * LN settlement proves the payment side, while the existing BitVM liquidity
 * lease keeps the ASP/LSP promise challengeable.
 */

const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');
const { buildJurassicMechanismRefs } = require('./jurassic_bitvm_mechanisms');
const {
  buildArkTaprootMiniscriptProofManifest,
  verifyArkTaprootMiniscriptProofManifest
} = require('./ark_taproot_miniscript_proof_manifest');

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

function normalizeOptionalString(value) {
  return value === undefined || value === null ? '' : String(value).trim();
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

function buildArkTemplateCommitment(options = {}) {
  const aspId = normalizeString(options.aspId || 'ark-asp-regtest', 'aspId');
  const templateId = normalizeString(options.templateId || `ark-template-${aspId}`, 'templateId');
  const internalKeyHex = normalizeHex32(options.internalKeyHex || sha256Hex(`ark-internal:${templateId}`), 'internalKeyHex');
  const taprootOutputKey = normalizeHex32(
    options.taprootOutputKey || sha256Hex(`ark-output-key:${templateId}:${aspId}`),
    'taprootOutputKey'
  );
  const leafRoles = options.leafRoles || ['batch-settle', 'user-exit', 'asp-forfeit'];

  const templateCore = {
    version: 1,
    protocol: 'ark_vtxo_template',
    aspId,
    templateId,
    internalKeyHex,
    taprootOutputKey,
    leafRoles,
    exitDelayBlocks: Number(options.exitDelayBlocks ?? 144),
    aspForfeitCsv: Number(options.aspForfeitCsv ?? 2000)
  };

  return {
    kind: 'ark_vtxo_template_commitment',
    templateCommitmentId: hashCanonical(templateCore),
    templateCore
  };
}

function buildArkVtxoLiquidityCommitment(options = {}) {
  const template = options.template || buildArkTemplateCommitment(options);
  const vtxoAmountSats = normalizeAmountSats(options.vtxoAmountSats || 50000n, 'vtxoAmountSats');
  const ownerNodeId = normalizeString(options.ownerNodeId || 'ln-edge-node-regtest', 'ownerNodeId');
  const aspRoundId = normalizeString(options.aspRoundId || 'ark-round-regtest-1', 'aspRoundId');
  const connectorOutpoint = normalizeOutpoint(
    options.connectorOutpoint || `${sha256Hex(`ark-connector:${aspRoundId}`)}:0`,
    'connectorOutpoint'
  );
  const vtxoId = normalizeHex32(options.vtxoId || sha256Hex(`ark-vtxo:${connectorOutpoint}:${ownerNodeId}`), 'vtxoId');
  const forfeitTxid = normalizeHex32(options.forfeitTxid || sha256Hex(`ark-forfeit:${vtxoId}`), 'forfeitTxid');
  const exitTxid = normalizeHex32(options.exitTxid || sha256Hex(`ark-exit:${vtxoId}`), 'exitTxid');
  const expiryBlock = Number(options.expiryBlock || 0);

  const vtxoCore = {
    version: 1,
    protocol: 'ark_vtxo_liquidity_graft',
    aspId: template.templateCore.aspId,
    templateId: template.templateCore.templateId,
    templateCommitmentId: template.templateCommitmentId,
    vtxoId,
    vtxoAmountSats: vtxoAmountSats.toString(),
    ownerNodeId,
    aspRoundId,
    connectorOutpoint,
    taprootOutputKey: template.templateCore.taprootOutputKey,
    forfeitTxid,
    exitTxid,
    expiryBlock
  };

  return {
    kind: 'ark_vtxo_liquidity_commitment',
    vtxoCommitmentId: hashCanonical(vtxoCore),
    vtxoCore
  };
}

function buildArkLiquidityGraftQuote(options = {}) {
  const template = options.template || buildArkTemplateCommitment(options);
  const vtxo = options.vtxo || buildArkVtxoLiquidityCommitment({ ...options, template });
  const promisedInboundSats = normalizeAmountSats(options.promisedInboundSats || vtxo.vtxoCore.vtxoAmountSats, 'promisedInboundSats');
  const leaseBlocks = Number(options.leaseBlocks || 144);
  const maxFeePpm = Number(options.maxFeePpm ?? 1000);
  const maxCltvDelta = Number(options.maxCltvDelta ?? 40);
  const graftPremiumSats = normalizeAmountSats(options.graftPremiumSats || 750n, 'graftPremiumSats');
  const paymentHashHex = normalizeHex32(options.paymentHashHex || sha256Hex(`ark-graft:${vtxo.vtxoCommitmentId}`), 'paymentHashHex');
  const jurassicMechanisms = buildJurassicMechanismRefs('ark', {
    contractId: vtxo.vtxoCommitmentId,
    applicationIntent: 'Ark round and VTXO claim handles for BitVM liquidity grafts',
    route: 'ark_round_cooperative_or_exit_challenge',
    amountSats: promisedInboundSats,
    settlementEpoch: `ark-round:${vtxo.vtxoCore.aspRoundId}`,
    challengeWindowBlocks: leaseBlocks
  });

  const quoteCore = {
    version: 1,
    protocol: 'ark_ln_liquidity_graft_quote',
    aspId: template.templateCore.aspId,
    templateId: template.templateCore.templateId,
    vtxoCommitmentId: vtxo.vtxoCommitmentId,
    promisedInboundSats: promisedInboundSats.toString(),
    leaseBlocks,
    maxFeePpm,
    maxCltvDelta,
    graftPremiumSats: graftPremiumSats.toString(),
    paymentHashHex,
    jurassicMechanisms,
    roundClaimHandleId: jurassicMechanisms.primaryPublicHandleId,
    roundCarrierCommitmentId: jurassicMechanisms.primaryCarrierCommitmentId,
    roundTranscriptDigest: jurassicMechanisms.primaryTranscriptDigest
  };

  return {
    kind: 'ark_ln_liquidity_graft_quote',
    quoteId: hashCanonical(quoteCore),
    quoteCore,
    obligation:
      'ASP/LSP makes Ark VTXO liquidity available to an LN edge route under the advertised fee and CLTV bounds.'
  };
}

function buildArkGraftSettlementEvidence(options = {}) {
  const template = options.template || buildArkTemplateCommitment(options);
  const vtxo = options.vtxo || buildArkVtxoLiquidityCommitment({ ...options, template });
  const quote = options.quote || buildArkLiquidityGraftQuote({ ...options, template, vtxo });
  const taprootProofManifest = options.taprootProofManifest || null;
  const liquidityLease = options.liquidityLease || null;
  const htlcProof = options.htlcProof || {};
  const deliveredInboundSats = normalizeAmountSats(options.deliveredInboundSats || quote.quoteCore.promisedInboundSats, 'deliveredInboundSats');
  const observedFeePpm = Number(options.observedFeePpm ?? quote.quoteCore.maxFeePpm);
  const observedCltvDelta = Number(options.observedCltvDelta ?? quote.quoteCore.maxCltvDelta);
  const observedBlock = Number(options.observedBlock || 0);
  const paymentHashHex = normalizeHex32(quote.quoteCore.paymentHashHex, 'paymentHashHex');
  const preimageHex = normalizeHex32(
    options.preimageHex ||
      (htlcProof.lightning && (htlcProof.lightning.paymentPreimageHex || htlcProof.lightning.preimageHex)) ||
      sha256Hex('ark-graft-preimage'),
    'preimageHex'
  );
  const observedPaymentHashHex = sha256Hex(Buffer.from(preimageHex, 'hex'));

  const settlementCore = {
    version: 1,
    quoteId: quote.quoteId,
    taprootProofManifestId: taprootProofManifest && taprootProofManifest.manifestId,
    taprootSelectedLeafRole: taprootProofManifest && taprootProofManifest.manifestCore.selectedLeafRole,
    taprootSelectedLeafHash: taprootProofManifest && taprootProofManifest.manifestCore.selectedTapLeafHash,
    jurassicMechanismRefId: quote.quoteCore.jurassicMechanisms.refId,
    roundClaimHandleId: quote.quoteCore.roundClaimHandleId,
    roundCarrierCommitmentId: quote.quoteCore.roundCarrierCommitmentId,
    roundTranscriptDigest: quote.quoteCore.roundTranscriptDigest,
    vtxoCommitmentId: vtxo.vtxoCommitmentId,
    liquidityLeaseBundleId: liquidityLease && liquidityLease.bundleId,
    deliveredInboundSats: deliveredInboundSats.toString(),
    observedFeePpm,
    observedCltvDelta,
    observedBlock,
    paymentHashHex,
    preimageHashHex: observedPaymentHashHex,
    lnClaimTxid: htlcProof.dlcFunding && htlcProof.dlcFunding.claimTxid,
    channelOrSpliceOutpoint:
      liquidityLease &&
      liquidityLease.successEvidence &&
      liquidityLease.successEvidence.evidenceCore.channelOutpoint,
    arkRoundId: vtxo.vtxoCore.aspRoundId,
    arkExitTxid: vtxo.vtxoCore.exitTxid,
    arkForfeitTxid: vtxo.vtxoCore.forfeitTxid
  };

  return {
    kind: 'ark_ln_liquidity_graft_settlement_evidence',
    settlementId: hashCanonical(settlementCore),
    settlementCore,
    checks: {
      templateBindsVtxo: vtxo.vtxoCore.templateCommitmentId === template.templateCommitmentId,
      vtxoCoversPromisedInbound: BigInt(vtxo.vtxoCore.vtxoAmountSats) >= BigInt(quote.quoteCore.promisedInboundSats),
      deliveredInboundMet: deliveredInboundSats >= BigInt(quote.quoteCore.promisedInboundSats),
      feeCeilingMet: observedFeePpm <= quote.quoteCore.maxFeePpm,
      cltvCeilingMet: observedCltvDelta <= quote.quoteCore.maxCltvDelta,
      paymentHashMatched: observedPaymentHashHex === paymentHashHex,
      arkExitPathPresent: Boolean(vtxo.vtxoCore.exitTxid),
      arkForfeitPathPresent: Boolean(vtxo.vtxoCore.forfeitTxid),
      bitvmLeaseVerified: Boolean(liquidityLease && liquidityLease.verification && liquidityLease.verification.ok)
    }
  };
}

function buildArkGraftChallengeEvidence(options = {}) {
  const quote = options.quote || buildArkLiquidityGraftQuote(options);
  const taprootProofManifest = options.taprootProofManifest || null;
  const deliveredInboundSats = normalizeAmountSats(options.deliveredInboundSats ?? 0n, 'deliveredInboundSats');
  const observedFeePpm = Number(options.observedFeePpm ?? quote.quoteCore.maxFeePpm + 1);
  const observedCltvDelta = Number(options.observedCltvDelta ?? quote.quoteCore.maxCltvDelta + 1);
  const missingExitPath = Boolean(options.missingExitPath);
  const missingForfeitPath = Boolean(options.missingForfeitPath);

  const violations = [];
  if (deliveredInboundSats < BigInt(quote.quoteCore.promisedInboundSats)) violations.push('insufficient_ark_grafted_liquidity');
  if (observedFeePpm > quote.quoteCore.maxFeePpm) violations.push('fee_ppm_above_graft_quote');
  if (observedCltvDelta > quote.quoteCore.maxCltvDelta) violations.push('cltv_delta_above_graft_quote');
  if (missingExitPath) violations.push('missing_ark_exit_path');
  if (missingForfeitPath) violations.push('missing_ark_forfeit_path');

  const challengeCore = {
    version: 1,
    quoteId: quote.quoteId,
    taprootProofManifestId: taprootProofManifest && taprootProofManifest.manifestId,
    taprootSelectedLeafRole: taprootProofManifest && taprootProofManifest.manifestCore.selectedLeafRole,
    taprootSelectedLeafHash: taprootProofManifest && taprootProofManifest.manifestCore.selectedTapLeafHash,
    jurassicMechanismRefId: quote.quoteCore.jurassicMechanisms.refId,
    roundClaimHandleId: quote.quoteCore.roundClaimHandleId,
    roundCarrierCommitmentId: quote.quoteCore.roundCarrierCommitmentId,
    roundTranscriptDigest: quote.quoteCore.roundTranscriptDigest,
    deliveredInboundSats: deliveredInboundSats.toString(),
    observedFeePpm,
    observedCltvDelta,
    missingExitPath,
    missingForfeitPath,
    violations
  };

  return {
    kind: 'ark_ln_liquidity_graft_challenge',
    challengeId: hashCanonical(challengeCore),
    challengeCore,
    slashable: violations.length > 0
  };
}

function ceilDiv(a, b) {
  return (a + b - 1n) / b;
}

function satsFromVbytes(feeRateSatVb, vbytes) {
  return BigInt(Math.ceil(Number(feeRateSatVb) * Number(vbytes)));
}

function ppmCost(amountSats, ppm) {
  return ceilDiv(normalizeAmountSats(amountSats, 'amountSats') * BigInt(Number(ppm)), 1000000n);
}

function buildArkGraftCostModel(options = {}) {
  const graftCount = Number(options.graftCount || 24);
  const graftAmountSats = normalizeAmountSats(options.graftAmountSats || options.promisedInboundSats || 50000n, 'graftAmountSats');
  const feeRateSatVb = Number(options.feeRateSatVb ?? 25);
  const rebalanceFeePpm = Number(options.rebalanceFeePpm ?? 1200);
  const channelOpenVbytes = Number(options.channelOpenVbytes ?? 154);
  const channelCloseVbytes = Number(options.channelCloseVbytes ?? 154);
  const spliceVbytes = Number(options.spliceVbytes ?? 220);
  const arkRoundVbytes = Number(options.arkRoundVbytes ?? 420);
  const arkRoundParticipants = Number(options.arkRoundParticipants ?? 24);
  const arkAspFeePpm = Number(options.arkAspFeePpm ?? 250);
  const arkExitReserveVbytes = Number(options.arkExitReserveVbytes ?? 180);
  const arkExitProbabilityBps = Number(options.arkExitProbabilityBps ?? 50);
  const bitvmChallengeReserveSats = normalizeAmountSats(
    options.bitvmChallengeReserveSats ?? 5000n,
    'bitvmChallengeReserveSats'
  );

  const baselinePerGraftSats =
    satsFromVbytes(feeRateSatVb, channelOpenVbytes + channelCloseVbytes) +
    satsFromVbytes(feeRateSatVb, spliceVbytes) +
    ppmCost(graftAmountSats, rebalanceFeePpm);
  const baselineTotalSats = baselinePerGraftSats * BigInt(graftCount);

  const arkRoundShareSats = ceilDiv(satsFromVbytes(feeRateSatVb, arkRoundVbytes), BigInt(arkRoundParticipants));
  const arkExitExpectedSats =
    (satsFromVbytes(feeRateSatVb, arkExitReserveVbytes) * BigInt(arkExitProbabilityBps)) / 10000n;
  const arkPerGraftSats = arkRoundShareSats + arkExitExpectedSats + ppmCost(graftAmountSats, arkAspFeePpm);
  const arkTotalSats = arkPerGraftSats * BigInt(graftCount) + bitvmChallengeReserveSats;
  const savingsSats = baselineTotalSats - arkTotalSats;
  const savingsBps = baselineTotalSats > 0n ? Number((savingsSats * 10000n) / baselineTotalSats) : 0;
  const breakEvenGrafts =
    baselinePerGraftSats > arkPerGraftSats
      ? Number(ceilDiv(bitvmChallengeReserveSats, baselinePerGraftSats - arkPerGraftSats))
      : null;

  const modelCore = {
    version: 1,
    protocol: 'ark_ln_liquidity_graft_cost_model',
    graftCount,
    graftAmountSats: graftAmountSats.toString(),
    feeRateSatVb,
    baseline: {
      channelOpenVbytes,
      channelCloseVbytes,
      spliceVbytes,
      rebalanceFeePpm,
      perGraftSats: baselinePerGraftSats.toString(),
      totalSats: baselineTotalSats.toString()
    },
    ark: {
      arkRoundVbytes,
      arkRoundParticipants,
      arkAspFeePpm,
      arkExitReserveVbytes,
      arkExitProbabilityBps,
      roundShareSats: arkRoundShareSats.toString(),
      expectedExitSats: arkExitExpectedSats.toString(),
      bitvmChallengeReserveSats: bitvmChallengeReserveSats.toString(),
      perGraftSats: arkPerGraftSats.toString(),
      totalSats: arkTotalSats.toString()
    },
    comparison: {
      savingsSats: savingsSats.toString(),
      savingsBps,
      breakEvenGrafts,
      saferMarginalCost: arkPerGraftSats < baselinePerGraftSats,
      lowerTotalCost: arkTotalSats < baselineTotalSats
    }
  };

  return {
    kind: 'ark_ln_liquidity_graft_cost_model',
    modelId: hashCanonical(modelCore),
    modelCore,
    interpretation:
      'Ark makes short-lived liquidity patching cheaper when batched round share plus ASP fee plus expected exit cost is below repeated LN channel/splice/rebalance cost.'
  };
}

function buildArkLiquidityGraftBundle(options = {}) {
  const template = buildArkTemplateCommitment(options);
  const vtxo = buildArkVtxoLiquidityCommitment({ ...options, template });
  const quote = buildArkLiquidityGraftQuote({
    ...options,
    template,
    vtxo,
    paymentHashHex:
      options.paymentHashHex ||
      (options.htlcProof && options.htlcProof.lightning && options.htlcProof.lightning.paymentHashHex)
  });
  const taprootProofManifest =
    options.taprootProofManifest ||
    buildArkTaprootMiniscriptProofManifest({
      ...options,
      template,
      vtxo,
      selectedLeafRole: options.selectedLeafRole || 'cooperative_round',
      amountSats: quote.quoteCore.promisedInboundSats,
      settlementRoot: options.settlementRoot || sha256Hex(`ark-ln-graft-settlement:${quote.quoteId}`)
    });
  const settlementEvidence = buildArkGraftSettlementEvidence({
    ...options,
    template,
    vtxo,
    quote,
    taprootProofManifest
  });
  const challengeEvidence = buildArkGraftChallengeEvidence({
    quote,
    taprootProofManifest,
    deliveredInboundSats: options.challengeDeliveredInboundSats ?? 0n,
    observedFeePpm: options.challengeObservedFeePpm,
    observedCltvDelta: options.challengeObservedCltvDelta,
    missingExitPath: options.challengeMissingExitPath ?? false,
    missingForfeitPath: options.challengeMissingForfeitPath ?? true
  });
  const costModel = buildArkGraftCostModel({
    ...options,
    graftAmountSats: options.graftAmountSats || quote.quoteCore.promisedInboundSats
  });

  const bundleCore = {
    templateCommitmentId: template.templateCommitmentId,
    vtxoCommitmentId: vtxo.vtxoCommitmentId,
    quoteId: quote.quoteId,
    taprootProofManifestId: taprootProofManifest.manifestId,
    jurassicMechanismRefId: quote.quoteCore.jurassicMechanisms.refId,
    roundClaimHandleId: quote.quoteCore.roundClaimHandleId,
    roundCarrierCommitmentId: quote.quoteCore.roundCarrierCommitmentId,
    settlementId: settlementEvidence.settlementId,
    challengeId: challengeEvidence.challengeId,
    costModelId: costModel.modelId
  };

  return {
    kind: 'ark_ln_bitvm_liquidity_graft_bundle',
    bundleId: hashCanonical(bundleCore),
    bundleCore,
    template,
    vtxo,
    quote,
    taprootProofManifest,
    settlementEvidence,
    challengeEvidence,
    costModel,
    thesis:
      'Use Ark VTXOs as fast temporary liquidity grafts for LN edge routes, reducing fee volatility while BitVM/DLC commitments enforce the liquidity lease if the ASP/LSP fails.',
    caveats: [
      'This validates evidence shape and local regtest settlement references, not a production Ark round.',
      'Production needs real ASP signatures, VTXO tree proofs, connector tracking, and forfeit/exit validation.',
      'The BitVM lease remains the external challenge layer; Ark supplies the fast liquidity surface.'
    ],
    references: [
      'https://ark-protocol.org/intro/vtxos/index.html',
      'https://ark-protocol.org/intro/connectors/index.html',
      'https://docs.arklabs.xyz/ark/FAQ/'
    ]
  };
}

function verifyArkLiquidityGraftBundle(bundle) {
  if (!bundle || bundle.kind !== 'ark_ln_bitvm_liquidity_graft_bundle') {
    return { ok: false, reason: 'wrong bundle kind' };
  }
  if (bundle.bundleId !== hashCanonical(bundle.bundleCore)) {
    return { ok: false, reason: 'bundle id mismatch' };
  }
  if (!bundle.taprootProofManifest) {
    return { ok: false, reason: 'missing taproot proof manifest' };
  }
  const taprootVerification = verifyArkTaprootMiniscriptProofManifest(bundle.taprootProofManifest);
  if (!taprootVerification.ok) {
    return { ok: false, reason: `taproot proof manifest failed: ${taprootVerification.reason}` };
  }
  if (bundle.bundleCore.taprootProofManifestId !== bundle.taprootProofManifest.manifestId) {
    return { ok: false, reason: 'taproot proof manifest id mismatch' };
  }
  if (bundle.taprootProofManifest.manifestCore.vtxoCommitmentId !== bundle.vtxo.vtxoCommitmentId) {
    return { ok: false, reason: 'taproot proof manifest does not bind VTXO commitment' };
  }
  for (const [name, passed] of Object.entries(bundle.settlementEvidence.checks || {})) {
    if (!passed) return { ok: false, reason: `settlement evidence failed: ${name}` };
  }
  if (!bundle.challengeEvidence.slashable) {
    return { ok: false, reason: 'challenge should be slashable in demo bundle' };
  }
  if (!bundle.costModel || bundle.costModel.modelId !== hashCanonical(bundle.costModel.modelCore)) {
    return { ok: false, reason: 'cost model id mismatch' };
  }
  return { ok: true };
}

module.exports = {
  buildArkTemplateCommitment,
  buildArkVtxoLiquidityCommitment,
  buildArkLiquidityGraftQuote,
  buildArkGraftSettlementEvidence,
  buildArkGraftChallengeEvidence,
  buildArkGraftCostModel,
  buildArkLiquidityGraftBundle,
  verifyArkLiquidityGraftBundle
};
