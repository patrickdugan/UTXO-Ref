const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');
const { verifyLiquidityLeaseBundle } = require('./lightning_liquidity_lease');
const { verifyArkLiquidityGraftManagerBundle } = require('./ark_liquidity_graft_manager');
const { verifyLnBtcTlUsdLiquidityPatchBundle } = require('./lnbtc_tlusd_liquidity_patch');
const { verifyDlcSubswapFundingRequest } = require('./utxoref_dlc_subswap_funding');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value) {
  return sha256Hex(canonicalStringify(value));
}

function minBigInt(a, b) {
  return a < b ? a : b;
}

function normalizeString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function satsString(value, fieldName = 'amountSats') {
  return normalizeAmountSats(value, fieldName).toString();
}

function allChecksPass(checks = {}) {
  return Object.values(checks || {}).every(Boolean);
}

function ppmFromFeeSats(feeSats, amountSats) {
  const amount = normalizeAmountSats(amountSats, 'amountSats');
  if (amount === 0n) return 0;
  return Number((normalizeAmountSats(feeSats, 'feeSats') * 1000000n) / amount);
}

function makeCandidate(core, refs = {}) {
  const normalizedCore = {
    version: 1,
    protocol: 'bitvm_channel_router_candidate',
    ...core,
    promisedCapacitySats: satsString(core.promisedCapacitySats || core.availableCapacitySats, 'promisedCapacitySats'),
    availableCapacitySats: satsString(core.availableCapacitySats, 'availableCapacitySats'),
    feePpm: Number(core.feePpm || 0),
    cltvDelta: Number(core.cltvDelta || 0),
    priority: Number(core.priority || 0),
    slashable: Boolean(core.slashable)
  };

  return {
    kind: 'bitvm_channel_router_candidate',
    channelId: hashCanonical(normalizedCore),
    channelCore: normalizedCore,
    proofRefs: refs.proofRefs || [],
    challengeRefs: refs.challengeRefs || [],
    jurassicMotifs: refs.jurassicMotifs || {
      transcriptAliases: [normalizedCore.transcriptAlias],
      namespaceHandle: normalizedCore.namespaceHandle,
      carrierHints: [normalizedCore.carrier]
    },
    automationHooks: refs.automationHooks || []
  };
}

function leaseCandidate(leaseBundle) {
  if (!leaseBundle || leaseBundle.kind !== 'bitvm_lightning_liquidity_lease_bundle') return [];
  const verification = leaseBundle.verification || verifyLiquidityLeaseBundle(leaseBundle);
  const terms = leaseBundle.offer.terms;
  const evidence = leaseBundle.successEvidence.evidenceCore;
  const jurassicMechanisms = terms.jurassicMechanisms || {};
  const namespaceHandle =
    jurassicMechanisms.primaryPublicHandleId || `lease-${terms.leaseId}-${leaseBundle.offer.offerId.slice(0, 12)}`;
  const successOk = allChecksPass(leaseBundle.successEvidence.checks);
  const available = successOk
    ? minBigInt(BigInt(evidence.observedInboundSats), BigInt(terms.promisedInboundSats))
    : 0n;

  return [
    makeCandidate(
      {
        sourceType: 'liquidity_lease',
        sourceId: leaseBundle.bundleId,
        routeId: `lease:${terms.leaseId}`,
        channelPurpose: 'route_liquidity',
        networkSurface: 'lightning_channel_or_splice',
        counterpartyNodeId: terms.lspNodeId,
        promisedCapacitySats: terms.promisedInboundSats,
        availableCapacitySats: available.toString(),
        feePpm: evidence.observedFeePpm,
        cltvDelta: evidence.observedCltvDelta,
        priority: 20,
        status: verification.ok && successOk ? 'settled' : 'needs_attention',
        slashable: false,
        challengeAvailable: Boolean(leaseBundle.challengeEvidence && leaseBundle.challengeEvidence.slashable),
        commitmentRef: evidence.fundingCommitmentHash,
        proofRef: leaseBundle.successEvidence.evidenceId,
        challengeRef: leaseBundle.challengeEvidence.challengeId,
        carrier: 'ln_htlc_subswap_to_channel_splice',
        transcriptAlias: 'liquidity_lease_success_evidence',
        namespaceHandle
      },
      {
        proofRefs: [leaseBundle.successEvidence.evidenceId],
        challengeRefs: [leaseBundle.challengeEvidence.challengeId],
        jurassicMotifs: {
          transcriptAliases: ['lease_offer', 'channel_or_splice_success_evidence'],
          namespaceHandle,
          carrierHints: ['lightning_invoice', 'channel_or_splice_outpoint', 'bitvm_penalty_claim']
        },
        automationHooks: [
          'verify_lease_success_evidence',
          'reserve_channel_or_splice_capacity',
          'prepare_lease_challenge_if_route_observation_fails'
        ]
      }
    )
  ];
}

