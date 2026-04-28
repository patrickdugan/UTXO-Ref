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

function assertNoMount(html, id) {
  assert.doesNotMatch(html, new RegExp(`id="${id}"`), `unexpected #${id}`);
}

function runPanel(name, check) {
  check();
  console.log(`OK ${name}`);
}

async function main() {
  const [html, script, walletView, testnetProof, funding] = await Promise.all([
    getText('/dashboard'),
    getText('/dashboard.js'),
    getJson('/v1/lnbtc-tlusd-liquidity-patch/wallet-view'),
    getJson('/v1/wallet-demo/bitcoin-testnet-proof'),
    getText('/funding')
  ]);

  runPanel('Proof Frame', () => {
    assert.match(html, /Cross-Domain Liquidity Map/, 'missing network map title');
    assert.match(html, /BTC-Only TradeLayer Oracle DLC/, 'missing new DLC subsection');
    assert.match(html, /Bitcoin Testnet Transaction Chain/, 'missing tx chain');
    assert.match(html, /BitVM Router Circuit/, 'missing BitVM circuit');
    for (const id of [
      'useCaseGrid',
      'pureBtcRouteDemo',
      'tradelayerOracleDlc',
      'demoSteps',
      'swapStateMachine',
      'dlcSettlement',
      'bitcoinProofLinks',
      'bitvmEnforcement'
    ]) {
      assertMount(html, id);
    }
    assert.doesNotMatch(html, /litecoin|tLTC/i, 'public dashboard frame leaks old substrate wording');
    assert.doesNotMatch(funding, /litecoin/i, 'funding brief leaks old substrate wording');
  });

  runPanel('Bottom Cut', () => {
    for (const id of [
      'botSelect',
      'operatorEconomics',
      'adapterEventFeed',
      'deploymentHealth',
      'botTable',
      'arkSavingsPanel',
      'failureControls',
      'assetMode',
      'integrationChecklist',
      'exportPackSummary'
    ]) {
      assertNoMount(html, id);
    }
    assert.doesNotMatch(html, /Autobot Routing Table|Operator Economics|Layer Adapter Feed|Deployment Health|Failure Injection/, 'simulated bottom panels still render');
  });

  runPanel('TradeLayer Oracle DLC', () => {
    const demo = walletView.tradeLayerOracleDlc;
    assert.equal(walletView.useCases.length, 3);
    assert.equal(walletView.useCases[2].id, 'btc-only-oracle-dlc');
    assert.equal(demo.noTapAssets, true);
    assert.equal(demo.trigger.txid, testnetProof.keyTxids.oraclePublish.txid);
    assert.equal(demo.trigger.payloadText, 'tle1,aqzr7k');
    assert.equal(demo.trigger.opReturnScriptHex, '6a0b746c65312c61717a72376b');
    assert.equal(demo.trigger.publisherAddress, demo.trigger.designatedOracleAddress);
    assert.equal(demo.trigger.maxDeviationBps, 500);
    assert.ok(demo.trigger.priceDeviationBps <= 500, 'oracle mark exceeds solvency band');
    assert.equal(demo.trigger.solvencyGuard.withinBand, true);
    assert.equal(demo.contract.settlementAsset, 'btc-only');
    assert.equal(demo.contract.oraclePolicy.maxDeviationBps, 500);
    assert.equal(demo.settlement.settlementRail, 'lightning');
    assert.equal(demo.settlement.noTapAssetPath, true);
    assert.equal(demo.bitvmOrganizer.totalGates, 888);
    assert.ok(demo.bitvmOrganizer.pseudocode.some(line => line.includes('decode_tx14(payloadText)')), 'missing tx14 pseudocode');
    assert.ok(demo.bitvmOrganizer.pseudocode.some(line => line.includes('designated_oracle_address_hash')), 'missing oracle publisher pseudocode');
    assert.ok(demo.bitvmOrganizer.pseudocode.some(line => line.includes('last_price * 500')), 'missing solvency band pseudocode');
    assert.equal(demo.vwapStateOracle.summaryCore.vwapPrice, '65020');
    assert.equal(demo.vwapStateOracle.summaryCore.validTradeCount, 3);
    assert.equal(demo.vwapStateOracle.solvencyGuard.withinBand, true);
    assert.equal(demo.vwapChallenge.totalGates, 1056);
    assert.equal(demo.vwapChallenge.challengeViolation, 'bad_vwap_arithmetic');
    assert.match(script, /renderTradeLayerOracleDlc/, 'missing oracle DLC renderer');
    assert.match(script, /TradeLayer VWAP State Oracle/, 'missing VWAP state oracle renderer');
  });

  runPanel('Bitcoin Testnet Proofs', () => {
    assert.equal(testnetProof.network, 'testnet4');
    assert.equal(testnetProof.summary.txCount, 20);
    assert.equal(testnetProof.summary.offchainCount, 2);
    assert.equal(testnetProof.submarineSwapHtlc.txid, testnetProof.summary.entryTxid);
    assert.match(testnetProof.submarineSwapHtlc.redeemScriptAsm, /OP_CHECKLOCKTIMEVERIFY/);
    assert.match(testnetProof.keyTxids.oraclePublish.explorer, /^https:\/\/mempool\.space\/testnet4\/tx\//);
  });

  runPanel('BitVM Unpack', () => {
    const circuit = walletView.liquidityPatch.routerCircuit;
    assert.equal(circuit.totalGates, 768);
    assert.ok(circuit.gateCounts.every(gate => gate.id), 'gate row missing id');
    assert.ok(circuit.gateCounts.every(gate => Array.isArray(gate.pseudocode)), 'gate row missing pseudocode');
    assert.ok(circuit.gateCounts.every(gate => Array.isArray(gate.flow)), 'gate row missing circuit flow');
    assert.match(script, /renderBitvmUnpack/, 'missing BitVM unpack renderer');
    assert.match(script, /data-gate-id/, 'missing clickable gate selector');
  });

  runPanel('Funding Brief', () => {
    assert.match(funding, /UTXORef Spiral Brief/, 'missing funding title');
    assert.match(funding, />Milestones</, 'missing milestones section');
    assert.doesNotMatch(funding, /Grant Milestones/, 'funding brief should use neutral milestone wording');
  });

  console.log(`panel data smoke test ok: ${BASE_URL}`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
