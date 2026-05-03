const {
  sha256Hex
} = require('./tradelayer_pnl_route_adapter');

const HEX32_RE = /^[0-9a-f]{64}$/i;

function toSats(value, fieldName) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${fieldName} must be a safe integer`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`${fieldName} must be an integer sat amount`);
}

function normalizeOutpoint(value, fieldName) {
  const parts = String(value || '').split(':');
  if (parts.length !== 2 || !HEX32_RE.test(parts[0]) || !/^\d+$/.test(parts[1])) {
    throw new Error(`${fieldName} must be txid:vout`);
  }
  return `${parts[0].toLowerCase()}:${Number(parts[1])}`;
}

function evaluateRouteEvidence(terms, evidence) {
  const observedCapacitySats = toSats(evidence.observedCapacitySats ?? 0, 'routeEvidence.observedCapacitySats');
  const observedFeePpm = Number(evidence.observedFeePpm ?? terms.maxFeePpm + 1);
  const observedCltvDelta = Number(evidence.observedCltvDelta ?? terms.maxCltvDelta + 1);
  const violations = [];
  if (observedCapacitySats < BigInt(terms.promisedCapacitySats)) violations.push('insufficient_capacity');
  if (observedFeePpm > terms.maxFeePpm) violations.push('fee_ppm_above_ceiling');
  if (observedCltvDelta > terms.maxCltvDelta) violations.push('cltv_delta_above_ceiling');
  if (!evidence.channelOutpoint) violations.push('missing_channel_outpoint');
  return {
    ok: violations.length === 0,
    observedCapacitySats: observedCapacitySats.toString(),
    observedFeePpm,
    observedCltvDelta,
    violations
  };
}

function buildBitvmLiquidityLease(input = {}) {
  const committedUtxo = {
    outpoint: normalizeOutpoint(input.committedUtxo?.outpoint || `${'11'.repeat(32)}:0`, 'committedUtxo.outpoint'),
    sats: toSats(input.committedUtxo?.sats || input.promisedCapacitySats || 50000, 'committedUtxo.sats').toString(),
    address: String(input.committedUtxo?.address || 'provider-utxo-address')
  };
  const terms = {
    kind: 'bitvm_liquidity_lease_terms_v1',
    leaseId: String(input.leaseId || 'ln-liquidity-lease-demo'),
    providerNodeId: String(input.providerNodeId || 'provider-node'),
    routerNodeId: String(input.routerNodeId || 'router-node'),
    committedUtxo,
    promisedCapacitySats: toSats(input.promisedCapacitySats || committedUtxo.sats, 'promisedCapacitySats').toString(),
    leaseStartHeight: Number(input.leaseStartHeight || 0),
    leaseBlocks: Number(input.leaseBlocks || 144),
    maxFeePpm: Number(input.maxFeePpm ?? 1000),
    maxCltvDelta: Number(input.maxCltvDelta ?? 40),
    penaltySats: toSats(input.penaltySats || 5000, 'penaltySats').toString()
  };
  const routeEvidence = {
    channelOutpoint: input.routeEvidence?.channelOutpoint || null,
    observedCapacitySats: toSats(input.routeEvidence?.observedCapacitySats ?? terms.promisedCapacitySats, 'routeEvidence.observedCapacitySats').toString(),
    observedFeePpm: Number(input.routeEvidence?.observedFeePpm ?? terms.maxFeePpm),
    observedCltvDelta: Number(input.routeEvidence?.observedCltvDelta ?? terms.maxCltvDelta),
    observedAtHeight: Number(input.routeEvidence?.observedAtHeight ?? terms.leaseStartHeight)
  };
  const routeCheck = evaluateRouteEvidence(terms, routeEvidence);
  const core = {
    kind: 'bitvm_liquidity_lease_v1',
    terms,
    routeEvidence,
    routeEvidenceHash: sha256Hex(routeEvidence),
    routeCheck
  };
  const leaseHash = sha256Hex(core);
  return {
    kind: 'bitvm_liquidity_lease',
    leaseHash,
    core,
    enforcement: {
      successPath: routeCheck.ok ? 'release_provider_premium' : 'blocked',
      challengePath: routeCheck.ok ? 'none' : 'claim_penalty',
      penaltySats: terms.penaltySats
    }
  };
}

function verifyBitvmLiquidityLease(lease) {
  if (!lease || lease.kind !== 'bitvm_liquidity_lease') return { ok: false, reason: 'wrong lease kind' };
  if (!lease.core || typeof lease.core !== 'object') return { ok: false, reason: 'lease core missing' };
  const routeCheck = evaluateRouteEvidence(lease.core.terms, lease.core.routeEvidence);
  if (JSON.stringify(routeCheck) !== JSON.stringify(lease.core.routeCheck)) {
    return { ok: false, reason: 'route evidence check mismatch' };
  }
  if (lease.core.routeEvidenceHash !== sha256Hex(lease.core.routeEvidence)) {
    return { ok: false, reason: 'route evidence hash mismatch' };
  }
  const leaseHash = sha256Hex(lease.core);
  if (lease.leaseHash !== leaseHash) return { ok: false, reason: 'lease hash mismatch', leaseHash };
  const expectedAction = routeCheck.ok ? 'release_provider_premium' : 'blocked';
  if (lease.enforcement?.successPath !== expectedAction) {
    return { ok: false, reason: 'success path mismatch' };
  }
  return {
    ok: true,
    leaseHash,
    routeOk: routeCheck.ok,
    violations: routeCheck.violations
  };
}

function buildBitvmLiquidityLeaseChallenge(lease) {
  const result = verifyBitvmLiquidityLease(lease);
  if (!result.ok) throw new Error(`invalid lease: ${result.reason}`);
  const core = {
    kind: 'bitvm_liquidity_lease_challenge_v1',
    leaseHash: lease.leaseHash,
    violations: result.violations,
    penaltySats: lease.core.terms.penaltySats
  };
  return {
    kind: 'bitvm_liquidity_lease_challenge',
    challengeHash: sha256Hex(core),
    challengeable: result.violations.length > 0,
    core
  };
}

function verifyBitvmLiquidityLeaseChallenge(challenge, lease) {
  if (!challenge || challenge.kind !== 'bitvm_liquidity_lease_challenge') {
    return { ok: false, reason: 'wrong challenge kind' };
  }
  if (lease && challenge.core?.leaseHash !== lease.leaseHash) return { ok: false, reason: 'lease hash mismatch' };
  const challengeHash = sha256Hex(challenge.core);
  if (challenge.challengeHash !== challengeHash) return { ok: false, reason: 'challenge hash mismatch', challengeHash };
  return { ok: true, challengeHash, challengeable: challenge.challengeable };
}

module.exports = {
  buildBitvmLiquidityLease,
  verifyBitvmLiquidityLease,
  buildBitvmLiquidityLeaseChallenge,
  verifyBitvmLiquidityLeaseChallenge
};
