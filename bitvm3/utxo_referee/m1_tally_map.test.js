/**
 * Milestone 1 Tally Map Tests
 *
 * Run: node bitvm3/utxo_referee/m1_tally_map.test.js
 */

const { ReceiptLedger, ReceiptTallyMap } = require('./index');

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

console.log('\n=== Milestone 1 Tally Map Tests ===\n');

test('snapshot hash is deterministic and canonical', () => {
  const a = new ReceiptTallyMap({ epochId: 7n });
  const b = new ReceiptTallyMap({ epochId: 7n });

  const events = [
    { depositId: 'd2', accountId: 'bob', amountSats: 25n },
    { depositId: 'd1', accountId: 'alice', amountSats: 10n },
    { redemptionId: 'r1', accountId: 'bob', amountSats: 5n }
  ];

  for (const e of events) {
    a.applyEvent(e);
  }
  for (const e of [events[1], events[0], events[2]]) {
    b.applyEvent(e);
  }

  assertEq(a.snapshotHashHex(), b.snapshotHashHex());
  assert(a.toBlob().includes('"kind": "receipt-tally-map"'), 'blob should be typed');
});

test('round-trip blob preserves balances and ids', () => {
  const ledger = new ReceiptLedger();
  ledger.applyDeposit({ depositId: 'd1', accountId: 'alice', amountSats: 100n });
  ledger.applyDeposit({ depositId: 'd2', accountId: 'bob', amountSats: 200n });
  ledger.applyRedemption({ redemptionId: 'r1', accountId: 'bob', amountSats: 50n });

  const state = ReceiptTallyMap.fromLedger(ledger, { epochId: 42n });
  const blob = state.toBlob();
  const restored = ReceiptTallyMap.fromBlob(blob);

  assertEq(restored.epochId, 42n);
  assertEq(restored.balanceOf('alice'), 100n);
  assertEq(restored.balanceOf('bob'), 150n);
  assertEq(restored.totalSupplySats(), 250n);
  assertEq(restored.snapshotHashHex(), state.snapshotHashHex());
});

test('finalizeEpoch carries prev hash into next state', () => {
  const state = new ReceiptTallyMap({ epochId: 1n });
  state.applyDeposit({ depositId: 'd1', accountId: 'alice', amountSats: 123n });

  const next = state.finalizeEpoch(2n);
  assertEq(next.epochId, 2n);
  assertEq(next.prevSnapshotHash, state.snapshotHashHex());
  assertEq(next.balanceOf('alice'), 123n);
});

test('committed snapshot includes hash envelope', () => {
  const state = new ReceiptTallyMap({
    epochId: 9n,
    challengeWindowStart: 9n,
    challengeWindowLength: 3n
  });
  state.applyDeposit({ depositId: 'd1', accountId: 'alice', amountSats: 10n });

  const committed = state.getCommittedSnapshot();
  assertEq(committed.snapshotHash, state.snapshotHashHex());
  assertEq(committed.balanceRoot, state.getBalanceMerkleRootHex());
  assertEq(committed.challengeWindowStart, '9');
  assertEq(committed.challengeWindowLength, '3');
  assertEq(committed.challengeWindowEnd, '12');
  assertEq(committed.kind, 'receipt-tally-map');
  assertEq(committed.epochId, '9');
});

test('annotated blob preserves canonical snapshot hash', () => {
  const state = new ReceiptTallyMap({ epochId: 14n });
  state.applyDeposit({ depositId: 'd1', accountId: 'alice', amountSats: 100n });

  const annotation = {
    kind: 'witness-settlement-delta',
    redeemedSats: '75',
    pnlGainSats: '0',
    pnlLossSats: '25',
    netDeltaSats: '-25'
  };

  const blob = state.toAnnotatedBlob(annotation);
  const restored = ReceiptTallyMap.fromBlob(blob);

  assertEq(restored.snapshotHashHex(), state.snapshotHashHex());
  assert(blob.includes('"deltaAnnotation"'), 'annotated blob should carry delta metadata');
});

test('balance root is deterministic across insertion order', () => {
  const a = new ReceiptTallyMap({ epochId: 3n });
  const b = new ReceiptTallyMap({ epochId: 3n });

  a.applyDeposit({ depositId: 'd1', accountId: 'bob', amountSats: 7n });
  a.applyDeposit({ depositId: 'd2', accountId: 'alice', amountSats: 5n });

  b.applyDeposit({ depositId: 'd2', accountId: 'alice', amountSats: 5n });
  b.applyDeposit({ depositId: 'd1', accountId: 'bob', amountSats: 7n });

  assertEq(a.getBalanceMerkleRootHex(), b.getBalanceMerkleRootHex());
});

test('balance proof verifies against committed root', () => {
  const state = new ReceiptTallyMap({ epochId: 11n });
  state.applyDeposit({ depositId: 'd1', accountId: 'alice', amountSats: 5n });
  state.applyDeposit({ depositId: 'd2', accountId: 'bob', amountSats: 9n });
  state.applyDeposit({ depositId: 'd3', accountId: 'carol', amountSats: 12n });

  const proof = state.getBalanceProof('bob');
  assertEq(proof.accountId, 'bob');
  assertEq(proof.balanceSats, 9n);
  assertEq(proof.root.toString('hex'), state.getBalanceMerkleRootHex());
  assert(ReceiptTallyMap.verifyBalanceProof(proof, state.getBalanceMerkleRoot()), 'proof must verify');
});

test('balance proof rejects wrong root', () => {
  const state = new ReceiptTallyMap({ epochId: 12n });
  state.applyDeposit({ depositId: 'd1', accountId: 'alice', amountSats: 7n });

  const proof = state.getBalanceProof('alice');
  const wrongRoot = Buffer.alloc(32, 0xaa);
  assert(!ReceiptTallyMap.verifyBalanceProof(proof, wrongRoot), 'proof must fail against wrong root');
});

test('balance claim bundles proof and root for one account', () => {
  const state = new ReceiptTallyMap({
    epochId: 13n,
    challengeWindowStart: 13n,
    challengeWindowLength: 7n
  });
  state.applyDeposit({ depositId: 'd1', accountId: 'alice', amountSats: 11n });
  state.applyDeposit({ depositId: 'd2', accountId: 'bob', amountSats: 19n });

  const claim = state.getBalanceClaim('alice');
  assertEq(claim.kind, 'receipt-balance-claim');
  assertEq(claim.accountId, 'alice');
  assertEq(claim.balanceSats, '11');
  assertEq(claim.balanceRoot, state.getBalanceMerkleRootHex());
  assertEq(claim.challengeWindowStart, '13');
  assertEq(claim.challengeWindowLength, '7');
  assertEq(claim.challengeWindowEnd, '20');
  assert(ReceiptTallyMap.verifyBalanceClaim(claim, state.getBalanceMerkleRoot()), 'claim must verify');
});

console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