function assignmentSettlementOk(assignment) {
  return allChecksPass(assignment.settlementEvidence && assignment.settlementEvidence.checks);
}

function arkAssignmentCandidate(assignment, managerBundle, sourceType, extra = {}) {
  const settlement = assignment.settlementEvidence.settlementCore;
  const quote = assignment.quote.quoteCore;
  const route = assignment.route || {};
  const namespaceHandle =
    quote.roundClaimHandleId ||
    (quote.jurassicMechanisms && quote.jurassicMechanisms.primaryPublicHandleId) ||
    `${sourceType}-${assignment.assignmentCore.routeId}-${assignment.quote.quoteId.slice(0, 12)}`;
  const settlementOk = assignmentSettlementOk(assignment);
  const promised = BigInt(assignment.assignmentCore.promisedInboundSats);
  const delivered = BigInt(assignment.assignmentCore.deliveredInboundSats);
  const available = settlementOk ? minBigInt(promised, delivered) : 0n;
  const slashable = assignment.assignmentCore.status === 'slashable' || !settlementOk;

  return makeCandidate(
    {
      sourceType,
      sourceId: managerBundle.bundleId,
      routeId: assignment.assignmentCore.routeId,
      channelPurpose: 'route_liquidity',
      networkSurface: sourceType === 'tlusd_liquidity_patch'
        ? 'taproot_asset_pledged_ark_vtxo_graft'
        : 'ark_vtxo_lightning_graft',
      counterpartyNodeId: route.counterpartyNodeId || assignment.assignmentCore.edgeNodeId,
      promisedCapacitySats: assignment.assignmentCore.promisedInboundSats,
      availableCapacitySats: available.toString(),
      feePpm: settlement.observedFeePpm,
      cltvDelta: settlement.observedCltvDelta,
      priority: route.priority || 0,
      status: assignment.assignmentCore.status,
      slashable,
      challengeAvailable: Boolean(assignment.challengeEvidence && assignment.challengeEvidence.slashable),
      commitmentRef: assignment.vtxo.vtxoCommitmentId,
      proofRef: assignment.settlementEvidence.settlementId,
      challengeRef: assignment.challengeEvidence.challengeId,
      carrier: sourceType === 'tlusd_liquidity_patch'
        ? 'taproot_asset_stake_to_ark_round'
        : 'ark_vtxo_connector_outpoint',
      transcriptAlias: sourceType === 'tlusd_liquidity_patch'
        ? 'tlusd_patch_assignment_transcript'
        : 'ark_graft_assignment_transcript',
      namespaceHandle,
      assetTicker: extra.assetTicker || null,
      stakeCommitmentId: extra.stakeCommitmentId || null
    },
    {
      proofRefs: [
        assignment.settlementEvidence.settlementId,
        assignment.taprootProofManifest && assignment.taprootProofManifest.manifestId
      ].filter(Boolean),
      challengeRefs: [assignment.challengeEvidence.challengeId],
      jurassicMotifs: {
        transcriptAliases: [
          'route_liquidity_demand',
          sourceType === 'tlusd_liquidity_patch' ? 'tlusd_stake_mandate' : 'ark_graft_assignment',
          'bitvm_challenge_evidence'
        ],
        namespaceHandle,
        carrierHints: [
          sourceType === 'tlusd_liquidity_patch' ? 'taproot_asset_proof' : 'ark_vtxo',
          'lightning_route_observation',
          'bitvm_forfeit_or_exit_path'
        ]
      },
      automationHooks: [
        'reserve_assignment_capacity',
        'verify_taproot_or_vtxo_manifest',
        'monitor_route_delivery',
        'challenge_assignment_if_under_delivered'
      ]
    }
  );
}

function arkManagerCandidates(managerBundle) {
  if (!managerBundle || managerBundle.kind !== 'ark_ln_bitvm_liquidity_graft_manager_bundle') return [];
  const verification = managerBundle.verification || verifyArkLiquidityGraftManagerBundle(managerBundle);
  if (!verification.ok) return [];
  return managerBundle.allocation.assignments.map(assignment =>
    arkAssignmentCandidate(assignment, managerBundle, 'ark_graft_manager')
  );
}

