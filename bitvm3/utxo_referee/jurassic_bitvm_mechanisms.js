/**
 * Jurassic BitVM mechanism catalog.
 *
 * This takes the three Jurassic Bitcoin motifs and turns them into candidate
 * BitVM mechanics for existing UTXORef prototype families. The output is a
 * deterministic design artifact, not a claim that the old Bitcoin transaction
 * forms should be used directly.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const OUT_JSON = path.join(ARTIFACTS_DIR, 'jurassic_bitvm_mechanisms_latest.json');
const OUT_MD = path.join(ARTIFACTS_DIR, 'jurassic_bitvm_mechanisms_latest.md');
const CONSTANT_ONE_DIGEST_HEX = `${'0'.repeat(63)}1`;

const TARGETS = Object.freeze([
  'lightning',
  'taproot_assets',
  'ark',
  'shinigami'
]);

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value) {
  return sha256Hex(canonicalStringify(value));
}

function stringifyJson(value, pretty = false) {
  return JSON.stringify(
    value,
    (_key, current) => (typeof current === 'bigint' ? current.toString() : current),
    pretty ? 2 : 0
  );
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeTargets(targets) {
  const selected = targets && targets.length ? targets : TARGETS;
  const normalized = selected.map((target) => normalizeString(target, 'target'));
  const unknown = normalized.filter((target) => !TARGETS.includes(target));
  if (unknown.length) {
    throw new Error(`unsupported target(s): ${unknown.join(', ')}`);
  }
  return Array.from(new Set(normalized));
}

function buildMechanismCore(options = {}) {
  const targetProtocols = normalizeTargets(options.targetProtocols);
  const amountSats = normalizeAmountSats(options.amountSats || 250000n, 'amountSats');
  const semanticStatement = {
    version: 1,
    family: 'jurassic_bitvm_mechanism_core',
    contractId: normalizeString(options.contractId || 'utxoref-jurassic-bitvm-demo', 'contractId'),
    applicationIntent: normalizeString(
      options.applicationIntent || 'prove one overlay state through multiple BitVM-visible publication and challenge surfaces',
      'applicationIntent'
    ),
    route: normalizeString(options.route || 'cooperative_or_challengeable_release', 'route'),
    amountSats: amountSats.toString(),
    settlementEpoch: normalizeString(options.settlementEpoch || 'm1-jurassic-demo', 'settlementEpoch'),
    challengeWindowBlocks: Number(options.challengeWindowBlocks ?? 144),
    targetProtocols
  };

  return {
    semanticStatement,
    semanticStateHash: hashCanonical(semanticStatement),
    targetProtocols
  };
}

function buildTranscriptSwitchboard(core) {
  const templates = [
    {
      mechanismId: 'ln_ptlc_success_retry_a',
      target: 'lightning',
      packageClass: 'ln-ptlc-success-retry',
      transcriptRole: 'success preimage package',
      bitvmUse: 'retry-equivalent PTLC/adaptor success proof for the same BitVM claim',
      action: 'accept'
    },
    {
      mechanismId: 'ln_ptlc_success_retry_b',
      target: 'lightning',
      packageClass: 'ln-ptlc-success-retry',
      transcriptRole: 'success preimage package',
      bitvmUse: 'second retry-equivalent success proof that aliases with retry_a',
      action: 'accept'
    },
    {
      mechanismId: 'ln_timeout_challenge_split',
      target: 'lightning',
      packageClass: 'ln-timeout-branch-split',
      transcriptRole: 'timeout challenge package',
      bitvmUse: 'distinct branch package for timeout or failed-liquidity challenge',
      action: 'accept'
    },
    {
      mechanismId: 'tap_asset_proof_delta',
      target: 'taproot_assets',
      packageClass: 'tap-proof-delta',
      transcriptRole: 'asset proof relay package',
      bitvmUse: 'asset proof wrapper over the same BitVM settlement state',
      action: 'accept'
    },
    {
      mechanismId: 'ark_round_exit_attestation',
      target: 'ark',
      packageClass: 'ark-round-exit-attestation',
      transcriptRole: 'round exit package',
      bitvmUse: 'round-exit transcript that feeds a challengeable release path',
      action: 'accept'
    },
    {
      mechanismId: 'shinigami_execution_trace',
      target: 'shinigami',
      packageClass: 'shinigami-execution-trace',
      transcriptRole: 'proof-carrying execution package',
      bitvmUse: 'execution trace attestation over the same semantic BitVM claim',
      action: 'scaffold_only'
    },
    {
      mechanismId: 'constant_one_tripwire',
      target: 'all',
      packageClass: 'sighash-single-constant-one-tripwire',
      transcriptRole: 'hazard detector',
      bitvmUse: 'reject digest-collapse candidates before they can become claim ids',
      action: 'reject'
    }
  ];

  const variants = templates.map((template) => {
    const transcriptDigest = template.mechanismId === 'constant_one_tripwire'
      ? CONSTANT_ONE_DIGEST_HEX
      : sha256Hex(`${core.semanticStateHash}|${template.packageClass}`);
    return {
      ...template,
      semanticStateHash: core.semanticStateHash,
      transcriptDigest,
      preservesSemanticState: true,
      rejected: template.action === 'reject'
    };
  });

  return {
    mechanism: 'transcript_switchboard',
    motif: 'transcript_multiplicity',
    thesis: 'Let a BitVM claim accept multiple proof-package transcripts while keeping one semantic state hash, with constant-one collapse treated as a rejection guard.',
    variants,
    summary: {
      variantCount: variants.length,
      acceptedVariantCount: variants.filter((variant) => !variant.rejected).length,
      rejectedVariantCount: variants.filter((variant) => variant.rejected).length,
      retryAliasDigest: variants.find((variant) => variant.mechanismId === 'ln_ptlc_success_retry_a').transcriptDigest,
      primaryBranchSplit: 'ln_timeout_challenge_split',
      tripwireDigest: CONSTANT_ONE_DIGEST_HEX
    }
  };
}

function buildIdentifierRelayMatrix(core) {
  const templates = [
    {
      target: 'lightning',
      handleRole: 'rendezvous_or_route_handle',
      label: 'ln-blinded-route-window',
      scaffold: 'lightning_integration.js / lightning_liquidity_lease.js'
    },
    {
      target: 'lightning',
      handleRole: 'watchtower_session',
      label: 'ln-watchtower-alert-window',
      scaffold: 'tradeLayerSendWatchtower / lightning watchtower prototypes'
    },
    {
      target: 'taproot_assets',
      handleRole: 'proof_anchor',
      label: 'tap-proof-anchor-v1',
      scaffold: 'lightning_taproot_assets_stablecoin.js'
    },
    {
      target: 'taproot_assets',
      handleRole: 'universe_sync_namespace',
      label: 'tap-universe-shadow-v1',
      scaffold: 'lightning_taproot_assets_stablecoin.js'
    },
    {
      target: 'ark',
      handleRole: 'round_or_vtxo_claim',
      label: 'ark-round-claim-v1',
      scaffold: 'lightning_ark_liquidity_graft.js / ark_dlc_settlement.js'
    },
    {
      target: 'ark',
      handleRole: 'offboard_exit_namespace',
      label: 'ark-exit-window-v1',
      scaffold: 'ark_liquidity_graft_manager.js'
    },
    {
      target: 'shinigami',
      handleRole: 'verifier_session',
      label: 'shinigami-verifier-session-v1',
      scaffold: 'jurassic_bitvm_mechanisms.js scaffold only'
    },
    {
      target: 'shinigami',
      handleRole: 'proof_blob_reference',
      label: 'shinigami-proof-blob-v1',
      scaffold: 'oracle sidecar / execution proof scaffold'
    }
  ];

  const variants = templates.map((template, index) => ({
    ...template,
    semanticStateHash: core.semanticStateHash,
    publicHandleId: hashCanonical({
      semanticStateHash: core.semanticStateHash,
      target: template.target,
      handleRole: template.handleRole,
      label: template.label,
      index
    }),
    preservesSemanticState: true
  }));

  return {
    mechanism: 'namespace_relay_matrix',
    motif: 'identifier_bifurcation',
    thesis: 'Let protocol-specific public handles rotate while one BitVM semantic state hash remains stable.',
    variants,
    summary: {
      variantCount: variants.length,
      uniqueHandleCount: new Set(variants.map((variant) => variant.publicHandleId)).size,
      targetsCovered: Array.from(new Set(variants.map((variant) => variant.target)))
    }
  };
}

function buildCarrierShadowRoutes(core) {
  const templates = [
    {
      target: 'lightning',
      carrierRouteId: 'ln_watchtower_sweep_shadow',
      ordinaryTopology: 'watchtower sweep or wallet-maintenance consolidation',
      publicationKind: 'alert proof sidecar',
      nearestPrototype: 'tradelayer_send_watchtower.js / lightning_liquidity_lease.js',
      verifier: 'watchtower checks transcript digest and channel/splice commitment'
    },
    {
      target: 'lightning',
      carrierRouteId: 'ln_splice_shadow',
      ordinaryTopology: 'splice-in or channel open maintenance transaction',
      publicationKind: 'liquidity lease status sidecar',
      nearestPrototype: 'lightning_wallet_integration.js',
      verifier: 'wallet checks lease offer id and funding commitment'
    },
    {
      target: 'taproot_assets',
      carrierRouteId: 'tap_asset_distribution_shadow',
      ordinaryTopology: 'asset proof anchor batch or issuance distribution',
      publicationKind: 'asset proof delta sidecar',
      nearestPrototype: 'lightning_taproot_assets_stablecoin.js',
      verifier: 'asset proof verifier checks proof id and RFQ quote id'
    },
    {
      target: 'ark',
      carrierRouteId: 'ark_round_batch_shadow',
      ordinaryTopology: 'round batch, refresh batch, or offboard settlement',
      publicationKind: 'round exit evidence sidecar',
      nearestPrototype: 'lightning_ark_liquidity_graft.js',
      verifier: 'ASP/LSP observer checks round id, VTXO commitment, and exit path'
    },
    {
      target: 'shinigami',
      carrierRouteId: 'shinigami_proof_publication_shadow',
      ordinaryTopology: 'proof publication folded into ordinary settlement batch',
      publicationKind: 'execution trace or verifier receipt sidecar',
      nearestPrototype: 'new scaffold from oracle-sidecar or hybrid dispute mesh',
      verifier: 'script verifier checks execution trace handle and semantic state hash'
    }
  ];

  const variants = templates.map((template, index) => ({
    ...template,
    semanticStateHash: core.semanticStateHash,
    carrierCommitmentId: hashCanonical({
      semanticStateHash: core.semanticStateHash,
      target: template.target,
      carrierRouteId: template.carrierRouteId,
      ordinaryTopology: template.ordinaryTopology,
      index
    }),
    expectedPolicyFit: template.target === 'shinigami' ? 'scaffold_only' : 'prototype_ready',
    preservesSemanticState: true
  }));

  return {
    mechanism: 'carrier_shadow_routes',
    motif: 'carrier_camouflage',
    thesis: 'Publish BitVM-relevant proof hints through ordinary protocol topologies instead of explicit one-off marker transactions.',
    variants,
    summary: {
      variantCount: variants.length,
      targetsCovered: Array.from(new Set(variants.map((variant) => variant.target))),
      scaffoldOnlyCount: variants.filter((variant) => variant.expectedPolicyFit === 'scaffold_only').length
    }
  };
}

function buildComposedMechanismPlans(core, transcriptSwitchboard, namespaceRelayMatrix, carrierShadowRoutes) {
  const byTarget = (items, target) => items.filter((item) => item.target === target || item.target === 'all');
  const planTemplates = [
    {
      planId: 'ln_ptlc_retry_watchtower_switchboard',
      target: 'lightning',
      appliesTo: [
        'lightning_liquidity_lease.js',
        'lightning_wallet_integration.js',
        'tradelayer_send_watchtower.js'
      ],
      mechanism: 'A Lightning lease can expose retry-equivalent success proofs, a distinct timeout challenge proof, rotating watchtower handles, and sweep-shaped publication cover.',
      firstBuild: 'extend lightning liquidity lease evidence with transcriptSwitchboardId and publicHandleId fields',
      status: 'prototype_ready'
    },
    {
      planId: 'tap_asset_proof_anchor_switchboard',
      target: 'taproot_assets',
      appliesTo: [
        'lightning_taproot_assets_stablecoin.js',
        'lightning_tradelayer_oracle_dlc.js'
      ],
      mechanism: 'A Taproot Assets RFQ can keep one asset transfer claim while rotating proof anchors and wrapping the proof in alternative relay packages.',
      firstBuild: 'add proof-anchor namespace ids to the stablecoin RFQ quote and challenge evidence',
      status: 'prototype_ready'
    },
    {
      planId: 'ark_round_exit_namespace_market',
      target: 'ark',
      appliesTo: [
        'lightning_ark_liquidity_graft.js',
        'ark_dlc_settlement.js',
        'ark_liquidity_graft_manager.js'
      ],
      mechanism: 'An Ark round can advertise multiple public claim handles over one VTXO commitment and route exit evidence through round-batch cover.',
      firstBuild: 'add namespace relay ids to Ark quote, settlement evidence, and challenge evidence',
      status: 'prototype_ready'
    },
    {
      planId: 'shinigami_proof_publication_switchboard',
      target: 'shinigami',
      appliesTo: [
        'new proof-carrying execution scaffold',
        'jurassic_bitvm_mechanisms.js',
        'oracle sidecar builders'
      ],
      mechanism: 'A proof-carrying execution surface can expose alternative proof packages and verifier handles while keeping one semantic program state.',
      firstBuild: 'model proof publication and verifier receipt as a repo-local application mesh before binding it to any external Shinigami implementation',
      status: 'scaffold_only'
    }
  ];

  return planTemplates.map((template) => ({
    ...template,
    semanticStateHash: core.semanticStateHash,
    transcriptVariantIds: byTarget(transcriptSwitchboard.variants, template.target).map((variant) => variant.mechanismId),
    namespaceVariantIds: byTarget(namespaceRelayMatrix.variants, template.target).map((variant) => variant.publicHandleId),
    carrierRouteIds: byTarget(carrierShadowRoutes.variants, template.target).map((variant) => variant.carrierRouteId)
  }));
}

function firstOrNull(values) {
  return values.length ? values[0] : null;
}

function buildJurassicMechanismRefs(target, options = {}) {
  const normalizedTarget = normalizeTargets([target])[0];
  const core = buildMechanismCore({
    ...options,
    targetProtocols: [normalizedTarget]
  });
  const transcriptSwitchboard = buildTranscriptSwitchboard(core);
  const namespaceRelayMatrix = buildIdentifierRelayMatrix(core);
  const carrierShadowRoutes = buildCarrierShadowRoutes(core);
  const composedPlans = buildComposedMechanismPlans(
    core,
    transcriptSwitchboard,
    namespaceRelayMatrix,
    carrierShadowRoutes
  );
  const transcriptVariants = transcriptSwitchboard.variants.filter(
    (variant) => !variant.rejected && (variant.target === normalizedTarget || variant.target === 'all')
  );
  const namespaceVariants = namespaceRelayMatrix.variants.filter((variant) => variant.target === normalizedTarget);
  const carrierVariants = carrierShadowRoutes.variants.filter((variant) => variant.target === normalizedTarget);
  const plan = composedPlans.find((candidate) => candidate.target === normalizedTarget);
  const refCore = {
    version: 1,
    target: normalizedTarget,
    semanticStateHash: core.semanticStateHash,
    planId: plan && plan.planId,
    transcriptVariantIds: transcriptVariants.map((variant) => variant.mechanismId),
    transcriptDigests: transcriptVariants.map((variant) => variant.transcriptDigest),
    publicHandleIds: namespaceVariants.map((variant) => variant.publicHandleId),
    carrierCommitmentIds: carrierVariants.map((variant) => variant.carrierCommitmentId)
  };

  return {
    kind: 'jurassic_bitvm_mechanism_refs',
    refId: hashCanonical(refCore),
    ...refCore,
    transcriptSwitchboardId: hashCanonical({
      semanticStateHash: core.semanticStateHash,
      target: normalizedTarget,
      transcriptDigests: refCore.transcriptDigests
    }),
    primaryTranscriptDigest: firstOrNull(refCore.transcriptDigests),
    primaryPublicHandleId: firstOrNull(refCore.publicHandleIds),
    primaryCarrierCommitmentId: firstOrNull(refCore.carrierCommitmentIds),
    status: plan ? plan.status : 'unknown',
    rejectionTripwireDigest: CONSTANT_ONE_DIGEST_HEX
  };
}

function buildJurassicBitvmMechanismCatalog(options = {}) {
  const core = buildMechanismCore(options);
  const transcriptSwitchboard = buildTranscriptSwitchboard(core);
  const namespaceRelayMatrix = buildIdentifierRelayMatrix(core);
  const carrierShadowRoutes = buildCarrierShadowRoutes(core);
  const composedPlans = buildComposedMechanismPlans(
    core,
    transcriptSwitchboard,
    namespaceRelayMatrix,
    carrierShadowRoutes
  );

  const report = {
    kind: 'jurassic_bitvm_mechanism_catalog',
    createdAt: options.createdAt || new Date().toISOString(),
    core,
    mechanisms: {
      transcriptSwitchboard,
      namespaceRelayMatrix,
      carrierShadowRoutes
    },
    composedPlans,
    recommendations: [
      'Prototype Lightning first by adding transcriptSwitchboardId and publicHandleId to liquidity-lease evidence bundles.',
      'Prototype Taproot Assets next by letting RFQ proof anchors rotate while quote and asset proof semantics stay fixed.',
      'Prototype Ark by attaching namespace relay ids to round, VTXO, and exit evidence objects.',
      'Keep Shinigami scoped as a proof-carrying execution scaffold until a dedicated local verifier harness exists.',
      `Reject any candidate mechanism that promotes ${CONSTANT_ONE_DIGEST_HEX} into a funding, claim, or challenge id.`
    ],
    artifactHash: null
  };

  report.artifactHash = hashCanonical({
    ...report,
    artifactHash: null
  });
  return report;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Jurassic BitVM Mechanism Catalog');
  lines.push('');
  lines.push(`- Generated: \`${report.createdAt}\``);
  lines.push(`- Artifact hash: \`${report.artifactHash}\``);
  lines.push(`- Semantic state hash: \`${report.core.semanticStateHash}\``);
  lines.push(`- Target protocols: \`${report.core.targetProtocols.join(', ')}\``);
  lines.push('');
  lines.push('## Mechanisms');
  for (const mechanism of Object.values(report.mechanisms)) {
    lines.push('');
    lines.push(`### ${mechanism.mechanism}`);
    lines.push(`- Motif: \`${mechanism.motif}\``);
    lines.push(`- Thesis: ${mechanism.thesis}`);
    lines.push(`- Variants: \`${mechanism.summary.variantCount}\``);
    if (mechanism.summary.targetsCovered) {
      lines.push(`- Targets: \`${mechanism.summary.targetsCovered.join(', ')}\``);
    }
  }
  lines.push('');
  lines.push('## Composed Plans');
  for (const plan of report.composedPlans) {
    lines.push(`- ${plan.planId} (${plan.target}, ${plan.status}): ${plan.mechanism}`);
    lines.push(`  First build: ${plan.firstBuild}`);
  }
  lines.push('');
  lines.push('## Recommendations');
  for (const recommendation of report.recommendations) {
    lines.push(`- ${recommendation}`);
  }
  return lines.join('\n');
}

function writeJurassicBitvmMechanismCatalog(report, outJsonPath = OUT_JSON, outMdPath = OUT_MD) {
  ensureDir(path.dirname(outJsonPath));
  fs.writeFileSync(outJsonPath, stringifyJson(report, true));
  fs.writeFileSync(outMdPath, renderMarkdown(report));
  return {
    outJsonPath,
    outMdPath
  };
}

function run() {
  const report = buildJurassicBitvmMechanismCatalog();
  const written = writeJurassicBitvmMechanismCatalog(report);

  console.log('=== Jurassic BitVM Mechanism Catalog ===');
  console.log(`semanticStateHash=${report.core.semanticStateHash}`);
  console.log(`plans=${report.composedPlans.length}`);
  console.log(`artifactHash=${report.artifactHash}`);
  console.log(`jsonPath=${written.outJsonPath}`);
  console.log(`mdPath=${written.outMdPath}`);
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error('Jurassic BitVM mechanism catalog generation failed:', err.message);
    process.exit(1);
  }
}

module.exports = {
  ARTIFACTS_DIR,
  OUT_JSON,
  OUT_MD,
  TARGETS,
  CONSTANT_ONE_DIGEST_HEX,
  buildMechanismCore,
  buildTranscriptSwitchboard,
  buildIdentifierRelayMatrix,
  buildCarrierShadowRoutes,
  buildComposedMechanismPlans,
  buildJurassicMechanismRefs,
  buildJurassicBitvmMechanismCatalog,
  writeJurassicBitvmMechanismCatalog,
  renderMarkdown
};
