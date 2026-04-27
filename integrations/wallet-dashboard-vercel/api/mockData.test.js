const assert = require('assert');
const { buildStatus, buildWalletView, buildStressDashboard } = require('./mockData');

const status = buildStatus();
const walletView = buildWalletView();
const dashboard = buildStressDashboard({ botCount: 5000 });

assert.strictEqual(status.ok, true);
assert.strictEqual(status.readiness.walletViewReady, true);
assert.strictEqual(walletView.conversion.lnbtcSats, 49000);
assert.strictEqual(dashboard.totals.botCount, 5000);
assert.ok(dashboard.totals.challengeCount > 0);
assert.ok(dashboard.totals.assignedInboundSats > dashboard.totals.deliveredInboundSats);
assert.strictEqual(dashboard.bots.length, 5000);
assert.strictEqual(dashboard.challengeQueue.length, 40);
assert.strictEqual(dashboard.verification.ok, true);

console.log('wallet-dashboard-vercel mock data ok');
