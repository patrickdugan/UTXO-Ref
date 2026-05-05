/**
 * Jurassic BitVM mechanism catalog tests.
 *
 * Run: node bitvm3/utxo_referee/jurassic_bitvm_mechanisms.test.js
 */

const {
  CONSTANT_ONE_DIGEST_HEX,
  TARGETS,
  buildJurassicMechanismRefs,
  buildJurassicBitvmMechanismCatalog
} = require('./jurassic_bitvm_mechanisms');

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

function buildFixtureCatalog() {
  return buildJurassicBitvmMechanismCatalog({
    createdAt: '2026-05-03T00:00:00.000Z',
    contractId: 'test-jurassic-bitvm',
    applicationIntent: 'unit-test Jurassic motifs against UTXORef BitVM prototypes',
    amountSats: '123456',
    settlementEpoch: 'unit-test-epoch',
    challengeWindowBlocks: 72
  });
}

console.log('\n=== Jurassic BitVM Mechanism Tests ===\n');

test('catalog covers the named protocol targets', () => {
  const report = buildFixtureCatalog();
  assertEq(report.core.targetProtocols.length, TARGETS.length);
  for (const target of TARGETS) {
    assert(report.core.targetProtocols.includes(target), `missing target ${target}`);
    assert(report.composedPlans.some((plan) => plan.target === target), `missing plan for ${target}`);
  }
});

test('transcript switchboard preserves one semantic state and rejects the tripwire digest', () => {
  const report = buildFixtureCatalog();
  const switchboard = report.mechanisms.transcriptSwitchboard;
  const variants = switchboard.variants;
  const stateHashes = new Set(variants.map((variant) => variant.semanticStateHash));
  const retryA = variants.find((variant) => variant.mechanismId === 'ln_ptlc_success_retry_a');
  const retryB = variants.find((variant) => variant.mechanismId === 'ln_ptlc_success_retry_b');
  const timeout = variants.find((variant) => variant.mechanismId === 'ln_timeout_challenge_split');
  const tripwire = variants.find((variant) => variant.mechanismId === 'constant_one_tripwire');

  assertEq(stateHashes.size, 1, 'all transcript variants should preserve one semantic state');
  assert(retryA && retryB && timeout && tripwire, 'expected core transcript variants');
  assertEq(retryA.transcriptDigest, retryB.transcriptDigest, 'retry variants should alias');
  assert(retryA.transcriptDigest !== timeout.transcriptDigest, 'timeout branch should split');
  assertEq(tripwire.transcriptDigest, CONSTANT_ONE_DIGEST_HEX);
  assert(tripwire.rejected, 'tripwire must be rejected');
});

test('namespace relay rotates public handles without changing semantic state', () => {
  const report = buildFixtureCatalog();
  const matrix = report.mechanisms.namespaceRelayMatrix;
  const variants = matrix.variants;
  const stateHashes = new Set(variants.map((variant) => variant.semanticStateHash));
  const publicHandles = new Set(variants.map((variant) => variant.publicHandleId));

  assertEq(stateHashes.size, 1);
  assertEq(publicHandles.size, variants.length);
  for (const target of TARGETS) {
    assert(variants.some((variant) => variant.target === target), `missing namespace variant for ${target}`);
  }
});

test('carrier routes include prototype-ready plans and keep Shinigami scaffold-only', () => {
  const report = buildFixtureCatalog();
  const carriers = report.mechanisms.carrierShadowRoutes.variants;
  const shinigami = carriers.filter((carrier) => carrier.target === 'shinigami');
  const ready = carriers.filter((carrier) => carrier.expectedPolicyFit === 'prototype_ready');

  assert(ready.length >= 4, 'expected several prototype-ready carrier routes');
  assert(shinigami.length >= 1, 'expected a Shinigami scaffold route');
  assert(shinigami.every((carrier) => carrier.expectedPolicyFit === 'scaffold_only'));
  assert(report.composedPlans.find((plan) => plan.target === 'shinigami').status === 'scaffold_only');
});

test('artifact hash is stable for identical inputs', () => {
  const a = buildFixtureCatalog();
  const b = buildFixtureCatalog();
  assertEq(a.artifactHash, b.artifactHash);
});

test('target refs expose stable ids for prototype bundles', () => {
  const refs = buildJurassicMechanismRefs('lightning', {
    contractId: 'lease-demo',
    amountSats: '50000',
    challengeWindowBlocks: 144
  });
  const refsAgain = buildJurassicMechanismRefs('lightning', {
    contractId: 'lease-demo',
    amountSats: '50000',
    challengeWindowBlocks: 144
  });

  assertEq(refs.refId, refsAgain.refId);
  assertEq(refs.target, 'lightning');
  assert(refs.transcriptSwitchboardId.length === 64, 'missing switchboard id');
  assert(refs.primaryPublicHandleId.length === 64, 'missing public handle');
  assert(refs.primaryCarrierCommitmentId.length === 64, 'missing carrier commitment');
  assertEq(refs.rejectionTripwireDigest, CONSTANT_ONE_DIGEST_HEX);
});

console.log('\n---------------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('---------------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
