#!/usr/bin/env node

const {
  buildStressDashboard,
  verifyStressDashboard,
  tlusdUnitsFromTltcSats
} = require('./stressDashboard');
const { buildWalletDemoConfig } = require('./walletBackendProfiles');

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

const patch = require('../../bitvm3/utxo_referee/artifacts/lnbtc_tlusd_liquidity_patch_latest.json');

console.log('\n=== Stress Dashboard Tests ===\n');

test('converts tLTC sats to TLUSD micro-units', () => {
  assert(tlusdUnitsFromTltcSats(100000000n, 85000000n) === 85000000n, '1 tLTC should equal 85 TLUSD');
});

test('builds deterministic bot fleet anchored to patch artifact', () => {
  const dashboard = buildStressDashboard({
    patch,
    config: buildWalletDemoConfig({}),
    botCount: 32
  });
  const result = verifyStressDashboard(dashboard);
  assert(result.ok, result.reason || 'dashboard should verify');
  assert(dashboard.bots.length === 32, 'wrong bot count');
  assert(dashboard.collateralAsset === 'tLTC', 'wrong collateral asset');
  assert(BigInt(dashboard.totals.assignedInboundSats) > 0n, 'missing assigned inbound');
  assert(dashboard.challengeQueue.length > 0, 'missing challenge queue');
});

test('dashboard generation is stable for the same input', () => {
  const config = buildWalletDemoConfig({});
  const a = buildStressDashboard({ patch, config, botCount: 16 });
  const b = buildStressDashboard({ patch, config, botCount: 16 });
  assert(a.dashboardId === b.dashboardId, 'dashboard id should be stable');
  assert(a.totals.assignedInboundSats === b.totals.assignedInboundSats, 'assigned total should be stable');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
