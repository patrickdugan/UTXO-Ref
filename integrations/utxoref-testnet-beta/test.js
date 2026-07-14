#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPolicy } = require('./betaPolicy');
const { StateStore, createInvitations } = require('./betaStore');
const { createBetaService } = require('./betaService');
const { BitcoinBackend } = require('./bitcoinBackend');
const { recoverInterruptedRuns } = require('./server');

const TEST_TXID = 'ab'.repeat(32);
const TEST_ADDRESS = `tb1q${'a'.repeat(38)}`;

function policyFor(statePath, overrides = {}) {
  return {
    ...loadPolicy({
      BETA_STATE_PATH: statePath,
      BETA_WALLET_RESERVE_FLOOR_SATS: '250000',
      BETA_DAILY_BUDGET_SATS: '50000'
    }),
    ...overrides
  };
}

function fakeBitcoin(store, options = {}) {
  const calls = { validate: 0, sends: 0, status: 0 };
  return {
    calls,
    async status() {
      calls.status += 1;
      return {
        chain: 'testnet4', blocks: 150000, headers: 150000,
        initialBlockDownload: false, verificationProgress: 1, pruned: true,
        walletTrustedSats: '400000', walletPendingSats: '0'
      };
    },
    async validateDestination(address) {
      calls.validate += 1;
      if (address !== TEST_ADDRESS) throw new Error('destination is invalid');
      return { address, scriptPubKey: `0014${'00'.repeat(20)}` };
    },
    async sendFaucet(_address, _amountSats, claimId) {
      calls.sends += 1;
      const persisted = store.read().claims[claimId];
      assert.equal(persisted.status, 'sending', 'claim must be on disk before broadcast');
      if (options.failSend) throw new Error('simulated RPC timeout');
      return TEST_TXID;
    },
    async getTxout() { return null; }
  };
}

async function listen(service) {
  const server = service.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function jsonRequest(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const payload = await response.json();
  return { response, payload };
}

async function createInvite(store, options = {}) {
  const [invitation] = await store.transact((state) => createInvitations(state, {
    label: 'test', maxClaims: 1, ...options
  }));
  return invitation.token;
}

async function testHappyPath(root) {
  const statePath = path.join(root, 'happy.json');
  const store = new StateStore(statePath);
  const bitcoin = fakeBitcoin(store);
  const policy = policyFor(statePath);
  const token = await createInvite(store);
  const live = await listen(createBetaService({ policy, store, bitcoin }));
  try {
    const health = await jsonRequest(live.baseUrl, '/healthz');
    assert.equal(health.response.status, 200);
    assert.equal(health.payload.ok, true);

    const status = await jsonRequest(live.baseUrl, '/v1/beta/status');
    assert.equal(status.response.status, 200);
    assert.equal(status.payload.chain.network, 'testnet4');
    assert.equal(status.payload.graph.verified, true);
    assert.equal(status.payload.betaReady, true);
    const cachedStatus = await jsonRequest(live.baseUrl, '/v1/beta/status');
    assert.equal(cachedStatus.response.status, 200);
    assert.equal(bitcoin.calls.status, 1, 'status refreshes inside the cache window must coalesce');

    const invalid = await jsonRequest(live.baseUrl, '/v1/faucet/claim', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'invalid-invite-key-01' },
      body: JSON.stringify({ inviteToken: 'ubeta_invalid_invalid_invalid_invalid', address: TEST_ADDRESS })
    });
    assert.equal(invalid.response.status, 401);
    assert.equal(bitcoin.calls.validate, 0, 'invalid invite must be rejected before Bitcoin RPC validation');

    const badAddress = await jsonRequest(live.baseUrl, '/v1/faucet/claim', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'bad-destination-key-01' },
      body: JSON.stringify({ inviteToken: token, address: 'not-an-address' })
    });
    assert.equal(badAddress.response.status, 400);
    assert.equal(badAddress.payload.error, 'invalid_destination');

    const headers = { 'content-type': 'application/json', 'idempotency-key': 'stable-claim-key-0001' };
    const body = JSON.stringify({ inviteToken: token, address: TEST_ADDRESS });
    const claim = await jsonRequest(live.baseUrl, '/v1/faucet/claim', { method: 'POST', headers, body });
    assert.equal(claim.response.status, 201);
    assert.equal(claim.payload.status, 'broadcast');
    assert.equal(claim.payload.txid, TEST_TXID);
    assert.equal(bitcoin.calls.sends, 1);

    const replay = await jsonRequest(live.baseUrl, '/v1/faucet/claim', { method: 'POST', headers, body });
    assert.equal(replay.response.status, 201);
    assert.equal(replay.payload.claimId, claim.payload.claimId);
    assert.equal(bitcoin.calls.sends, 1, 'idempotent replay must not send again');

    const exhausted = await jsonRequest(live.baseUrl, '/v1/faucet/claim', {
      method: 'POST', headers: { ...headers, 'idempotency-key': 'different-claim-key-02' }, body
    });
    assert.equal(exhausted.response.status, 409);
    assert.equal(exhausted.payload.error, 'invite_exhausted');

    const stressPending = jsonRequest(live.baseUrl, '/v1/stress/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: token, iterations: 8 })
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const healthStarted = Date.now();
    const duringStress = await jsonRequest(live.baseUrl, '/healthz');
    assert.equal(duringStress.response.status, 200);
    assert.ok(Date.now() - healthStarted < 1000, 'worker stress must not block health responses');
    const stress = await stressPending;
    assert.equal(stress.response.status, 201);
    assert.equal(stress.payload.passed, 8);
    assert.equal(stress.payload.failed, 0);
    assert.ok(store.read().stressRuns[stress.payload.runId]);

    const receipt = await jsonRequest(live.baseUrl, `/v1/runs/${stress.payload.runId}`);
    assert.deepEqual(receipt.payload, stress.payload);

    const page = await fetch(`${live.baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /UTXORef Beta Console/);
  } finally {
    await live.close();
  }
}

async function testUnknownBroadcast(root) {
  const statePath = path.join(root, 'unknown.json');
  const store = new StateStore(statePath);
  const bitcoin = fakeBitcoin(store, { failSend: true });
  const policy = policyFor(statePath);
  const token = await createInvite(store);
  const live = await listen(createBetaService({ policy, store, bitcoin }));
  const headers = { 'content-type': 'application/json', 'idempotency-key': 'unknown-result-key-01' };
  const body = JSON.stringify({ inviteToken: token, address: TEST_ADDRESS });
  try {
    const failed = await jsonRequest(live.baseUrl, '/v1/faucet/claim', { method: 'POST', headers, body });
    assert.equal(failed.response.status, 502);
    assert.equal(failed.payload.error, 'bitcoin_rpc_result_unknown');
    const [persisted] = Object.values(store.read().claims);
    assert.equal(persisted.status, 'broadcast_unknown');

    const replay = await jsonRequest(live.baseUrl, '/v1/faucet/claim', { method: 'POST', headers, body });
    assert.equal(replay.response.status, 201);
    assert.equal(replay.payload.status, 'broadcast_unknown');
    assert.equal(bitcoin.calls.sends, 1, 'uncertain broadcast must never be retried automatically');
  } finally {
    await live.close();
  }
}

async function testBasePath(root) {
  const statePath = path.join(root, 'base-path.json');
  const store = new StateStore(statePath);
  const bitcoin = fakeBitcoin(store);
  const policy = policyFor(statePath, { basePath: '/utxoref-beta' });
  const live = await listen(createBetaService({ policy, store, bitcoin }));
  try {
    const outside = await fetch(`${live.baseUrl}/`);
    assert.equal(outside.status, 404);
    const redirect = await fetch(`${live.baseUrl}/utxoref-beta`, { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), '/utxoref-beta/');
    const page = await fetch(`${live.baseUrl}/utxoref-beta/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /UTXORef Beta Console/);
    const status = await jsonRequest(live.baseUrl, '/utxoref-beta/v1/beta/status');
    assert.equal(status.response.status, 200);
    assert.equal(status.payload.betaReady, true);
  } finally {
    await live.close();
  }
}

