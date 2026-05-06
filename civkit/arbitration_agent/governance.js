const { sha256Hex } = require('./types');

function normalizePositiveInt(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return normalized;
}

class ArbitratorProfile {
  constructor({
    arbitratorId,
    approved = true,
    modelVersion = null,
    capabilities = [],
    bondSats = 0n
  }) {
    if (arbitratorId == null || String(arbitratorId).trim() === '') {
      throw new Error('arbitratorId is required');
    }
    this.arbitratorId = String(arbitratorId);
    this.approved = !!approved;
    this.modelVersion = modelVersion == null ? null : String(modelVersion);
    this.capabilities = Array.isArray(capabilities)
      ? capabilities.map((entry) => String(entry))
      : [];
    this.bondSats = BigInt(bondSats);
    if (this.bondSats < 0n) {
      throw new Error('bondSats must be non-negative');
    }
  }

  toJSON() {
    return {
      arbitratorId: this.arbitratorId,
      approved: this.approved,
      modelVersion: this.modelVersion,
      capabilities: this.capabilities,
      bondSats: this.bondSats.toString()
    };
  }

  hash() {
    return Buffer.from(sha256Hex(this.toJSON()), 'hex');
  }
}

class GovernancePolicy {
  constructor({
    policyId,
    minBondSats = 0n,
    requiredCapabilities = ['escrow_split'],
    allowedModelVersions = [],
    requireApproval = true,
    minAuditQuorum = 1
  }) {
    if (policyId == null || String(policyId).trim() === '') {
      throw new Error('policyId is required');
    }
    this.policyId = String(policyId);
    this.minBondSats = BigInt(minBondSats);
    if (this.minBondSats < 0n) {
      throw new Error('minBondSats must be non-negative');
    }
    this.requiredCapabilities = Array.isArray(requiredCapabilities)
      ? requiredCapabilities.map((entry) => String(entry))
      : [];
    this.allowedModelVersions = Array.isArray(allowedModelVersions)
      ? allowedModelVersions.map((entry) => String(entry))
      : [];
    this.requireApproval = !!requireApproval;
    this.minAuditQuorum = normalizePositiveInt(minAuditQuorum, 'minAuditQuorum');
  }

  toJSON() {
    return {
      policyId: this.policyId,
      minBondSats: this.minBondSats.toString(),
      requiredCapabilities: this.requiredCapabilities,
      allowedModelVersions: this.allowedModelVersions,
      requireApproval: this.requireApproval,
      minAuditQuorum: this.minAuditQuorum
    };
  }

  hash() {
    return Buffer.from(sha256Hex(this.toJSON()), 'hex');
  }
}

function evaluateArbitratorAuthority(profileLike, policyLike) {
  const profile = profileLike instanceof ArbitratorProfile
    ? profileLike
    : new ArbitratorProfile(profileLike);
  const policy = policyLike instanceof GovernancePolicy
    ? policyLike
    : new GovernancePolicy(policyLike);

  const missingCapabilities = policy.requiredCapabilities.filter(
    (capability) => !profile.capabilities.includes(capability)
  );
  const modelAllowed =
    policy.allowedModelVersions.length === 0 ||
    policy.allowedModelVersions.includes(profile.modelVersion);
  const authorized =
    (!policy.requireApproval || profile.approved) &&
    profile.bondSats >= policy.minBondSats &&
    missingCapabilities.length === 0 &&
    modelAllowed;

  return {
    authorized,
    missingCapabilities,
    modelAllowed,
    profile,
    policy
  };
}

module.exports = {
  ArbitratorProfile,
  GovernancePolicy,
  evaluateArbitratorAuthority
};
