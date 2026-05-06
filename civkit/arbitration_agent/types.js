const crypto = require('crypto');

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('hex');
  }
  return value;
}

function canonicalJsonString(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(value) {
  return crypto.createHash('sha256')
    .update(typeof value === 'string' ? value : canonicalJsonString(value))
    .digest('hex');
}

function normalizeBps(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > 10000) {
    throw new Error(`${label} must be an integer between 0 and 10000`);
  }
  return normalized;
}

function normalizeOptionalBigInt(value, label) {
  if (value == null) {
    return null;
  }
  const normalized = BigInt(value);
  if (normalized < 0n) {
    throw new Error(`${label} must be non-negative`);
  }
  return normalized;
}

class ArbitrationPolicy {
  constructor({
    policyId,
    minSubAgentConfidenceBps = 6200,
    minDecisionConfidenceBps = 7000,
    splitBandBps = 1200,
    splitRequiresNotary = true,
    allowRelease = true,
    allowRefund = true,
    allowSplit = true,
    resolverFeeSats = null,
    claimType = 'general_dispute',
    minReleaseAuthenticityBps = 8000,
    minRefundAuthenticityBps = 3500,
    screenshotPenaltyBps = 2200
  }) {
    if (policyId == null || String(policyId).trim() === '') {
      throw new Error('policyId is required');
    }

    this.policyId = String(policyId);
    this.minSubAgentConfidenceBps = normalizeBps(
      minSubAgentConfidenceBps,
      'minSubAgentConfidenceBps'
    );
    this.minDecisionConfidenceBps = normalizeBps(
      minDecisionConfidenceBps,
      'minDecisionConfidenceBps'
    );
    this.splitBandBps = normalizeBps(splitBandBps, 'splitBandBps');
    this.splitRequiresNotary = !!splitRequiresNotary;
    this.allowRelease = !!allowRelease;
    this.allowRefund = !!allowRefund;
    this.allowSplit = !!allowSplit;
    this.resolverFeeSats = normalizeOptionalBigInt(resolverFeeSats, 'resolverFeeSats');
    this.claimType = String(claimType || 'general_dispute');
    this.minReleaseAuthenticityBps = normalizeBps(
      minReleaseAuthenticityBps,
      'minReleaseAuthenticityBps'
    );
    this.minRefundAuthenticityBps = normalizeBps(
      minRefundAuthenticityBps,
      'minRefundAuthenticityBps'
    );
    this.screenshotPenaltyBps = normalizeBps(screenshotPenaltyBps, 'screenshotPenaltyBps');
  }

  toJSON() {
    return {
      policyId: this.policyId,
      minSubAgentConfidenceBps: this.minSubAgentConfidenceBps,
      minDecisionConfidenceBps: this.minDecisionConfidenceBps,
      splitBandBps: this.splitBandBps,
      splitRequiresNotary: this.splitRequiresNotary,
      allowRelease: this.allowRelease,
      allowRefund: this.allowRefund,
      allowSplit: this.allowSplit,
      resolverFeeSats: this.resolverFeeSats == null ? null : this.resolverFeeSats.toString(),
      claimType: this.claimType,
      minReleaseAuthenticityBps: this.minReleaseAuthenticityBps,
      minRefundAuthenticityBps: this.minRefundAuthenticityBps,
      screenshotPenaltyBps: this.screenshotPenaltyBps
    };
  }

  hash() {
    return Buffer.from(sha256Hex(this.toJSON()), 'hex');
  }
}

class EvidenceItem {
  constructor({
    evidenceId,
    kind,
    submittedBy,
    reliabilityBps = 7000,
    releaseWeightBps = 0,
    refundWeightBps = 0,
    authenticityBps = null,
    evidenceFormat = 'generic',
    summary = '',
    metadata = {}
  }) {
    if (evidenceId == null || String(evidenceId).trim() === '') {
      throw new Error('evidenceId is required');
    }
    if (kind == null || String(kind).trim() === '') {
      throw new Error('kind is required');
    }
    if (submittedBy == null || String(submittedBy).trim() === '') {
      throw new Error('submittedBy is required');
    }

    this.evidenceId = String(evidenceId);
    this.kind = String(kind);
    this.submittedBy = String(submittedBy);
    this.reliabilityBps = normalizeBps(reliabilityBps, 'reliabilityBps');
    this.releaseWeightBps = normalizeBps(releaseWeightBps, 'releaseWeightBps');
    this.refundWeightBps = normalizeBps(refundWeightBps, 'refundWeightBps');
    this.authenticityBps = authenticityBps == null
      ? this.reliabilityBps
      : normalizeBps(authenticityBps, 'authenticityBps');
    this.evidenceFormat = String(evidenceFormat || 'generic');
    this.summary = String(summary || '');
    this.metadata = metadata && typeof metadata === 'object' ? metadata : {};
  }

