/**
 * Milestone 1 Expiry Redemption Tests
 *
 * Run: node bitvm3/utxo_referee/m1_expiry_redemption.test.js
 */

const {
  ReceiptLedger,
  ReceiptTallyMap,
  buildSettlementDeltaAnnotation,
  buildSettlementBreakdown,
  buildWitnessBlobWithDelta
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

console.log('\n=== Milestone 1 Expiry Redemption Tests ===\n');

test('delta annotation tracks redeemed amount and pnl loss', () => {
  const delta = buildSettlementDeltaAnnotation({
    epochId: 21n,
    route: 'roll',
    depositedSats: 798100n,
    redeemedSats: 783735n,
    pnlReferenceSats: 798100n,
    realizedPnlSats: -14365n,
    feeSats: 0n,
    maturityHeight: 1000n,
    expiryHeight: 1008n,
    oracleEventId: 'oracle-event-21'
  });

  assertEq(delta.redeemedSats, '783735');
  assertEq(delta.pnlGainSats, '0');
  assertEq(delta.pnlLossSats, '14365');
  assertEq(delta.netDeltaSats, '-14365');
  assertEq(delta.settlementBreakdown.winnerSweepSats, '783735');
  assertEq(delta.settlementBreakdown.refundSats, '14365');
  assertEq(delta.settlementBreakdown.settlementKind, 'timeout-refund');
  assert(delta.annotationHash.length === 64, 'annotation hash should be hex');
});

test('settlement breakdown names winner sweep and refund remainder', () => {
  const breakdown = buildSettlementBreakdown({
    epochId: 21n,
    route: 'pnl',
    collateralSats: 798100n,
    redeemedSats: 802500n,
    pnlReferenceSats: 798100n,
    realizedPnlSats: 4400n,
    feeSats: 0n,
    refundSats: 0n,
    dustCarrySats: 0n,
    winnerRecipient: 'alice',
    refundRecipient: 'residual',
    note: 'winner sweep and refund remainder'
  });

  assertEq(breakdown.settlementKind, 'pnl-sweep');
  assertEq(breakdown.winnerSweepSats, '802500');
  assertEq(breakdown.winnerPnlSats, '4400');
  assertEq(breakdown.loserPnlSats, '0');
  assertEq(breakdown.refundSats, '0');
  assertEq(breakdown.refundRecipient, 'residual');
});

test('witness blob sidecar preserves tally snapshot hash', () => {
  const ledger = new ReceiptLedger();
  ledger.applyDeposit({ depositId: 'd1', accountId: 'alice', amountSats: 798100n });
  ledger.applyRedemption({ redemptionId: 'r1', accountId: 'alice', amountSats: 783735n });

  const tally = ReceiptTallyMap.fromLedger(ledger, {
    epochId: 21n,
    challengeWindowStart: 1000n,
    challengeWindowLength: 8n
  });

  const delta = buildSettlementDeltaAnnotation({
    epochId: 21n,
    route: 'roll',
    depositedSats: 798100n,
    redeemedSats: 783735n,
    pnlReferenceSats: 798100n,
    realizedPnlSats: -14365n,
    feeSats: 0n,
    maturityHeight: 1000n,
    expiryHeight: 1008n,
    oracleEventId: 'oracle-event-21',
    note: 'expiry redemption witness blob'
  });

  const blob = buildWitnessBlobWithDelta(tally, delta);
  assertEq(blob.committed.snapshotHash, tally.snapshotHashHex());
  assertEq(blob.deltaAnnotation.redeemedSats, '783735');
  assertEq(blob.deltaAnnotation.pnlLossSats, '14365');
  assert(blob.witnessBlobHash.length === 64, 'witness blob hash should be hex');
});

console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
