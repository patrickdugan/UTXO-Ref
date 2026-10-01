const {
  MarketplacePolicy,
  NotaryProfile,
  MarketOffer
} = require('./types');

function asPolicy(policyLike) {
  return policyLike instanceof MarketplacePolicy
    ? policyLike
    : new MarketplacePolicy(policyLike);
}

function asNotaryProfile(profileLike) {
  return profileLike instanceof NotaryProfile
    ? profileLike
    : new NotaryProfile(profileLike);
}

function asOffer(offerLike) {
  return offerLike instanceof MarketOffer
    ? offerLike
    : new MarketOffer(offerLike);
}

function feeFromBps(amountSats, bps) {
  if (bps === 0) {
    return 0n;
  }
  const amount = BigInt(amountSats);
  return (amount * BigInt(bps) + 9999n) / 10000n;
}

function quotePlatformFee(policyLike, offerLike) {
  const policy = asPolicy(policyLike);
  const offer = asOffer(offerLike);
  return policy.platformFlatFeeSats + feeFromBps(offer.amountSats, policy.platformFeeBps);
}

function quoteNotaryFees(profileLike, offerLike, policyLike = null) {
  const notary = asNotaryProfile(profileLike);
  const offer = asOffer(offerLike);
  const policy = policyLike == null ? null : asPolicy(policyLike);

  if (policy != null && notary.resolverFeeBps > policy.maxResolverFeeBps) {
    throw new Error(
      `Notary ${notary.notaryId} resolverFeeBps ${notary.resolverFeeBps} exceeds policy max ${policy.maxResolverFeeBps}`
    );
  }

  const bookingFeeSats = notary.bookingFlatFeeSats + feeFromBps(offer.amountSats, notary.bookingFeeBps);
  const resolverFeeSats = notary.resolverFlatFeeSats + feeFromBps(offer.amountSats, notary.resolverFeeBps);

  return {
    bookingFeeSats,
    resolverFeeSats,
    totalPotentialFeeSats: bookingFeeSats + resolverFeeSats
  };
}

module.exports = {
  asPolicy,
  asNotaryProfile,
  asOffer,
  feeFromBps,
  quotePlatformFee,
  quoteNotaryFees
};
