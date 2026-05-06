/**
 * Ark liquidity graft manager prototype.
 *
 * This layer coordinates many Ark VTXO grafts for Lightning route liquidity.
 * Ark supplies cheap temporary UTXO references; the BitVM/UTXORef policy is
 * the enforcement rail when an ASP/LSP under-delivers, overcharges, or hides
 * exit / forfeit paths.
 */

const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');
const {
  buildArkTemplateCommitment,
  buildArkVtxoLiquidityCommitment,
  buildArkLiquidityGraftQuote,
  buildArkGraftSettlementEvidence,
  buildArkGraftChallengeEvidence,
  buildArkGraftCostModel
} = require('./lightning_ark_liquidity_graft');
const {
  buildArkTaprootMiniscriptProofManifest,
  verifyArkTaprootMiniscriptProofManifest
} = require('./ark_taproot_miniscript_proof_manifest');

const HEX_32_RE = /^[0-9a-f]{64}$/i;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value) {
  return sha256Hex(canonicalStringify(value));
}

function paymentHashFromPreimage(preimageHex) {
  return sha256Hex(Buffer.from(preimageHex, 'hex'));
}

function normalizeString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
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

function sumBigInt(items, selector) {
  return items.reduce((acc, item) => acc + BigInt(selector(item)), 0n);
}

function buildArkLiquidityInventory(options = {}) {
  const template = options.template || buildArkTemplateCommitment(options);
  const aspId = template.templateCore.aspId;
  const managerId = normalizeString(options.managerId || 'ark-ln-liquidity-manager-regtest', 'managerId');
  const inventoryEpoch = normalizeString(options.inventoryEpoch || 'regtest-epoch-1', 'inventoryEpoch');
  const defaultAmounts = options.vtxoAmountsSats || [50000n, 75000n, 100000n, 125000n];
  const sourceVtxos =
    options.vtxos ||
    defaultAmounts.map((amount, index) => ({
      vtxoAmountSats: amount,
      ownerNodeId: `ln-edge-${index + 1}`,
      aspRoundId: `ark-round-liquidity-${index + 1}`,
      connectorOutpoint: `${sha256Hex(`ark-manager-connector:${managerId}:${index}`)}:${index}`
    }));

  const vtxos = sourceVtxos.map((entry, index) => {
    const commitment = entry.kind === 'ark_vtxo_liquidity_commitment'
      ? entry
      : buildArkVtxoLiquidityCommitment({
          ...entry,
          template,
          ownerNodeId: entry.ownerNodeId || `ln-edge-${index + 1}`,
          aspRoundId: entry.aspRoundId || `ark-round-liquidity-${index + 1}`
        });
    return {
      ...commitment,
      inventoryStatus: entry.inventoryStatus || 'available'
    };
  });

  const inventoryCore = {
    version: 1,
    protocol: 'ark_ln_liquidity_inventory',
    managerId,
    aspId,
    inventoryEpoch,
    templateCommitmentId: template.templateCommitmentId,
    vtxos: vtxos.map(vtxo => ({
      vtxoCommitmentId: vtxo.vtxoCommitmentId,
      vtxoId: vtxo.vtxoCore.vtxoId,
      vtxoAmountSats: vtxo.vtxoCore.vtxoAmountSats,
      ownerNodeId: vtxo.vtxoCore.ownerNodeId,
      aspRoundId: vtxo.vtxoCore.aspRoundId,
      connectorOutpoint: vtxo.vtxoCore.connectorOutpoint,
      exitTxid: vtxo.vtxoCore.exitTxid,
      forfeitTxid: vtxo.vtxoCore.forfeitTxid,
      inventoryStatus: vtxo.inventoryStatus
    }))
  };

  return {
    kind: 'ark_ln_liquidity_inventory',
    inventoryId: hashCanonical(inventoryCore),
    inventoryCore,
    template,
    vtxos
  };
}

