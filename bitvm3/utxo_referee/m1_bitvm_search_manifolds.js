/**
 * Milestone 1 - BitVM Search Manifolds
 *
 * Builds two experiment families from the latest referee artifacts:
 * - transcript multiplicity, where the same settlement statement can be
 *   steered across multiple digest-equivalence classes
 * - identifier bifurcation, where the same transcript core can be wrapped in
 *   multiple anchor envelopes without changing the settlement claim
 *
 * These are search benches for BitVM/DLC overlay work. They are not claims
 * about current Bitcoin consensus behavior in this repo.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { assertCommittedRouting } = require('./m1_routing_commitments');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const CHALLENGE_BUNDLE_PATH = path.join(ARTIFACTS_DIR, 'm1_challenge_bundle_latest.json');
const CHALLENGE_WITNESS_PATH = path.join(ARTIFACTS_DIR, 'm1_challenge_witness_latest.json');
const PROCEDURAL_SYNC_PATH = path.join(ARTIFACTS_DIR, 'bitvm_procedural_sync_latest.json');
const PARALLEL_UTXO_INDEX_PATH = path.join(ARTIFACTS_DIR, 'm1_parallel_utxo_index_latest.json');
const OUT_JSON = path.join(ARTIFACTS_DIR, 'm1_bitvm_search_manifolds_latest.json');
const OUT_MD = path.join(ARTIFACTS_DIR, 'm1_bitvm_search_manifolds_latest.md');
const CONSTANT_ONE_DIGEST_HEX = `${'0'.repeat(63)}1`;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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

function loadJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function artifactMeta(filePath, artifact) {
  if (!artifact || !fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  return {
    path: filePath,
    kind: artifact.kind || null,
    hash: sha256Hex(raw)
  };
}

function toBigIntString(value, fallback = '0') {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  return BigInt(value).toString();
}

function toStringOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return String(value);
}

function deriveSettlementCore(inputs) {
  const challengeBundle = inputs?.challengeBundle;
  if (!challengeBundle || typeof challengeBundle !== 'object') {
    throw new Error('challengeBundle is required');
  }

  const selectedPath = challengeBundle.selectedPath || {};
  const committedRouting = assertCommittedRouting(selectedPath, 'bitvm search manifold routing');
  const route = toStringOrNull(
    challengeBundle.selectedPathId
    || selectedPath.pathId
    || inputs?.challengeWitness?.route
    || inputs?.challengeWitness?.witness?.route
    || inputs?.proceduralSync?.settlement?.route
  );
  const fundingOutpoint = challengeBundle.binding?.fundingOutpoint || {};
  const fundingTxid = toStringOrNull(
    challengeBundle.binding?.fundingTxidFinalized
    || inputs?.parallelUtxoIndex?.anchors?.fundingTxid
    || inputs?.proceduralSync?.fundingTxid
    || fundingOutpoint.txid
  );
  const selectedPathTxid = toStringOrNull(selectedPath.txid);
  const contractId = toStringOrNull(
    inputs?.proceduralSync?.contractId
    || challengeBundle.oracleBinding?.eventId
    || inputs?.challengeWitness?.witness?.honestPath?.deltaPublication?.rollTrigger?.nextContractId
  );

  const settlementStatement = {
    contractId,
    route,
    selectedPathId: toStringOrNull(challengeBundle.selectedPathId || selectedPath.pathId),
    collateralSats: toBigIntString(
      fundingOutpoint.valueSats
      ?? inputs?.proceduralSync?.funding?.collateralSats
      ?? inputs?.challengeWitness?.witness?.transitionState?.collateralSats
      ?? 0n
    ),
    payoutSats: toBigIntString(selectedPath.payoutSats ?? selectedPath.actualPayoutSats ?? 0n),
    actualPayoutSats: toBigIntString(selectedPath.actualPayoutSats ?? selectedPath.payoutSats ?? 0n),
    refundSats: toBigIntString(selectedPath.refundSats ?? selectedPath.residualSats ?? 0n),
    residualSats: toBigIntString(selectedPath.residualSats ?? selectedPath.refundSats ?? 0n),
    rolloverCollateralSats: toBigIntString(selectedPath.rolloverCollateralSats ?? 0n),
    feeSats: toBigIntString(selectedPath.feeSats ?? 0n),
    dustCarrySats: toBigIntString(selectedPath.dustCarrySats ?? challengeBundle.binding?.dustCarrySats ?? 0n),
    deltaSats: toBigIntString(
      challengeBundle.deltaPublication?.deltaSats
      ?? selectedPath.deltaSats
      ?? selectedPath.residualSats
      ?? selectedPath.rolloverCollateralSats
      ?? 0n
    ),
    committedRouting,
    oracleMapId: toStringOrNull(challengeBundle.oracleBinding?.oracleMapId),
    fundingValueSats: toBigIntString(fundingOutpoint.valueSats ?? 0n)
  };

  const statementHash = sha256Hex(stringifyJson(settlementStatement));
  const transcriptCore = {
    statementHash,
    bundleHash: toStringOrNull(challengeBundle.bundleHash),
    oracleMessageDigestHex: toStringOrNull(challengeBundle.oracleBinding?.messageDigestHex),
    deltaPublicationHash: toStringOrNull(challengeBundle.deltaPublication?.publicationHash),
    deltaPublicationId: toStringOrNull(challengeBundle.deltaPublication?.publicationId),
    selectedPathId: settlementStatement.selectedPathId,
    route
  };
  const transcriptCoreHash = sha256Hex(stringifyJson(transcriptCore));
  const anchorContextHash = sha256Hex(stringifyJson({
    transcriptCoreHash,
    fundingTxid,
    selectedPathTxid,
    contractId
  }));

  return {
    contractId,
    route,
    fundingTxid,
    selectedPathTxid,
    settlementStatement,
    statementHash,
    transcriptCore,
    transcriptCoreHash,
    anchorContextHash
  };
}

function buildVariantBuckets(variants, keyField) {
  const buckets = new Map();
  for (const variant of variants) {
    const key = variant[keyField];
    const list = buckets.get(key) || [];
    list.push(variant.variantId);
    buckets.set(key, list);
  }
  return Array.from(buckets.entries()).map(([key, variantIds]) => ({
    [keyField]: key,
    variantIds
  }));
}

function buildTranscriptMultiplicityFamily(core) {
  const variants = [
    {
      variantId: 'canonical_control',
      surface: 'canonical',
      profile: 'baseline',
      aliasClass: 'canonical',
      transcriptHash: sha256Hex(`${core.transcriptCoreHash}|canonical`),
      preservesStatement: true,
      riskLevel: 'low',
      recommendedUse: 'control transcript for honest-vs-challenged path comparison',
      notes: 'Use as the stable control for BitVM witness and summary regressions.'
    },
    {
      variantId: 'fd_repeat_aa',
      surface: 'findanddelete',
      profile: 'aa',
      aliasClass: 'fd-repeat-core',
      transcriptHash: sha256Hex(`${core.transcriptCoreHash}|fd-repeat-core`),
      preservesStatement: true,
      riskLevel: 'medium',
      recommendedUse: 'retry-equivalent challenge session for the same branch intent',
      notes: 'Models the short repeated-token member of the measured FindAndDelete equivalence class.'
    },
    {
      variantId: 'fd_repeat_aaaa',
      surface: 'findanddelete',
      profile: 'aaaa',
      aliasClass: 'fd-repeat-core',
      transcriptHash: sha256Hex(`${core.transcriptCoreHash}|fd-repeat-core`),
      preservesStatement: true,
      riskLevel: 'medium',
      recommendedUse: 'second retry-equivalent session for the same branch intent',
      notes: 'Shares the same alias class as fd_repeat_aa on purpose.'
    },
    {
      variantId: 'fd_repeat_aabb',
      surface: 'findanddelete',
      profile: 'aabb',
      aliasClass: 'fd-branch-split',
      transcriptHash: sha256Hex(`${core.transcriptCoreHash}|fd-branch-split`),
      preservesStatement: true,
      riskLevel: 'low',
      recommendedUse: 'explicit branch split for a distinct BitVM challenge fork',
      notes: 'Use this when you want the same settlement statement but a different transcript family.'
    },
    {
      variantId: 'single_control_00',
      surface: 'sighash_single',
      profile: 'control-input0-output0',
      aliasClass: 'single-control-00',
      transcriptHash: sha256Hex(`${core.transcriptCoreHash}|single-control-00`),
      preservesStatement: true,
      riskLevel: 'low',
      recommendedUse: 'negative-control baseline for non-collapsing SIGHASH_SINGLE behavior',
      notes: 'Useful as a control lane when comparing bug-collapse detection.'
    },
    {
      variantId: 'single_bug_oob_a',
      surface: 'sighash_single',
      profile: 'bug-out-of-range-a',
      aliasClass: 'single-constant-one',
      transcriptHash: CONSTANT_ONE_DIGEST_HEX,
      preservesStatement: true,
      riskLevel: 'high',
      recommendedUse: 'hazard detector only; do not promote to funding or challenge ids',
      notes: 'Represents the constant-one collapse family and should be rejected by the experiment harness.'
    },
    {
      variantId: 'single_bug_oob_b',
      surface: 'sighash_single',
      profile: 'bug-out-of-range-b',
      aliasClass: 'single-constant-one',
      transcriptHash: CONSTANT_ONE_DIGEST_HEX,
      preservesStatement: true,
      riskLevel: 'high',
      recommendedUse: 'hazard detector only; do not promote to funding or challenge ids',
      notes: 'A second collapsed sample that should alias with single_bug_oob_a.'
    }
  ].map((variant) => ({
    ...variant,
    statementHash: core.statementHash,
    transcriptCoreHash: core.transcriptCoreHash,
    hazardous: variant.transcriptHash === CONSTANT_ONE_DIGEST_HEX
  }));

  const transcriptBuckets = buildVariantBuckets(variants, 'transcriptHash');
  const hazardousVariantCount = variants.filter((variant) => variant.hazardous).length;

  return {
    thesis: 'Reuse FindAndDelete-style alias classes for controlled retry families, and treat SIGHASH_SINGLE constant-one collapse as a red-flag detector only.',
    variants,
    summary: {
      variantCount: variants.length,
      uniqueTranscriptCount: transcriptBuckets.length,
      hazardousVariantCount,
      aliasGroups: transcriptBuckets.filter((bucket) => bucket.variantIds.length > 1),
      recommendedPrimaryVariant: 'fd_repeat_aabb',
      recommendedRetryAliasPair: ['fd_repeat_aa', 'fd_repeat_aaaa'],
      rejectionDigestHex: CONSTANT_ONE_DIGEST_HEX
    }
  };
}

function buildIdentifierBifurcationFamily(core) {
  const variantTemplates = [
    {
      variantId: 'anchor_primary',
      carrierLane: 'opreturn-primary',
      envelopeTag: 'primary',
      overlayFit: 'BitVM next-contract handoff id'
    },
    {
      variantId: 'anchor_retry_window',
      carrierLane: 'opreturn-retry-window',
      envelopeTag: 'retry',
      overlayFit: 'mempool retry / rebroadcast lane'
    },
    {
      variantId: 'anchor_parallel_shadow',
      carrierLane: 'parallel-utxo-shadow',
      envelopeTag: 'shadow',
      overlayFit: 'wallet and observer mirror index'
    },
    {
      variantId: 'anchor_oracle_mirror',
      carrierLane: 'oracle-mirror',
      envelopeTag: 'oracle',
      overlayFit: 'OP_RETURN / DLC oracle sidecar mirror'
    }
  ];

  const variants = variantTemplates.map((template, index) => {
    const projectedAnchorId = sha256Hex(
      `${core.anchorContextHash}|${template.carrierLane}|${template.envelopeTag}|${index}`
    );
    return {
      ...template,
      statementHash: core.statementHash,
      transcriptCoreHash: core.transcriptCoreHash,
      preservesStatement: true,
      preservesTranscriptCore: true,
      projectedAnchorId,
      projectedPublicationId: sha256Hex(
        `${core.statementHash}|${template.carrierLane}|${template.envelopeTag}`
      ).slice(0, 24),
      projectedTxidLikeHex: projectedAnchorId,
      notes: 'Projected anchor ids differ even though the settlement statement and transcript core stay fixed.'
    };
  });

  return {
    thesis: 'Treat txid-like identifiers as a search envelope around a stable settlement core, so overlay protocols can rotate anchors without rewriting the economic claim.',
    variants,
    summary: {
      variantCount: variants.length,
      uniqueProjectedAnchorCount: new Set(variants.map((variant) => variant.projectedAnchorId)).size,
      stableTranscriptCoreHash: core.transcriptCoreHash,
      recommendedPrimaryVariant: 'anchor_retry_window',
      recommendedMirrorVariant: 'anchor_parallel_shadow'
    }
  };
}

function buildBitvmSearchManifolds(inputs) {
  const core = deriveSettlementCore(inputs);
  const transcriptMultiplicity = buildTranscriptMultiplicityFamily(core);
  const identifierBifurcation = buildIdentifierBifurcationFamily(core);
  const report = {
    kind: 'm1_bitvm_search_manifolds',
    createdAt: new Date().toISOString(),
    core,
    transcriptMultiplicity,
    identifierBifurcation,
    recommendations: [
      'Promote fd_repeat_aabb as the primary branch-splitting transcript and reserve fd_repeat_aa/fd_repeat_aaaa for retry-equivalent sessions.',
      `Reject any candidate transcript whose digest collapses to ${CONSTANT_ONE_DIGEST_HEX}.`,
      'Use anchor_retry_window as the first txid-like bifurcation lane because it preserves the transcript core while giving a separate external anchor id.'
    ],
    sourceArtifacts: {
      challengeBundle: artifactMeta(CHALLENGE_BUNDLE_PATH, inputs.challengeBundle),
      challengeWitness: artifactMeta(CHALLENGE_WITNESS_PATH, inputs.challengeWitness),
      proceduralSync: artifactMeta(PROCEDURAL_SYNC_PATH, inputs.proceduralSync),
      parallelUtxoIndex: artifactMeta(PARALLEL_UTXO_INDEX_PATH, inputs.parallelUtxoIndex)
    },
    artifactHash: null
  };

  report.artifactHash = sha256Hex(stringifyJson({
    ...report,
    artifactHash: null
  }));
  return report;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# M1 BitVM Search Manifolds');
  lines.push('');
  lines.push(`- Generated: \`${report.createdAt}\``);
  lines.push(`- Artifact hash: \`${report.artifactHash}\``);
  lines.push(`- Contract id: \`${report.core.contractId || 'unknown'}\``);
  lines.push(`- Route: \`${report.core.route || 'unknown'}\``);
  lines.push(`- Funding txid: \`${report.core.fundingTxid || 'unknown'}\``);
  lines.push(`- Statement hash: \`${report.core.statementHash}\``);
  lines.push(`- Transcript core hash: \`${report.core.transcriptCoreHash}\``);
  lines.push('');
  lines.push('## Transcript Multiplicity');
  lines.push(`- Thesis: ${report.transcriptMultiplicity.thesis}`);
  lines.push(`- Variants: \`${report.transcriptMultiplicity.summary.variantCount}\``);
  lines.push(`- Unique transcript ids: \`${report.transcriptMultiplicity.summary.uniqueTranscriptCount}\``);
  lines.push(`- Hazard variants: \`${report.transcriptMultiplicity.summary.hazardousVariantCount}\``);
  lines.push(`- Primary branch split: \`${report.transcriptMultiplicity.summary.recommendedPrimaryVariant}\``);
  lines.push(`- Retry alias pair: \`${report.transcriptMultiplicity.summary.recommendedRetryAliasPair.join(', ')}\``);
  for (const variant of report.transcriptMultiplicity.variants) {
    lines.push(`- ${variant.variantId}: \`${variant.transcriptHash}\` via ${variant.surface}/${variant.profile} (${variant.riskLevel})`);
  }
  lines.push('');
  lines.push('## Identifier Bifurcation');
  lines.push(`- Thesis: ${report.identifierBifurcation.thesis}`);
  lines.push(`- Variants: \`${report.identifierBifurcation.summary.variantCount}\``);
  lines.push(`- Unique projected anchors: \`${report.identifierBifurcation.summary.uniqueProjectedAnchorCount}\``);
  lines.push(`- Primary projected anchor: \`${report.identifierBifurcation.summary.recommendedPrimaryVariant}\``);
  for (const variant of report.identifierBifurcation.variants) {
    lines.push(`- ${variant.variantId}: \`${variant.projectedAnchorId}\` for ${variant.overlayFit}`);
  }
  lines.push('');
  lines.push('## Recommendations');
  for (const recommendation of report.recommendations) {
    lines.push(`- ${recommendation}`);
  }
  lines.push('');
  lines.push('## Source Artifacts');
  for (const [name, meta] of Object.entries(report.sourceArtifacts)) {
    if (!meta) {
      lines.push(`- ${name}: not found`);
      continue;
    }
    lines.push(`- ${name}: \`${path.basename(meta.path)}\` (${meta.kind || 'unknown'}, ${meta.hash})`);
  }
  return lines.join('\n');
}

function loadLatestBitvmSearchManifoldInputs() {
  const challengeBundle = loadJsonIfExists(CHALLENGE_BUNDLE_PATH);
  if (!challengeBundle) {
    throw new Error(`Missing required artifact: ${CHALLENGE_BUNDLE_PATH}`);
  }

  return {
    challengeBundle,
    challengeWitness: loadJsonIfExists(CHALLENGE_WITNESS_PATH),
    proceduralSync: loadJsonIfExists(PROCEDURAL_SYNC_PATH),
    parallelUtxoIndex: loadJsonIfExists(PARALLEL_UTXO_INDEX_PATH)
  };
}

function writeBitvmSearchManifolds(report, outJsonPath = OUT_JSON, outMdPath = OUT_MD) {
  ensureDir(path.dirname(outJsonPath));
  fs.writeFileSync(outJsonPath, stringifyJson(report, true));
  fs.writeFileSync(outMdPath, renderMarkdown(report));
  return {
    outJsonPath,
    outMdPath
  };
}

function run() {
  const inputs = loadLatestBitvmSearchManifoldInputs();
  const report = buildBitvmSearchManifolds(inputs);
  const written = writeBitvmSearchManifolds(report);

  console.log('=== M1 BitVM Search Manifolds ===');
  console.log(`statementHash=${report.core.statementHash}`);
  console.log(`transcriptVariants=${report.transcriptMultiplicity.summary.variantCount}`);
  console.log(`identifierVariants=${report.identifierBifurcation.summary.variantCount}`);
  console.log(`artifactHash=${report.artifactHash}`);
  console.log(`jsonPath=${written.outJsonPath}`);
  console.log(`mdPath=${written.outMdPath}`);
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error('BitVM search manifold generation failed:', err.message);
    process.exit(1);
  }
}

module.exports = {
  CONSTANT_ONE_DIGEST_HEX,
  CHALLENGE_BUNDLE_PATH,
  CHALLENGE_WITNESS_PATH,
  PROCEDURAL_SYNC_PATH,
  PARALLEL_UTXO_INDEX_PATH,
  OUT_JSON,
  OUT_MD,
  deriveSettlementCore,
  buildTranscriptMultiplicityFamily,
  buildIdentifierBifurcationFamily,
  buildBitvmSearchManifolds,
  loadLatestBitvmSearchManifoldInputs,
  writeBitvmSearchManifolds,
  renderMarkdown
};
