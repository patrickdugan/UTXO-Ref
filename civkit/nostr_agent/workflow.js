const platform = require('../p2p_platform');
const escrow = require('../bitvm_escrow');
const { APP_NAMESPACE, EVENT_KINDS, AGENT_ROLES } = require('./types');
const { signEvent, canonicalJsonString, verifyEvent, tagValue } = require('./events');

function buildCommonTags(threadId, role, extraTags = []) {
  return [
    ['d', threadId],
    ['t', 'civkit-agent'],
    ['namespace', APP_NAMESPACE],
    ['role', role],
    ...extraTags
  ];
}

function serializeBitvmChallengeBundle(bundle) {
  return {
    route: bundle.route,
    threshold: bundle.threshold,
    signerSet: bundle.signerSet,
    verification: {
      ok: !!bundle.verification?.ok,
      reason: bundle.verification?.reason || null
    },
    binding: bundle.binding,
    transitionState: bundle.transitionState
  };
}

function buildManagedOfferEvent({
  privateKeyHex,
  policy,
  offer,
  threadId = offer.offerId,
  createdAt
}) {
  const normalizedPolicy = policy instanceof platform.MarketplacePolicy
    ? policy
    : new platform.MarketplacePolicy(policy);
  const normalizedOffer = offer instanceof platform.MarketOffer
    ? offer
    : new platform.MarketOffer(offer);

  return signEvent({
    kind: EVENT_KINDS.managedOffer,
    created_at: createdAt,
    tags: buildCommonTags(threadId, AGENT_ROLES.market, [
      ['offer', normalizedOffer.offerId],
      ['policy', normalizedPolicy.hash().toString('hex')],
      ['payment', normalizedOffer.paymentMethod],
      ['region', normalizedOffer.region]
    ]),
    content: canonicalJsonString({
      threadId,
      offerId: normalizedOffer.offerId,
      offerHash: normalizedOffer.hash().toString('hex'),
      policyId: normalizedPolicy.policyId,
      policyHash: normalizedPolicy.hash().toString('hex'),
      epochId: normalizedOffer.epochId.toString(),
      amountSats: normalizedOffer.amountSats.toString(),
      fiatCurrency: normalizedOffer.fiatCurrency,
      fiatAmountMinor: normalizedOffer.fiatAmountMinor.toString(),
      paymentMethod: normalizedOffer.paymentMethod,
      region: normalizedOffer.region,
      sellerId: normalizedOffer.sellerId
    })
  }, privateKeyHex);
}

function buildNotaryAssignmentEvent({
  privateKeyHex,
  session,
  createdAt
}) {
  return signEvent({
    kind: EVENT_KINDS.notaryAssignment,
    created_at: createdAt,
    tags: buildCommonTags(session.tradeId, AGENT_ROLES.notary, [
      ['offer', session.offer.offerId],
      ['notary', session.notary.notaryId],
      ['order', session.escrowOrder.hash().toString('hex')],
      ['authorization_mode', session.authorizationMode]
    ]),
    content: canonicalJsonString({
      tradeId: session.tradeId,
      offerId: session.offer.offerId,
      orderHash: session.escrowOrder.hash().toString('hex'),
      notaryId: session.notary.notaryId,
      nostrPubkey: session.notary.nostrPubkey,
      authorizationMode: session.authorizationMode,
      splitRequiresNotary: !!session.bitvmPolicy?.splitRequiresNotary,
      expiryBlock: session.expiryBlock == null ? null : session.expiryBlock.toString(),
      feeQuote: {
        platformFeeSats: session.feeQuote.platformFeeSats.toString(),
        bookingFeeSats: session.feeQuote.bookingFeeSats.toString(),
        resolverFeeSats: session.feeQuote.resolverFeeSats.toString(),
        totalPotentialFeeSats: session.feeQuote.totalPotentialFeeSats.toString()
      }
    })
  }, privateKeyHex);
}