function normalizeRouteIntent(intent, index) {
  const routeId = normalizeString(intent.routeId || `ln-route-${index + 1}`, 'routeId');
  const preimageHex = normalizeHex32(intent.preimageHex || sha256Hex(`ark-manager-preimage:${routeId}`), 'preimageHex');
  const paymentHashHex = normalizeHex32(intent.paymentHashHex || paymentHashFromPreimage(preimageHex), 'paymentHashHex');
  return {
    routeId,
    edgeNodeId: normalizeString(intent.edgeNodeId || `ldk-edge-${index + 1}`, 'edgeNodeId'),
    counterpartyNodeId: normalizeString(intent.counterpartyNodeId || `ln-peer-${index + 1}`, 'counterpartyNodeId'),
    requestedInboundSats: normalizeAmountSats(intent.requestedInboundSats || intent.amountSats || 50000n, 'requestedInboundSats').toString(),
    leaseBlocks: Number(intent.leaseBlocks || 144),
    maxFeePpm: Number(intent.maxFeePpm ?? 1000),
    maxCltvDelta: Number(intent.maxCltvDelta ?? 40),
    priority: Number(intent.priority || 0),
    requiredByBlock: Number(intent.requiredByBlock || 0),
    paymentHashHex,
    preimageHex
  };
}

function buildLightningRouteDemand(options = {}) {
  const managerId = normalizeString(options.managerId || 'ark-ln-liquidity-manager-regtest', 'managerId');
  const demandEpoch = normalizeString(options.demandEpoch || 'regtest-demand-1', 'demandEpoch');
  const routeIntents = (options.routeIntents || [
    { routeId: 'edge-a-inbound', requestedInboundSats: 50000n, priority: 3, maxFeePpm: 900 },
    { routeId: 'edge-b-inbound', requestedInboundSats: 75000n, priority: 2, maxFeePpm: 1000 },
    { routeId: 'edge-c-inbound', requestedInboundSats: 100000n, priority: 1, maxFeePpm: 1100 }
  ]).map(normalizeRouteIntent);

  const demandCore = {
    version: 1,
    protocol: 'lightning_route_liquidity_demand',
    managerId,
    demandEpoch,
    routeIntents: routeIntents.map(({ preimageHex, ...publicIntent }) => publicIntent)
  };

  return {
    kind: 'lightning_route_liquidity_demand',
    demandId: hashCanonical(demandCore),
    demandCore,
    routeIntents
  };
}

function buildBitvmEnforcementPolicy(options = {}) {
  const managerId = normalizeString(options.managerId || 'ark-ln-liquidity-manager-regtest', 'managerId');
  const policyCore = {
    version: 1,
    protocol: 'bitvm_utxoref_ark_liquidity_enforcement_policy',
    managerId,
    governorCircuitId: normalizeString(options.governorCircuitId || 'utxoref-ark-asp-pathing-v1', 'governorCircuitId'),
    settlementWindowBlocks: Number(options.settlementWindowBlocks || 18),
    challengeWindowBlocks: Number(options.challengeWindowBlocks || 144),
    slashReserveSats: normalizeAmountSats(options.slashReserveSats || 25000n, 'slashReserveSats').toString(),
    maxAspExposureSats: normalizeAmountSats(options.maxAspExposureSats || 500000n, 'maxAspExposureSats').toString(),
    aspBondOutpoint: normalizeOutpoint(
      options.aspBondOutpoint || `${sha256Hex(`bitvm-asp-bond:${managerId}`)}:0`,
      'aspBondOutpoint'
    ),
    requireExitPath: options.requireExitPath !== false,
    requireForfeitPath: options.requireForfeitPath !== false,
    requireLightningPreimage: options.requireLightningPreimage !== false,
    requireLeaseProof: options.requireLeaseProof !== false,
    enforcementHook: 'utxo_referee_bitvm_asp_pathing_challenge'
  };

  return {
    kind: 'bitvm_utxoref_ark_liquidity_enforcement_policy',
    policyId: hashCanonical(policyCore),
    policyCore
  };
}

