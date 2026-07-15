#!/usr/bin/env node

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPolicy } = require('./betaPolicy');
const { StateStore, createInvitations } = require('./betaStore');
const { createBetaService, requestIp } = require('./betaService');
const { BitcoinBackend } = require('./bitcoinBackend');
const { recoverInterruptedRuns } = require('./server');
const { stableStringify } = require('../../bitvm3/utxo_referee/tradelayer_pnl_route_adapter');
const { buildGuardianQuorumVaultManifest } = require('../../bitvm3/utxo_referee/utxoref_v2_guardian_quorum_reserve');

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
    async getTxout(txid, vout) { return options.txouts?.[`${txid}:${vout}`] || null; }
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

async function testPersistentRateLimits(root) {
  const statePath = path.join(root, 'persistent-rate.json');
  const store = new StateStore(statePath);
  const bitcoin = fakeBitcoin(store);
  let now = new Date('2026-07-15T12:00:00.000Z');
  const policy = policyFor(statePath, { postRequestsPerMinute: 2, postRequestsPerHour: 3 });
  const request = (baseUrl, suffix) => jsonRequest(baseUrl, '/v1/faucet/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `persistent-rate-${suffix}` },
    body: JSON.stringify({ inviteToken: 'ubeta_invalid_invalid_invalid_invalid', address: TEST_ADDRESS })
  });

  const first = await listen(createBetaService({ policy, store, bitcoin, clock: () => now }));
  try {
    assert.equal((await request(first.baseUrl, '01')).response.status, 401);
    assert.equal((await request(first.baseUrl, '02')).response.status, 401);
  } finally { await first.close(); }

  const restarted = await listen(createBetaService({ policy, store: new StateStore(statePath), bitcoin, clock: () => now }));
  try {
    const blockedAfterRestart = await request(restarted.baseUrl, '03');
    assert.equal(blockedAfterRestart.response.status, 429);
    now = new Date(now.getTime() + 61000);
    assert.equal((await request(restarted.baseUrl, '04')).response.status, 401);
    assert.equal((await request(restarted.baseUrl, '05')).response.status, 429, 'hour limit must survive minute rollover');
  } finally { await restarted.close(); }

  const disk = fs.readFileSync(statePath, 'utf8');
  assert.ok(!disk.includes('127.0.0.1'), 'rate ledger must not retain plaintext requester IPs');
  assert.equal(requestIp({ headers: { 'x-forwarded-for': 'attacker-controlled' }, socket: { remoteAddress: '127.0.0.1' } }, { trustProxy: true }), '127.0.0.1');
  assert.equal(requestIp({ headers: { 'x-forwarded-for': '203.0.113.8' }, socket: { remoteAddress: '127.0.0.1' } }, { trustProxy: true }), '203.0.113.8');
}

function guardianFixture(label) {
  const heartbeat = crypto.generateKeyPairSync('ed25519');
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.generateKeys();
  const publicDer = heartbeat.publicKey.export({ type: 'spki', format: 'der' });
  return {
    guardianId: crypto.createHash('sha256').update(publicDer.subarray(-32)).digest('hex').slice(0, 24),
    label,
    guardianXonly: ecdh.getPublicKey(null, 'compressed').subarray(1).toString('hex'),
    heartbeatPublicKeyPem: heartbeat.publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: heartbeat.privateKey
  };
}

function signedHeartbeat(guardian, sequence, observedAt, overrides = {}) {
  const core = {
    kind: 'utxoref_beta_guardian_heartbeat_v1',
    version: 1,
    guardianId: guardian.guardianId,
    label: guardian.label,
    guardianXonly: guardian.guardianXonly,
    graphHash: '34dfe4a3d05264fa54cd6d99e9a07ac784c22f3011b7704847337a0543d02eee',
    observedAt,
    sequence,
    chain: 'testnet4',
    blockHeight: 150000,
    headerHeight: 150001,
    chainLagBlocks: 1,
    betaReadyObserved: false,
    ...overrides
  };
  return {
    kind: 'utxoref_beta_guardian_heartbeat',
    version: 1,
    core,
    signature: crypto.sign(null, Buffer.from(stableStringify(core)), guardian.privateKey).toString('base64')
  };
}

