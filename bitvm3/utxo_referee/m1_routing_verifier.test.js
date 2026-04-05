/**
 * Milestone 1 Settlement Routing Verifier Tests
 *
 * Run: node bitvm3/utxo_referee/m1_routing_verifier.test.js
 */

const {
  deriveSettlementRouting,
  verifySettlementRouting
} = require('./index');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
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

console.log('\n=== M1 Settlement Routing Verifier Tests ===\n');

test('derive settlement routing keeps bounded payout exact', () => {
  const derived = deriveSettlementRouting({
    route: 'settle-loss',
    collateralSats: 800000n,
    actualPayoutSats: 12400n,
    feeSats: 2000n,
    refundSats: 785600n,
    dustCarrySats: 0n
  }, {
    winnerAddress: 'alice-dest',
    refundAddress: 'residual-dest',
    feeAddress: 'fee-dest'
  });

  assertEq(derived.settlementKind, 'pnl-sweep');
  assertEq(derived.winnerSweepSats.toString(), '12400');
  assertEq(derived.refundRemainderSats.toString(), '785600');
  assertEq(derived.totalOutputsSats.toString(), '800000');
  assert(derived.conservationHolds, 'conservation should hold');
});

test('derive settlement routing maps roll route to timeout refund', () => {
  const derived = deriveSettlementRouting({
    route: 'roll',
    collateralSats: 798100n,
    feeSats: 0n,
    rolloverCollateralSats: 783735n,
    dustCarrySats: 0n
  });

  assertEq(derived.settlementKind, 'timeout-refund');
  assertEq(derived.winnerSweepSats.toString(), '783735');
  assertEq(derived.refundRemainderSats.toString(), '14365');
  assert(derived.conservationHolds, 'roll conservation should hold');
});

test('verify settlement routing accepts exact timeout proof outputs', () => {
  const result = verifySettlementRouting({
    route: 'roll',
    collateralSats: 798100n,
    feeSats: 0n,
    rolloverCollateralSats: 783735n,
    dustCarrySats: 0n
  }, {
    outputs: [
      { role: 'winner-sweep', address: 'recipient', amountSats: '783735' },
      { role: 'refund-remainder', address: 'residual', amountSats: '14365' }
    ]
  }, {
    winnerAddress: 'recipient',
    refundAddress: 'residual'
  });

  assert(result.ok, result.reason);
  assertEq(result.expected.settlementKind, 'timeout-refund');
});

test('verify settlement routing rejects wrong refund remainder', () => {
  const result = verifySettlementRouting({
    route: 'settle-gain',
    collateralSats: 800000n,
    actualPayoutSats: 12400n,
    feeSats: 2000n,
    refundSats: 785600n,
    dustCarrySats: 0n
  }, {
    outputs: [
      { role: 'winner-sweep', address: 'alice', amountSats: '12400' },
      { role: 'refund-remainder', address: 'residual', amountSats: '785599' },
      { role: 'fee', address: 'fee', amountSats: '2000' }
    ]
  }, {
    winnerAddress: 'alice',
    refundAddress: 'residual',
    feeAddress: 'fee'
  });

  assert(!result.ok, 'routing verification should fail');
  assert(String(result.reason || '').includes('refund-remainder amount mismatch'), 'expected refund mismatch reason');
});

console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