function buildObservationMap(routeIntents, options = {}) {
  const byRoute = new Map();
  const observations = options.routeObservations || [];
  for (const observation of observations) {
    byRoute.set(observation.routeId, observation);
  }

  return new Map(
    routeIntents.map(route => {
      const override = byRoute.get(route.routeId) || {};
      return [
        route.routeId,
        {
          deliveredInboundSats:
            override.deliveredInboundSats !== undefined
              ? normalizeAmountSats(override.deliveredInboundSats, 'deliveredInboundSats')
              : BigInt(route.requestedInboundSats),
          observedFeePpm: Number(override.observedFeePpm ?? route.maxFeePpm),
          observedCltvDelta: Number(override.observedCltvDelta ?? route.maxCltvDelta),
          observedBlock: Number(override.observedBlock || options.observedBlock || 0),
          missingExitPath: Boolean(override.missingExitPath),
          missingForfeitPath: Boolean(override.missingForfeitPath),
          preimageHex: normalizeHex32(override.preimageHex || route.preimageHex, 'preimageHex')
        }
      ];
    })
  );
}

function allocateArkGrafts(options = {}) {
  const inventory = options.inventory || buildArkLiquidityInventory(options);
  const demand = options.demand || buildLightningRouteDemand(options);
  const policy = options.policy || buildBitvmEnforcementPolicy(options);
  const template = inventory.template;
  const observationMap = buildObservationMap(demand.routeIntents, options);
  const assignments = [];
  const unmetRoutes = [];
  const usedVtxos = new Set();
  let aspExposureSats = 0n;
  const maxAspExposureSats = BigInt(policy.policyCore.maxAspExposureSats);
  const orderedRoutes = [...demand.routeIntents].sort((a, b) => b.priority - a.priority || a.routeId.localeCompare(b.routeId));

  for (const route of orderedRoutes) {
    const requested = BigInt(route.requestedInboundSats);
    const vtxo = inventory.vtxos.find(candidate => {
      return (
        candidate.inventoryStatus === 'available' &&
        !usedVtxos.has(candidate.vtxoCommitmentId) &&
        BigInt(candidate.vtxoCore.vtxoAmountSats) >= requested &&
        aspExposureSats + requested <= maxAspExposureSats
      );
    });

    if (!vtxo) {
      unmetRoutes.push({
        routeId: route.routeId,
        requestedInboundSats: route.requestedInboundSats,
        reason: aspExposureSats + requested > maxAspExposureSats ? 'policy_exposure_limit' : 'insufficient_available_vtxo'
      });
      continue;
    }

    usedVtxos.add(vtxo.vtxoCommitmentId);
    aspExposureSats += requested;

    const quote = buildArkLiquidityGraftQuote({
      template,
      vtxo,
      promisedInboundSats: requested,
      leaseBlocks: route.leaseBlocks,
      maxFeePpm: route.maxFeePpm,
      maxCltvDelta: route.maxCltvDelta,
      graftPremiumSats: options.graftPremiumSats || 750n,
      paymentHashHex: route.paymentHashHex
    });
    const observation = observationMap.get(route.routeId);
    const taprootProofManifest = buildArkTaprootMiniscriptProofManifest({
      ...options,
      template,
      vtxo,
      selectedLeafRole: options.selectedLeafRole || 'cooperative_round',
      amountSats: route.requestedInboundSats,
      settlementRoot: sha256Hex(`ark-manager-settlement:${quote.quoteId}:${route.routeId}`),
      utxorefPolicyId: policy.policyId
    });
    const settlementEvidence = buildArkGraftSettlementEvidence({
      template,
      vtxo,
      quote,
      taprootProofManifest,
      liquidityLease: options.liquidityLease,
      htlcProof: options.htlcProof || {},
      deliveredInboundSats: observation.deliveredInboundSats,
      observedFeePpm: observation.observedFeePpm,
      observedCltvDelta: observation.observedCltvDelta,
      observedBlock: observation.observedBlock,
      preimageHex: observation.preimageHex
    });
    const settlementOk = Object.values(settlementEvidence.checks).every(Boolean);
    const challengeEvidence = buildArkGraftChallengeEvidence({
      quote,
      taprootProofManifest,
      deliveredInboundSats: observation.deliveredInboundSats,
      observedFeePpm: observation.observedFeePpm,
      observedCltvDelta: observation.observedCltvDelta,
      missingExitPath: observation.missingExitPath || (policy.policyCore.requireExitPath && !vtxo.vtxoCore.exitTxid),
      missingForfeitPath: observation.missingForfeitPath || (policy.policyCore.requireForfeitPath && !vtxo.vtxoCore.forfeitTxid)
    });

    const assignmentCore = {
      version: 1,
      protocol: 'ark_ln_liquidity_graft_assignment',
      managerId: inventory.inventoryCore.managerId,
      inventoryId: inventory.inventoryId,
      demandId: demand.demandId,
      policyId: policy.policyId,
      routeId: route.routeId,
      edgeNodeId: route.edgeNodeId,
      vtxoCommitmentId: vtxo.vtxoCommitmentId,
      quoteId: quote.quoteId,
      taprootProofManifestId: taprootProofManifest.manifestId,
      settlementId: settlementEvidence.settlementId,
      challengeId: challengeEvidence.challengeId,
      promisedInboundSats: route.requestedInboundSats,
      deliveredInboundSats: observation.deliveredInboundSats.toString(),
      status: settlementOk ? 'settled' : challengeEvidence.slashable ? 'slashable' : 'assigned'
    };

    const { preimageHex, ...publicRoute } = route;

    assignments.push({
      kind: 'ark_ln_liquidity_graft_assignment',
      assignmentId: hashCanonical(assignmentCore),
      assignmentCore,
      route: publicRoute,
      vtxo,
      quote,
      taprootProofManifest,
      settlementEvidence,
      challengeEvidence
    });
  }

  return {
    kind: 'ark_ln_liquidity_graft_allocation',
    allocationId: hashCanonical({
      inventoryId: inventory.inventoryId,
      demandId: demand.demandId,
      policyId: policy.policyId,
      assignmentIds: assignments.map(assignment => assignment.assignmentId),
      unmetRoutes
    }),
    assignments,
    unmetRoutes,
    totals: {
      requestedInboundSats: sumBigInt(demand.routeIntents, route => route.requestedInboundSats).toString(),
      assignedInboundSats: sumBigInt(assignments, assignment => assignment.assignmentCore.promisedInboundSats).toString(),
      deliveredInboundSats: sumBigInt(assignments, assignment => assignment.assignmentCore.deliveredInboundSats).toString(),
      slashableAssignments: assignments.filter(assignment => assignment.assignmentCore.status === 'slashable').length,
      settledAssignments: assignments.filter(assignment => assignment.assignmentCore.status === 'settled').length
    }
  };
}

