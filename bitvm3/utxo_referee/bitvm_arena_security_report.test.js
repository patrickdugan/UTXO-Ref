/**
 * Run: node bitvm3/utxo_referee/bitvm_arena_security_report.test.js
 */

const {
  buildBitvmArenaSecurityReport,
  verifyBitvmArenaSecurityReport
} = require('./bitvm_arena_security_report');

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
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEq(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

console.log('\n=== BitVM Arena Security Report Tests ===\n');

test('builds a report from the UTXORef Arena red-team pass', () => {
  const report = buildBitvmArenaSecurityReport();
  const result = verifyBitvmArenaSecurityReport(report);

  assert(result.ok, result.reason);
  assertEq(result.attackReduction, 6);
  assertEq(result.validationRegressions, 0);
  assert(report.core.nextArenaTargets.includes('withdrawal queue duplicate payout'), 'missing next target');
});

test('detects report tampering', () => {
  const report = buildBitvmArenaSecurityReport();
  const tampered = clone(report);
  tampered.core.after.successfulAttacks = 1;
  const result = verifyBitvmArenaSecurityReport(tampered);

  assert(!result.ok, 'tampered report should fail');
  assert(String(result.reason).includes('report hash mismatch'), 'expected report hash mismatch');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
