/**
 * Pipeline driver tests
 *
 * Run: node bitvm3/utxo_referee/m1_pipeline.test.js
 */

const {
  resolvePipelineOptions,
  buildPipelinePlan,
  resolveValidationSkipReason,
  summarizeFailure
} = require('./m1_pipeline');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `expected ${expected}, got ${actual}`);
  }
}

console.log('\n=== M1 Pipeline Tests ===\n');

test('default pipeline plan stays in safe non-broadcast roll mode', () => {
  const options = resolvePipelineOptions({});
  const plan = buildPipelinePlan(options, { fileExists: () => false });
  const selectBundle = plan.find(step => step.id === 'selectBundle');
  const signFinalize = plan.find(step => step.id === 'signFinalize');
  const validation = plan.find(step => step.id === 'settlementValidation');
  const parallelUtxoIndex = plan.find(step => step.id === 'parallelUtxoIndex');
  const bitvmSearchManifolds = plan.find(step => step.id === 'bitvmSearchManifolds');

  assertEq(options.mode, 'fresh');
  assertEq(options.pathName, null);
  assertEq(options.bucketPct, null);
  assertEq(options.broadcastFunding, false);
  assertEq(selectBundle.env.PATH_NAME, 'roll');
  assertEq(signFinalize.env.BROADCAST_FUNDING, '0');
  assert(validation.skipReason, 'validation should be skipped when timeout proof is absent');
  assert(parallelUtxoIndex, 'parallel UTXO index step should be present');
  assert(bitvmSearchManifolds, 'BitVM search manifold step should be present');
});

test('explicit path and broadcast flags flow into plan', () => {
  const options = resolvePipelineOptions({
    M1_PATH_NAME: 'settle-loss',
    M1_BROADCAST_FUNDING: '1',
    M1_FORCE_SETTLEMENT_VALIDATION: '1'
  });
  const plan = buildPipelinePlan(options, {
    fileExists: () => true,
    loadJson: () => ({
      artifactHash: 'same-hash',
      artifact: {
        artifactHash: 'same-hash'
      }
    })
  });
  const selectBundle = plan.find(step => step.id === 'selectBundle');
  const signFinalize = plan.find(step => step.id === 'signFinalize');
  const validation = plan.find(step => step.id === 'settlementValidation');

  assertEq(options.pathName, 'settle-loss');
  assertEq(options.broadcastFunding, true);
  assertEq(selectBundle.env.PATH_NAME, 'settle-loss');
  assertEq(signFinalize.env.BROADCAST_FUNDING, '1');
  assertEq(validation.skipReason, null);
});

test('replay mode skips live wallet generation steps', () => {
  const options = resolvePipelineOptions({
    M1_PIPELINE_MODE: 'replay',
    M1_BUCKET_PCT: '10'
  });
  const plan = buildPipelinePlan(options, { fileExists: () => false });
  const bootstrap = plan.find(step => step.id === 'bootstrap');
  const psbtCet = plan.find(step => step.id === 'psbtCet');
  const signFinalize = plan.find(step => step.id === 'signFinalize');
  const selectBundle = plan.find(step => step.id === 'selectBundle');
  const parallelUtxoIndex = plan.find(step => step.id === 'parallelUtxoIndex');
  const bitvmSearchManifolds = plan.find(step => step.id === 'bitvmSearchManifolds');

  assertEq(options.mode, 'replay');
  assertEq(bootstrap.skipReason, 'replay mode reuses latest draft artifact');
  assertEq(psbtCet.skipReason, 'replay mode reuses latest funding PSBT and CET artifacts');
  assertEq(signFinalize.skipReason, 'replay mode reuses latest finalized funding artifact');
  assertEq(selectBundle.env.BUCKET_PCT, '10');
  assert(parallelUtxoIndex, 'parallel UTXO index step should be present');
  assertEq(parallelUtxoIndex.skipReason, undefined);
  assert(bitvmSearchManifolds, 'BitVM search manifold step should be present');
});

test('validation skips stale timeout proof unless forced', () => {
  const options = resolvePipelineOptions({});
  const skipReason = resolveValidationSkipReason(options, {
    fileExists: () => true,
    loadJson: (filePath) => {
      if (String(filePath).includes('m1_expiry_timeout_testnet_proof')) {
        return {
          artifact: {
            artifactHash: 'old-expiry-hash'
          }
        };
      }
      return {
        artifactHash: 'new-expiry-hash'
      };
    }
  });

  assertEq(skipReason, 'skipped because timeout proof is stale relative to m1_expiry_redemption_latest.json');
});

test('forced validation overrides stale timeout proof gate', () => {
  const options = resolvePipelineOptions({
    M1_FORCE_SETTLEMENT_VALIDATION: '1'
  });
  const skipReason = resolveValidationSkipReason(options, {
    fileExists: () => true,
    loadJson: () => ({
      artifactHash: 'new-expiry-hash',
      artifact: {
        artifactHash: 'old-expiry-hash'
      }
    })
  });

  assertEq(skipReason, null);
});

test('invalid pipeline mode is rejected', () => {
  let threw = false;
  try {
    resolvePipelineOptions({
      M1_PIPELINE_MODE: 'offline'
    });
  } catch (err) {
    threw = true;
    assert(String(err.message).includes('M1_PIPELINE_MODE'), 'expected invalid mode error');
  }

  assert(threw, 'expected resolvePipelineOptions to reject invalid pipeline mode');
});

test('bucket selection cannot be combined with explicit path', () => {
  let threw = false;
  try {
    resolvePipelineOptions({
      M1_PATH_NAME: 'roll',
      M1_BUCKET_PCT: '10'
    });
  } catch (err) {
    threw = true;
    assert(String(err.message).includes('Choose M1_PATH_NAME'), 'expected path/bucket conflict error');
  }

  assert(threw, 'expected resolvePipelineOptions to reject conflicting selectors');
});

test('failure summary suggests replay mode for bootstrap RPC refusal', () => {
  const summary = summarizeFailure({
    failure: {
      stepId: 'bootstrap'
    },
    options: {
      mode: 'fresh'
    },
    steps: [
      {
        id: 'bootstrap',
        stderrLines: ['Bootstrap failed: connect ECONNREFUSED 127.0.0.1:19332']
      }
    ]
  });

  assertEq(summary.stepId, 'bootstrap');
  assertEq(summary.lastStderrLine, 'Bootstrap failed: connect ECONNREFUSED 127.0.0.1:19332');
  assert(
    summary.hint.includes('configured chain RPC') && summary.hint.includes('M1_PIPELINE_MODE=replay'),
    'expected replay hint when bootstrap RPC is unavailable'
  );
});

console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