function buildArkLiquidityManagerChallenge(options = {}) {
  const managerId = normalizeString(options.managerId || 'ark-ln-liquidity-manager-regtest', 'managerId');
  const policy = options.policy || buildBitvmEnforcementPolicy({ managerId });
  const allocation = options.allocation || { assignments: [], unmetRoutes: [], totals: {} };
  const assignmentChallenges = allocation.assignments
    .filter(assignment => assignment.challengeEvidence && assignment.challengeEvidence.slashable)
    .map(assignment => ({
      routeId: assignment.assignmentCore.routeId,
      assignmentId: assignment.assignmentId,
      quoteId: assignment.quote.quoteId,
      challengeId: assignment.challengeEvidence.challengeId,
      violations: assignment.challengeEvidence.challengeCore.violations
    }));

  const violations = [];
  if (assignmentChallenges.length > 0) violations.push('assignment_liquidity_obligation_failed');
  if ((allocation.unmetRoutes || []).length > 0) violations.push('unmet_route_demand');
  if (options.missingBitvmForfeitCommitment) violations.push('missing_bitvm_forfeit_commitment');
  if (BigInt((allocation.totals && allocation.totals.assignedInboundSats) || 0) > BigInt(policy.policyCore.maxAspExposureSats)) {
    violations.push('asp_exposure_above_policy');
  }

  const challengeCore = {
    version: 1,
    protocol: 'bitvm_utxoref_ark_liquidity_manager_challenge',
    managerId,
    policyId: policy.policyId,
    assignmentChallenges,
    unmetRoutes: allocation.unmetRoutes || [],
    violations
  };

  return {
    kind: 'bitvm_utxoref_ark_liquidity_manager_challenge',
    challengeId: hashCanonical(challengeCore),
    challengeCore,
    slashable: violations.length > 0,
    remedy: violations.length > 0 ? 'slash ASP bond or force Ark exit/forfeit path through UTXORef challenge' : 'none'
  };
}

