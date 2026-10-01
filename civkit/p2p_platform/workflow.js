const crypto = require('crypto');
const escrow = require('../bitvm_escrow');
const { NotaryRegistry } = require('./registry');
const {
  asPolicy,
  asOffer,
  asNotaryProfile,
  quotePlatformFee,
  quoteNotaryFees
} = require('./fees');

function deriveTradeId(policy, offer, notary, startBlock) {
  const hash = crypto.createHash('sha256');
  hash.update(policy.hash());
  hash.update(offer.hash());
  hash.update(notary.hash());
  hash.update(Buffer.from(String(startBlock == null ? '' : startBlock), 'utf8'));
  return hash.digest('hex');
}

function openTradeSession({
  policy: policyLike,
  registry,
  offer: offerLike,
  selectedNotaryId = null,
  startBlock = null,
  authorizationMode = escrow.AUTHORIZATION_MODES.threshold2of3,
  splitRequiresNotary = true
}) {
  const policy = asPolicy(policyLike);
  const offer = asOffer(offerLike);

  if (!(registry instanceof NotaryRegistry)) {
    throw new Error('registry must be a NotaryRegistry');
  }

  const selection = selectedNotaryId == null
    ? registry.chooseNotary(policy, offer)
    : (() => {
      const profile = registry.get(selectedNotaryId);
      if (profile == null) {
        throw new Error(`Unknown notaryId: ${selectedNotaryId}`);
      }
      const eligibleIds = registry.listEligible(policy, offer).map((entry) => entry.notaryId);
      if (!eligibleIds.includes(profile.notaryId)) {
        throw new Error(`Notary ${profile.notaryId} is not eligible for this offer`);
      }
      return {
        profile,
        quote: quoteNotaryFees(profile, offer, policy)
      };
    })();

  const notary = asNotaryProfile(selection.profile);
  const platformFeeSats = quotePlatformFee(policy, offer);
  const feeQuote = {
    platformFeeSats,
    bookingFeeSats: selection.quote.bookingFeeSats,
    resolverFeeSats: selection.quote.resolverFeeSats,
    totalPotentialFeeSats:
      platformFeeSats +
      selection.quote.bookingFeeSats +
      selection.quote.resolverFeeSats
  };

  const fixedFeeOutputs = [];
  if (platformFeeSats > 0n) {
    fixedFeeOutputs.push({
      feeId: 'platform_fee',
      role: 'platform_fee',
      recipientScriptPubKey: policy.platformFeeScriptPubKey,
      amountSats: platformFeeSats
    });
  }
  if (selection.quote.bookingFeeSats > 0n) {
    fixedFeeOutputs.push({
      feeId: 'notary_booking_fee',
      role: 'notary_booking_fee',
      recipientScriptPubKey: notary.settlementScriptPubKey,
      amountSats: selection.quote.bookingFeeSats
    });
  }

  const normalizedStartBlock = startBlock == null ? null : BigInt(startBlock);
  const expiryBlock = normalizedStartBlock == null
    ? null
    : normalizedStartBlock + policy.escrowExpiryBlocks;
  const tradeId = deriveTradeId(policy, offer, notary, normalizedStartBlock);

  const escrowOrder = new escrow.EscrowOrder({
    orderId: tradeId,
    epochId: offer.epochId,
    escrowAmountSats: offer.amountSats,
    sellerPayoutScriptPubKey: offer.sellerPayoutScriptPubKey,
    buyerRefundScriptPubKey: offer.buyerRefundScriptPubKey,
    fixedFeeOutputs,
    resolverFeeScriptPubKey: notary.settlementScriptPubKey,
    expiryBlock,
    residualDest: offer.buyerRefundScriptPubKey
  });

  return {
    tradeId,
    policy,
    offer,
    notary,
    startBlock: normalizedStartBlock,
    expiryBlock,
    authorizationMode,
    bitvmPolicy: {
      authorizationMode,
      splitRequiresNotary
    },
    feeQuote,
    escrowOrder
  };
}

function verifyTradeSettlement(session, decisionLike, options = {}) {
  return escrow.verifyEscrowSettlement(session.escrowOrder, decisionLike, options);
}