function buildSettlementDecisionEvent({
  privateKeyHex,
  session,
  decisionLike,
  spendPackage = null,
  keyset = null,
  fundingOutpoint = null,
  authorizationPath = null,
  authorizationMode = null,
  signerSet = null,
  splitRequiresNotary = null,
  timeoutRoute = null,
  network = 'regtest',
  currentBlock = null,
  createdAt
}) {
  const resolvedAuthorizationMode =
    authorizationMode ||
    session.authorizationMode ||
    escrow.AUTHORIZATION_MODES.routeSpecific;
  const resolvedSplitRequiresNotary =
    splitRequiresNotary ??
    session.bitvmPolicy?.splitRequiresNotary ??
    true;
  const resolvedSpendPackage = spendPackage || platform.buildTradeSpendPackage(session, decisionLike, {
    keyset,
    fundingOutpoint,
    authorizationPath,
    network,
    currentBlock,
    authorizationMode: resolvedAuthorizationMode
  });
  const resolvedTimeoutRoute =
    timeoutRoute == null
      ? resolvedSpendPackage.txTemplate.authorizationPath === 'refund_timeout'
      : !!timeoutRoute;
  const resolvedSignerSet = platform.resolveTradeSignerSet(session, decisionLike, {
    signerSet,
    authorizationPath: resolvedSpendPackage.txTemplate.authorizationPath,
    timeoutRoute: resolvedTimeoutRoute,
    splitRequiresNotary: resolvedSplitRequiresNotary
  });
  const bitvmChallengeBundle = resolvedSpendPackage.bitvm || platform.buildTradeBitvmChallengeBundle(
    session,
    decisionLike,
    {
      signerSet: resolvedSignerSet,
      currentBlock,
      authorizationPath: resolvedSpendPackage.txTemplate.authorizationPath,
      timeoutRoute: resolvedTimeoutRoute,
      splitRequiresNotary: resolvedSplitRequiresNotary
    }
  );

  return signEvent({
    kind: EVENT_KINDS.settlementDecision,
    created_at: createdAt,
    tags: buildCommonTags(session.tradeId, AGENT_ROLES.settlement, [
      ['route', resolvedSpendPackage.settlement.decision.route],
      ['order', resolvedSpendPackage.settlement.orderHash.toString('hex')],
      ['decision', resolvedSpendPackage.settlement.decisionHash.toString('hex')],
      ['txid', resolvedSpendPackage.txTemplate.txId],
      ['authorization_mode', resolvedAuthorizationMode],
      ['bitvm_route', bitvmChallengeBundle.route],
      ['buyer_signed', resolvedSignerSet.buyerSigned ? '1' : '0'],
      ['seller_signed', resolvedSignerSet.sellerSigned ? '1' : '0'],
      ['notary_signed', resolvedSignerSet.notarySigned ? '1' : '0'],
      ['transition_commitment', bitvmChallengeBundle.binding.transitionCommitmentHashHex],
      ['selected_commitment', resolvedSpendPackage.binding.selectedCommitmentHashHex]
    ]),
    content: canonicalJsonString({
      tradeId: session.tradeId,
      route: resolvedSpendPackage.settlement.decision.route,
      authorizationMode: resolvedAuthorizationMode,
      authorizationPath: resolvedSpendPackage.txTemplate.authorizationPath,
      commitmentType: resolvedSpendPackage.commitmentType,
      authorization: resolvedSpendPackage.authorization,
      binding: resolvedSpendPackage.binding,
      signerSet: resolvedSignerSet,
      splitRequiresNotary: resolvedSplitRequiresNotary,
      orderHash: resolvedSpendPackage.settlement.orderHash.toString('hex'),
      decisionHash: resolvedSpendPackage.settlement.decisionHash.toString('hex'),
      refereeCommitmentHash: resolvedSpendPackage.settlement.commitment.hash().toString('hex'),
      bitvmTransitionCommitmentHash: bitvmChallengeBundle.binding.transitionCommitmentHashHex,
      bitvmChallenge: serializeBitvmChallengeBundle(bitvmChallengeBundle),
      taprootAddress: resolvedSpendPackage.taproot.address,
      taprootMerkleRoot: resolvedSpendPackage.taproot.merkleRootHex,
      selectedLeaf: resolvedSpendPackage.psbt.selectedLeaf.name,
      txId: resolvedSpendPackage.txTemplate.txId,
      txHex: resolvedSpendPackage.txTemplate.txHex,
      psbtBase64: resolvedSpendPackage.psbt.base64,
      commitmentAnchor: resolvedSpendPackage.txTemplate.commitmentAnchor == null
        ? null
        : resolvedSpendPackage.txTemplate.commitmentAnchor.hashHex,
      outputs: resolvedSpendPackage.txTemplate.outputs.map((output) => ({
        role: output.role,
        amountSats: output.amountSats.toString(),
        scriptPubKeyHex: output.scriptPubKeyHex
      }))
    })
  }, privateKeyHex);
}