function tlusdPatchCandidates(patchBundle) {
  if (!patchBundle || patchBundle.kind !== 'lnbtc_tlusd_liquidity_patch_bundle') return [];
  const verification = patchBundle.verification || verifyLnBtcTlUsdLiquidityPatchBundle(patchBundle);
  if (!verification.ok) return [];
  const manager = patchBundle.mandate.manager;
  return manager.allocation.assignments.map(assignment =>
    arkAssignmentCandidate(assignment, manager, 'tlusd_liquidity_patch', {
      assetTicker: patchBundle.conversion.stablecoin.asset.descriptorCore.ticker,
      stakeCommitmentId: patchBundle.stake.stakeCommitmentId
    })
  );
}

function dlcFundingCandidate(bundle) {
  if (!bundle) return [];
  const request = bundle.kind === 'utxoref_dlc_subswap_funding_request' ? bundle : bundle.request;
  if (!request || request.kind !== 'utxoref_dlc_subswap_funding_request') return [];
  const verification = bundle.verification || verifyDlcSubswapFundingRequest(request);
  const core = request.requestCore;
  const requestedCollateral = BigInt(core.submarineSwap.requestedCollateralSats);
  const swapFee = BigInt(core.submarineSwap.swapFeeSats);
  const proofOk = !request.executionProof || allChecksPass(request.executionProof.checks);
  const available = verification.ok && proofOk ? requestedCollateral : 0n;

  return [
    makeCandidate(
      {
        sourceType: 'dlc_subswap_funding',
        sourceId: request.requestId,
        routeId: `dlc-funding:${core.targetDlc.contractId}`,
        channelPurpose: 'funding_fallback',
        networkSurface: 'ln_invoice_to_p2wsh_dlc_output',
        counterpartyNodeId: core.walletNodeId,
        promisedCapacitySats: requestedCollateral.toString(),
        availableCapacitySats: available.toString(),
        feePpm: ppmFromFeeSats(swapFee, requestedCollateral),
        cltvDelta: Number(core.submarineSwap.refundBlocks || 0),
        priority: 5,
        status: verification.ok && proofOk ? 'verified' : 'needs_attention',
        slashable: false,
        challengeAvailable: false,
        commitmentRef: core.dlcFundingOutput.commitmentHash,
        proofRef: request.executionProof && request.executionProof.claimTxid,
        challengeRef: null,
        carrier: 'ln_invoice_p2wsh_htlc_dlc_funding_output',
        transcriptAlias: 'dlc_subswap_funding_request',
        namespaceHandle: core.jurassicMotifs.namespaceHandle
      },
      {
        proofRefs: [
          request.requestId,
          request.executionProof && request.executionProof.claimTxid,
          core.targetBindingHash
        ].filter(Boolean),
        challengeRefs: [],
        jurassicMotifs: core.jurassicMotifs,
        automationHooks: [
          'request_funding_invoice',
          'watch_htlc_claim_to_dlc_output',
          'verify_target_binding_hash'
        ]
      }
    )
  ];
}

function buildBitvmChannelInventory({
  liquidityLease = null,
  arkManager = null,
  tlusdPatch = null,
  dlcSubswapFunding = null
} = {}) {
  const channels = [
    ...leaseCandidate(liquidityLease),
    ...arkManagerCandidates(arkManager),
    ...tlusdPatchCandidates(tlusdPatch),
    ...dlcFundingCandidate(dlcSubswapFunding)
  ];
  const inventoryCore = {
    version: 1,
    protocol: 'bitvm_channel_router_inventory',
    sourceIds: {
      liquidityLease: liquidityLease && liquidityLease.bundleId,
      arkManager: arkManager && arkManager.bundleId,
      tlusdPatch: tlusdPatch && tlusdPatch.bundleId,
      dlcSubswapFunding:
        dlcSubswapFunding &&
        (dlcSubswapFunding.requestId || (dlcSubswapFunding.request && dlcSubswapFunding.request.requestId))
    },
    channelIds: channels.map(channel => channel.channelId)
  };

  return {
    kind: 'bitvm_channel_router_inventory',
    inventoryId: hashCanonical(inventoryCore),
    inventoryCore,
    channels
  };
}

