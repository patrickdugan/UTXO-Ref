const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

// The uptime workflow applies deploy/beta-status-invariant.jq to the public status. These cases pin that a missing
// or mistyped field fails the probe, which jq's default ordering of null would not do.
const filter = path.join(__dirname, 'deploy', 'beta-status-invariant.jq');
const probe = spawnSync('jq', ['--version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  console.log('status invariant tests skipped: jq is not installed');
  process.exit(0);
}

const GRAPH = '34dfe4a3d05264fa54cd6d99e9a07ac784c22f3011b7704847337a0543d02eee';

function healthy() {
  return {
    betaReady: true,
    chain: { network: 'testnet4', initialBlockDownload: false, lagBlocks: 0 },
    graph: { verified: true, graphHash: GRAPH },
    guardians: { configured: 3, fresh: 3, quorum: 2, quorumHealthy: true },
    guardianReserve: { configured: true, healthy: true, unspent: true, manifestVerified: true, fundingHeightMatches: true },
    faucet: { enabled: true, amountSats: '1000', dailyRemainingSats: '40000' }
  };
}

function passes(status) {
  const result = spawnSync('jq', ['-e', '--arg', 'graph', GRAPH, '-f', filter], {
    input: JSON.stringify(status),
    encoding: 'utf8'
  });
  return result.status === 0;
}

function without(path) {
  const status = healthy();
  const keys = path.split('.');
  let target = status;
  for (const key of keys.slice(0, -1)) target = target[key];
  delete target[keys[keys.length - 1]];
  return status;
}

assert.strictEqual(passes(healthy()), true, 'a healthy status must pass');
assert.strictEqual(passes({ ...healthy(), betaReady: false }), false);
assert.strictEqual(passes({ ...healthy(), graph: { verified: true, graphHash: '0'.repeat(64) } }), false);
for (const field of [
  'chain.lagBlocks',
  'guardians.fresh',
  'guardians.quorum',
  'guardians.configured',
  'faucet.dailyRemainingSats',
  'faucet.amountSats'
]) {
  assert.strictEqual(passes(without(field)), false, `a missing ${field} must fail the probe`);
}
assert.strictEqual(passes({ ...healthy(), chain: { ...healthy().chain, lagBlocks: '0' } }), false, 'a string lag is not a number');
assert.strictEqual(passes({ ...healthy(), chain: { ...healthy().chain, lagBlocks: 13 } }), false);
assert.strictEqual(passes({ ...healthy(), guardians: { configured: 3, fresh: 1, quorum: 2, quorumHealthy: true } }), false);
assert.strictEqual(passes({ ...healthy(), faucet: { enabled: true, amountSats: '1000', dailyRemainingSats: '999' } }), false);
console.log('status invariant tests ok');
