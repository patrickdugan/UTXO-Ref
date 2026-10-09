/**
 * Run: node bitvm3/utxo_referee/bitvm_liquidity_lease_referee.test.js
 */

const {
  buildBitvmLiquidityLease,
  verifyBitvmLiquidityLease,
  buildBitvmLiquidityLeaseChallenge,
  verifyBitvmLiquidityLeaseChallenge
} = require('./bitvm_liquidity_lease_referee');

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

console.log('\n=== BitVM Liquidity Lease Referee Tests ===\n');

test('verifies a route-quality lease with sufficient capacity', () => {
  const lease = buildBitvmLiquidityLease({
    promisedCapacitySats: 100000,
    routeEvidence: {
      channelOutpoint: `${'22'.repeat(32)}:1`,
      observedCapacitySats: 100000,
      observedFeePpm: 500,
      observedCltvDelta: 20
    }
  });
  const result = verifyBitvmLiquidityLease(lease);

  assert(result.ok, result.reason);
  assert(result.routeOk, 'route evidence should pass');
  assertEq(lease.enforcement.successPath, 'release_provider_premium');
});

test('builds challengeable penalty evidence for failed route lease', () => {
  const lease = buildBitvmLiquidityLease({
    promisedCapacitySats: 100000,
    routeEvidence: {
      observedCapacitySats: 50000,
      observedFeePpm: 2000,
      observedCltvDelta: 80
    }
  });
  const leaseResult = verifyBitvmLiquidityLease(lease);
  const challenge = buildBitvmLiquidityLeaseChallenge(lease);
  const challengeResult = verifyBitvmLiquidityLeaseChallenge(challenge, lease);

  assert(leaseResult.ok, leaseResult.reason);
  assert(!leaseResult.routeOk, 'route evidence should fail');
  assert(challengeResult.ok, challengeResult.reason);
  assert(challenge.challengeable, 'failed route lease should be challengeable');
  assert(challenge.core.violations.includes('insufficient_capacity'), 'missing capacity violation');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
