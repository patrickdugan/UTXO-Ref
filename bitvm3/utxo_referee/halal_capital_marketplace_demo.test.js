#!/usr/bin/env node

const {
  buildCapitalCommitment
} = require('./halal_capital_template_registry');
const {
  buildHalalCapitalMarketplaceSnapshot,
  verifyHalalCapitalMarketplaceSnapshot,
  buildObserverIndex
} = require('./halal_capital_marketplace_demo');

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

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `expected ${expected}, got ${actual}`);
  }
}

const OUTPOINT_A = `${'aa'.repeat(32)}:0`;
const OUTPOINT_B = `${'bb'.repeat(32)}:1`;
const OUTPOINT_C = `${'cc'.repeat(32)}:0`;

console.log('\n=== Halal Capital Marketplace Demo Tests ===\n');

test('marketplace snapshot verifies and covers every property template', () => {
  const snapshot = buildHalalCapitalMarketplaceSnapshot();
  const result = verifyHalalCapitalMarketplaceSnapshot(snapshot);

  assert(result.ok, result.reason);
  assertEq(snapshot.commitments.length, snapshot.registry.templates.length);
  assertEq(snapshot.revenueEvents.length, snapshot.commitments.length);
  assert(snapshot.snapshotCore.totalActiveCapitalSats !== '0', 'missing active capital total');
  assert(snapshot.snapshotCore.totalServiceRevenueSats !== '0', 'missing revenue total');
});

test('observer index resolves public handles and carrier commitments', () => {
  const snapshot = buildHalalCapitalMarketplaceSnapshot();
  const index = snapshot.observerIndex;

  for (const commitment of snapshot.commitments) {
    assert(index.byPublicHandleId[commitment.commitmentCore.publicHandleId], 'missing public handle index');
    assert(index.byCarrierCommitmentId[commitment.commitmentCore.carrierCommitmentId], 'missing carrier index');
    assert(index.byPropertyId[commitment.commitmentCore.propertyId], 'missing property id index');
    assert(Array.isArray(index.byPropertyId[commitment.commitmentCore.propertyId]), 'property id index should be a list');
  }
});

test('revenue events reference known commitments', () => {
  const snapshot = buildHalalCapitalMarketplaceSnapshot();
  const commitmentIds = new Set(snapshot.commitments.map((commitment) => commitment.commitmentId));

  for (const event of snapshot.revenueEvents) {
    assert(commitmentIds.has(event.eventCore.commitmentId), 'revenue event points at unknown commitment');
    assert(Number(event.eventCore.revenueSats) > 0, 'revenue should be positive');
  }
});

test('snapshot verification rejects active duplicate outpoints', () => {
  const lease = buildCapitalCommitment({
    propertyId: 1101,
    fundingOutpoint: OUTPOINT_A,
    amountSats: 100000n
  });
  const ark = buildCapitalCommitment({
    propertyId: 3101,
    fundingOutpoint: OUTPOINT_A,
    amountSats: 100000n
  });
  const snapshot = buildHalalCapitalMarketplaceSnapshot({
    commitments: [lease, ark]
  });
  const result = verifyHalalCapitalMarketplaceSnapshot(snapshot);

  assert(!result.ok, 'duplicate active outpoints should fail');
  assert(String(result.reason).includes('funding outpoint reused'), 'expected outpoint reuse failure');
});

test('observer index is deterministic for the same commitments', () => {
  const a = buildCapitalCommitment({
    propertyId: 1101,
    fundingOutpoint: OUTPOINT_A,
    amountSats: 100000n
  });
  const b = buildCapitalCommitment({
    propertyId: 2101,
    fundingOutpoint: OUTPOINT_B,
    amountSats: 200000n
  });
  const first = buildObserverIndex([a, b]);
  const second = buildObserverIndex([a, b]);

  assertEq(first.indexId, second.indexId);
});

test('observer index keeps multiple commitments under the same property id', () => {
  const firstLease = buildCapitalCommitment({
    propertyId: 1101,
    fundingOutpoint: OUTPOINT_A,
    amountSats: 100000n
  });
  const secondLease = buildCapitalCommitment({
    propertyId: 1101,
    fundingOutpoint: OUTPOINT_C,
    amountSats: 200000n
  });
  const index = buildObserverIndex([firstLease, secondLease]);

  assertEq(index.byPropertyId[1101].length, 2, 'property index should keep both leases');
  assert(index.byPublicHandleId[firstLease.commitmentCore.publicHandleId], 'missing first public handle');
  assert(index.byPublicHandleId[secondLease.commitmentCore.publicHandleId], 'missing second public handle');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
