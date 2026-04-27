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
  const [html, script, dashboard, status, walletView, adapterFeed, testnetProof] = await Promise.all([
    getText('/dashboard'),
    getText('/dashboard.js'),
    getJson('/v1/wallet-demo/stress-dashboard?bots=5000'),
    getJson('/v1/wallet-demo/status'),
    getJson('/v1/lnbtc-tlusd-liquidity-patch/wallet-view'),
    getJson('/v1/wallet-demo/adapter-feed'),
    getJson('/v1/wallet-demo/bitcoin-testnet-proof')
  ]);
  const funding = await getText('/funding');

  runPanel('Network Map Frame', () => {
    assert.match(html, /Cross-Domain Liquidity Map/, 'missing network map title');
    assert.match(html, /class="network-map"/, 'missing SVG network map');
    for (const id of ['mapAssigned', 'mapSubstrate', 'mapAdapterEvents', 'mapChainLabel']) {
      assertMount(html, id);
    }
    assert.doesNotMatch(html, /litecoin|tLTC/i, 'public dashboard frame leaks old substrate wording');
    assert.doesNotMatch(funding, /litecoin/i, 'funding brief leaks old substrate wording');
    assert.doesNotMatch(html, /testnet mock|fixture replay|modular testnet|Wallet Mock|TLUSD mock/i, 'public dashboard leaks old demo wording');
    assert.doesNotMatch(funding, /What Is Mocked|fixture replay|modular testnet/i, 'funding brief leaks old scope wording');
  });

  runPanel('Guided Demo', () => {
    assertMount(html, 'demoSteps');
    assertMount(html, 'demoNext');
    assertMount(html, 'demoPrev');
    assert.match(script, /demoFlow/, 'missing guided demo flow');
    assert.match(script, /Subswap funds DLC/, 'missing funding guided step');
  });

  runPanel('Bitcoin Testnet Proofs', () => {
    assertMount(html, 'bitcoinProofSummary');
    assertMount(html, 'bitcoinProofLinks');
    assertMount(html, 'bitcoinProofStatus');
    assert.equal(testnetProof.network, 'testnet4');
    assert.equal(testnetProof.summary.txCount, 13);
    assert.equal(testnetProof.summary.offchainCount, 1);
    assert.match(testnetProof.keyTxids.hybridColoredPledge.explorer, /^https:\/\/mempool\.space\/testnet4\/tx\//);
    assert.match(testnetProof.keyTxids.arkLiquidityGraft.explorer, /^https:\/\/mempool\.space\/testnet4\/tx\//);
    assert.match(script, /bitcoin-testnet-proof/, 'missing Bitcoin testnet proof endpoint');
  });

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

  runPanel('Invariant Ledger', () => {
    assertMount(html, 'invariantLedger');
    for (const claim of ['assigned >= delivered', 'Ark fee < direct fee', '5k smoke payload verifies']) {
      assert.match(script, new RegExp(claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing invariant ${claim}`);
    }
  });

  runPanel('Artifact Links', () => {
    assertMount(html, 'artifactLinks');
    assert.match(script, /stress-dashboard/, 'missing stress dashboard artifact link');
    assert.match(script, /wallet-view/, 'missing wallet view artifact link');
    assert.match(script, /funding\.html/, 'missing funding artifact link');
  });

  runPanel('Adapter Contracts', () => {
    assertMount(html, 'adapterContracts');
    for (const adapter of ['LDK Node', 'LND', 'Core Lightning', 'Bark / Ark', 'Taproot Assets', 'TradeLayer']) {
      assert.match(script, new RegExp(adapter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing adapter ${adapter}`);
    }
  });

  runPanel('Layer Adapter Feed', () => {
    assertMount(html, 'adapterSummary');
    assertMount(html, 'adapterEventFeed');
    assertMount(html, 'adapterFeedStatus');
    assert.equal(adapterFeed.verification.ok, true, 'adapter feed verification failed');
    assert.equal(adapterFeed.verification.adaptersCovered, 4, 'adapter count mismatch');
    assert.equal(adapterFeed.verification.bitcoinTestnetTxids, 13, 'missing Bitcoin testnet txids');
    for (const key of ['ldk', 'ark', 'taprootAssets', 'tradeLayer']) {
      assert.ok(adapterFeed.adapters[key], `missing adapter feed ${key}`);
      assert.ok(adapterFeed.adapters[key].eventCount > 0, `${key} has no adapter events`);
    }
    for (const sourceType of ['PaymentClaimable', 'VtxoBatchQuoted', 'AssetProofVerified', 'Tx33SyntheticUsdQuoted']) {
      assert.ok(adapterFeed.events.some(item => item.sourceType === sourceType), `missing ${sourceType}`);
    }
  });

  runPanel('Reviewer Export Pack', () => {
    assertMount(html, 'exportPackSummary');
    assertMount(html, 'exportPackButton');
    assert.match(script, /buildExportPack/, 'missing export pack builder');
    assert.match(script, /adapterFeed/, 'missing adapter feed in export pack');
    assert.match(script, /npm run test:panels/, 'missing smoke test command in export pack');
  });

  runPanel('Deployment Health', () => {
    assertMount(html, 'deploymentHealth');
    assertMount(html, 'healthStatus');
    assert.match(script, /renderDeploymentHealth/, 'missing deployment health renderer');
    assert.match(script, /Adapter API/, 'missing adapter API health metric');
    assert.match(script, /5k status/, 'missing 5k health metric');
  });

  runPanel('Funding Brief', () => {
    assert.match(funding, /UTXORef Spiral Brief/, 'missing funding title');
    assert.match(funding, /What Works Today/, 'missing works today section');
    assert.match(funding, />Milestones</, 'missing milestones section');
    assert.doesNotMatch(funding, /Grant Milestones/, 'funding brief should use neutral milestone wording');
    assert.match(funding, /Acceptance Criteria/, 'missing acceptance criteria section');
  });

  console.log(`panel data smoke test ok: ${BASE_URL}`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
