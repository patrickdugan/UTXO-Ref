const crypto = require('crypto');
const escrow = require('../bitvm_escrow');
const platform = require('../p2p_platform');
const {
  ArbitrationPolicy,
  EvidenceItem,
  SubAgentReview,
  ArbitrationReceipt
} = require('./types');

const EVIDENCE_PRESETS = Object.freeze({
  chain_funding_confirmed: {
    releaseWeightBps: 400,
    refundWeightBps: 0,
    authenticityBps: 9800,
    evidenceFormat: 'chain'
  },
  fiat_receipt_match: {
    releaseWeightBps: 3200,
    refundWeightBps: 0,
    authenticityBps: 5200,
    evidenceFormat: 'screenshot'
  },
  payment_method_match: {
    releaseWeightBps: 900,
    refundWeightBps: 0,
    authenticityBps: 7600,
    evidenceFormat: 'metadata'
  },
  seller_denial: {
    releaseWeightBps: 0,
    refundWeightBps: 1800,
    authenticityBps: 7200,
    evidenceFormat: 'statement'
  },
  receipt_mismatch: {
    releaseWeightBps: 0,
    refundWeightBps: 2600,
    authenticityBps: 8200,
    evidenceFormat: 'metadata'
  },
  timeout_risk: {
    releaseWeightBps: 0,
    refundWeightBps: 900,
    authenticityBps: 8800,
    evidenceFormat: 'system'
  },
  seller_ack: {
    releaseWeightBps: 2600,
    refundWeightBps: 0,
    authenticityBps: 9000,
    evidenceFormat: 'counterparty_ack'
  },
  bank_api_match: {
    releaseWeightBps: 4200,
    refundWeightBps: 0,
    authenticityBps: 9700,
    evidenceFormat: 'bank_api'
  },
  open_banking_attestation: {
    releaseWeightBps: 4600,
    refundWeightBps: 0,
    authenticityBps: 9800,
    evidenceFormat: 'signed_attestation'
  },
  unverifiable_screenshot: {
    releaseWeightBps: 800,
    refundWeightBps: 400,
    authenticityBps: 2200,
    evidenceFormat: 'screenshot'
  }
});

