/**
 * Milestone 1 - End-to-End Pipeline Driver
 *
 * Runs the current BitVM referee artifact chain in one command and writes a
 * workflow summary artifact for downstream consumers.
 *
 * Run:
 *   node bitvm3/utxo_referee/m1_pipeline.js
 *
 * Optional env:
 *   M1_PIPELINE_MODE=fresh|replay
 *   M1_PATH_NAME=roll|settle-gain|settle-loss
 *   M1_BUCKET_PCT=0|5|...|100
 *   M1_BROADCAST_FUNDING=0|1
 *   M1_INCLUDE_SETTLEMENT_VALIDATION=0|1
 *   M1_FORCE_SETTLEMENT_VALIDATION=0|1
 *   M1_PIPELINE_OUT_PATH=C:\path\to\m1_pipeline_latest.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const PIPELINE_OUT_PATH = path.join(ARTIFACTS_DIR, 'm1_pipeline_latest.json');
const TIMEOUT_PROOF_PATH = path.join(ARTIFACTS_DIR, 'm1_expiry_timeout_testnet_proof.json');
const PROCEDURAL_SYNC_PATH = path.join(ARTIFACTS_DIR, 'bitvm_procedural_sync_latest.json');
const VALIDATION_PATH = path.join(ARTIFACTS_DIR, 'm1_settlement_validation_latest.json');
const PARALLEL_UTXO_INDEX_PATH = path.join(ARTIFACTS_DIR, 'm1_parallel_utxo_index_latest.json');
const BITVM_SEARCH_MANIFOLDS_PATH = path.join(ARTIFACTS_DIR, 'm1_bitvm_search_manifolds_latest.json');

const ARTIFACT_FILES = Object.freeze({
  draft: path.join(ARTIFACTS_DIR, 'm1_dlc_draft_latest.json'),
  fundingPsbt: path.join(ARTIFACTS_DIR, 'm1_funding_psbt_latest.json'),
  fundingFinal: path.join(ARTIFACTS_DIR, 'm1_funding_finalized_latest.json'),
  rollForward: path.join(ARTIFACTS_DIR, 'm1_roll_forward_latest.json'),
  oracleWiring: path.join(ARTIFACTS_DIR, 'm1_oracle_wiring_latest.json'),
  challengeBundle: path.join(ARTIFACTS_DIR, 'm1_challenge_bundle_latest.json'),
  challengeWitness: path.join(ARTIFACTS_DIR, 'm1_challenge_witness_latest.json'),
  expiryRedemption: path.join(ARTIFACTS_DIR, 'm1_expiry_redemption_latest.json'),
  fastRoll: path.join(ARTIFACTS_DIR, 'm1_fast_roll_latest.json'),
  settlementValidation: VALIDATION_PATH,
  proceduralSync: PROCEDURAL_SYNC_PATH,
  parallelUtxoIndex: PARALLEL_UTXO_INDEX_PATH,
  bitvmSearchManifolds: BITVM_SEARCH_MANIFOLDS_PATH
});

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

function loadJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function artifactMeta(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  let kind = null;
  try {
    const parsed = JSON.parse(raw);
    kind = parsed.kind || null;
  } catch (_err) {
    kind = null;
  }

  return {
    path: filePath,
    kind,
    hash: sha256Hex(raw)
  };
}

function compactOutput(output, maxLines = 20, maxChars = 8000) {
  if (!output) {
    return [];
  }

  const trimmed = String(output).trim();
  if (!trimmed) {
    return [];
  }

  let body = trimmed;
  if (body.length > maxChars) {
    body = body.slice(body.length - maxChars);
  }

  const lines = body.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines));
}

function parseIntegerEnv(rawValue, label) {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return null;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer`);
  }
  return parsed;
}

function parsePipelineMode(rawValue) {
  const mode = String(rawValue || 'fresh').trim().toLowerCase();
  if (!['fresh', 'replay'].includes(mode)) {
    throw new Error('M1_PIPELINE_MODE must be one of: fresh, replay');
  }
  return mode;
}

function normalizePlanDeps(deps) {
  if (typeof deps === 'function') {
    return {
      fileExists: deps,
      loadJson: loadJsonIfExists
    };
  }

  return {
    fileExists: deps && typeof deps.fileExists === 'function'
      ? deps.fileExists
      : fs.existsSync,
    loadJson: deps && typeof deps.loadJson === 'function'
      ? deps.loadJson
      : loadJsonIfExists
  };
}

function timeoutProofMatchesLatestExpiry(timeoutProof, expiryArtifact) {
  if (!timeoutProof || !expiryArtifact) {
    return false;
  }

  const proofExpiryHash = timeoutProof?.artifact?.artifactHash || null;
  const latestExpiryHash = expiryArtifact?.artifactHash || null;
  if (!proofExpiryHash || !latestExpiryHash) {
    return false;
  }

  return proofExpiryHash === latestExpiryHash;
}

function resolveValidationSkipReason(options, deps = {}) {
  if (!options.includeSettlementValidation) {
    return 'disabled by M1_INCLUDE_SETTLEMENT_VALIDATION=0';
  }

  const { fileExists, loadJson } = normalizePlanDeps(deps);
  if (!fileExists(TIMEOUT_PROOF_PATH)) {
    return `skipped because ${TIMEOUT_PROOF_PATH} is missing`;
  }

  if (options.forceSettlementValidation) {
    return null;
  }

  const timeoutProof = loadJson(TIMEOUT_PROOF_PATH);
  const expiryArtifact = loadJson(ARTIFACT_FILES.expiryRedemption);
  if (!timeoutProof || !expiryArtifact) {
    return 'skipped because timeout proof or expiry artifact could not be loaded';
  }

  if (!timeoutProofMatchesLatestExpiry(timeoutProof, expiryArtifact)) {
    return 'skipped because timeout proof is stale relative to m1_expiry_redemption_latest.json';
  }

  return null;
}

function resolvePipelineOptions(env = process.env) {
  const mode = parsePipelineMode(env.M1_PIPELINE_MODE);
  const pathName = env.M1_PATH_NAME || env.PATH_NAME || null;
  const bucketPct = parseIntegerEnv(env.M1_BUCKET_PCT ?? env.BUCKET_PCT, 'M1_BUCKET_PCT/BUCKET_PCT');
  const broadcastFunding = (env.M1_BROADCAST_FUNDING ?? env.BROADCAST_FUNDING ?? '0') !== '0';
  const includeSettlementValidation = (env.M1_INCLUDE_SETTLEMENT_VALIDATION ?? '1') !== '0';
  const forceSettlementValidation = (env.M1_FORCE_SETTLEMENT_VALIDATION ?? '0') !== '0';
  const outPath = env.M1_PIPELINE_OUT_PATH || PIPELINE_OUT_PATH;

  if (pathName && bucketPct !== null) {
    throw new Error('Choose M1_PATH_NAME/PATH_NAME or M1_BUCKET_PCT/BUCKET_PCT, not both');
  }
  if (bucketPct !== null && (bucketPct < 0 || bucketPct > 100 || bucketPct % 5 !== 0)) {
    throw new Error('M1_BUCKET_PCT/BUCKET_PCT must be one of: 0,5,10,...,100');
  }

  return {
    mode,
    pathName,
    bucketPct,
    broadcastFunding,
    includeSettlementValidation,
    forceSettlementValidation,
    outPath
  };
}

function buildPipelinePlan(options = {}, deps = {}) {
  const reuseLatestArtifacts = options.mode === 'replay';
  const bundleSelectionEnv = options.pathName
    ? { PATH_NAME: options.pathName }
    : (options.bucketPct !== null && options.bucketPct !== undefined
      ? { BUCKET_PCT: String(options.bucketPct) }
      : { PATH_NAME: 'roll' });

  const validationSkipReason = resolveValidationSkipReason(options, deps);

  return [
    {
      id: 'bootstrap',
      label: 'Bootstrap funded epoch draft',
      script: 'm1_dlc_bootstrap.js',
      env: {},
      skipReason: reuseLatestArtifacts ? 'replay mode reuses latest draft artifact' : null
    },
    {
      id: 'psbtCet',
      label: 'Generate funding PSBT and CET skeletons',
      script: 'm1_dlc_psbt_cet.js',
      env: {},
      skipReason: reuseLatestArtifacts ? 'replay mode reuses latest funding PSBT and CET artifacts' : null
    },
    {
      id: 'signFinalize',
      label: 'Finalize funding transaction artifact',
      script: 'm1_dlc_sign_finalize.js',
      env: {
        BROADCAST_FUNDING: options.broadcastFunding ? '1' : '0'
      },
      skipReason: reuseLatestArtifacts ? 'replay mode reuses latest finalized funding artifact' : null
    },
    {
      id: 'rollForward',
      label: 'Emit roll-forward handoff artifact',
      script: 'm1_roll_forward.js',
      env: {}
    },
    {
      id: 'oracleWiring',
      label: 'Generate oracle wiring artifact',
      script: 'm1_oracle_wiring.js',
      env: {}
    },
    {
      id: 'selectBundle',
      label: 'Select challenge bundle path',
      script: 'm1_select_bucket_bundle.js',
      env: bundleSelectionEnv
    },
    {
      id: 'witnessSummary',
      label: 'Render compact witness summary',
      script: 'm1_challenge_witness_summary.js',
      env: {},
      parseJsonStdout: true
    },
    {
      id: 'expiryRedemption',
      label: 'Generate expiry redemption artifact',
      script: 'm1_expiry_redemption.js',
      env: {}
    },
    {
      id: 'fastRoll',
      label: 'Generate fast-roll handoff artifact',
      script: 'm1_fast_roll.js',
      env: {}
    },
    {
      id: 'settlementValidation',
      label: 'Validate latest settlement artifacts',
      script: 'm1_validate_latest_settlement.js',
      env: {},
      skipReason: validationSkipReason
    },
    {
      id: 'parallelUtxoIndex',
      label: 'Emit parallel UTXO artifact index',
      script: 'm1_parallel_utxo_index.js',
      env: {}
    },
    {
      id: 'proceduralSync',
      label: 'Emit wallet-facing procedural sync summary',
      script: 'm1_procedural_sync.js',
      env: {}
    },
    {
      id: 'bitvmSearchManifolds',
      label: 'Emit BitVM search manifold experiments',
      script: 'm1_bitvm_search_manifolds.js',
      env: {}
    }
  ];
}

function runPipelineStep(step, stepIndex, totalSteps) {
  if (step.skipReason) {
    return {
      id: step.id,
      label: step.label,
      script: step.script,
      status: 'skipped',
      skipReason: step.skipReason
    };
  }

  console.log(`[${stepIndex + 1}/${totalSteps}] ${step.label}`);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const scriptPath = path.join(__dirname, step.script);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...step.env
    },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  const endedAtMs = Date.now();
  const endedAt = new Date(endedAtMs).toISOString();

  const stepResult = {
    id: step.id,
    label: step.label,
    script: step.script,
    status: result.status === 0 ? 'ok' : 'failed',
    exitCode: result.status,
    startedAt,
    endedAt,
    durationMs: endedAtMs - startedAtMs,
    env: step.env,
    stdoutLines: compactOutput(result.stdout),
    stderrLines: compactOutput(result.stderr)
  };

  if (step.parseJsonStdout) {
    const stdout = String(result.stdout || '').trim();
    if (stdout) {
      try {
        stepResult.parsedOutput = JSON.parse(stdout);
      } catch (err) {
        stepResult.parseError = err.message;
      }
    }
  }

  if (result.error) {
    stepResult.processError = result.error.message;
  }

  if (stepResult.status === 'failed') {
    const err = new Error(`Step ${step.id} failed`);
    err.stepResult = stepResult;
    throw err;
  }

  return stepResult;
}

function collectArtifacts() {
  return Object.keys(ARTIFACT_FILES).reduce((acc, key) => {
    acc[key] = artifactMeta(ARTIFACT_FILES[key]);
    return acc;
  }, {});
}

function buildPipelineSummary({ options, plan, results, failure }) {
  const witnessSummaryStep = results.find(step => step.id === 'witnessSummary' && step.status === 'ok');
  const proceduralSyncStep = results.find(step => step.id === 'proceduralSync' && step.status === 'ok');
  const settlementValidationStep = results.find(step => step.id === 'settlementValidation' && step.status === 'ok');
  const parallelUtxoIndexStep = results.find(step => step.id === 'parallelUtxoIndex' && step.status === 'ok');
  const bitvmSearchManifoldsStep = results.find(step => step.id === 'bitvmSearchManifolds' && step.status === 'ok');
  const witnessSummary = witnessSummaryStep ? (witnessSummaryStep.parsedOutput || null) : null;
  const proceduralSync = proceduralSyncStep ? loadJsonIfExists(PROCEDURAL_SYNC_PATH) : null;
  const settlementValidation = settlementValidationStep ? loadJsonIfExists(VALIDATION_PATH) : null;
  const parallelUtxoIndex = parallelUtxoIndexStep ? loadJsonIfExists(PARALLEL_UTXO_INDEX_PATH) : null;
  const bitvmSearchManifolds = bitvmSearchManifoldsStep ? loadJsonIfExists(BITVM_SEARCH_MANIFOLDS_PATH) : null;
  const summary = {
    kind: 'm1_pipeline',
    createdAt: new Date().toISOString(),
    status: failure ? 'failed' : 'ok',
    options: {
      mode: options.mode || 'fresh',
      selectedPath: options.pathName || null,
      selectedBucketPct: options.bucketPct,
      broadcastFunding: options.broadcastFunding,
      includeSettlementValidation: options.includeSettlementValidation,
      forceSettlementValidation: options.forceSettlementValidation
    },
    steps: results.map(step => ({
      id: step.id,
      label: step.label,
      script: step.script,
      status: step.status,
      skipReason: step.skipReason || null,
      exitCode: step.exitCode ?? null,
      durationMs: step.durationMs ?? null,
      stdoutLines: step.stdoutLines || [],
      stderrLines: step.stderrLines || []
    })),
    plannedSteps: plan.map(step => ({
      id: step.id,
      label: step.label,
      script: step.script,
      skipReason: step.skipReason || null
    })),
    outputs: {
      witnessSummary,
      proceduralSync,
      parallelUtxoIndex: parallelUtxoIndex
        ? {
            chainId: parallelUtxoIndex.chain?.chainId || null,
            transactionCount: Array.isArray(parallelUtxoIndex.transactions)
              ? parallelUtxoIndex.transactions.length
              : null,
            fundingTxid: parallelUtxoIndex.anchors?.fundingTxid || null,
            timeoutSpendTxid: parallelUtxoIndex.anchors?.timeoutSpendTxid || null,
            artifactHash: parallelUtxoIndex.artifactHash || null
          }
        : null,
      settlementValidation: settlementValidation
        ? {
            validationHash: settlementValidation.validationHash || null,
            draftPathCount: Array.isArray(settlementValidation.checks?.draftPaths)
              ? settlementValidation.checks.draftPaths.length
              : null,
            expirySettlementKind: settlementValidation.checks?.expiryArtifact?.expected?.settlementKind || null,
            timeoutSettlementKind: settlementValidation.checks?.timeoutProof?.expected?.settlementKind || null
          }
        : null,
      bitvmSearchManifolds: bitvmSearchManifolds
        ? {
            statementHash: bitvmSearchManifolds.core?.statementHash || null,
            transcriptVariantCount: bitvmSearchManifolds.transcriptMultiplicity?.summary?.variantCount ?? null,
            identifierVariantCount: bitvmSearchManifolds.identifierBifurcation?.summary?.variantCount ?? null,
            recommendedTranscriptVariant: bitvmSearchManifolds.transcriptMultiplicity?.summary?.recommendedPrimaryVariant || null,
            recommendedAnchorVariant: bitvmSearchManifolds.identifierBifurcation?.summary?.recommendedPrimaryVariant || null,
            artifactHash: bitvmSearchManifolds.artifactHash || null
          }
        : null
    },
    artifacts: collectArtifacts(),
    failure: failure
      ? {
          stepId: failure.stepResult?.id || null,
          message: failure.message
        }
      : null,
    artifactHash: null
  };

  summary.artifactHash = sha256Hex(stringifyJson({
    ...summary,
    artifactHash: null
  }));
  return summary;
}

function writePipelineSummary(summary, outPath) {
  fs.writeFileSync(outPath, stringifyJson(summary, true));
}

function summarizeFailure(summary) {
  if (!summary || !summary.failure) {
    return null;
  }

  const failedStep = Array.isArray(summary.steps)
    ? summary.steps.find(step => step.id === summary.failure.stepId)
    : null;
  const lastStderrLine = failedStep && Array.isArray(failedStep.stderrLines) && failedStep.stderrLines.length > 0
    ? failedStep.stderrLines[failedStep.stderrLines.length - 1]
    : null;

  let hint = null;
  if (
    summary.options?.mode === 'fresh'
    && summary.failure.stepId === 'bootstrap'
    && lastStderrLine
    && /ECONNREFUSED/i.test(lastStderrLine)
  ) {
    hint = 'Start the configured chain RPC or rerun with M1_PIPELINE_MODE=replay to reuse the latest artifacts.';
  }

  return {
    stepId: summary.failure.stepId || null,
    lastStderrLine,
    hint
  };
}

function run() {
  const options = resolvePipelineOptions();
  const plan = buildPipelinePlan(options);
  const results = [];
  let failure = null;

  for (let index = 0; index < plan.length; index++) {
    const step = plan[index];
    try {
      const result = runPipelineStep(step, index, plan.length);
      results.push(result);
    } catch (err) {
      failure = err;
      results.push(err.stepResult || {
        id: step.id,
        label: step.label,
        script: step.script,
        status: 'failed',
        exitCode: null,
        stdoutLines: [],
        stderrLines: [String(err.message || err)]
      });
      break;
    }
  }

  const summary = buildPipelineSummary({
    options,
    plan,
    results,
    failure
  });
  writePipelineSummary(summary, options.outPath);

  console.log('=== M1 Pipeline ===');
  console.log(`status=${summary.status}`);
  console.log(`mode=${summary.options.mode}`);
  console.log(`selectedPath=${summary.options.selectedPath}`);
  console.log(`selectedBucketPct=${summary.options.selectedBucketPct}`);
  console.log(`broadcastFunding=${summary.options.broadcastFunding}`);
  console.log(`settlementValidation=${settlementValidationStepStatus(summary.steps)}`);
  console.log(`proceduralState=${summary.outputs.proceduralSync?.state || null}`);
  console.log(`parallelUtxoTxs=${summary.outputs.parallelUtxoIndex?.transactionCount || null}`);
  console.log(`transcriptVariants=${summary.outputs.bitvmSearchManifolds?.transcriptVariantCount || null}`);
  console.log(`artifactHash=${summary.artifactHash}`);
  console.log(`artifactPath=${options.outPath}`);

  if (failure) {
    const failureSummary = summarizeFailure(summary);
    console.error(`Pipeline failed at step ${failure.stepResult?.id || 'unknown'}: ${failure.message}`);
    if (failureSummary?.lastStderrLine) {
      console.error(`Last error: ${failureSummary.lastStderrLine}`);
    }
    if (failureSummary?.hint) {
      console.error(`Hint: ${failureSummary.hint}`);
    }
    process.exit(1);
  }
}

function settlementValidationStepStatus(steps) {
  const step = Array.isArray(steps) ? steps.find(entry => entry.id === 'settlementValidation') : null;
  return step ? step.status : 'missing';
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error('Pipeline execution failed:', err.message);
    process.exit(1);
  }
}

module.exports = {
  PIPELINE_OUT_PATH,
  TIMEOUT_PROOF_PATH,
  PARALLEL_UTXO_INDEX_PATH,
  BITVM_SEARCH_MANIFOLDS_PATH,
  resolvePipelineOptions,
  buildPipelinePlan,
  buildPipelineSummary,
  resolveValidationSkipReason,
  timeoutProofMatchesLatestExpiry,
  summarizeFailure
};
