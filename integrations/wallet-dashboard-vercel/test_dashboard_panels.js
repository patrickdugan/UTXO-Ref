const assert = require('assert/strict');

const BASE_URL = (process.env.DASHBOARD_BASE_URL || 'https://wallet-dashboard-vercel.vercel.app').replace(/\/$/, '');

async function getText(path) {
  const response = await fetch(`${BASE_URL}${path}`);
  assert.equal(response.ok, true, `${path} returned ${response.status}`);
  return response.text();
}

async function getJson(path) {
  const response = await fetch(`${BASE_URL}${path}`);
  assert.equal(response.ok, true, `${path} returned ${response.status}`);
  return response.json();
}

function assertMount(html, id) {
  assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
}

function assertPositive(value, label) {
  assert.equal(Number.isFinite(Number(value)), true, `${label} is not numeric`);
  assert.ok(Number(value) > 0, `${label} is not positive`);
}

function assertString(value, label) {
  assert.equal(typeof value, 'string', `${label} is not a string`);
  assert.ok(value.length > 0, `${label} is empty`);
}

function runPanel(name, check) {
  check();
  console.log(`OK ${name}`);
}

async function main() {
  const [html, script, dashboard, status, walletView] = await Promise.all([
    getText('/dashboard'),
    getText('/dashboard.js'),
    getJson('/v1/wallet-demo/stress-dashboard?bots=5000'),
    getJson('/v1/wallet-demo/status'),
    getJson('/v1/lnbtc-tlusd-liquidity-patch/wallet-view')
  ]);

  runPanel('Protocol Trace', () => {
    assertMount(html, 'protocolTrace');
    assertString(walletView.conversion.subswapFundingTxid, 'subswap funding txid');
    assertString(walletView.conversion.dlcFundingTxid, 'dlc funding txid');
    assertString(walletView.liquidityPatch.allocationId, 'ark allocation id');
    assertString(walletView.liquidityPatch.challenge.challengeId, 'bitvm challenge id');
    assertString(dashboard.dashboardId, 'dashboard id');
  });

  runPanel('Failure Injection', () => {
    assertMount(html, 'failureControls');
    assertMount(html, 'failureImpact');
    assertMount(html, 'failureStatus');
    for (const key of ['asp_delay', 'oracle_mismatch', 'htlc_timeout', 'under_delivery', 'forced_exit']) {
      assert.match(script, new RegExp(key), `missing failure scenario ${key}`);
    }
    assertPositive(dashboard.totals.assignedInboundSats, 'assigned inbound sats');
    assertPositive(dashboard.totals.deliveredInboundSats, 'delivered inbound sats');
  });

  runPanel('BOLT / LDK Pane', () => {
    assertMount(html, 'lnCompatibility');
    assertPositive(walletView.conversion.lnbtcSats, 'lnbtc sats');
    assertPositive(dashboard.totals.averageFeePpm, 'average fee ppm');
    assert.match(script, /PaymentClaimable|PaymentPathFailed/, 'missing LDK event mapping');
  });

  runPanel('Ark Batch Savings', () => {
    assertMount(html, 'arkFeeRate');
    assertMount(html, 'arkSavingsPanel');
    assertMount(html, 'arkSavingsHeadline');
    assertPositive(dashboard.totals.routeCount, 'route count');
    assertPositive(dashboard.totals.arkVtxoCount, 'ark vtxo count');
    assertPositive(dashboard.totals.arkSavingsSats, 'modeled ark savings');
  });

  runPanel('BitVM Enforcement', () => {
    assertMount(html, 'bitvmEnforcement');
    assert.ok(Array.isArray(dashboard.challengeQueue), 'challenge queue is not an array');
    assert.ok(dashboard.challengeQueue.length > 0, 'challenge queue is empty');
    assertString(dashboard.challengeQueue[0].bitvmChallengeId, 'challenge id');
    assertPositive(dashboard.challengeQueue[0].requestedInboundSats, 'challenge requested sats');
    assertPositive(dashboard.challengeQueue[0].deliveredInboundSats, 'challenge delivered sats');
  });

  runPanel('Asset Mode', () => {
    assertMount(html, 'assetMode');
    assertMount(html, 'assetModePanel');
    for (const key of ['tlusd', 'taproot', 'tradelayer']) {
      assert.match(script, new RegExp(key), `missing asset mode ${key}`);
    }
    assertPositive(walletView.conversion.tlusdUnits, 'tlusd units');
    assertPositive(walletView.stake.stakedTlUsdUnits, 'staked tlusd units');
  });

  runPanel('Integration Readiness', () => {
    assertMount(html, 'integrationChecklist');
    assertString(status.activeProfileId, 'active profile id');
    assertString(status.chain.chain, 'chain name');
    assert.equal(status.readiness.walletViewReady, true, 'wallet view is not ready');
    assert.equal(status.readiness.stressDashboardReady, true, 'stress dashboard is not ready');
  });

  runPanel('Operator Economics', () => {
    assertMount(html, 'operatorEconomics');
    assertMount(html, 'operatorNetYield');
    assertPositive(dashboard.totals.earnedFeesSats, 'earned fees sats');
    assertPositive(dashboard.totals.challengeCount, 'challenge count');
    assertPositive(dashboard.totals.deliveredInboundSats, 'delivered inbound sats');
    assert.ok(Number(dashboard.totals.deliveryBps) <= 10000, 'delivery bps is too high');
  });

  console.log(`panel data smoke test ok: ${BASE_URL}`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
