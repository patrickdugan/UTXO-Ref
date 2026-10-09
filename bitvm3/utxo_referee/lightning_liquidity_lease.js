/**
 * BitVM-backed Lightning liquidity lease prototype.
 *
 * This models an enforceable liquidity promise:
 * - Lightning payment receipt funds a full HTLC/subswap output.
 * - Success path pays into a BitVM/DLC commitment output.
 * - LSP must bind that output to promised channel/splice liquidity terms.
 * - Failure can be represented by deterministic challenge/penalty evidence.
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
  return value;
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

function msatFromSats(sats) {
  return (normalizeAmountSats(sats) * 1000n).toString();
}

function buildLiquidityLeaseOffer(options = {}) {
  const leaseId = normalizeString(options.leaseId || 'lease-regtest-demo', 'leaseId');
  const lspNodeId = normalizeString(options.lspNodeId || 'lsp-node-demo', 'lspNodeId');
  const clientNodeId = normalizeString(options.clientNodeId || 'client-node-demo', 'clientNodeId');
  const promisedInboundSats = normalizeAmountSats(options.promisedInboundSats || 50000n, 'promisedInboundSats');
  const leaseBlocks = Number(options.leaseBlocks || 144);
  const maxFeePpm = Number(options.maxFeePpm ?? 1000);
  const maxCltvDelta = Number(options.maxCltvDelta ?? 40);
  const penaltySats = normalizeAmountSats(options.penaltySats || promisedInboundSats / 10n, 'penaltySats');
  const leasePremiumSats = normalizeAmountSats(options.leasePremiumSats || 1000n, 'leasePremiumSats');
  const paymentHashHex = normalizeHex32(options.paymentHashHex || sha256Hex(`lease-payment:${leaseId}`), 'paymentHashHex');
  const refundLocktime = Number(options.refundLocktime || 0);
  const jurassicMechanisms = buildJurassicMechanismRefs('lightning', {
    contractId: leaseId,
    applicationIntent: 'Lightning liquidity lease proof packages and watchtower handles',
    route: 'liquidity_lease_success_or_timeout_challenge',
    amountSats: promisedInboundSats,
    settlementEpoch: `lightning-lease:${leaseId}`,
    challengeWindowBlocks: leaseBlocks
  });

  const terms = {
    version: 1,
    leaseId,
    lspNodeId,
    clientNodeId,
    promisedInboundSats: promisedInboundSats.toString(),
    leaseBlocks,
    maxFeePpm,
    maxCltvDelta,
    penaltySats: penaltySats.toString(),
    leasePremiumSats: leasePremiumSats.toString(),
    paymentHashHex,
    refundLocktime,
    jurassicMechanisms
  };

  return {
    kind: 'bitvm_lightning_liquidity_lease_offer',
    terms,
    offerId: hashCanonical(terms),
    invoiceAmountMsat: msatFromSats(leasePremiumSats + penaltySats),
    enforceableClaim: {
      success: 'LSP earns premium only after promised channel/splice evidence binds to the lease.',
      failure: 'Client/watchtower can claim penalty if the lease window opens without matching route evidence.'
    }
  };
}

function buildLeaseSuccessEvidence(options = {}) {
  const offer = options.offer || buildLiquidityLeaseOffer(options);
  const htlcProof = options.htlcProof || {};
  const channelOutpoint = normalizeOutpoint(
    options.channelOutpoint ||
      (htlcProof.dlcFunding ? `${htlcProof.dlcFunding.claimTxid}:${htlcProof.dlcFunding.outputVout}` : null),
    'channelOutpoint'
  );
  const fundingCommitmentHash = normalizeHex32(
    options.fundingCommitmentHash ||
      (htlcProof.dlcFunding && htlcProof.dlcFunding.commitmentHash),
    'fundingCommitmentHash'
  );
  const observedInboundSats = normalizeAmountSats(
    options.observedInboundSats || offer.terms.promisedInboundSats,
    'observedInboundSats'
  );
  const observedFeePpm = Number(options.observedFeePpm ?? offer.terms.maxFeePpm);
  const observedCltvDelta = Number(options.observedCltvDelta ?? offer.terms.maxCltvDelta);
  const observedAtBlock = Number(options.observedAtBlock || 0);

  const evidenceCore = {
    version: 1,
    offerId: offer.offerId,
    jurassicMechanismRefId: offer.terms.jurassicMechanisms.refId,
    transcriptSwitchboardId: offer.terms.jurassicMechanisms.transcriptSwitchboardId,
    publicHandleId: offer.terms.jurassicMechanisms.primaryPublicHandleId,
    carrierCommitmentId: offer.terms.jurassicMechanisms.primaryCarrierCommitmentId,
    channelOutpoint,
    fundingCommitmentHash,
    observedInboundSats: observedInboundSats.toString(),
    observedFeePpm,
    observedCltvDelta,
    observedAtBlock,
    source: 'channel_or_splice_state_snapshot'
  };

  return {
    kind: 'bitvm_lightning_liquidity_lease_success_evidence',
    evidenceId: hashCanonical(evidenceCore),
    evidenceCore,
    checks: {
      inboundCapacityMet: observedInboundSats >= BigInt(offer.terms.promisedInboundSats),
      feeCeilingMet: observedFeePpm <= offer.terms.maxFeePpm,
      cltvCeilingMet: observedCltvDelta <= offer.terms.maxCltvDelta,
      fundingOutputBound: fundingCommitmentHash === (htlcProof.dlcFunding && htlcProof.dlcFunding.commitmentHash)
    }
  };
}

function buildLeaseChallengeEvidence(options = {}) {
  const offer = options.offer || buildLiquidityLeaseOffer(options);
  const observedInboundSats = normalizeAmountSats(options.observedInboundSats ?? 0n, 'observedInboundSats');
  const observedFeePpm = Number(options.observedFeePpm ?? offer.terms.maxFeePpm + 1);
  const observedCltvDelta = Number(options.observedCltvDelta ?? offer.terms.maxCltvDelta + 1);
  const challengeBlock = Number(options.challengeBlock || offer.terms.refundLocktime || 0);
  const channelOutpoint = options.channelOutpoint
    ? normalizeOutpoint(options.channelOutpoint, 'channelOutpoint')
    : null;

  const violations = [];
  if (observedInboundSats < BigInt(offer.terms.promisedInboundSats)) violations.push('insufficient_inbound_capacity');
  if (observedFeePpm > offer.terms.maxFeePpm) violations.push('fee_ppm_above_ceiling');
  if (observedCltvDelta > offer.terms.maxCltvDelta) violations.push('cltv_delta_above_ceiling');
  if (!channelOutpoint) violations.push('missing_channel_or_splice_outpoint');

  const challengeCore = {
    version: 1,
    offerId: offer.offerId,
    jurassicMechanismRefId: offer.terms.jurassicMechanisms.refId,
    transcriptSwitchboardId: offer.terms.jurassicMechanisms.transcriptSwitchboardId,
    publicHandleId: offer.terms.jurassicMechanisms.primaryPublicHandleId,
    carrierCommitmentId: offer.terms.jurassicMechanisms.primaryCarrierCommitmentId,
    channelOutpoint,
    observedInboundSats: observedInboundSats.toString(),
    observedFeePpm,
    observedCltvDelta,
    challengeBlock,
    violations
  };

  return {
    kind: 'bitvm_lightning_liquidity_lease_challenge',
    challengeId: hashCanonical(challengeCore),
    challengeCore,
    penaltyClaim: {
      amountSats: offer.terms.penaltySats,
      reason: violations.join(',') || 'none'
    },
    slashable: violations.length > 0
  };
}

function buildLiquidityLeaseBundle(options = {}) {
  const htlcProof = options.htlcProof || null;
  const offer = buildLiquidityLeaseOffer({
    ...options,
    paymentHashHex: options.paymentHashHex || (htlcProof && htlcProof.lightning && htlcProof.lightning.paymentHashHex),
    refundLocktime: options.refundLocktime || (htlcProof && htlcProof.swap && htlcProof.swap.refundLocktime)
  });
  const successEvidence = buildLeaseSuccessEvidence({
    offer,
    htlcProof: htlcProof || {},
    channelOutpoint: options.channelOutpoint,
    fundingCommitmentHash: options.fundingCommitmentHash,
    observedInboundSats: options.observedInboundSats,
    observedFeePpm: options.observedFeePpm,
    observedCltvDelta: options.observedCltvDelta,
    observedAtBlock: options.observedAtBlock
  });
  const challengeEvidence = buildLeaseChallengeEvidence({
    offer,
    observedInboundSats: options.challengeObservedInboundSats ?? 0n,
    observedFeePpm: options.challengeObservedFeePpm,
    observedCltvDelta: options.challengeObservedCltvDelta,
    challengeBlock: options.challengeBlock,
    channelOutpoint: options.challengeChannelOutpoint
  });

  const bundleCore = {
    offerId: offer.offerId,
    jurassicMechanismRefId: offer.terms.jurassicMechanisms.refId,
    transcriptSwitchboardId: offer.terms.jurassicMechanisms.transcriptSwitchboardId,
    publicHandleId: offer.terms.jurassicMechanisms.primaryPublicHandleId,
    carrierCommitmentId: offer.terms.jurassicMechanisms.primaryCarrierCommitmentId,
    successEvidenceId: successEvidence.evidenceId,
    challengeId: challengeEvidence.challengeId,
    htlcFundingTxid: htlcProof && htlcProof.swap && htlcProof.swap.fundingTxid,
    dlcFundingTxid: htlcProof && htlcProof.dlcFunding && htlcProof.dlcFunding.claimTxid
  };

  return {
    kind: 'bitvm_lightning_liquidity_lease_bundle',
    bundleId: hashCanonical(bundleCore),
    bundleCore,
    offer,
    successEvidence,
    challengeEvidence,
    routingUseCases: [
      'LSP JIT inbound channel lease',
      'splice-in liquidity lease with penalty if unavailable',
      'route corridor capacity bond',
      'watchtower-audited route-quality SLA'
    ],
    caveats: [
      'This proves committed lease terms and local regtest HTLC funding, not global route availability.',
      'Production needs privacy-preserving route evidence and LDK-native channel/splice state hooks.'
    ]
  };
}

function verifyLiquidityLeaseBundle(bundle) {
  if (!bundle || bundle.kind !== 'bitvm_lightning_liquidity_lease_bundle') {
    return { ok: false, reason: 'wrong bundle kind' };
  }
  const expectedBundleId = hashCanonical(bundle.bundleCore);
  if (bundle.bundleId !== expectedBundleId) {
    return { ok: false, reason: 'bundle id mismatch' };
  }
  for (const [name, passed] of Object.entries(bundle.successEvidence.checks || {})) {
    if (!passed) return { ok: false, reason: `success evidence failed: ${name}` };
  }
  if (!bundle.challengeEvidence.slashable) {
    return { ok: false, reason: 'challenge should be slashable in demo bundle' };
  }
  return { ok: true };
}

module.exports = {
  buildLiquidityLeaseOffer,
  buildLeaseSuccessEvidence,
  buildLeaseChallengeEvidence,
  buildLiquidityLeaseBundle,
  verifyLiquidityLeaseBundle
};
