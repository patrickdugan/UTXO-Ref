#!/usr/bin/env node

const {
  buildShinigamiVirtualCetBundle,
  verifyShinigamiVirtualCetBundle,
  buildShinigamiFraudCases,
  buildShinigamiDashboardProof
} = require('./shinigami_virtual_cet_ark');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  OK  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

console.log('\n=== Shinigami Ark Virtual CET Tests ===\n');

test('bundle binds DLC outcomes to Ark leaves and deterministic Shinigami receipt', () => {
  const bundle = buildShinigamiVirtualCetBundle({ outcomeCount: 17 });
  const result = verifyShinigamiVirtualCetBundle(bundle);

  assert(result.ok, result.reason || 'bundle should verify');
  assert(bundle.kind === 'shinigami_ark_virtual_cet_bundle', 'wrong bundle kind');
  assert(bundle.virtualCetSet.virtualCets.length === 17, 'outcome count mismatch');
  assert(bundle.dashboardProjection.compression.materializedCetCount === 0, 'CETs should stay virtual');
  assert(bundle.zkClaim.claimCore.materializedCetCount === 0, 'claim should not materialize CETs');
  assert(bundle.proofReceipt.receiptCore.proofSystem === 'shinigami-stwo-placeholder', 'wrong proof receipt profile');
  assert(bundle.taprootProofManifest.manifestCore.selectedLeafRole === 'dlc_virtual_cet_settlement', 'wrong taproot role');
  assert(bundle.arkZkMiniscriptClaim.claimCore.selectedLeafRole === 'dlc_virtual_cet_settlement', 'wrong Ark ZK role');
});

test('dashboard proof exposes a compact reviewer projection', () => {
  const proof = buildShinigamiDashboardProof({ outcomeCount: 9 });

  assert(proof.verification.ok, proof.verification.reason || 'dashboard proof should verify');
  assert(proof.projection.summary.virtualCetCount === 9, 'projection outcome count mismatch');
  assert(proof.projection.summary.materializedCetCount === 0, 'projection should show no materialized CETs');
  assert(proof.projection.flow.length === 4, 'flow should have four stages');
  assert(proof.projection.fraudMatrix.length >= 6, 'fraud matrix should cover expected cases');
  assert(proof.projection.proofStatement.claimId === proof.claimId, 'proof statement should bind claim id');
});

test('fraud cases are stable and slashable', () => {
  const bundle = buildShinigamiVirtualCetBundle();
  const cases = buildShinigamiFraudCases(bundle);

  assert(cases.length === 6, 'expected six fraud cases');
  assert(cases.every(item => item.caseId.length === 64), 'case id missing');
  assert(cases.every(item => item.slashable), 'case should be slashable');
  assert(cases.some(item => item.id === 'stale-oracle'), 'missing stale oracle case');
  assert(cases.some(item => item.id === 'asp-route-mismatch'), 'missing ASP route mismatch case');
});

test('verification fails on changed outcome', () => {
  const bundle = clone(buildShinigamiVirtualCetBundle());
  bundle.selectedOutcome.outcomeId = 'btc_usd_not_committed';

  const result = verifyShinigamiVirtualCetBundle(bundle);
  assert(!result.ok, 'tampered outcome should fail');
});

test('verification fails on changed payout', () => {
  const bundle = clone(buildShinigamiVirtualCetBundle());
  bundle.selectedOutcome.offerPayoutSats = String(Number(bundle.selectedOutcome.offerPayoutSats) + 1);

  const result = verifyShinigamiVirtualCetBundle(bundle);
  assert(!result.ok, 'tampered payout should fail');
});

test('verification fails on changed Ark root', () => {
  const bundle = clone(buildShinigamiVirtualCetBundle());
  bundle.arkLeafRoot = '0'.repeat(64);

  const result = verifyShinigamiVirtualCetBundle(bundle);
  assert(!result.ok, 'tampered Ark root should fail');
});

test('verification fails on stale oracle claim', () => {
  const bundle = buildShinigamiVirtualCetBundle({
    oracleAttestationAgeBlocks: 145,
    maxOracleAgeBlocks: 144
  });

  const result = verifyShinigamiVirtualCetBundle(bundle);
  assert(!result.ok, 'stale oracle should fail');
  assert(result.reason.includes('stale'), `unexpected reason: ${result.reason}`);
});

test('verification fails on mismatched proof receipt', () => {
  const bundle = clone(buildShinigamiVirtualCetBundle());
  bundle.proofReceipt.receiptCore.claimId = '0'.repeat(64);

  const result = verifyShinigamiVirtualCetBundle(bundle);
  assert(!result.ok, 'bad proof receipt should fail');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