function normalizeRouteIntent(intent = {}) {
  const amountSats = satsString(intent.amountSats || '120000', 'routeIntent.amountSats');
  const routeIntentCore = {
    version: 1,
    intentId: normalizeString(intent.intentId || 'bitvm-router-demo-intent', 'intentId'),
    useCase: normalizeString(intent.useCase || 'route_liquidity', 'useCase'),
    destinationNodeId: normalizeString(intent.destinationNodeId || 'ldk-router-destination-regtest', 'destinationNodeId'),
    amountSats,
    maxFeePpm: Number(intent.maxFeePpm ?? 1200),
    maxCltvDelta: Number(intent.maxCltvDelta ?? 45),
    allowSplitShards: intent.allowSplitShards !== false,
    assetTicker: intent.assetTicker || null
  };
  return {
    ...routeIntentCore,
    routeIntentId: hashCanonical(routeIntentCore)
  };
}

function normalizeRouterPolicy(policy = {}) {
  return {
    excludeSlashable: policy.excludeSlashable !== false,
    allowFundingFallback: Boolean(policy.allowFundingFallback),
    allowShortfall: Boolean(policy.allowShortfall),
    minShardSats: satsString(policy.minShardSats || '1000', 'policy.minShardSats'),
    sourcePreference: policy.sourcePreference || [
      'liquidity_lease',
      'ark_graft_manager',
      'tlusd_liquidity_patch',
      'dlc_subswap_funding'
    ]
  };
}

function candidateEligible(candidate, routeIntent, policy) {
  const core = candidate.channelCore;
  if (core.channelPurpose !== routeIntent.useCase) {
    if (!(core.channelPurpose === 'funding_fallback' && policy.allowFundingFallback)) {
      return false;
    }
  }
  if (policy.excludeSlashable && core.slashable) return false;
  if (core.status === 'needs_attention') return false;
  if (BigInt(core.availableCapacitySats) <= 0n) return false;
  if (core.feePpm > routeIntent.maxFeePpm && core.channelPurpose === 'route_liquidity') return false;
  if (core.cltvDelta > routeIntent.maxCltvDelta && core.channelPurpose === 'route_liquidity') return false;
  if (routeIntent.assetTicker && core.assetTicker && core.assetTicker !== routeIntent.assetTicker) return false;
  return true;
}

function sourceRank(sourceType, policy) {
  const index = policy.sourcePreference.indexOf(sourceType);
  return index === -1 ? policy.sourcePreference.length : index;
}

function candidateScore(candidate, routeIntent, policy) {
  const core = candidate.channelCore;
  const available = BigInt(core.availableCapacitySats);
  const target = BigInt(routeIntent.amountSats);
  const usefulCapacity = Number(minBigInt(available, target) / 1000n);
  const settledBonus = core.status === 'settled' || core.status === 'verified' ? 50000 : 0;
  const sourceBonus = (policy.sourcePreference.length - sourceRank(core.sourceType, policy)) * 1000;
  return settledBonus + sourceBonus + core.priority * 1000 + usefulCapacity - core.feePpm - core.cltvDelta * 10;
}

function selectChannels(inventory, routeIntent, policy) {
  let remaining = BigInt(routeIntent.amountSats);
  const minShard = BigInt(policy.minShardSats);
  const eligible = inventory.channels
    .filter(candidate => candidateEligible(candidate, routeIntent, policy))
    .map(candidate => ({
      candidate,
      score: candidateScore(candidate, routeIntent, policy)
    }))
    .sort((a, b) => b.score - a.score || a.candidate.channelId.localeCompare(b.candidate.channelId));

  const selected = [];
  for (const { candidate, score } of eligible) {
    if (remaining <= 0n) break;
    const available = BigInt(candidate.channelCore.availableCapacitySats);
    const assign = minBigInt(available, remaining);
    if (assign < minShard && assign < remaining) continue;
    selected.push({
      channelId: candidate.channelId,
      routeId: candidate.channelCore.routeId,
      sourceType: candidate.channelCore.sourceType,
      assignedSats: assign.toString(),
      availableCapacitySats: candidate.channelCore.availableCapacitySats,
      feePpm: candidate.channelCore.feePpm,
      cltvDelta: candidate.channelCore.cltvDelta,
      status: candidate.channelCore.status,
      score,
      proofRefs: candidate.proofRefs,
      challengeRefs: candidate.challengeRefs,
      transcriptAlias: candidate.channelCore.transcriptAlias,
      carrier: candidate.channelCore.carrier
    });
    remaining -= assign;
    if (!routeIntent.allowSplitShards) break;
  }

  return {
    selected,
    shortfallSats: remaining > 0n ? remaining.toString() : '0'
  };
}

