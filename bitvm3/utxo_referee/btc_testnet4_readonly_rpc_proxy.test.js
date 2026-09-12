'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const referee = require('./index');
const {
  METHOD_POLICY,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_CONCURRENT_REQUESTS,
  MAX_AUTHENTICATED_REQUESTS_PER_MINUTE,
  MAX_CONNECTIONS,
  createFileTokenProvider,
  validateRpcRequest,
  createReadonlyRpcProxy
} = require('./btc_testnet4_readonly_rpc_proxy');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function post(port, token, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': body.length
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        value: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('read-only RPC policy rejects wallet, signing, broadcast, and node-control methods', () => {
  const evaluationPolicy = referee.dlc.testnet4EvaluationPolicy;
  assert.equal(referee.dlc.securityBoundaryVersion, 58);
  assert.equal(referee.dlc.durableJournalPolicy.recordReadProtocol, 'lstat-open-fstat-lstat-v2');
  assert.equal(referee.dlc.durableJournalPolicy.pathEntryStableThroughReadRequired, true);
  assert.equal(referee.dlc.durableJournalPolicy.pathEntryStableThroughFinalFlushRequired, true);
  assert.equal(referee.dlc.durableJournalPolicy.directoryLinkTraversalAllowed, false);
  assert.equal(referee.dlc.durableJournalPolicy.exactSequenceFilenamesRequired, true);
  assert.equal(referee.dlc.durableJournalPolicy.externalCheckpointKind, 'utxoref_dlc_journal_checkpoint_v1');
  assert.deepEqual(referee.dlc.durableJournalPolicy.checkpointStores,
    ['contract-state', 'oracle-event', 'peer-session', 'signing-authorization',
      'refund-recovery', 'broadcast-authorization', 'watchtower']);
  assert.equal(referee.dlc.durableJournalPolicy.checkpointBindsRecordAtPinnedCount, true);
  assert.equal(referee.dlc.durableJournalPolicy.longerHistoryMustContainPinnedHead, true);
  assert.equal(referee.dlc.durableJournalPolicy.checkpointStorageInsideJournalAllowed, false);
  assert.equal(referee.dlc.durableJournalPolicy.checkpointInputsNormalizedToFrozenPlainData, true);
  assert.equal(referee.dlc.durableJournalPolicy.linkedFinalRecordsAllowed, false);
  assert.equal(referee.dlc.signerPolicy.signingConsumptionIdentityBound, true);
  assert.equal(referee.dlc.signerPolicy.signingConsumptionHardLinksAllowed, false);
  assert.equal(referee.dlc.signerPolicy.signingConsumptionMaxRecordBytes, 32768);
  assert.equal(typeof referee.dlc.RefundRecoveryStore, 'function');
  assert.equal(referee.dlc.signerPolicy.fullySignedRefundRecoveryRequired, true);
  assert.equal(referee.dlc.signerPolicy.refundRecoveryAppendOnce, true);
  assert.equal(referee.dlc.signerPolicy.refundRecoveryTaprootWitnessVerified, true);
  assert.equal(referee.dlc.signerPolicy.refundRecoveryRestoredBeforeFunding, true);
  assert.equal(referee.dlc.signerPolicy.refundRecoveryReceiptDigestBound, true);
  assert.equal(referee.dlc.signerPolicy.refundRecoveryRaceWorkers, 16);
  assert.equal(referee.dlc.signerPolicy.exactOneRefundArtifactRaceWinner, true);
  assert.equal(evaluationPolicy.watchOnlySwarmWalletRequired, true);
  assert.equal(evaluationPolicy.watchOnlyWalletProvisioning, 'public-descriptor-import-v1');
  assert.equal(evaluationPolicy.privateDescriptorsAccepted, false);
  assert.equal(evaluationPolicy.exactWatchOnlyUtxoParityRequired, true);
  assert.equal(evaluationPolicy.sourceWalletModified, false);
  assert.equal(evaluationPolicy.watchOnlyEvidenceLiveRevalidated, true);
  assert.equal(evaluationPolicy.watchOnlyEvidenceFileTrusted, false);
  assert.equal(evaluationPolicy.watchOnlyAuditMutationAllowed, false);
  assert.equal(evaluationPolicy.watchOnlyProvisioningSigningAllowed, false);
  assert.equal(evaluationPolicy.watchOnlyProvisioningBroadcastAllowed, false);
  assert.deepEqual(Object.keys(METHOD_POLICY).sort(), referee.dlc.testnet4EvaluationPolicy.readonlyRpcMethods);
  assert.equal(MAX_REQUEST_BYTES, referee.dlc.testnet4EvaluationPolicy.readonlyRpcMaxRequestBytes);
  assert.equal(MAX_RESPONSE_BYTES, referee.dlc.testnet4EvaluationPolicy.readonlyRpcMaxResponseBytes);
  assert.equal(MAX_CONCURRENT_REQUESTS, referee.dlc.testnet4EvaluationPolicy.readonlyRpcMaxConcurrentRequests);
  assert.equal(MAX_AUTHENTICATED_REQUESTS_PER_MINUTE,
    referee.dlc.testnet4EvaluationPolicy.readonlyRpcMaxAuthenticatedRequestsPerMinute);
  assert.equal(MAX_CONNECTIONS, referee.dlc.testnet4EvaluationPolicy.readonlyRpcMaxConnections);
  assert.equal(referee.dlc.testnet4EvaluationPolicy.readonlyRpcTokenFormat, 'lowercase-hex-256-bit');
  assert.equal(referee.dlc.testnet4EvaluationPolicy.readonlyRpcTokenRevalidatedPerRequest, true);
  assert.equal(referee.dlc.testnet4EvaluationPolicy.readonlyRpcTokenRotationRevokesImmediately, true);
  assert.equal(referee.dlc.testnet4EvaluationPolicy.readonlyRpcTokenComparisonBuffersCleared, true);
  assert.equal(referee.dlc.testnet4EvaluationPolicy.readonlyRpcCredentialReadIdentityBound, true);
  assert.equal(referee.dlc.testnet4EvaluationPolicy.readonlyRpcCredentialHardLinksAllowed, false);
  assert.equal(referee.dlc.testnet4EvaluationPolicy.readonlyRpcCredentialReadBuffersCleared, true);
  assert.equal(referee.dlc.testnet4EvaluationPolicy.bitcoinCoreBinaryProvenance, 'authenticode-sha256-v1');
  assert.equal(referee.dlc.testnet4EvaluationPolicy.actualRpcListenerLoopbackRequired, true);
  assert.equal(referee.dlc.testnet4EvaluationPolicy.rpcListenerOwnerBinaryPinned, true);
  assert.equal(referee.dlc.testnet4EvaluationPolicy.evidenceRequiresCleanWorktree, true);
  assert.equal(referee.dlc.testnet4EvaluationPolicy.compatibilitySnapshotDirtyTreeAllowed, false);
  assert.equal(referee.dlc.testnet4EvaluationPolicy.scaleSnapshotDirtyTreeAllowed, false);
  assert.equal(referee.dlc.testnet4EvaluationPolicy.evidenceCommitMustRemainStable, true);
  for (const method of [
    'getwalletinfo', 'listunspent', 'walletpassphrase', 'signrawtransactionwithwallet',
    'sendrawtransaction', 'submitblock', 'stop', 'setnetworkactive', 'addnode', 'pruneblockchain'
  ]) {
    const result = validateRpcRequest({ jsonrpc: '2.0', id: 1, method, params: [] });
    assert.equal(result.ok, false, method);
    assert.equal(result.code, -32601, method);
  }
  assert.equal(validateRpcRequest([{ jsonrpc: '2.0', id: 1, method: 'getbestblockhash', params: [] }]).ok, false);
  assert.equal(validateRpcRequest({
    jsonrpc: '2.0', id: 1, method: 'gettxout', params: ['11'.repeat(32), 0, false]
  }).ok, false);
  assert.equal(validateRpcRequest({
    jsonrpc: '2.0', id: 1, method: 'testmempoolaccept', params: [["00"], 0]
  }).ok, true);
  assert.throws(() => createReadonlyRpcProxy({
    cookiePath: path.resolve('unused-cookie'), token: 'not-a-256-bit-token'
  }), /invalid read-only RPC proxy configuration/);
});

test('proxy forwards an allowed call and never forwards denied methods', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-rpc-proxy-'));
  const cookiePath = path.join(temporary, '.cookie');
  fs.writeFileSync(cookiePath, '__cookie__:test-only-secret\n', { encoding: 'utf8', flag: 'wx' });
  let upstreamCalls = 0;
  const upstream = http.createServer((request, response) => {
    upstreamCalls++;
    assert.match(request.headers.authorization || '', /^Basic /);
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const incoming = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const body = Buffer.from(JSON.stringify({
        jsonrpc: '2.0', id: incoming.id, result: { chain: 'testnet4' }
      }), 'utf8');
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      response.end(body);
    });
  });
  const rpcPort = await listen(upstream);
  const token = 'ab'.repeat(32);
  const proxy = createReadonlyRpcProxy({ cookiePath, token, rpcPort });
  const proxyPort = await listen(proxy.server);
  try {
    const allowed = await post(proxyPort, token, {
      jsonrpc: '2.0', id: 7, method: 'getblockchaininfo', params: []
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.value.result.chain, 'testnet4');
    assert.equal(upstreamCalls, 1);

    for (const method of ['sendrawtransaction', 'stop', 'walletpassphrase']) {
      const denied = await post(proxyPort, token, { jsonrpc: '2.0', id: method, method, params: [] });
      assert.equal(denied.status, 400);
      assert.equal(denied.value.error.code, -32601);
    }
    const badToken = await post(proxyPort, 'cd'.repeat(32), {
      jsonrpc: '2.0', id: 8, method: 'getblockchaininfo', params: []
    });
    assert.equal(badToken.status, 403);
    assert.equal(upstreamCalls, 1);
    assert.deepEqual(proxy.stats, { accepted: 1, denied: 4, failed: 0 });
  } finally {
    await close(proxy.server);
    await close(upstream);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('proxy enforces its cross-request concurrency bound', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-rpc-limit-'));
  const cookiePath = path.join(temporary, '.cookie');
  fs.writeFileSync(cookiePath, '__cookie__:test-only-secret\n', { encoding: 'utf8', flag: 'wx' });
  let releaseUpstream;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const incoming = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      markStarted();
      releaseUpstream = () => {
        const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: incoming.id, result: true }), 'utf8');
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
        response.end(body);
      };
    });
  });
  const rpcPort = await listen(upstream);
  const token = 'ef'.repeat(32);
  const proxy = createReadonlyRpcProxy({ cookiePath, token, rpcPort, maxConcurrent: 1 });
  const proxyPort = await listen(proxy.server);
  try {
    const first = post(proxyPort, token, { jsonrpc: '2.0', id: 1, method: 'getbestblockhash', params: [] });
    await started;
    const second = await post(proxyPort, token, {
      jsonrpc: '2.0', id: 2, method: 'getbestblockhash', params: []
    });
    assert.equal(second.status, 429);
    assert.equal(second.value.error.code, -32002);
    releaseUpstream();
    assert.equal((await first).status, 200);
    assert.deepEqual(proxy.stats, { accepted: 1, denied: 1, failed: 0 });
  } finally {
    await close(proxy.server);
    await close(upstream);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('proxy token bucket bounds authenticated request rate and refills over time', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-rpc-rate-'));
  const cookiePath = path.join(temporary, '.cookie');
  fs.writeFileSync(cookiePath, '__cookie__:test-only-secret\n', { encoding: 'utf8', flag: 'wx' });
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const incoming = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: incoming.id, result: true }), 'utf8');
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      response.end(body);
    });
  });
  const rpcPort = await listen(upstream);
  const token = '12'.repeat(32);
  let clock = 1000;
  const proxy = createReadonlyRpcProxy({
    cookiePath, token, rpcPort, maxRequestsPerMinute: 2, now: () => clock
  });
  const proxyPort = await listen(proxy.server);
  const request = id => post(proxyPort, token, {
    jsonrpc: '2.0', id, method: 'getbestblockhash', params: []
  });
  try {
    assert.equal((await request(1)).status, 200);
    assert.equal((await request(2)).status, 200);
    const limited = await request(3);
    assert.equal(limited.status, 429);
    assert.equal(limited.value.error.code, -32004);
    clock += 30000;
    assert.equal((await request(4)).status, 200);
    clock -= 60000;
    assert.equal((await request(5)).status, 429);
    assert.deepEqual(proxy.stats, { accepted: 3, denied: 2, failed: 0 });
  } finally {
    await close(proxy.server);
    await close(upstream);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('proxy token-file provider applies rotation and revocation on the next request', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-rpc-token-'));
  const cookiePath = path.join(temporary, '.cookie');
  const tokenPath = path.join(temporary, 'proxy.token');
  const firstToken = '34'.repeat(32);
  const secondToken = '56'.repeat(32);
  fs.writeFileSync(cookiePath, '__cookie__:test-only-secret\n', { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(tokenPath, firstToken, { encoding: 'utf8', flag: 'wx' });
  let upstreamCalls = 0;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      upstreamCalls++;
      const incoming = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: incoming.id, result: true }), 'utf8');
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      response.end(body);
    });
  });
  const rpcPort = await listen(upstream);
  const proxy = createReadonlyRpcProxy({
    cookiePath,
    tokenProvider: createFileTokenProvider(tokenPath),
    rpcPort
  });
  const proxyPort = await listen(proxy.server);
  const request = token => post(proxyPort, token, {
    jsonrpc: '2.0', id: token.slice(0, 2), method: 'getbestblockhash', params: []
  });
  try {
    assert.equal((await request(firstToken)).status, 200);
    fs.writeFileSync(tokenPath, secondToken, 'utf8');
    assert.equal((await request(firstToken)).status, 403);
    assert.equal((await request(secondToken)).status, 200);
    fs.rmSync(tokenPath);
    assert.equal((await request(secondToken)).status, 403);
    assert.equal(upstreamCalls, 2);
    assert.deepEqual(proxy.stats, { accepted: 2, denied: 2, failed: 0 });
  } finally {
    await close(proxy.server);
    await close(upstream);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('file token provider rejects malformed and multiply-linked credential files', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-rpc-token-file-'));
  const tokenPath = path.join(temporary, 'proxy.token');
  const hardLinkPath = path.join(temporary, 'proxy-token-link');
  try {
    fs.writeFileSync(tokenPath, 'malformed', { encoding: 'utf8', flag: 'wx' });
    assert.throws(() => createFileTokenProvider(tokenPath), /256-bit lowercase hex/);
    fs.writeFileSync(tokenPath, '78'.repeat(32), 'utf8');
    fs.linkSync(tokenPath, hardLinkPath);
    assert.throws(() => createFileTokenProvider(tokenPath), /bounded regular non-linked file/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
