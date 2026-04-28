const assert = require('assert');
const { buildStatus, buildWalletView, buildStressDashboard } = require('./mockData');

const status = buildStatus();
const walletView = buildWalletView();
const dashboard = buildStressDashboard({ botCount: 5000 });

assert.strictEqual(status.ok, true);
assert.strictEqual(status.readiness.walletViewReady, true);
assert.strictEqual(status.artifacts.bitcoinTestnetProof.txCount, 20);
assert.strictEqual(walletView.conversion.lnbtcSats, 49000);
assert.strictEqual(walletView.pureBtcRouteDemo.id, 'demo-3-pure-btc-bitvm-ln');
assert.strictEqual(walletView.pureBtcRouteDemo.stages.length, 3);
assert.strictEqual(walletView.pureBtcRouteDemo.stages[0].id, 'subswap-htlc');
assert.strictEqual(walletView.pureBtcRouteDemo.stages[1].status, 'complete');
assert.strictEqual(walletView.pureBtcRouteDemo.stages[2].kind, 'bitvm-router-circuit');
assert.strictEqual(walletView.useCases.length, 3);
assert.strictEqual(walletView.useCases[0].id, 'usd-asset-routing');
assert.strictEqual(walletView.useCases[1].id, 'btc-bitvm-graft');
assert.strictEqual(walletView.useCases[2].id, 'btc-only-oracle-dlc');
assert.ok(walletView.useCases[1].offchainProofs.includes('bitvm-router-circuit'));
assert.strictEqual(walletView.useCases[1].bitcoinEvidence.length, 1);
assert.strictEqual(walletView.useCases[1].bitcoinEvidence[0], walletView.conversion.bitvmShowcaseAnchorTxid);
assert.strictEqual(walletView.tradeLayerOracleDlc.noTapAssets, true);
assert.strictEqual(walletView.tradeLayerOracleDlc.trigger.payloadText, 'tle1,aqzr7k');
assert.strictEqual(walletView.tradeLayerOracleDlc.trigger.opReturnScriptHex, '6a0b746c65312c61717a72376b');
assert.strictEqual(walletView.tradeLayerOracleDlc.trigger.publisherAddress, walletView.tradeLayerOracleDlc.trigger.designatedOracleAddress);
assert.strictEqual(walletView.tradeLayerOracleDlc.trigger.maxDeviationBps, 500);
assert.ok(walletView.tradeLayerOracleDlc.trigger.priceDeviationBps <= 500);
assert.strictEqual(walletView.tradeLayerOracleDlc.trigger.solvencyGuard.withinBand, true);
assert.strictEqual(walletView.tradeLayerOracleDlc.bitvmOrganizer.totalGates, 888);
assert.ok(
  walletView.tradeLayerOracleDlc.bitvmOrganizer.pseudocode.some(line => line.includes('designated_oracle_address_hash')),
  'oracle DLC pseudocode missing designated publisher check'
);
assert.ok(
  walletView.tradeLayerOracleDlc.bitvmOrganizer.pseudocode.some(line => line.includes('last_price * 500')),
  'oracle DLC pseudocode missing 5% solvency band'
);
assert.strictEqual(walletView.tradeLayerOracleDlc.vwapStateOracle.summaryCore.vwapPrice, '65020');
assert.strictEqual(walletView.tradeLayerOracleDlc.vwapStateOracle.summaryCore.validTradeCount, 3);
assert.strictEqual(walletView.tradeLayerOracleDlc.vwapStateOracle.solvencyGuard.withinBand, true);
assert.strictEqual(walletView.tradeLayerOracleDlc.vwapStateOracle.publishTxid, '2f034a7e08ad1466b787e1f78cbb3f07566b36ed0cce95e1f1a30da82330d77f');
assert.strictEqual(walletView.tradeLayerOracleDlc.vwapChallenge.totalGates, 1056);
assert.strictEqual(walletView.tradeLayerOracleDlc.vwapChallenge.challengeViolation, 'bad_vwap_arithmetic');
assert.strictEqual(walletView.tradeLayerOracleDlc.settlement.settlementRail, 'lightning');
assert.strictEqual(walletView.tradeLayerOracleDlc.settlement.noTapAssetPath, true);
assert.notStrictEqual(walletView.conversion.journeyEntryTxid, walletView.conversion.bitvmShowcaseAnchorTxid);
assert.strictEqual(walletView.conversion.submarineSwapHtlc.txid, walletView.conversion.journeyEntryTxid);
assert.match(walletView.conversion.submarineSwapHtlc.redeemScriptAsm, /OP_SHA256/);
assert.match(walletView.conversion.submarineSwapHtlc.redeemScriptAsm, /OP_CHECKLOCKTIMEVERIFY/);
assert.ok(status.lightningDiscovery.explorers.length >= 2);
assert.ok(status.lightningDiscovery.candidatePeers.length >= 5);
assert.ok(status.lightningDiscovery.candidatePeers.every(peer => peer.tcpOpen === true));
assert.match(walletView.conversion.subswapFundingExplorer, /^https:\/\/mempool\.space\/testnet4\/tx\//);
assert.match(walletView.conversion.dlcFundingTxid, /^[0-9a-f]{64}$/);
assert.strictEqual(walletView.liquidityPatch.routerCircuit.totalGates, 768);
assert.ok(walletView.liquidityPatch.routerCircuit.gateCounts.length >= 6);
assert.ok(walletView.liquidityPatch.routerCircuit.gateCounts.every(gate => gate.id), 'gate missing stable id');
assert.ok(walletView.liquidityPatch.routerCircuit.gateCounts.every(gate => Array.isArray(gate.flow) && gate.flow.length >= 3), 'gate missing flow unpack');
assert.ok(walletView.liquidityPatch.routerCircuit.gateCounts.every(gate => Array.isArray(gate.pseudocode) && gate.pseudocode.length >= 2), 'gate missing pseudocode unpack');
assert.ok(
  walletView.liquidityPatch.routerCircuit.gateCounts
    .find(gate => gate.id === 'liquidity-comparator')
    .pseudocode.some(line => line.includes('delivered_sats')),
  'liquidity comparator unpack does not explain delivered_sats'
);
assert.ok(walletView.liquidityPatch.routerCircuit.scriptTemplate.some(line => line.includes('OP_CHECKSIG')));
assert.strictEqual(dashboard.totals.botCount, 5000);
assert.ok(dashboard.totals.challengeCount > 0);
assert.ok(dashboard.totals.assignedInboundSats > dashboard.totals.deliveredInboundSats);
assert.strictEqual(dashboard.bots.length, 5000);
assert.strictEqual(dashboard.challengeQueue.length, 40);
assert.strictEqual(dashboard.verification.ok, true);

console.log('wallet-dashboard-vercel mock data ok');
