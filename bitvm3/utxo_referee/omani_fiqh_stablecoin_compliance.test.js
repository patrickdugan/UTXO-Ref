#!/usr/bin/env node

const {
  buildOmaniFiqhStablecoinComplianceChecklist,
  verifyOmaniFiqhStablecoinComplianceChecklist
} = require('./omani_fiqh_stablecoin_compliance');

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
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

console.log('\n=== Omani Fiqh Stablecoin Compliance Tests ===\n');

test('checklist verifies and includes Omani fiqh posture', () => {
  const checklist = buildOmaniFiqhStablecoinComplianceChecklist();
  const result = verifyOmaniFiqhStablecoinComplianceChecklist(checklist);

  assert(result.ok, result.reason);
  assert(checklist.checklistCore.fiqhPosture.includes('Ibadi-aware'), 'missing Ibadi-aware posture');
  assert(checklist.checklistCore.fiqhPosture.includes('fiqh-pluralist'), 'missing fiqh pluralist posture');
});

test('checklist covers governance, reserve, token, defi, and regulatory gates', () => {
  const checklist = buildOmaniFiqhStablecoinComplianceChecklist();
  const sections = checklist.checklistCore.checklist.map((section) => section.section);

  assert(sections.includes('Omani Fiqh And Sharia Governance'));
  assert(sections.includes('Stablecoin Reserve And Redemption'));
  assert(sections.includes('Token, Proof, And Custody Mechanics'));
  assert(sections.includes('Halal DeFi Rails'));
  assert(sections.includes('Regulatory And Launch Gates'));
});

test('launch plan has ordered phases from preflight through scale', () => {
  const checklist = buildOmaniFiqhStablecoinComplianceChecklist();
  const phases = checklist.checklistCore.launchPlan.map((phase) => phase.phase);

  assertEq(phases[0], 0);
  assertEq(phases[phases.length - 1], 6);
  assert(checklist.checklistCore.launchPlan[0].title.includes('Scholar'));
  assert(checklist.checklistCore.launchPlan[3].title.includes('Halal DeFi'));
});

test('stop conditions block yield leakage and unapproved REIT backing', () => {
  const checklist = buildOmaniFiqhStablecoinComplianceChecklist();
  const stopText = checklist.checklistCore.stopConditions.join(' ');

  assert(stopText.includes('stablecoin holder entitlement to reserve yield'));
  assert(stopText.includes('farm REIT asset counted toward stablecoin backing'));
});

test('verifier rejects duplicate checklist item ids', () => {
  const checklist = clone(buildOmaniFiqhStablecoinComplianceChecklist());
  checklist.checklistCore.checklist[0].items[1].id = checklist.checklistCore.checklist[0].items[0].id;
  checklist.checklistId = require('crypto').createHash('sha256').update('tampered').digest('hex');
  const result = verifyOmaniFiqhStablecoinComplianceChecklist(checklist);

  assert(!result.ok, 'duplicate ids should fail');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