function buildAgentTaskEvent({
  privateKeyHex,
  threadId,
  role,
  action,
  payload = {},
  createdAt
}) {
  return signEvent({
    kind: EVENT_KINDS.agentTask,
    created_at: createdAt,
    tags: buildCommonTags(threadId, role, [
      ['action', action]
    ]),
    content: canonicalJsonString({
      threadId,
      role,
      action,
      payload
    })
  }, privateKeyHex);
}

function buildEvidenceSubmissionEvent({
  privateKeyHex,
  threadId,
  evidence,
  evidenceHashHex,
  submittedBy,
  createdAt
}) {
  const normalizedHash = String(evidenceHashHex || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedHash)) {
    throw new Error('evidenceHashHex must be a 32-byte hex string');
  }

  return signEvent({
    kind: EVENT_KINDS.evidenceSubmission,
    created_at: createdAt,
    tags: buildCommonTags(threadId, AGENT_ROLES.arbitration, [
      ['evidence_hash', normalizedHash],
      ['submitted_by', String(submittedBy || '')]
    ]),
    content: canonicalJsonString({
      threadId,
      evidenceHashHex: normalizedHash,
      submittedBy: String(submittedBy || ''),
      evidence
    })
  }, privateKeyHex);
}

function buildAppealRequestEvent({
  privateKeyHex,
  threadId,
  decisionEvent,
  reasonCode,
  requestedBy,
  createdAt
}) {
  const decisionId = tagValue(decisionEvent, 'decision') || decisionEvent?.content?.decisionHash || null;
  return signEvent({
    kind: EVENT_KINDS.appealRequest,
    created_at: createdAt,
    tags: buildCommonTags(threadId, AGENT_ROLES.governance, [
      ['decision', String(decisionId || '')],
      ['requested_by', String(requestedBy || '')],
      ['reason_code', String(reasonCode || 'appeal_requested')]
    ]),
    content: canonicalJsonString({
      threadId,
      decisionId,
      requestedBy: String(requestedBy || ''),
      reasonCode: String(reasonCode || 'appeal_requested'),
      status: 'pending'
    })
  }, privateKeyHex);
}

function buildGovernanceAttestationEvent({
  privateKeyHex,
  threadId,
  policyHashHex,
  approvedSigners = [],
  revokedSigners = [],
  modelVersion = null,
  createdAt
}) {
  const normalizedPolicyHash = String(policyHashHex || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedPolicyHash)) {
    throw new Error('policyHashHex must be a 32-byte hex string');
  }

  return signEvent({
    kind: EVENT_KINDS.governanceAttestation,
    created_at: createdAt,
    tags: buildCommonTags(threadId, AGENT_ROLES.governance, [
      ['policy_hash', normalizedPolicyHash],
      ['model_version', modelVersion == null ? '' : String(modelVersion)]
    ]),
    content: canonicalJsonString({
      threadId,
      policyHashHex: normalizedPolicyHash,
      approvedSigners: approvedSigners.map((entry) => String(entry)),
      revokedSigners: revokedSigners.map((entry) => String(entry)),
      modelVersion: modelVersion == null ? null : String(modelVersion)
    })
  }, privateKeyHex);
}

