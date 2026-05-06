#!/usr/bin/env node

const {
  CAPITAL_PROPERTY_TEMPLATES,
  buildCapitalTemplateRegistry,
  buildCapitalCommitment,
  verifyCapitalCommitment,
  verifyExclusiveCapitalSet,
  buildCapitalRoleTransition,
  verifyCapitalRoleTransition,
  buildHalalCapitalRoadmap
} = require('./halal_capital_template_registry');

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

const OUTPOINT_A = `${'11'.repeat(32)}:0`;
const OUTPOINT_B = `${'22'.repeat(32)}:1`;

console.log('\n=== Halal Capital Template Registry Tests ===\n');

test('registry materializes unique property templates with Jurassic refs', () => {
  const registry = buildCapitalTemplateRegistry();
  const propertyIds = new Set(registry.templates.map((template) => template.propertyId));
  const templateHashes = new Set(registry.templates.map((template) => template.templateHash));

  assertEq(registry.templates.length, CAPITAL_PROPERTY_TEMPLATES.length);
  assertEq(propertyIds.size, registry.templates.length);
  assertEq(templateHashes.size, registry.templates.length);
  for (const template of registry.templates) {
    assert(template.accounting.rehypothecationAllowed === false, 'rehypothecation must be disabled');
    assert(template.accounting.oneSatOneRole === true, 'one-sat-one-role flag missing');
    assert(template.jurassicApplication.refId.length === 64, 'missing Jurassic ref id');
  }
});

test('commitment verifies propertyId, template, active role, and exclusive flag', () => {
  const commitment = buildCapitalCommitment({
    propertyId: 1101,
    fundingOutpoint: OUTPOINT_A,
    amountSats: 500000n,
    holderId: 'holder-a',
    operatorId: 'lsp-a'
  });
  const result = verifyCapitalCommitment(commitment);

  assert(result.ok, result.reason);
  assertEq(commitment.commitmentCore.propertyId, 1101);
  assertEq(commitment.commitmentCore.activeRole, 'lightning_channel_lease');
  assert(commitment.commitmentCore.publicHandleId.length === 64, 'missing public handle id');
});

test('exclusive set rejects the same active outpoint across different property ids', () => {
  const lease = buildCapitalCommitment({
    propertyId: 1101,
    fundingOutpoint: OUTPOINT_A,
    amountSats: 500000n,
    holderId: 'holder-a',
    operatorId: 'lsp-a'
  });
  const rfq = buildCapitalCommitment({
    propertyId: 2101,
    fundingOutpoint: OUTPOINT_A,
    amountSats: 500000n,
    holderId: 'holder-a',
    operatorId: 'edge-a'
  });
  const result = verifyExclusiveCapitalSet([lease, rfq]);

  assert(!result.ok, 'active outpoint reuse should fail');
  assert(String(result.reason).includes('funding outpoint reused'), 'expected outpoint reuse failure');
});

test('exclusive set accepts different outpoints across different templates', () => {
  const lease = buildCapitalCommitment({
    propertyId: 1101,
    fundingOutpoint: OUTPOINT_A,
    amountSats: 500000n
  });
  const ark = buildCapitalCommitment({
    propertyId: 3101,
    fundingOutpoint: OUTPOINT_B,
    amountSats: 250000n
  });
  const result = verifyExclusiveCapitalSet([lease, ark]);

  assert(result.ok, result.reason);
  assertEq(result.activeCommitmentCount, 2);
});

test('role transition requires the old commitment to be retired before reissue', () => {
  const active = buildCapitalCommitment({
    propertyId: 1101,
    fundingOutpoint: OUTPOINT_A,
    amountSats: 500000n
  });
  const transition = buildCapitalRoleTransition({
    fromCommitment: active,
    toPropertyId: 3101
  });
  const activeResult = verifyCapitalRoleTransition(transition, active);
  const retired = {
    ...active,
    commitmentCore: {
      ...active.commitmentCore,
      status: 'retired'
    }
  };
  const retiredResult = verifyCapitalRoleTransition(transition, retired);

  assert(!activeResult.ok, 'active commitment should not be reissued');
  assert(retiredResult.ok, retiredResult.reason);
  assertEq(transition.transitionCore.toPropertyId, 3101);
  assertEq(transition.transitionCore.burnBeforeReissue, true);
});

test('roadmap binds phases to registry and all Jurassic applications', () => {
  const roadmap = buildHalalCapitalRoadmap({ title: 'unit-test roadmap' });
  assert(roadmap.registry.templates.length >= 6, 'expected several property templates');
  assertEq(roadmap.roadmapCore.jurassicApplications.length, 3);
  assert(roadmap.roadmapCore.phases.some((phase) => phase.title === 'TradeLayer Derivatives'));
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
