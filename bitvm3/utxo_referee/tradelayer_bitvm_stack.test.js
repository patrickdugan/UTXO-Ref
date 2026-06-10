/**
 * Run: node bitvm3/utxo_referee/tradelayer_bitvm_stack.test.js
 */

const {
  buildTradeLayerBitvmStackBundle,
  verifyTradeLayerBitvmStackBundle,
  buildDashboardView,
  dashboardJsonSchema
} = require('./tradelayer_bitvm_stack');

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

console.log('\n=== TradeLayer BitVM Stack Bundle Tests ===\n');

test('builds a verifiable stack bundle for dashboard handoff', () => {
  const bundle = buildTradeLayerBitvmStackBundle();
  const result = verifyTradeLayerBitvmStackBundle(bundle);

  assert(result.ok, result.reason);
  assertEq(bundle.kind, 'bitvm_tradelayer_stack_bundle');
  assertEq(bundle.dashboard.schema, 'bitvm_tradelayer_dashboard_v1');
  assertEq(bundle.dashboard.status, 'ready');
  assertEq(bundle.dashboard.txids.selectedSend, bundle.selectedSend.txid);
  assert(bundle.stackHash.length === 64, 'stack hash should be present');
  assert(bundle.dashboard.viewHash.length === 64, 'dashboard view hash should be present');
  assert(bundle.hashes.routeTranscriptHash === bundle.sweepPlan.routeTranscriptHash, 'sweep route transcript should be bound');
  assert(bundle.hashes.halalCapitalTokenPlanHash === bundle.halalCapitalTokenPlan.planId, 'capital token plan should be bound');
  assertEq(bundle.dashboard.capital.tokenSpecCount, 7);
  assertEq(bundle.dashboard.capital.principalUnits, bundle.halalCapitalTokenPlan.planCore.totalPrincipalUnits);
});

test('binds a solvent reserve reconciliation into the verified bundle', () => {
  const bundle = buildTradeLayerBitvmStackBundle();
  assert(bundle.reserveReconciliation.solvent, 'default reserve should be solvent');
  assertEq(bundle.dashboard.solvent, true);
  assertEq(bundle.productionPolicy.walletAction, 'allow_sweep');
  assert(!bundle.productionPolicy.failedChecks.includes('reserve_solvency'), 'solvency check should pass');
  assertEq(bundle.dashboard.hashes.reserveReconciliation, bundle.reserveReconciliation.reconciliationHash);
});

test('pauses the sweep when the withdrawal cap exceeds the deposit reserve', () => {
  const bundle = buildTradeLayerBitvmStackBundle({ reserve: { reservedSats: 1 } });
  const result = verifyTradeLayerBitvmStackBundle(bundle);

  assert(result.ok, `evidence should still verify intact: ${result.reason}`);
  assert(!bundle.reserveReconciliation.solvent, 'tiny reserve should be insolvent');
  assertEq(bundle.dashboard.status, 'needs_attention');
  assertEq(bundle.dashboard.solvent, false);
  assert(bundle.dashboard.challengeable.includes('reserve_insolvency'), 'insolvency should be challengeable');
  assertEq(bundle.productionPolicy.walletAction, 'pause_spend');
  assert(bundle.productionPolicy.failedChecks.includes('reserve_solvency'), 'reserve_solvency should fail closed');
});

test('exports a compact dashboard schema contract', () => {
  const schema = dashboardJsonSchema();

  assertEq(schema.schema, 'bitvm_tradelayer_dashboard_v1');
  assert(schema.requiredFields.includes('hashes'), 'hashes should be required');
  assert(schema.requiredFields.includes('capital'), 'capital should be required');
  assert(schema.requiredFields.includes('txids'), 'txids should be required');
});

test('rebuilds dashboard view hashes deterministically', () => {
  const bundle = buildTradeLayerBitvmStackBundle();
  const view = buildDashboardView(bundle);

  assertEq(view.viewHash, bundle.dashboard.viewHash);
  assertEq(view.hashes.checkpoint, bundle.stateCheckpoint.checkpointHash);
  assertEq(view.hashes.liquidityLease, bundle.liquidityLease.leaseHash);
  assertEq(view.hashes.halalCapitalTokenPlan, bundle.halalCapitalTokenPlan.planId);
  assertEq(view.capital.serviceRevenueUnits, bundle.halalCapitalTokenPlan.planCore.totalServiceRevenueUnits);
});

test('detects stack hash tampering', () => {
  const bundle = buildTradeLayerBitvmStackBundle();
  const tampered = clone(bundle);
  tampered.withdrawalQueue.queueCore.entries[0].sats = '1';
  const result = verifyTradeLayerBitvmStackBundle(tampered);

  assert(!result.ok, 'tampered bundle should fail');
});

test('detects tampered halal capital token plan', () => {
  const bundle = buildTradeLayerBitvmStackBundle();
  const tampered = clone(bundle);
  tampered.halalCapitalTokenPlan.planCore.totalPrincipalUnits = '1';
  const result = verifyTradeLayerBitvmStackBundle(tampered);

  assert(!result.ok, 'tampered token plan should fail');
  assert(String(result.reason).includes('halalCapitalTokenPlan'), 'expected token plan failure');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