function parseContent(event) {
  try {
    return JSON.parse(event.content);
  } catch (error) {
    return event.content;
  }
}

function deriveAgentTasks(state) {
  const tasks = [];
  if (!state.offer) {
    return tasks;
  }
  if (!state.assignment) {
    tasks.push({
      role: AGENT_ROLES.market,
      action: 'assign_curated_notary'
    });
    return tasks;
  }
  if (!state.decision) {
    tasks.push({
      role: AGENT_ROLES.settlement,
      action: 'monitor_trade_and_prepare_resolution'
    });
    return tasks;
  }

  const content = state.decision.content || {};
  if (!content.txHex) {
    tasks.push({
      role: AGENT_ROLES.settlement,
      action: 'build_settlement_transaction'
    });
    return tasks;
  }

  tasks.push({
    role: AGENT_ROLES.signing,
    action: `collect_${content.authorizationPath || 'route'}_signatures`
  });

  if (content.authorizationPath === 'refund_timeout') {
    tasks.push({
      role: AGENT_ROLES.broadcast,
      action: 'broadcast_timeout_refund_after_locktime'
    });
  } else {
    tasks.push({
      role: AGENT_ROLES.broadcast,
      action: 'broadcast_signed_settlement'
    });
  }

  return tasks;
}

function reduceManagedTradeEvents(events, { verifySignatures = true } = {}) {
  const sortedEvents = events.slice().sort((left, right) => {
    if (left.created_at !== right.created_at) {
      return left.created_at - right.created_at;
    }
    return String(left.id || '').localeCompare(String(right.id || ''));
  });

  const state = {
    threadId: sortedEvents.length > 0 ? tagValue(sortedEvents[0], 'd') : null,
    phase: 'empty',
    offer: null,
    assignment: null,
    decision: null,
    evidence: [],
    appeal: null,
    governance: [],
    tasks: [],
    invalidEvents: []
  };

  sortedEvents.forEach((event) => {
    if (verifySignatures && !verifyEvent(event)) {
      state.invalidEvents.push(event);
      return;
    }

    const parsed = {
      ...event,
      content: parseContent(event)
    };

    switch (event.kind) {
      case EVENT_KINDS.managedOffer:
        state.offer = parsed;
        break;
      case EVENT_KINDS.notaryAssignment:
        state.assignment = parsed;
        break;
      case EVENT_KINDS.settlementDecision:
        state.decision = parsed;
        break;
      case EVENT_KINDS.evidenceSubmission:
        state.evidence.push(parsed);
        break;
      case EVENT_KINDS.appealRequest:
        state.appeal = parsed;
        break;
      case EVENT_KINDS.governanceAttestation:
        state.governance.push(parsed);
        break;
      case EVENT_KINDS.agentTask:
        state.tasks.push(parsed);
        break;
      default:
        break;
    }
  });

  if (state.offer && !state.assignment) {
    state.phase = 'offer_open';
  } else if (state.assignment && !state.decision) {
    state.phase = state.evidence.length > 0 ? 'dispute_open' : 'escrow_live';
  } else if (state.decision) {
    state.phase = state.appeal == null ? 'decision_ready' : 'appeal_pending';
  }

  state.derivedTasks = deriveAgentTasks(state);
  return state;
}

module.exports = {
  buildManagedOfferEvent,
  buildNotaryAssignmentEvent,
  buildSettlementDecisionEvent,
  buildAgentTaskEvent,
  buildEvidenceSubmissionEvent,
  buildAppealRequestEvent,
  buildGovernanceAttestationEvent,
  deriveAgentTasks,
  reduceManagedTradeEvents
};
