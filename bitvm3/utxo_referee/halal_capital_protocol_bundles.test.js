#!/usr/bin/env node

const {
  PROTOCOL_PROPERTY_IDS,
  REISSUE_TARGETS,
  buildHalalCapitalProtocolBundlePortfolio,
  verifyHalalCapitalProtocolBundlePortfolio,
  verifyPropertyProtocolBundle
} = require('./halal_capital_protocol_bundles');

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

console.log('\n=== Halal Capital Protocol Bundle Tests ===\n');

test('protocol portfolio verifies and covers the first three application properties', () => {
  const portfolio = buildHalalCapitalProtocolBundlePortfolio();
  const result = verifyHalalCapitalProtocolBundlePortfolio(portfolio);

  assert(result.ok, result.reason);
  assertEq(portfolio.protocolBundles.length, PROTOCOL_PROPERTY_IDS.length);
  assertEq(JSON.stringify(portfolio.portfolioCore.propertyIds), JSON.stringify(PROTOCOL_PROPERTY_IDS));
});

test('each property bundle binds capital commitment, token event, revenue, and retirement flow', () => {
  const portfolio = buildHalalCapitalProtocolBundlePortfolio();

  for (const bundle of portfolio.protocolBundles) {
    const result = verifyPropertyProtocolBundle(bundle, portfolio.tokenPlan);
    assert(result.ok, result.reason);
    assertEq(bundle.bundleCore.reissueTargetPropertyId, REISSUE_TARGETS[bundle.bundleCore.propertyId]);
    assert(bundle.bundleCore.serviceRevenueUnits !== '0', 'service revenue should be non-zero');
    assert(bundle.retirementFlow.verification.ok, bundle.retirementFlow.verification.reason);
    assertEq(bundle.retirementFlow.reissueEvent.eventCore.sourceBurnEventId, bundle.retirementFlow.burnEvent.eventId);
  }
});

test('protocol artifact kinds are specific to Lightning, Ark, and TradeLayer DLC margin', () => {
  const portfolio = buildHalalCapitalProtocolBundlePortfolio();
  const byProperty = new Map(portfolio.protocolBundles.map((bundle) => [bundle.bundleCore.propertyId, bundle]));

  assertEq(byProperty.get(1101).protocolArtifact.kind, 'hln_lease_protocol_artifact');
  assertEq(byProperty.get(3101).protocolArtifact.kind, 'hark_liq_protocol_artifact');
  assertEq(byProperty.get(4101).protocolArtifact.kind, 'htl_dlcm_protocol_artifact');
  assert(byProperty.get(4101).protocolArtifact.dlcBundle.bundleId, 'DLC bundle id missing');
  assert(byProperty.get(4101).protocolArtifact.perpSettlement.settlementHash, 'perp settlement missing');
});

test('verifier rejects a tampered protocol artifact', () => {
  const portfolio = clone(buildHalalCapitalProtocolBundlePortfolio());
  portfolio.protocolBundles[0].protocolArtifact.lease.bundleCore.offerId = 'tampered';
  const result = verifyHalalCapitalProtocolBundlePortfolio(portfolio);

  assert(!result.ok, 'tampered protocol artifact should fail');
  assert(String(result.reason).includes('property 1101'), 'expected property 1101 failure');
});

test('verifier rejects a missing burn-before-reissue transition', () => {
  const portfolio = clone(buildHalalCapitalProtocolBundlePortfolio());
  portfolio.protocolBundles[1].retirementFlow.flowCore.burnBeforeReissue = false;
  const result = verifyHalalCapitalProtocolBundlePortfolio(portfolio);

  assert(!result.ok, 'bad retirement flow should fail');
  assert(String(result.reason).includes('property 3101'), 'expected property 3101 failure');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
