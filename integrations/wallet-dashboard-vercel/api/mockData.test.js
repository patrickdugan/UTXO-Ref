const assert = require('assert');
const { buildStatus, buildWalletView, buildStressDashboard } = require('./mockData');

const status = buildStatus();
const walletView = buildWalletView();
const dashboard = buildStressDashboard({ botCount: 5000 });

assert.strictEqual(status.ok, true);
assert.strictEqual(status.readiness.walletViewReady, true);
assert.strictEqual(status.artifacts.bitcoinTestnetProof.txCount, 12);
assert.strictEqual(walletView.conversion.lnbtcSats, 49000);
assert.strictEqual(walletView.useCases.length, 2);
assert.strictEqual(walletView.useCases[0].id, 'usd-asset-routing');
assert.strictEqual(walletView.useCases[1].id, 'btc-bitvm-graft');
assert.ok(walletView.useCases[1].offchainProofs.includes('bitvm-router-circuit'));
assert.ok(status.lightningDiscovery.explorers.length >= 2);
assert.ok(status.lightningDiscovery.candidatePeers.length >= 5);
assert.ok(status.lightningDiscovery.candidatePeers.every(peer => peer.tcpOpen === true));
assert.match(walletView.conversion.subswapFundingExplorer, /^https:\/\/mempool\.space\/testnet4\/tx\//);
assert.match(walletView.conversion.dlcFundingTxid, /^[0-9a-f]{64}$/);
assert.strictEqual(walletView.liquidityPatch.routerCircuit.totalGates, 768);
assert.ok(walletView.liquidityPatch.routerCircuit.gateCounts.length >= 6);
assert.ok(walletView.liquidityPatch.routerCircuit.scriptTemplate.some(line => line.includes('OP_CHECKSIG')));
assert.strictEqual(dashboard.totals.botCount, 5000);
assert.ok(dashboard.totals.challengeCount > 0);
assert.ok(dashboard.totals.assignedInboundSats > dashboard.totals.deliveredInboundSats);
assert.strictEqual(dashboard.bots.length, 5000);
assert.strictEqual(dashboard.challengeQueue.length, 40);
assert.strictEqual(dashboard.verification.ok, true);

console.log('wallet-dashboard-vercel mock data ok');