function buildArkLiquidityGraftManagerBundle(options = {}) {
  const managerId = normalizeString(options.managerId || 'ark-ln-liquidity-manager-regtest', 'managerId');
  const template = buildArkTemplateCommitment({ ...options, managerId });
  const inventory = buildArkLiquidityInventory({ ...options, managerId, template });
  const demand = buildLightningRouteDemand({ ...options, managerId });
  const policy = buildBitvmEnforcementPolicy({ ...options, managerId });
  const allocation = allocateArkGrafts({ ...options, inventory, demand, policy });
  const publicDemand = {
    kind: demand.kind,
    demandId: demand.demandId,
    demandCore: demand.demandCore
  };
  const challengeEvidence = buildArkLiquidityManagerChallenge({
    managerId,
    policy,
    allocation,
    missingBitvmForfeitCommitment: options.missingBitvmForfeitCommitment
  });
  const assignmentCount = allocation.assignments.length || 1;
  const averageAssignmentSats =
    allocation.assignments.length > 0
      ? BigInt(allocation.totals.assignedInboundSats) / BigInt(allocation.assignments.length)
      : 0n;
  const costModel = buildArkGraftCostModel({
    ...options,
    graftCount: assignmentCount,
    graftAmountSats: averageAssignmentSats || 50000n
  });

  const managerCore = {
    version: 1,
    protocol: 'ark_ln_bitvm_liquidity_graft_manager',
    managerId,
    inventoryId: inventory.inventoryId,
    demandId: demand.demandId,
    policyId: policy.policyId,
    allocationId: allocation.allocationId,
    challengeId: challengeEvidence.challengeId,
    costModelId: costModel.modelId,
    assignmentCount: allocation.assignments.length,
    unmetRouteCount: allocation.unmetRoutes.length,
    totals: allocation.totals
  };
  const bundle = {
    kind: 'ark_ln_bitvm_liquidity_graft_manager_bundle',
    bundleId: hashCanonical(managerCore),
    managerCore,
    inventory,
    demand: publicDemand,
    policy,
    allocation,
    challengeEvidence,
    costModel,
    thesis:
      'A manager can graft Ark VTXO liquidity onto Lightning edge routes while BitVM/UTXORef governs ASP pathing power and turns under-delivery into slashable evidence.',
    caveats: [
      'This is a deterministic evidence-shape prototype, not a live ASP integration.',
      'Production needs real Ark round signatures, VTXO membership proofs, LDK/LND route observations, and BitVM challenge transaction construction.',
      'The manager optimizes fee surface and enforcement, but it does not create net liquidity; it reallocates pledged liquidity with stronger failure handling.'
    ]
  };
  return bundle;
}

