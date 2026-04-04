/**
 * Milestone 1 Transition Tests
 *
 * Run: node bitvm3/utxo_referee/m1_transition.test.js
 */

const {
  ReceiptTallyMap,
  computeRouteAmounts,
  computeBoundedSettlementAmounts,
  applyBinarySettlementTransition,
  generateTransitionCircuit,
  toTransitionWitness,
  buildChallengeWitnessBundle
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

test('bounded settlement only pays realized loss and carries refund forward', () => {
  const result = computeBoundedSettlementAmounts(1000000n, 500, 155, 0);
  assertEq(result.actualPayoutSats.toString(), '15500');
  assertEq(result.feeSats.toString(), '0');
  assertEq(result.refundSats.toString(), '984500');
  assertEq(result.rolloverCollateralSats.toString(), '984500');
  assertEq(result.effectivePnlBps, 155);
});

test('bounded settlement caps realized loss at the active bucket', () => {
  const result = computeBoundedSettlementAmounts(1000000n, 500, 1553, 25);
  assertEq(result.effectivePnlBps, 500);
  assertEq(result.actualPayoutSats.toString(), '50000');
  assertEq(result.feeSats.toString(), '2500');
  assertEq(result.refundSats.toString(), '947500');
  assertEq(result.rolloverCollateralSats.toString(), '947500');
});

test('bounded transition emits payout fee and rollover fields', () => {
  const next = applyBinarySettlementTransition({
    epochId: 7n,
    collateralSats: 1000000n,
    bucketCapBps: 500,
    realizedPnlBps: 155,
    feeBps: 25
  }, { route: 'settle-loss' });

  assertEq(next.route, 'settle-loss');
  assertEq(next.actualPayoutSats, '15500');
  assertEq(next.feeSats, '2500');
  assertEq(next.refundSats, '982000');
  assertEq(next.rolloverCollateralSats, '982000');
  assertEq(next.residualSats, '982000');
  assertEq(next.outputs.rolloverCollateralSats, '982000');
});

test('challenge witness consumes settle-loss bundle fields', () => {
  const tally = new ReceiptTallyMap({
    epochId: 1n,
    challengeWindowStart: 1n,
    challengeWindowLength: 4n
  });
  tally.applyDeposit({ depositId: 'dep-1', accountId: 'alice', amountSats: 798100n });

  const built = buildChallengeWitnessBundle({
    challengeBundle: {
      selectedPathId: 'settle-loss',
      binding: {
        fundingOutpoint: { valueSats: '798100' },
        dustCarrySats: '0'
      },
      selectedPath: {
        pathId: 'settle-loss',
        payoutSats: '12368',
        residualSats: '783737',
        rolloverCollateralSats: '783737',
        dustCarrySats: '0',
        bucketCapBps: 500,
        realizedPnlBps: 155,
        effectivePnlBps: 155,
        feeBps: 25,
        feeSats: '1995',
        rawTxHex: 'deadbeef'
      },
      oracleBinding: {
        messageDigestHex: '11'.repeat(32),
        messagePayload: 'oracle-msg',
        oracleSignaturePlaceholder: 'sig-placeholder'
      }
    },
    tallyMap: tally,
    claimAccountId: 'alice',
    transitionState: { epochId: 1n }
  });

  assertEq(built.route, 'settle-loss');
  assertEq(built.requiresOracle, true);
  assertEq(built.honestPath.oracleMessageDigestHex, '11'.repeat(32));
  assertEq(built.honestPath.oracleSignature, 'sig-placeholder');
  assertEq(built.honestPath.cetPreimageOrSig, 'deadbeef');
  assertEq(built.transitionState.actualPayoutSats.toString(), '12368');
  assertEq(built.transitionState.feeSats.toString(), '1995');
  assertEq(built.transitionState.rolloverCollateralSats.toString(), '783737');
  assertEq(built.transitionWitness.routeSettleLoss, 1);
  assertEq(built.transitionWitness.routeRoll, 0);
  assert(built.transitionWitness.balanceClaim, 'balance claim should be attached');
});

test('challenge witness allows roll path without oracle digest', () => {
  const tally = new ReceiptTallyMap({ epochId: 1n });
  tally.applyDeposit({ depositId: 'dep-1', accountId: 'alice', amountSats: 798100n });

  const built = buildChallengeWitnessBundle({
    challengeBundle: {
      selectedPathId: 'roll',
      binding: {
        fundingOutpoint: { valueSats: '798100' },
        dustCarrySats: '0'
      },
      selectedPath: {
        pathId: 'roll',
        residualSats: '758195',
        rolloverCollateralSats: '758195',
        dustCarrySats: '0',
        rawTxHex: 'cafebabe'
      },
      oracleBinding: {
        messageDigestHex: null,
        oracleSignaturePlaceholder: null
      }
    },
    tallyMap: tally,
    claimAccountId: 'alice',
    transitionState: { epochId: 1n }
  });

  assertEq(built.route, 'roll');
  assertEq(built.requiresOracle, false);
  assertEq(built.transitionState.rolloverCollateralSats.toString(), '758195');
  assertEq(built.transitionWitness.routeRoll, 1);
  assertEq(built.transitionWitness.routeSettleLoss, 0);
  assertEq(built.honestPath.oracleSignature, null);
  assertEq(built.challengedPath.attestationDigest, null);
});

console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
