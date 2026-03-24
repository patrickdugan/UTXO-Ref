/**
 * Milestone 1 Transition Tests
 *
 * Run: node bitvm3/utxo_referee/m1_transition.test.js
 */

const {
  ReceiptTallyMap,
  computeRouteAmounts,
  applyBinarySettlementTransition,
  generateTransitionCircuit,
  toTransitionWitness
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

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `expected ${expected}, got ${actual}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

console.log('\n=== Milestone 1 Transition Tests ===\n');

test('transition carries balance root through state', () => {
  const tally = new ReceiptTallyMap({ epochId: 1n });
  tally.applyDeposit({ depositId: 'dep-1', accountId: 'alice', amountSats: 762000n });

  const state = {
    epochId: 1n,
    collateralSats: tally.totalSupplySats(),
    pnlPayoutBps: 3333,
    receiptBalanceRoot: tally.getBalanceMerkleRootHex(),
    challengeWindowStart: 1n,
    challengeWindowLength: 2n,
    challengeWindowEnd: 3n
  };

  const next = applyBinarySettlementTransition(state, { route: 'flat' });
  assertEq(next.receiptBalanceRoot, tally.getBalanceMerkleRootHex());
  assertEq(next.prevBalanceRoot, tally.getBalanceMerkleRootHex());
  assertEq(next.challengeWindowStart, '1');
  assertEq(next.challengeWindowLength, '2');
  assertEq(next.challengeWindowEnd, '3');
  assertEq(next.dustCarrySats, '0');
});

test('transition witness includes balance root bits', () => {
  const tally = new ReceiptTallyMap({ epochId: 1n });
  tally.applyDeposit({ depositId: 'dep-1', accountId: 'alice', amountSats: 798100n });

  const witness = toTransitionWitness({
    tallyMap: tally,
    epochId: 1n,
    collateralSats: tally.totalSupplySats(),
    pnlPayoutBps: 3333
  }, 'roll');

  assertEq(witness.receiptBalanceRoot.length, 256);
  assertEq(witness.prevBalanceRoot.length, 256);
  assert(witness.routeRoll === 1, 'roll route bit should be set');
});

test('transition witness includes an account claim bundle', () => {
  const tally = new ReceiptTallyMap({
    epochId: 2n,
    challengeWindowStart: 2n,
    challengeWindowLength: 3n
  });
  tally.applyDeposit({ depositId: 'dep-1', accountId: 'alice', amountSats: 123n });
  tally.applyDeposit({ depositId: 'dep-2', accountId: 'bob', amountSats: 456n });

  const witness = toTransitionWitness({
    tallyMap: tally,
    claimAccountId: 'alice',
    epochId: 2n,
    collateralSats: tally.totalSupplySats(),
    pnlPayoutBps: 3333
  }, 'flat');

  assert(witness.balanceClaim, 'balance claim should be present');
  assertEq(witness.balanceClaim.accountId, 'alice');
  assertEq(witness.balanceClaim.balanceSats, '123');
  assertEq(witness.balanceClaim.balanceRoot, tally.getBalanceMerkleRootHex());
  assertEq(witness.balanceClaim.challengeWindowStart, '2');
  assertEq(witness.balanceClaim.challengeWindowLength, '3');
  assertEq(witness.balanceClaim.challengeWindowEnd, '5');
  assertEq(witness.balanceClaimLeafHash.length, 256);
  assertEq(witness.balanceClaimSiblings.length, 16);
  assertEq(witness.balanceClaimIndex.length, 16);
  assertEq(witness.challengeWindowStart.length, 64);
  assertEq(witness.challengeWindowLength.length, 64);
  assertEq(witness.challengeWindowEnd.length, 64);
});

test('transition circuit exposes balance root inputs', () => {
  const built = generateTransitionCircuit({ bitWidth: 64 });
  assert(built.inputs.receiptBalanceRoot, 'receiptBalanceRoot input missing');
  assert(built.inputs.prevBalanceRoot, 'prevBalanceRoot input missing');
  assert(built.inputs.balanceClaimEpochId, 'balanceClaimEpochId input missing');
  assert(built.inputs.balanceClaimBalanceSats, 'balanceClaimBalanceSats input missing');
  assert(built.inputs.balanceClaimLeafHash, 'balanceClaimLeafHash input missing');
  assert(built.inputs.balanceClaimRoot, 'balanceClaimRoot input missing');
  assert(built.inputs.balanceClaimIndex, 'balanceClaimIndex input missing');
  assert(built.inputs.balanceClaimSiblings, 'balanceClaimSiblings input missing');
  assert(built.inputs.challengeWindowStart, 'challengeWindowStart input missing');
  assert(built.inputs.challengeWindowLength, 'challengeWindowLength input missing');
  assert(built.inputs.challengeWindowEnd, 'challengeWindowEnd input missing');
});

test('route amounts remain exact integer sats', () => {
  const result = computeRouteAmounts(798100n, 3333);
  assertEq(result.flatPayoutSats.toString(), '532094');
  assertEq(result.pnlPayoutSats.toString(), '266006');
  assertEq(result.dustCarrySats.toString(), '0');
});

console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