async function testGuardianQuorum(root) {
  const statePath = path.join(root, 'guardians.json');
  const registryPath = path.join(root, 'guardian-registry.json');
  const reservePath = path.join(root, 'guardian-reserve.json');
  const guardians = [guardianFixture('domain-one'), guardianFixture('domain-two')];
  const operator = guardianFixture('operator');
  const recovery = guardianFixture('recovery');
  const registry = {
    kind: 'utxoref_beta_guardian_registry',
    version: 1,
    graphHash: '34dfe4a3d05264fa54cd6d99e9a07ac784c22f3011b7704847337a0543d02eee',
    quorum: 2,
    guardians: guardians.map(({ privateKey, ...guardian }) => guardian)
  };
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  const reserveTxid = 'cd'.repeat(32);
  const manifest = buildGuardianQuorumVaultManifest({
    network: 'bitcoin-testnet4',
    fundingOutpoint: { txid: reserveTxid, vout: 1 },
    amountSats: 10000,
    observedAtHeight: 150000,
    reserveEpochId: 'beta-test-reserve',
    bindingHash: registry.graphHash,
    operatorXonly: operator.guardianXonly,
    guardianXonlys: guardians.map((guardian) => guardian.guardianXonly),
    guardianThreshold: registry.quorum,
    recoveryXonly: recovery.guardianXonly,
    recoveryCsvDelay: 2016
  });
  fs.writeFileSync(reservePath, `${JSON.stringify({
    kind: 'utxoref_beta_guardian_quorum_reserve_deployment',
    version: 1,
    broadcast: true,
    graphHash: registry.graphHash,
    guardianThreshold: registry.quorum,
    manifest
  }, null, 2)}\n`);
  const store = new StateStore(statePath);
  const bitcoin = fakeBitcoin(store, { txouts: {
    [`${reserveTxid}:1`]: {
      value: 0.0001,
      confirmations: 1,
      scriptPubKey: { hex: manifest.core.p2trScriptPubKey }
    }
  } });
  let now = new Date('2026-07-15T12:00:00.000Z');
  const policy = policyFor(statePath, {
    guardianRegistryPath: registryPath,
    guardianReservePath: reservePath,
    requireGuardianQuorum: true,
    guardianHeartbeatMaxAgeSeconds: 180,
    guardianClockSkewSeconds: 60,
    postRequestsPerMinute: 50,
    postRequestsPerHour: 100
  });
  const live = await listen(createBetaService({ policy, store, bitcoin, clock: () => now }));
  const post = (heartbeat) => jsonRequest(live.baseUrl, '/v1/guardians/heartbeat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(heartbeat)
  });
  try {
    const before = await jsonRequest(live.baseUrl, '/v1/beta/status');
    assert.equal(before.payload.betaReady, false);
    assert.equal(before.payload.guardians.fresh, 0);
    assert.equal(before.payload.guardianReserve.healthy, true);

    const firstHeartbeat = signedHeartbeat(guardians[0], 1, now.toISOString());
    const first = await post(firstHeartbeat);
    assert.equal(first.response.status, 201);
    assert.equal(first.payload.accepted, true);
    assert.equal((await post(firstHeartbeat)).payload.duplicate, true, 'exact replay must be idempotent');

    const equivocation = signedHeartbeat(guardians[0], 1, now.toISOString(), { blockHeight: 149999, chainLagBlocks: 2 });
    const rejectedEquivocation = await post(equivocation);
    assert.equal(rejectedEquivocation.response.status, 409);
    assert.equal(rejectedEquivocation.payload.error, 'guardian_equivocation');

    const badSignature = signedHeartbeat(guardians[1], 1, now.toISOString());
    badSignature.signature = firstHeartbeat.signature;
    assert.equal((await post(badSignature)).response.status, 401);

    const withinClockSkew = new Date(now.getTime() + 30000).toISOString();
    assert.equal((await post(signedHeartbeat(guardians[1], 1, withinClockSkew))).response.status, 201);
    const ready = await jsonRequest(live.baseUrl, '/v1/beta/status');
    assert.equal(ready.payload.guardians.fresh, 2);
    assert.equal(ready.payload.guardians.quorumHealthy, true);
    assert.equal(ready.payload.betaReady, true);

    now = new Date(now.getTime() + 181000);
    const expired = await jsonRequest(live.baseUrl, '/v1/beta/status');
    assert.equal(expired.payload.guardians.quorumHealthy, false);
    assert.equal(expired.payload.betaReady, false);
  } finally { await live.close(); }
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
    await testPersistentRateLimits(root);
    await testGuardianQuorum(root);
    await testCrossProcessLock(root);
    await testBitcoinBackendCompatibility();
    testInterruptedRunRecovery();
    console.log(JSON.stringify({ ok: true, suite: 'utxoref-testnet-beta', tests: 8 }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
