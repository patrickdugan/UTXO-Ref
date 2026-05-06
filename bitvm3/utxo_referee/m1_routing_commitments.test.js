/**
 * Routing commitment normalization tests
 *
 * Run: node bitvm3/utxo_referee/m1_routing_commitments.test.js
 */

const {
  normalizeRoutingCommitments,
  withCommittedRouting,
  assertCommittedRouting
} = require('./index');

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

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `expected ${expected}, got ${actual}`);
  }
}

console.log('\n=== M1 Routing Commitment Tests ===\n');

test('withCommittedRouting emits canonical committedRouting field', () => {
  const enriched = withCommittedRouting({
    winnerRole: 'alice',
    winnerAddress: 'alice-dest',
    refundRole: 'residual',
    refundAddress: 'residual-dest'
  });

  assert(enriched.committedRouting, 'committedRouting should exist');
  assertEq(enriched.committedRouting.winnerAddress, 'alice-dest');
  assertEq(enriched.committedRouting.refundAddress, 'residual-dest');
});

test('normalizeRoutingCommitments prefers nested committedRouting payload', () => {
  const normalized = normalizeRoutingCommitments({
    winnerAddress: 'stale-winner',
    committedRouting: {
      winnerRole: 'bob',
      winnerAddress: 'fresh-winner',
      refundRole: 'residual',
      refundAddress: 'fresh-refund'
    }
  });

  assertEq(normalized.winnerRole, 'bob');
  assertEq(normalized.winnerAddress, 'fresh-winner');
  assertEq(normalized.refundAddress, 'fresh-refund');
});

test('assertCommittedRouting rejects missing address for declared role', () => {
  let threw = false;
  try {
    assertCommittedRouting({
      winnerRole: 'alice',
      winnerAddress: null
    }, 'test commitments');
  } catch (err) {
    threw = true;
    assert(String(err.message).includes('winnerAddress'), 'expected missing winnerAddress message');
  }

  assert(threw, 'expected assertCommittedRouting to throw');
});

console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