async function testCrossProcessLock(root) {
  const statePath = path.join(root, 'lock.json');
  const first = new StateStore(statePath);
  const second = new StateStore(statePath);
  await Promise.all([
    first.transact(async (state) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      state.stressRuns.a = { status: 'complete' };
    }),
    second.transact((state) => { state.stressRuns.b = { status: 'complete' }; })
  ]);
  const state = first.read();
  assert.ok(state.stressRuns.a);
  assert.ok(state.stressRuns.b);
}

async function testBitcoinBackendCompatibility() {
  const calls = [];
  const rpc = async (method, args, wallet) => {
    calls.push({ method, args, wallet });
    if (method === 'sendtoaddress') return TEST_TXID;
    if (method === 'listtransactions') {
      return [{ txid: TEST_TXID, comment: 'UTXORef beta aabbccddeeff001122334455' }];
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
  const backend = new BitcoinBackend(rpc, 'beta-wallet');
  assert.equal(await backend.sendFaucet(TEST_ADDRESS, 1000, 'aabbccddeeff001122334455'), TEST_TXID);
  assert.equal(calls[0].args.length, 8, 'sendtoaddress must not require the optional avoid_reuse wallet flag');
  assert.equal(await backend.findFaucetTransaction('aabbccddeeff001122334455'), TEST_TXID);
}

function testInterruptedRunRecovery() {
  const state = { stressRuns: {
    running: { status: 'running' },
    complete: { status: 'complete' }
  } };
  assert.equal(recoverInterruptedRuns(state, '2026-07-14T00:00:00.000Z'), 1);
  assert.equal(state.stressRuns.running.status, 'failed');
  assert.equal(state.stressRuns.running.errorCode, 'service_restarted');
  assert.equal(state.stressRuns.complete.status, 'complete');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-beta-test-'));
  try {
    await testHappyPath(root);
    await testUnknownBroadcast(root);
    await testBasePath(root);
    await testCrossProcessLock(root);
    await testBitcoinBackendCompatibility();
    testInterruptedRunRecovery();
    console.log(JSON.stringify({ ok: true, suite: 'utxoref-testnet-beta', tests: 6 }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