  toJSON() {
    return {
      evidenceId: this.evidenceId,
      kind: this.kind,
      submittedBy: this.submittedBy,
      reliabilityBps: this.reliabilityBps,
      releaseWeightBps: this.releaseWeightBps,
      refundWeightBps: this.refundWeightBps,
      authenticityBps: this.authenticityBps,
      evidenceFormat: this.evidenceFormat,
      summary: this.summary,
      metadata: this.metadata
    };
  }

  hash() {
    return Buffer.from(sha256Hex(this.toJSON()), 'hex');
  }
}

class SubAgentReview {
  constructor({
    agentId,
    agentRole,
    recommendedRoute,
    confidenceBps,
    releaseScoreBps,
    refundScoreBps,
    releaseAuthenticityBps = 0,
    refundAuthenticityBps = 0,
    citedEvidenceIds = [],
    notes = []
  }) {
    if (agentId == null || String(agentId).trim() === '') {
      throw new Error('agentId is required');
    }
    if (agentRole == null || String(agentRole).trim() === '') {
      throw new Error('agentRole is required');
    }

    this.agentId = String(agentId);
    this.agentRole = String(agentRole);
    this.recommendedRoute = String(recommendedRoute);
    this.confidenceBps = normalizeBps(confidenceBps, 'confidenceBps');
    this.releaseScoreBps = Number(releaseScoreBps);
    this.refundScoreBps = Number(refundScoreBps);
    this.releaseAuthenticityBps = normalizeBps(
      releaseAuthenticityBps,
      'releaseAuthenticityBps'
    );
    this.refundAuthenticityBps = normalizeBps(
      refundAuthenticityBps,
      'refundAuthenticityBps'
    );
    this.citedEvidenceIds = Array.isArray(citedEvidenceIds)
      ? citedEvidenceIds.map((entry) => String(entry))
      : [];
    this.notes = Array.isArray(notes) ? notes.map((entry) => String(entry)) : [];
  }

  toJSON() {
    return {
      agentId: this.agentId,
      agentRole: this.agentRole,
      recommendedRoute: this.recommendedRoute,
      confidenceBps: this.confidenceBps,
      releaseScoreBps: this.releaseScoreBps,
      refundScoreBps: this.refundScoreBps,
      releaseAuthenticityBps: this.releaseAuthenticityBps,
      refundAuthenticityBps: this.refundAuthenticityBps,
      citedEvidenceIds: this.citedEvidenceIds,
      notes: this.notes
    };
  }

  hash() {
    return Buffer.from(sha256Hex(this.toJSON()), 'hex');
  }
}

class ArbitrationReceipt {
  constructor({
    arbitrationId,
    arbitratorId,
    trustedToSign,
    finalRoute,
    finalConfidenceBps,
    reasonCode,
    policyHashHex,
    evidenceRootHex,
    reviewsRootHex,
    binding = {},
    chainContext = {}
  }) {
    if (arbitrationId == null || String(arbitrationId).trim() === '') {
      throw new Error('arbitrationId is required');
    }
    if (arbitratorId == null || String(arbitratorId).trim() === '') {
      throw new Error('arbitratorId is required');
    }

    this.arbitrationId = String(arbitrationId);
    this.arbitratorId = String(arbitratorId);
    this.trustedToSign = !!trustedToSign;
    this.finalRoute = String(finalRoute);
    this.finalConfidenceBps = normalizeBps(finalConfidenceBps, 'finalConfidenceBps');
    this.reasonCode = String(reasonCode || '');
    this.policyHashHex = String(policyHashHex || '');
    this.evidenceRootHex = String(evidenceRootHex || '');
    this.reviewsRootHex = String(reviewsRootHex || '');
    this.binding = binding && typeof binding === 'object' ? binding : {};
    this.chainContext = chainContext && typeof chainContext === 'object' ? chainContext : {};
  }

  toJSON() {
    return {
      arbitrationId: this.arbitrationId,
      arbitratorId: this.arbitratorId,
      trustedToSign: this.trustedToSign,
      finalRoute: this.finalRoute,
      finalConfidenceBps: this.finalConfidenceBps,
      reasonCode: this.reasonCode,
      policyHashHex: this.policyHashHex,
      evidenceRootHex: this.evidenceRootHex,
      reviewsRootHex: this.reviewsRootHex,
      binding: this.binding,
      chainContext: this.chainContext
    };
  }

  hash() {
    return Buffer.from(sha256Hex(this.toJSON()), 'hex');
  }
}

module.exports = {
  canonicalize,
  canonicalJsonString,
  sha256Hex,
  ArbitrationPolicy,
  EvidenceItem,
  SubAgentReview,
  ArbitrationReceipt
};
