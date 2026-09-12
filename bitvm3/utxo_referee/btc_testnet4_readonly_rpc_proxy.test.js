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
  assert.deepEqual(Object.keys(METHOD_POLICY).sort(), referee.dlc.testnet4EvaluationPolicy.readonlyRpcMethods);
  assert.equal(MAX_REQUEST_BYTES, referee.dlc.testnet4EvaluationPolicy.readonlyRpcMaxRequestBytes);
  assert.equal(MAX_RESPONSE_BYTES, referee.dlc.testnet4EvaluationPolicy.readonlyRpcMaxResponseBytes);
  assert.equal(MAX_CONCURRENT_REQUESTS, referee.dlc.testnet4EvaluationPolicy.readonlyRpcMaxConcurrentRequests);
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
