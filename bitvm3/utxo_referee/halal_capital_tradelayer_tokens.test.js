#!/usr/bin/env node

const {
  buildHalalCapitalTradeLayerTokenPlan,
  verifyHalalCapitalTradeLayerTokenPlan,
  buildBalanceRows
} = require('./halal_capital_tradelayer_tokens');

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sum(values) {
  return values.reduce((acc, value) => acc + BigInt(value || 0), 0n).toString();
}

console.log('\n=== Halal Capital TradeLayer Token Tests ===\n');

test('token plan verifies and covers every marketplace property template', () => {
  const plan = buildHalalCapitalTradeLayerTokenPlan();
  const result = verifyHalalCapitalTradeLayerTokenPlan(plan);

  assert(result.ok, result.reason);
  assertEq(plan.tokenSpecs.length, plan.marketplaceSnapshot.registry.templates.length);
  assertEq(plan.principalMintEvents.length, plan.marketplaceSnapshot.commitments.length);
  assertEq(plan.serviceRevenueCreditEvents.length, plan.marketplaceSnapshot.revenueEvents.length);
});

test('principal receipt supply tracks active committed capital', () => {
  const plan = buildHalalCapitalTradeLayerTokenPlan();
  const minted = sum(plan.principalMintEvents.map((event) => event.eventCore.amountUnits));

  assertEq(minted, plan.marketplaceSnapshot.snapshotCore.totalActiveCapitalSats);
  assertEq(plan.planCore.totalPrincipalUnits, minted);
});

test('service revenue accrual is separated from principal supply', () => {
  const plan = buildHalalCapitalTradeLayerTokenPlan();
  const revenue = sum(plan.serviceRevenueCreditEvents.map((event) => event.eventCore.amountUnits));
  const principal = sum(plan.principalMintEvents.map((event) => event.eventCore.amountUnits));

  assertEq(plan.planCore.totalServiceRevenueUnits, revenue);
  assert(principal !== revenue, 'principal and revenue ledgers should be distinct');
  assert(plan.serviceRevenueCreditEvents.every((event) => event.eventCore.eventType === 'credit_service_revenue'));
});

test('role transition instruction burns before reissue into another property id', () => {
  const plan = buildHalalCapitalTradeLayerTokenPlan();
  const instruction = plan.roleTransitionInstruction;

  assert(instruction, 'missing transition instruction');
  assertEq(instruction.instructionCore.burnBeforeReissue, true);
  assertEq(instruction.instructionCore.rehypothecationAllowed, false);
  assert(instruction.burnEvent.eventCore.propertyId !== instruction.reissueEvent.eventCore.propertyId);
  assertEq(instruction.reissueEvent.eventCore.sourceBurnEventId, instruction.burnEvent.eventId);
});

test('verifier rejects tampered principal mint amount', () => {
  const plan = clone(buildHalalCapitalTradeLayerTokenPlan());
  plan.principalMintEvents[0].eventCore.amountUnits = '1';
  const result = verifyHalalCapitalTradeLayerTokenPlan(plan);

  assert(!result.ok, 'tampered plan should fail');
  assert(String(result.reason).includes('event id mismatch') || String(result.reason).includes('principal'));
});

test('balance rows remain deterministic and property-scoped', () => {
  const plan = buildHalalCapitalTradeLayerTokenPlan();
  const rows = buildBalanceRows(plan.marketplaceSnapshot);
  const propertyIds = new Set(rows.map((row) => row.propertyId));

  assertEq(JSON.stringify(rows), JSON.stringify(plan.balanceRows));
  assertEq(propertyIds.size, plan.tokenSpecs.length);
  assert(rows.every((row) => row.revenueBackedByKnownCommitments), 'revenue should reference known commitments');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
