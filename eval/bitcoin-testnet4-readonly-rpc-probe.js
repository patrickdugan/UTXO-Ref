#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  createFileTokenProvider,
  createReadonlyRpcProxy
} = require('../bitvm3/utxo_referee/btc_testnet4_readonly_rpc_proxy');

const cookiePath = process.env.BITCOIN_COOKIE || 'D:\\BitcoinTestnet\\testnet4\\.cookie';
const rpcPort = Number(process.env.BITCOIN_RPC_PORT || '48332');

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
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function run() {
  if (!path.isAbsolute(cookiePath) || !Number.isSafeInteger(rpcPort) || rpcPort < 1 || rpcPort > 65535) {
    throw new Error('invalid live proxy probe configuration');
  }
  const token = crypto.randomBytes(32).toString('hex');
  const wrongToken = crypto.randomBytes(32).toString('hex');
  const rotatedToken = crypto.randomBytes(32).toString('hex');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-live-proxy-token-'));
  const tokenFile = path.join(temporary, 'proxy.token');
  fs.writeFileSync(tokenFile, token, { encoding: 'utf8', flag: 'wx' });
  const proxy = createReadonlyRpcProxy({
    cookiePath,
    tokenProvider: createFileTokenProvider(tokenFile),
    rpcPort
  });
  const port = await listen(proxy.server);
  try {
    const allowedCalls = [
      ['getblockchaininfo', []],
      ['getbestblockhash', []],
      ['getrawmempool', [false, true]]
    ];
    const allowed = [];
    for (let index = 0; index < allowedCalls.length; index++) {
      const [method, params] = allowedCalls[index];
      const response = await post(port, token, { jsonrpc: '2.0', id: index + 1, method, params });
      allowed.push(response.status === 200 && !response.value.error);
    }
    const deniedMethods = [
      'listunspent', 'walletpassphrase', 'signrawtransactionwithwallet',
      'sendrawtransaction', 'stop', 'setnetworkactive', 'pruneblockchain'
    ];
    const denied = [];
    for (let index = 0; index < deniedMethods.length; index++) {
      const method = deniedMethods[index];
      const response = await post(port, token, { jsonrpc: '2.0', id: `deny-${index}`, method, params: [] });
      denied.push(response.status === 400 && response.value.error?.code === -32601);
    }
    const unauthenticated = await post(port, wrongToken, {
      jsonrpc: '2.0', id: 'wrong-token', method: 'getblockchaininfo', params: []
    });
    fs.writeFileSync(tokenFile, rotatedToken, 'utf8');
    const rotatedOld = await post(port, token, {
      jsonrpc: '2.0', id: 'rotated-old', method: 'getbestblockhash', params: []
    });
    const rotatedNew = await post(port, rotatedToken, {
      jsonrpc: '2.0', id: 'rotated-new', method: 'getbestblockhash', params: []
    });
    fs.rmSync(tokenFile);
    const revoked = await post(port, rotatedToken, {
      jsonrpc: '2.0', id: 'revoked', method: 'getbestblockhash', params: []
    });
    const result = {
      schema: 'utxoref_bitcoin_testnet4_readonly_rpc_probe_v1',
      capturedAt: new Date().toISOString(),
      network: 'bitcoin-testnet4',
      allowedCallsPassed: allowed.filter(Boolean).length,
      allowedCallsExpected: allowed.length,
      deniedCallsPassed: denied.filter(Boolean).length,
      deniedCallsExpected: denied.length,
      unauthenticatedRejected: unauthenticated.status === 403,
      liveTokenRotationPassed: rotatedOld.status === 403 && rotatedNew.status === 200,
      liveTokenRevocationPassed: revoked.status === 403,
      upstreamAccepted: proxy.stats.accepted,
      proxyDenied: proxy.stats.denied,
      proxyFailed: proxy.stats.failed,
      walletRpcAllowed: false,
      signingAllowed: false,
      broadcastAllowed: false
    };
    if (result.allowedCallsPassed !== result.allowedCallsExpected ||
        result.deniedCallsPassed !== result.deniedCallsExpected ||
        !result.unauthenticatedRejected || !result.liveTokenRotationPassed ||
        !result.liveTokenRevocationPassed || result.proxyFailed !== 0) {
      throw new Error(`live read-only proxy assertions failed: ${JSON.stringify(result)}`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await close(proxy.server);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

run().catch(error => {
  process.stderr.write(`Bitcoin testnet4 read-only RPC probe failed: ${error.message}\n`);
  process.exitCode = 1;
});