function buildBitvmChannelRouterPlan(options = {}) {
  const inventory = options.inventory || buildBitvmChannelInventory(options.sources || options);
  const routeIntent = normalizeRouteIntent(options.routeIntent);
  const policy = normalizeRouterPolicy(options.policy);
  const selection = selectChannels(inventory, routeIntent, policy);
  const assignedSats = selection.selected.reduce((sum, channel) => sum + BigInt(channel.assignedSats), 0n).toString();
  const skippedSlashable = inventory.channels
    .filter(channel => channel.channelCore.slashable)
    .map(channel => ({
      channelId: channel.channelId,
      routeId: channel.channelCore.routeId,
      challengeRefs: channel.challengeRefs
    }));

  const planCore = {
    version: 1,
    protocol: 'bitvm_channel_router_plan',
    routeIntent,
    policy,
    inventoryId: inventory.inventoryId,
    selectedChannels: selection.selected.map(channel => ({
      channelId: channel.channelId,
      routeId: channel.routeId,
      sourceType: channel.sourceType,
      assignedSats: channel.assignedSats,
      proofRefs: channel.proofRefs,
      challengeRefs: channel.challengeRefs,
      transcriptAlias: channel.transcriptAlias,
      carrier: channel.carrier
    })),
    assignedSats,
    shortfallSats: selection.shortfallSats
  };

  return {
    kind: 'bitvm_channel_router_plan',
    routerId: hashCanonical(planCore),
    planCore,
    inventory,
    selectedChannels: selection.selected,
    skippedSlashable,
    jurassicMotifRouter: {
      transcriptMultiplicity:
        'Every shard keeps a public route transcript and a separate proof/challenge transcript.',
      identifierBifurcation:
        'The router id, public channel ids, private proof refs, and challenge refs are independently hashed but cross-bound.',
      carrierCamouflage:
        'The selected routes stay inside ordinary LN channel/splice evidence, Ark VTXOs, Taproot Asset proofs, and P2WSH HTLC funding outputs.'
    },
    automation: {
      preflight: [
        'verify inventory candidate ids',
        'filter slashable or over-fee channels',
        'score eligible BitVM-backed channels',
        'reserve route shards until the requested amount is covered'
      ],
      execute: selection.selected.map((channel, index) => ({
        step: index + 1,
        action: 'reserve_bitvm_channel_shard',
        channelId: channel.channelId,
        routeId: channel.routeId,
        assignedSats: channel.assignedSats,
        proofRefs: channel.proofRefs
      })),
      monitor: [
        'watch route observations for delivered inbound capacity',
        'refresh channel/splice, Ark, and Taproot Asset proof refs',
        'prepare challenge transactions when a selected proof stops matching policy'
      ],
      fallbackChallenges: skippedSlashable
    }
  };
}

function verifyInventory(inventory) {
  if (!inventory || inventory.kind !== 'bitvm_channel_router_inventory') {
    return { ok: false, reason: 'wrong inventory kind' };
  }
  for (const channel of inventory.channels || []) {
    if (channel.channelId !== hashCanonical(channel.channelCore)) {
      return { ok: false, reason: `channel id mismatch: ${channel.channelCore && channel.channelCore.routeId}` };
    }
  }
  const expectedInventoryId = hashCanonical(inventory.inventoryCore);
  if (inventory.inventoryId !== expectedInventoryId) {
    return { ok: false, reason: 'inventory id mismatch' };
  }
  return { ok: true };
}

