const { NotaryProfile } = require('./types');
const { asPolicy, asOffer, asNotaryProfile, quoteNotaryFees } = require('./fees');

function compareBigIntAsc(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

class NotaryRegistry {
  constructor(profiles = []) {
    this.profiles = new Map();
    profiles.forEach((profile) => this.register(profile));
  }

  register(profileLike) {
    const profile = asNotaryProfile(profileLike);
    this.profiles.set(profile.notaryId, profile);
    return profile;
  }

  get(notaryId) {
    return this.profiles.get(String(notaryId)) || null;
  }

  listEligible(policyLike, offerLike) {
    const policy = asPolicy(policyLike);
    const offer = asOffer(offerLike);

    return Array.from(this.profiles.values()).filter((profile) => {
      if (!profile.active) {
        return false;
      }
      if (!profile.whitelistTags.includes(policy.requiredWhitelistTag)) {
        return false;
      }
      if (profile.reputationScore < policy.minNotaryReputation) {
        return false;
      }
      if (offer.amountSats < profile.minTradeSats) {
        return false;
      }
      if (profile.maxTradeSats != null && offer.amountSats > profile.maxTradeSats) {
        return false;
      }
      if (
        policy.allowedPaymentMethods.length > 0 &&
        !policy.allowedPaymentMethods.includes(offer.paymentMethod)
      ) {
        return false;
      }
      if (
        policy.allowedRegions.length > 0 &&
        !policy.allowedRegions.includes(offer.region)
      ) {
        return false;
      }
      if (
        profile.supportedPaymentMethods.length > 0 &&
        !profile.supportedPaymentMethods.includes(offer.paymentMethod)
      ) {
        return false;
      }
      if (
        profile.supportedRegions.length > 0 &&
        !profile.supportedRegions.includes(offer.region)
      ) {
        return false;
      }

      try {
        quoteNotaryFees(profile, offer, policy);
        return true;
      } catch (error) {
        return false;
      }
    });
  }

  chooseNotary(policyLike, offerLike, options = {}) {
    const offer = asOffer(offerLike);
    const eligible = this.listEligible(policyLike, offer);

    if (eligible.length === 0) {
      throw new Error('No eligible curated notaries found');
    }

    const preferredIds = Array.isArray(options.preferredNotaryIds) && options.preferredNotaryIds.length > 0
      ? options.preferredNotaryIds.map((value) => String(value))
      : offer.preferredNotaryIds;

    const candidatePool = preferredIds.length > 0
      ? eligible.filter((profile) => preferredIds.includes(profile.notaryId))
      : eligible;
    const rankedPool = candidatePool.length > 0 ? candidatePool : eligible;

    const scored = rankedPool.map((profile) => ({
      profile,
      quote: quoteNotaryFees(profile, offer, policyLike)
    }));

    scored.sort((left, right) => {
      const feeOrder = compareBigIntAsc(
        left.quote.totalPotentialFeeSats,
        right.quote.totalPotentialFeeSats
      );
      if (feeOrder !== 0) {
        return feeOrder;
      }
      if (left.profile.reputationScore !== right.profile.reputationScore) {
        return right.profile.reputationScore - left.profile.reputationScore;
      }
      return left.profile.notaryId.localeCompare(right.profile.notaryId);
    });

    return scored[0];
  }
}

module.exports = {
  NotaryRegistry
};