function verifyArkLiquidityGraftManagerBundle(bundle) {
  if (!bundle || bundle.kind !== 'ark_ln_bitvm_liquidity_graft_manager_bundle') {
    return { ok: false, reason: 'wrong bundle kind' };
  }
  if (bundle.bundleId !== hashCanonical(bundle.managerCore)) {
    return { ok: false, reason: 'bundle id mismatch' };
  }
  if (bundle.inventory.inventoryId !== hashCanonical(bundle.inventory.inventoryCore)) {
    return { ok: false, reason: 'inventory id mismatch' };
  }
  if (bundle.demand.demandId !== hashCanonical(bundle.demand.demandCore)) {
    return { ok: false, reason: 'demand id mismatch' };
  }
  if (bundle.policy.policyId !== hashCanonical(bundle.policy.policyCore)) {
    return { ok: false, reason: 'policy id mismatch' };
  }
  const allocationDigest = hashCanonical({
    inventoryId: bundle.inventory.inventoryId,
    demandId: bundle.demand.demandId,
    policyId: bundle.policy.policyId,
    assignmentIds: bundle.allocation.assignments.map(assignment => assignment.assignmentId),
    unmetRoutes: bundle.allocation.unmetRoutes
  });
  if (bundle.allocation.allocationId !== allocationDigest) {
    return { ok: false, reason: 'allocation id mismatch' };
  }
  const usedVtxos = new Set();
  for (const assignment of bundle.allocation.assignments) {
    if (assignment.assignmentId !== hashCanonical(assignment.assignmentCore)) {
      return { ok: false, reason: `assignment id mismatch: ${assignment.assignmentCore.routeId}` };
    }
    if (!assignment.taprootProofManifest) {
      return { ok: false, reason: `missing taproot proof manifest: ${assignment.assignmentCore.routeId}` };
    }
    const taprootVerification = verifyArkTaprootMiniscriptProofManifest(assignment.taprootProofManifest);
    if (!taprootVerification.ok) {
      return {
        ok: false,
        reason: `taproot proof manifest failed for ${assignment.assignmentCore.routeId}: ${taprootVerification.reason}`
      };
    }
    if (assignment.assignmentCore.taprootProofManifestId !== assignment.taprootProofManifest.manifestId) {
      return { ok: false, reason: `taproot proof manifest id mismatch: ${assignment.assignmentCore.routeId}` };
    }
    if (assignment.taprootProofManifest.manifestCore.utxorefPolicyId !== bundle.policy.policyId) {
      return { ok: false, reason: `taproot proof manifest policy mismatch: ${assignment.assignmentCore.routeId}` };
    }
    if (usedVtxos.has(assignment.vtxo.vtxoCommitmentId)) {
      return { ok: false, reason: `duplicate vtxo assignment: ${assignment.vtxo.vtxoCommitmentId}` };
    }
    usedVtxos.add(assignment.vtxo.vtxoCommitmentId);
    if (BigInt(assignment.vtxo.vtxoCore.vtxoAmountSats) < BigInt(assignment.assignmentCore.promisedInboundSats)) {
      return { ok: false, reason: `vtxo underfunds route: ${assignment.assignmentCore.routeId}` };
    }
    const settlementOk = Object.values(assignment.settlementEvidence.checks || {}).every(Boolean);
    if (assignment.assignmentCore.status === 'settled' && !settlementOk) {
      return { ok: false, reason: `settled assignment has failed checks: ${assignment.assignmentCore.routeId}` };
    }
    if (assignment.assignmentCore.status === 'slashable' && !assignment.challengeEvidence.slashable) {
      return { ok: false, reason: `slashable assignment lacks challenge: ${assignment.assignmentCore.routeId}` };
    }
  }
  if (bundle.challengeEvidence.challengeId !== hashCanonical(bundle.challengeEvidence.challengeCore)) {
    return { ok: false, reason: 'manager challenge id mismatch' };
  }
  if (bundle.costModel.modelId !== hashCanonical(bundle.costModel.modelCore)) {
    return { ok: false, reason: 'cost model id mismatch' };
  }
  return { ok: true };
}

module.exports = {
  buildArkLiquidityInventory,
  buildLightningRouteDemand,
  buildBitvmEnforcementPolicy,
  allocateArkGrafts,
  buildArkLiquidityManagerChallenge,
  buildArkLiquidityGraftManagerBundle,
  verifyArkLiquidityGraftManagerBundle
};