const DEFAULT_SUB_AGENT_PROFILES = Object.freeze([
  Object.freeze({
    agentId: 'seller_case_agent',
    agentRole: 'seller_case',
    releaseMultiplierBps: 11250,
    refundMultiplierBps: 9000
  }),
  Object.freeze({
    agentId: 'buyer_safety_agent',
    agentRole: 'buyer_safety',
    releaseMultiplierBps: 9000,
    refundMultiplierBps: 11250
  })
]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function asPolicy(policyLike) {
  return policyLike instanceof ArbitrationPolicy
    ? policyLike
    : new ArbitrationPolicy(policyLike);
}

function asEvidenceItem(evidenceLike) {
  if (evidenceLike instanceof EvidenceItem) {
    return evidenceLike;
  }

  const preset = EVIDENCE_PRESETS[String(evidenceLike.kind || '')] || {};
  return new EvidenceItem({
    ...preset,
    ...evidenceLike
  });
}

function buildHashRootHex(buffers) {
  const hash = crypto.createHash('sha256');
  buffers.forEach((entry) => hash.update(entry));
  return hash.digest('hex');
}

function determineRecommendedRoute(releaseScoreBps, refundScoreBps, splitBandBps) {
  const gap = Math.abs(releaseScoreBps - refundScoreBps);
  if (gap <= splitBandBps) {
    return 'split';
  }
  return releaseScoreBps > refundScoreBps ? 'release' : 'refund';
}

function computeConfidenceBps(route, releaseScoreBps, refundScoreBps) {
  const total = Math.max(1, releaseScoreBps + refundScoreBps);
  const gap = Math.abs(releaseScoreBps - refundScoreBps);

  if (route === 'split') {
    return clamp(6200 + Math.round(Math.min(total, 5000) / 5), 6200, 9300);
  }

  return clamp(5600 + Math.round((gap * 4200) / total), 5600, 9800);
}

function effectiveEvidenceAuthenticityBps(item, policy) {
  let authenticityBps = item.authenticityBps;
  if (item.evidenceFormat === 'screenshot') {
    authenticityBps = Math.max(0, authenticityBps - policy.screenshotPenaltyBps);
  }
  return authenticityBps;
}

function evaluateEvidenceForProfile(evidenceItems, profile, policy) {
  let releaseScoreBps = 0;
  let refundScoreBps = 0;
  let releaseAuthenticityWeighted = 0;
  let releaseAuthenticityWeight = 0;
  let refundAuthenticityWeighted = 0;
  let refundAuthenticityWeight = 0;
  const citedEvidenceIds = [];
  const notes = [];

  evidenceItems.forEach((item) => {
    const releaseWeight = Math.round(
      (item.releaseWeightBps * item.reliabilityBps * profile.releaseMultiplierBps) /
      10000 /
      10000
    );
    const refundWeight = Math.round(
      (item.refundWeightBps * item.reliabilityBps * profile.refundMultiplierBps) /
      10000 /
      10000
    );
    const authenticityBps = effectiveEvidenceAuthenticityBps(item, policy);

    releaseScoreBps += releaseWeight;
    refundScoreBps += refundWeight;
    if (releaseWeight > 0) {
      releaseAuthenticityWeighted += authenticityBps * releaseWeight;
      releaseAuthenticityWeight += releaseWeight;
    }
    if (refundWeight > 0) {
      refundAuthenticityWeighted += authenticityBps * refundWeight;
      refundAuthenticityWeight += refundWeight;
    }
    if (releaseWeight > 0 || refundWeight > 0) {
      citedEvidenceIds.push(item.evidenceId);
    }
    if (item.summary) {
      notes.push(`${item.kind}:${item.summary}:auth=${authenticityBps}`);
    }
  });

  const releaseAuthenticityBps = releaseAuthenticityWeight === 0
    ? 0
    : Math.round(releaseAuthenticityWeighted / releaseAuthenticityWeight);
  const refundAuthenticityBps = refundAuthenticityWeight === 0
    ? 0
    : Math.round(refundAuthenticityWeighted / refundAuthenticityWeight);

  const recommendedRoute = determineRecommendedRoute(
    releaseScoreBps,
    refundScoreBps,
    policy.splitBandBps
  );
  const confidenceBps = computeConfidenceBps(
    recommendedRoute,
    releaseScoreBps,
    refundScoreBps
  );

  return new SubAgentReview({
    agentId: profile.agentId,
    agentRole: profile.agentRole,
    recommendedRoute,
    confidenceBps,
    releaseScoreBps,
    refundScoreBps,
    releaseAuthenticityBps,
    refundAuthenticityBps,
    citedEvidenceIds,
    notes
  });
}

function deriveSplitAmounts(session, averageReleaseScoreBps, averageRefundScoreBps, resolverFeeSats) {
  const fixedFeeSats = session.escrowOrder.fixedFeeOutputs.reduce(
    (sum, output) => sum + BigInt(output.amountSats),
    0n
  );
  const distributable = BigInt(session.escrowOrder.escrowAmountSats) - fixedFeeSats - resolverFeeSats;
  if (distributable < 0n) {
    throw new Error('Escrow amount is insufficient for fixed fees plus resolver fee');
  }

  const normalizedRelease = BigInt(Math.max(averageReleaseScoreBps, 1));
  const normalizedRefund = BigInt(Math.max(averageRefundScoreBps, 1));
  const denominator = normalizedRelease + normalizedRefund;
  const sellerAmountSats = (distributable * normalizedRelease) / denominator;

  return {
    sellerAmountSats,
    buyerAmountSats: distributable - sellerAmountSats,
    resolverFeeSats
  };
}

function deriveArbitrationDecision(session, reviews, policyLike) {
  const policy = asPolicy(policyLike);
  const routes = Array.from(new Set(reviews.map((review) => review.recommendedRoute)));
  const minConfidenceBps = Math.min(...reviews.map((review) => review.confidenceBps));
  const averageReleaseScoreBps = average(reviews.map((review) => review.releaseScoreBps));
  const averageRefundScoreBps = average(reviews.map((review) => review.refundScoreBps));
  const averageReleaseAuthenticityBps = average(
    reviews.map((review) => review.releaseAuthenticityBps || 0)
  );
  const averageRefundAuthenticityBps = average(
    reviews.map((review) => review.refundAuthenticityBps || 0)
  );

  let route;
  let reasonCode;
  let decisionConfidenceBps;

  if (
    routes.length === 1 &&
    routes[0] !== 'split' &&
    minConfidenceBps >= policy.minSubAgentConfidenceBps
  ) {
    route = routes[0];
    reasonCode = `subagent_consensus_${route}`;
    decisionConfidenceBps = minConfidenceBps;
  } else {
    if (!policy.allowSplit) {
      throw new Error('Arbitration policy disallows split route');
    }
    route = 'split';
    reasonCode = routes.length === 1
      ? 'subagent_consensus_split'
      : 'subagent_disagreement_forced_split';
    decisionConfidenceBps = clamp(
      average(reviews.map((review) => review.confidenceBps)),
      policy.minDecisionConfidenceBps,
      9300
    );
  }

  if (route === 'release' && !policy.allowRelease) {
    throw new Error('Arbitration policy disallows release route');
  }
  if (route === 'refund' && !policy.allowRefund) {
    throw new Error('Arbitration policy disallows refund route');
  }

  if (route === 'release' && averageReleaseAuthenticityBps < policy.minReleaseAuthenticityBps) {
    if (!policy.allowSplit) {
      route = 'refund';
      reasonCode = 'release_authenticity_too_low_refund_bias';
      decisionConfidenceBps = clamp(minConfidenceBps, policy.minDecisionConfidenceBps, 9300);
    } else {
      route = 'split';
      reasonCode = 'release_authenticity_too_low_forced_split';
      decisionConfidenceBps = clamp(
        average(reviews.map((review) => review.confidenceBps)),
        policy.minDecisionConfidenceBps,
        9300
      );
    }
  }

  if (route === 'refund' && averageRefundAuthenticityBps < policy.minRefundAuthenticityBps) {
    route = 'split';
    reasonCode = 'refund_authenticity_too_low_forced_split';
    decisionConfidenceBps = clamp(
      average(reviews.map((review) => review.confidenceBps)),
      policy.minDecisionConfidenceBps,
      9300
    );
  }

  let decision;
  if (route === 'split') {
    const resolverFeeSats = policy.resolverFeeSats == null
      ? BigInt(session.feeQuote.resolverFeeSats)
      : BigInt(policy.resolverFeeSats);
    const split = deriveSplitAmounts(
      session,
      averageReleaseScoreBps,
      averageRefundScoreBps,
      resolverFeeSats
    );

    decision = new escrow.EscrowDecision({
      route: 'split',
      sellerAmountSats: split.sellerAmountSats,
      buyerAmountSats: split.buyerAmountSats,
      resolverFeeSats: split.resolverFeeSats,
      decisionId: `ai-split:${session.tradeId}`
    });
  } else {
    decision = new escrow.EscrowDecision({
      route,
      decisionId: `ai-${route}:${session.tradeId}`
    });
  }

  return {
    route,
    reasonCode,
    decisionConfidenceBps,
    minSubAgentConfidenceBps: minConfidenceBps,
    averageReleaseScoreBps,
    averageRefundScoreBps,
    averageReleaseAuthenticityBps,
    averageRefundAuthenticityBps,
    trustedToSign: decisionConfidenceBps >= policy.minDecisionConfidenceBps,
    decision
  };
}

function buildArbitrationReceipt({
  session,
  arbitratorId,
  policy,
  evidenceItems,
  reviews,
  decisionSummary,
  spendPackage,
  chainContext = {}
}) {
  const evidenceRootHex = buildHashRootHex(evidenceItems.map((item) => item.hash()));
  const reviewsRootHex = buildHashRootHex(reviews.map((review) => review.hash()));

  const receipt = new ArbitrationReceipt({
    arbitrationId: `${session.tradeId}:${decisionSummary.route}`,
    arbitratorId,
    trustedToSign: decisionSummary.trustedToSign,
    finalRoute: decisionSummary.route,
    finalConfidenceBps: decisionSummary.decisionConfidenceBps,
    reasonCode: decisionSummary.reasonCode,
    policyHashHex: policy.hash().toString('hex'),
    evidenceRootHex,
    reviewsRootHex,
    binding: {
      orderHashHex: spendPackage.settlement.orderHash.toString('hex'),
      decisionHashHex: spendPackage.settlement.decisionHash.toString('hex'),
      selectedCommitmentHashHex: spendPackage.binding.selectedCommitmentHashHex,
      settlementCommitmentHashHex: spendPackage.binding.settlementCommitmentHashHex,
      transitionCommitmentHashHex: spendPackage.binding.transitionCommitmentHashHex,
      taprootAddress: spendPackage.taproot.address,
      txId: spendPackage.txTemplate.txId
    },
    chainContext
  });

  return {
    evidenceRootHex,
    reviewsRootHex,
    receipt,
    receiptHashHex: receipt.hash().toString('hex')
  };
}

function runArbitratedTrade({
  session,
  policy: policyLike,
  evidence,
  arbitratorId = 'ai_arbitrator',
  subAgentProfiles = DEFAULT_SUB_AGENT_PROFILES,
  keyset,
  fundingOutpoint,
  network = 'regtest',
  currentBlock = null,
  chainContext = {},
  enforceTrustedExecution = true
}) {
  const policy = asPolicy(policyLike);
  const evidenceItems = evidence.map((entry) => asEvidenceItem(entry));
  const reviews = subAgentProfiles.map((profile) =>
    evaluateEvidenceForProfile(evidenceItems, profile, policy)
  );
  const decisionSummary = deriveArbitrationDecision(session, reviews, policy);

  if (enforceTrustedExecution && !decisionSummary.trustedToSign) {
    throw new Error('Arbitration result did not meet the trust threshold for autonomous signing');
  }

  const spendPackage = platform.buildTradeSpendPackage(session, decisionSummary.decision, {
    keyset,
    fundingOutpoint,
    network,
    currentBlock,
    splitRequiresNotary: policy.splitRequiresNotary
  });
  const bitvmChallengeBundle = spendPackage.bitvm || platform.buildTradeBitvmChallengeBundle(
    session,
    decisionSummary.decision,
    {
      currentBlock,
      splitRequiresNotary: policy.splitRequiresNotary
    }
  );
  const receipt = buildArbitrationReceipt({
    session,
    arbitratorId,
    policy,
    evidenceItems,
    reviews,
    decisionSummary,
    spendPackage,
    chainContext
  });

  return {
    policy,
    evidenceItems,
    reviews,
    decisionSummary,
    spendPackage,
    bitvmChallengeBundle,
    receipt
  };
}

module.exports = {
  EVIDENCE_PRESETS,
  DEFAULT_SUB_AGENT_PROFILES,
  asPolicy,
  asEvidenceItem,
  evaluateEvidenceForProfile,
  deriveArbitrationDecision,
  buildArbitrationReceipt,
  runArbitratedTrade,
  buildHashRootHex
};
