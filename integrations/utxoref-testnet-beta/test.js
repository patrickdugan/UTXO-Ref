#!/usr/bin/env node

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPolicy } = require('./betaPolicy');
const { StateStore, createInvitations, privateHash } = require('./betaStore');
const { rateLimitPathFor } = require('./rateLimiter');
const { createBetaService, requestIp } = require('./betaService');
const { BitcoinBackend } = require('./bitcoinBackend');
const {
  SERVICE_RPC_METHODS,
  assertRestrictedRpc,
  recoverInterruptedRuns,
  resolveRpcCredentials
} = require('./server');
const { stableStringify, sha256Hex } = require('../../bitvm3/utxo_referee/tradelayer_pnl_route_adapter');
const taprootScript = require('../../bitvm3/utxo_referee/tradelayer_taproot_script');
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
  const rateDisk = fs.readFileSync(rateLimitPathFor(statePath), 'utf8');
  assert.ok(rateDisk.includes(':hour:'), 'rate counters were not persisted to the rate-limit file');
  assert.ok(!rateDisk.includes('127.0.0.1'), 'rate-limit file must not retain plaintext requester IPs');
  assert.equal(requestIp({ headers: { 'x-forwarded-for': 'attacker-controlled' }, socket: { remoteAddress: '127.0.0.1' } }, { trustProxy: true }), '127.0.0.1');
  assert.equal(requestIp({ headers: { 'x-forwarded-for': '203.0.113.8' }, socket: { remoteAddress: '127.0.0.1' } }, { trustProxy: true }), '203.0.113.8');
}

// BETA-1 (port of readiness-assessment poc6): a flood of unauthenticated POSTs
// from many addresses fills the rate-limit table. It must evict, not refuse
// everyone with 503, and guardian heartbeats must not share the limiter.
async function testRateLimitFloodDoesNotLockOut(root) {
  const { EventEmitter } = require('events');
  const statePath = path.join(root, 'rate-flood.json');
  const store = new StateStore(statePath);
  let nowMs = Date.parse('2026-10-01T12:00:05Z');
  const policy = { ...policyFor(statePath, { postRequestsPerMinute: 1, postRequestsPerHour: 2 }), trustProxy: true, rateLimitMaxEntries: 64 };
  const service = createBetaService({ policy, store, bitcoin: fakeBitcoin(store), clock: () => new Date(nowMs) });
  const post = (ip, url = '/v1/faucet/claim') => new Promise((resolve) => {
    const req = new EventEmitter();
    Object.assign(req, { method: 'POST', url, headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: '127.0.0.1' }, destroy() {} });
    const res = { writeHead(status) { this.status = status; }, setHeader() {}, end(body) { resolve({ status: this.status, error: body ? JSON.parse(body).error : null }); } };
    service.handler(req, res);
    setImmediate(() => req.emit('end'));
  });
  const ipFor = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
  const statuses = [];
  const stateBefore = fs.readFileSync(statePath);
  for (let i = 1; i <= 200; i++) statuses.push((await post(ipFor(i))).status);
  assert.ok(!statuses.includes(503), 'a full rate-limit table refused requests with 503');
  assert.ok(Object.keys(store.read().rateLimits).length <= 64, 'rate-limit table grew past its bound');
  assert.ok(service.rateLimiter.size <= 64, 'in-memory rate-limit table grew past its bound');
  // BETA-1 residual: unauthenticated POSTs do not take the state lock or
  // rewrite the state file; counters live in their own file.
  assert.ok(fs.readFileSync(statePath).equals(stateBefore), 'unauthenticated POSTs rewrote the beta state file');
  nowMs += 61000;
  const knownClient = await post(ipFor(1));
  assert.notEqual(knownClient.status, 503, 'a known client was locked out after the flood');
  assert.notEqual(knownClient.status, 429, 'a known client was still throttled in a fresh minute');
  // Heartbeats are verified by signature, not throttled by source address.
  const first = await post(ipFor(500), '/v1/guardians/heartbeat');
  const second = await post(ipFor(500), '/v1/guardians/heartbeat');
  assert.notEqual(first.status, 429);
  assert.notEqual(second.status, 429, 'guardian heartbeats share the unauthenticated POST limiter');
  service.rateLimiter.close();
  const flushed = JSON.parse(fs.readFileSync(rateLimitPathFor(statePath), 'utf8'));
  assert.ok(Object.keys(flushed.counters).length <= 64, 'persisted rate-limit table grew past its bound');
}