function verifyBitvmChannelRouterPlan(plan) {
  if (!plan || plan.kind !== 'bitvm_channel_router_plan') {
    return { ok: false, reason: 'wrong router plan kind' };
  }
  if (plan.routerId !== hashCanonical(plan.planCore)) {
    return { ok: false, reason: 'router id mismatch' };
  }
  const inventoryCheck = verifyInventory(plan.inventory);
  if (!inventoryCheck.ok) return inventoryCheck;

  const byId = new Map(plan.inventory.channels.map(channel => [channel.channelId, channel]));
  const seen = new Set();
  let assigned = 0n;
  for (const selection of plan.selectedChannels || []) {
    const channel = byId.get(selection.channelId);
    if (!channel) return { ok: false, reason: `selected channel missing from inventory: ${selection.channelId}` };
    if (seen.has(selection.channelId)) return { ok: false, reason: `duplicate selected channel: ${selection.channelId}` };
    seen.add(selection.channelId);
    if (plan.planCore.policy.excludeSlashable && channel.channelCore.slashable) {
      return { ok: false, reason: `slashable channel selected: ${channel.channelCore.routeId}` };
    }
    if (channel.channelCore.feePpm > plan.planCore.routeIntent.maxFeePpm && channel.channelCore.channelPurpose === 'route_liquidity') {
      return { ok: false, reason: `fee ceiling exceeded: ${channel.channelCore.routeId}` };
    }
    if (channel.channelCore.cltvDelta > plan.planCore.routeIntent.maxCltvDelta && channel.channelCore.channelPurpose === 'route_liquidity') {
      return { ok: false, reason: `cltv ceiling exceeded: ${channel.channelCore.routeId}` };
    }
    const amount = BigInt(selection.assignedSats);
    if (amount <= 0n) return { ok: false, reason: `non-positive shard amount: ${channel.channelCore.routeId}` };
    if (amount > BigInt(channel.channelCore.availableCapacitySats)) {
      return { ok: false, reason: `assigned amount exceeds available channel capacity: ${channel.channelCore.routeId}` };
    }
    assigned += amount;
  }

  if (assigned.toString() !== plan.planCore.assignedSats) {
    return { ok: false, reason: 'assigned sats mismatch' };
  }
  const target = BigInt(plan.planCore.routeIntent.amountSats);
  if (assigned < target && !plan.planCore.policy.allowShortfall) {
    return { ok: false, reason: 'route amount not fully covered' };
  }
  return { ok: true };
}

function buildBitvmChannelRouterWalletView(plan) {
  const verification = verifyBitvmChannelRouterPlan(plan);
  return {
    kind: 'wallet_bitvm_channel_router_view',
    status: verification.ok ? 'ready' : 'needs_attention',
    title: 'BitVM Channel Router',
    subtitle: `${plan.planCore.assignedSats}/${plan.planCore.routeIntent.amountSats} sats assigned across ${plan.selectedChannels.length} shard(s)`,
    routerId: plan.routerId,
    routeIntentId: plan.planCore.routeIntent.routeIntentId,
    targetAmountSats: plan.planCore.routeIntent.amountSats,
    assignedSats: plan.planCore.assignedSats,
    shortfallSats: plan.planCore.shortfallSats,
    maxFeePpm: plan.planCore.routeIntent.maxFeePpm,
    maxCltvDelta: plan.planCore.routeIntent.maxCltvDelta,
    selectedChannels: plan.selectedChannels.map(channel => ({
      channelId: channel.channelId,
      routeId: channel.routeId,
      sourceType: channel.sourceType,
      assignedSats: channel.assignedSats,
      feePpm: channel.feePpm,
      cltvDelta: channel.cltvDelta,
      status: channel.status
    })),
    skippedSlashable: plan.skippedSlashable,
    actions: [
      { id: 'quote_bitvm_route', label: 'Quote BitVM channel route' },
      { id: 'verify_router_plan', label: 'Verify router plan bindings' },
      { id: 'reserve_selected_shards', label: 'Reserve selected channel shards' },
      { id: 'monitor_or_challenge', label: 'Monitor route proofs or prepare challenge' }
    ],
    verification
  };
}

function buildBitvmChannelRouterBundle(options = {}) {
  const plan = buildBitvmChannelRouterPlan(options);
  const verification = verifyBitvmChannelRouterPlan(plan);
  return {
    kind: 'bitvm_channel_router_bundle',
    createdAt: options.createdAt || new Date().toISOString(),
    plan,
    walletView: buildBitvmChannelRouterWalletView(plan),
    verification
  };
}

function verifyBitvmChannelRouterBundle(bundle) {
  if (!bundle || bundle.kind !== 'bitvm_channel_router_bundle') {
    return { ok: false, reason: 'wrong router bundle kind' };
  }
  return verifyBitvmChannelRouterPlan(bundle.plan);
}

module.exports = {
  buildBitvmChannelInventory,
  buildBitvmChannelRouterPlan,
  verifyBitvmChannelRouterPlan,
  buildBitvmChannelRouterWalletView,
  buildBitvmChannelRouterBundle,
  verifyBitvmChannelRouterBundle
};