function deriveTradeSignerSet(decisionLike, options = {}) {
  const decision = escrow.asEscrowDecision(decisionLike);
  const timeoutRoute = !!options.timeoutRoute || options.authorizationPath === 'refund_timeout';
  const splitRequiresNotary = options.splitRequiresNotary ?? true;

  if (timeoutRoute) {
    return {
      buyerSigned: true,
      sellerSigned: false,
      notarySigned: false
    };
  }

  if (decision.route === 'split') {
    return splitRequiresNotary
      ? {
        buyerSigned: true,
        sellerSigned: false,
        notarySigned: true
      }
      : {
        buyerSigned: true,
        sellerSigned: true,
        notarySigned: false
      };
  }

  return {
    buyerSigned: true,
    sellerSigned: true,
    notarySigned: false
  };
}

function resolveTradeSignerSet(session, decisionLike, options = {}) {
  return escrow.normalizeSignerSet(
    options.signerSet == null
      ? deriveTradeSignerSet(decisionLike, {
        timeoutRoute: options.timeoutRoute,
        authorizationPath: options.authorizationPath,
        splitRequiresNotary: options.splitRequiresNotary ?? session?.bitvmPolicy?.splitRequiresNotary
      })
      : options.signerSet
  );
}

function buildTradeSpendPackage(session, decisionLike, options = {}) {
  const timeoutRoute = !!options.timeoutRoute || options.authorizationPath === 'refund_timeout';
  const splitRequiresNotary = options.splitRequiresNotary ?? session.bitvmPolicy?.splitRequiresNotary;
  const signerSet = resolveTradeSignerSet(session, decisionLike, {
    signerSet: options.signerSet,
    timeoutRoute,
    authorizationPath: options.authorizationPath,
    splitRequiresNotary
  });

  return escrow.buildEscrowSpendPackage({
    orderLike: session.escrowOrder,
    decisionLike,
    keyset: options.keyset,
    fundingOutpoint: options.fundingOutpoint,
    network: options.network || 'regtest',
    internalPubkey: options.internalPubkey,
    authorizationPath: options.authorizationPath,
    includeCommitmentAnchor: options.includeCommitmentAnchor !== false,
    currentBlock: options.currentBlock,
    authorizationMode: options.authorizationMode || session.authorizationMode,
    signerSet,
    timeoutRoute,
    splitRequiresNotary,
    commitmentType: options.commitmentType || escrow.COMMITMENT_TYPES.transition
  });
}

function buildTradeBitvmChallengeBundle(session, decisionLike, options = {}) {
  const timeoutRoute = !!options.timeoutRoute || options.authorizationPath === 'refund_timeout';
  const splitRequiresNotary = options.splitRequiresNotary ?? session.bitvmPolicy?.splitRequiresNotary;
  const signerSet = resolveTradeSignerSet(session, decisionLike, {
    signerSet: options.signerSet,
    timeoutRoute,
    authorizationPath: options.authorizationPath,
    splitRequiresNotary
  });

  return escrow.buildEscrowBitvmChallengeBundle(
    session.escrowOrder,
    decisionLike,
    {
      signerSet,
      currentBlock: options.currentBlock,
      timeoutRoute,
      splitRequiresNotary
    }
  );
}

function planReleaseSettlement(session, options = {}) {
  const decision = new escrow.EscrowDecision({
    route: 'release',
    decisionId: options.decisionId || `release:${session.tradeId}`
  });
  return {
    decision,
    result: verifyTradeSettlement(session, decision, options)
  };
}

function planRefundSettlement(session, options = {}) {
  const decision = new escrow.EscrowDecision({
    route: 'refund',
    decisionId: options.decisionId || `refund:${session.tradeId}`
  });
  return {
    decision,
    result: verifyTradeSettlement(session, decision, options)
  };
}

function planSplitSettlement(
  session,
  {
    sellerAmountSats,
    buyerAmountSats,
    resolverFeeSats = session.feeQuote.resolverFeeSats,
    decisionId = `split:${session.tradeId}`
  }
) {
  const decision = new escrow.EscrowDecision({
    route: 'split',
    sellerAmountSats,
    buyerAmountSats,
    resolverFeeSats,
    decisionId
  });
  return {
    decision,
    result: verifyTradeSettlement(session, decision)
  };
}

module.exports = {
  openTradeSession,
  deriveTradeSignerSet,
  resolveTradeSignerSet,
  buildTradeSpendPackage,
  buildTradeBitvmChallengeBundle,
  verifyTradeSettlement,
  planReleaseSettlement,
  planRefundSettlement,
  planSplitSettlement
};