// BETA-1: counters written to the state file before the split carry over, so
// upgrading does not reset a throttled client.
async function testLegacyRateLimitsCarryOver(root) {
  const statePath = path.join(root, 'legacy-rate.json');
  const store = new StateStore(statePath);
  const now = new Date('2026-10-01T12:00:05.000Z');
  const nowMs = now.getTime();
  await store.transact((state) => {
    const ipHash = privateHash(state, 'rate-ip', '127.0.0.1');
    state.rateLimits[`${ipHash}:minute:${Math.floor(nowMs / 60000)}`] = {
      count: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(),
      expiresAt: new Date((Math.floor(nowMs / 60000) + 2) * 60000).toISOString()
    };
  });
  const policy = policyFor(statePath, { postRequestsPerMinute: 1, postRequestsPerHour: 5 });
  const live = await listen(createBetaService({ policy, store, bitcoin: fakeBitcoin(store), clock: () => now }));
  try {
    const { response } = await jsonRequest(live.baseUrl, '/v1/faucet/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'legacy-rate-01' },
      body: JSON.stringify({ inviteToken: 'ubeta_invalid_invalid_invalid_invalid', address: TEST_ADDRESS })
    });
    assert.equal(response.status, 429, 'a counter from the state file was not carried over');
  } finally { await live.close(); }
  assert.ok(fs.existsSync(rateLimitPathFor(statePath)), 'carried-over counters were not written to the rate-limit file');
}

// BETA-2: the service refuses full-privilege cookie auth and refuses to start
// with rpcauth credentials that Core does not restrict to its method set.
async function testRestrictedRpcCredentials(root) {
  const datadir = path.join(root, 'cookie-datadir');
  fs.mkdirSync(path.join(datadir, 'testnet4'), { recursive: true });
  fs.writeFileSync(path.join(datadir, 'testnet4', '.cookie'), '__cookie__:secret');
  assert.throws(() => resolveRpcCredentials({ BTCTEST_DATADIR: datadir }), /refusing Core cookie authentication/);
  assert.equal(resolveRpcCredentials({ BTCTEST_DATADIR: datadir, BETA_ALLOW_COOKIE_RPC: '1' }).source, 'cookie');
  assert.equal(resolveRpcCredentials({ BTC_RPC_USER: 'utxoref-beta', BTC_RPC_PASS: 'pw' }).source, 'rpcauth');
  assert.throws(() => resolveRpcCredentials({ BTC_RPC_USER: 'utxoref-beta' }), /must be set together/);
  const restricted = async (method) => {
    if (!SERVICE_RPC_METHODS.includes(method)) throw new Error(`RPC ${method} returned HTTP 403: `);
    return {};
  };
  assert.equal(await assertRestrictedRpc(restricted), true);
  await assert.rejects(assertRestrictedRpc(async () => 12345), /not restricted by rpcwhitelist/);
  await assert.rejects(assertRestrictedRpc(async () => { throw new Error('connect ECONNREFUSED'); }), /could not confirm/);
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

  // RES-1: a reserve whose Taproot internal key belongs to the operator has a
  // key path that bypasses the guardians. The loader must refuse it even when
  // the manifest is internally consistent (script, hash) for that key.
  const forgedCore = {
    ...manifest.core,
    internalXonly: operator.guardianXonly,
    p2trScriptPubKey: taprootScript.taprootScriptPubKeyWithRoot(
      Buffer.from(operator.guardianXonly, 'hex'),
      Buffer.from(manifest.core.merkleRoot, 'hex')
    ).toString('hex')
  };
  const forgedReservePath = path.join(root, 'guardian-reserve-forged.json');
  fs.writeFileSync(forgedReservePath, `${JSON.stringify({
    kind: 'utxoref_beta_guardian_quorum_reserve_deployment',
    version: 1,
    broadcast: true,
    graphHash: registry.graphHash,
    guardianThreshold: registry.quorum,
    manifest: { ...manifest, core: forgedCore, manifestHash: sha256Hex(forgedCore) }
  }, null, 2)}\n`);
  assert.throws(() => createBetaService({
    policy: policyFor(statePath, {
      guardianRegistryPath: registryPath,
      guardianReservePath: forgedReservePath,
      requireGuardianQuorum: true
    }),
    store,
    bitcoin
  }), /internal key is not the deterministic NUMS key/);

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
    await testRateLimitFloodDoesNotLockOut(root);
    await testLegacyRateLimitsCarryOver(root);
    await testRestrictedRpcCredentials(root);
    await testGuardianQuorum(root);
    await testCrossProcessLock(root);
    await testBitcoinBackendCompatibility();
    testInterruptedRunRecovery();
    console.log(JSON.stringify({ ok: true, suite: 'utxoref-testnet-beta', tests: 9 }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
