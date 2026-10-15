#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const path = require('path');
const core = require('./utxoref_rpc_proxy_core');

const { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_CONCURRENT_REQUESTS, MAX_AUTHENTICATED_REQUESTS_PER_MINUTE, MAX_CONNECTIONS } = core;
const { exactParams, txidOfRawTransaction, readBoundedRegularFile, TXID } = core;
const HEX = /^(?:[0-9a-f]{2})+$/;
const TOKEN = /^[0-9a-f]{64}$/;
const BROADCAST_ALLOWLIST_KIND = 'utxoref_rpc_proxy_broadcast_allowlist_v1';
const MAX_BROADCAST_ALLOWLIST_TXIDS = 256;

const METHOD_POLICY = Object.freeze({
  getbestblockhash: params => exactParams(params, 0),
  getblockchaininfo: params => exactParams(params, 0),
  getnetworkinfo: params => exactParams(params, 0),
  getrawmempool: params =>
    (exactParams(params, 1) && params[0] === false) ||
    (exactParams(params, 2) && params[0] === false && params[1] === true),
  gettxout: params => exactParams(params, 3) && TXID.test(params[0]) &&
    Number.isSafeInteger(params[1]) && params[1] >= 0 && params[1] <= 0xffffffff && params[2] === true,
  getblockhash: params => exactParams(params, 1) && Number.isSafeInteger(params[0]) && params[0] >= 0,
  getblockheader: params => exactParams(params, 2) && TXID.test(params[0]) && params[1] === true,
  decoderawtransaction: params => exactParams(params, 1) && typeof params[0] === 'string' &&
    params[0].length <= 800000 && HEX.test(params[0]),
  testmempoolaccept: params => (params.length === 1 || params.length === 2) &&
    Array.isArray(params[0]) && params[0].length >= 1 && params[0].length <= 25 &&
    params[0].every(value => typeof value === 'string' && value.length <= 800000 && HEX.test(value)) &&
    (params.length === 1 || (typeof params[1] === 'number' && Number.isFinite(params[1]) && params[1] >= 0))
});

function validateRpcRequest(value, options = {}) {
  return core.validateRpcRequest(value, { methodPolicy: METHOD_POLICY, broadcastTxids: options.broadcastTxids });
}

function timingSafeToken(received, expected) {
  if (typeof received !== 'string' || !received.startsWith('Bearer ') ||
      typeof expected !== 'string' || !TOKEN.test(expected)) return false;
  const actualText = received.slice(7);
  if (!TOKEN.test(actualText)) return false;
  const actual = Buffer.from(actualText, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  try {
    return crypto.timingSafeEqual(actual, wanted);
  } finally {
    actual.fill(0);
    wanted.fill(0);
  }
}

function createFileTokenProvider(tokenFile) {
  if (!path.isAbsolute(tokenFile)) throw new Error('proxy token file must be absolute');
  const provider = () => {
    const value = readBoundedRegularFile(tokenFile, 256, 'proxy token');
    if (!TOKEN.test(value)) throw new Error('proxy token must be 256-bit lowercase hex');
    return value;
  };
  provider();
  return provider;
}

function createFileBroadcastAllowlistProvider(allowlistFile) {
  if (!path.isAbsolute(allowlistFile)) throw new Error('broadcast allowlist file must be absolute');
  const provider = () => {
    const value = JSON.parse(readBoundedRegularFile(allowlistFile, 65536, 'broadcast allowlist'));
    if (!value || value.kind !== BROADCAST_ALLOWLIST_KIND || !Array.isArray(value.txids) ||
        value.txids.length < 1 || value.txids.length > MAX_BROADCAST_ALLOWLIST_TXIDS ||
        !value.txids.every(txid => typeof txid === 'string' && TXID.test(txid)) ||
        new Set(value.txids).size !== value.txids.length) {
      throw new Error(`broadcast allowlist must be ${BROADCAST_ALLOWLIST_KIND} with 1..${MAX_BROADCAST_ALLOWLIST_TXIDS} unique txids`);
    }
    return new Set(value.txids);
  };
  provider();
  return provider;
}

function createReadonlyRpcProxy({
  cookiePath,
  token,
  tokenProvider,
  rpcPort = 48332,
  maxConcurrent = MAX_CONCURRENT_REQUESTS,
  maxRequestsPerMinute = MAX_AUTHENTICATED_REQUESTS_PER_MINUTE,
  now = Date.now,
  broadcastAllowlistProvider = null
}) {
  if (broadcastAllowlistProvider !== null && typeof broadcastAllowlistProvider !== 'function') {
    throw new Error('invalid read-only RPC proxy configuration');
  }
  const hasStaticToken = typeof token === 'string';
  const hasTokenProvider = typeof tokenProvider === 'function';
  if (!path.isAbsolute(cookiePath) || hasStaticToken === hasTokenProvider ||
      (hasStaticToken && !TOKEN.test(token))) {
    throw new Error('invalid read-only RPC proxy configuration');
  }
  const expectedToken = () => (hasTokenProvider ? tokenProvider() : token);
  const cookie = () => {
    const text = readBoundedRegularFile(cookiePath, 4096, 'Bitcoin Core cookie');
    if (!/^[^:\r\n]+:[^\r\n]+$/.test(text)) throw new Error('Bitcoin Core cookie is malformed');
    return text;
  };
  const proxy = core.createRpcProxy({
    methodPolicy: METHOD_POLICY,
    authorize: header => timingSafeToken(header, expectedToken()),
    cookie,
    rpcPort,
    broadcastTxids: broadcastAllowlistProvider,
    broadcastMode: broadcastAllowlistProvider ? 'allowlisted-txids-only' : false,
    maxConcurrent,
    maxRequestsPerMinute,
    now
  });
  return { ...proxy, methods: Object.freeze(Object.keys(METHOD_POLICY).sort()) };
}

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.find(argument => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

if (require.main === module) {
  try {
    const cookiePath = option('cookie', 'D:\\BitcoinTestnet\\testnet4\\.cookie');
    const tokenFile = option('token-file');
    const port = Number(option('port', '18444'));
    const rpcPort = Number(option('rpc-port', '48332'));
    if (!tokenFile || !path.isAbsolute(tokenFile) ||
        !Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error('--token-file must be absolute and --port must be in 1..65535');
    }
    const tokenProvider = createFileTokenProvider(tokenFile);
    const allowlistFile = option('broadcast-allowlist-file');
    const broadcastAllowlistProvider = allowlistFile ? createFileBroadcastAllowlistProvider(allowlistFile) : null;
    const proxy = createReadonlyRpcProxy({ cookiePath, tokenProvider, rpcPort, broadcastAllowlistProvider });
    proxy.server.listen(port, '127.0.0.1', () => {
      process.stdout.write(`${JSON.stringify({
        schema: 'utxoref_bitcoin_testnet4_readonly_rpc_proxy_v1',
        host: '127.0.0.1',
        port,
        methods: proxy.methods,
        maxRequestBytes: MAX_REQUEST_BYTES,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        maxConcurrentRequests: MAX_CONCURRENT_REQUESTS,
        maxAuthenticatedRequestsPerMinute: MAX_AUTHENTICATED_REQUESTS_PER_MINUTE,
        maxConnections: MAX_CONNECTIONS,
        tokenFormat: 'lowercase-hex-256-bit',
        tokenRevalidatedPerRequest: true,
        broadcastAllowed: broadcastAllowlistProvider ? 'allowlisted-txids-only' : false,
        walletRpcAllowed: false
      })}\n`);
    });
  } catch (error) {
    process.stderr.write(`read-only RPC proxy failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  METHOD_POLICY,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_CONCURRENT_REQUESTS,
  MAX_AUTHENTICATED_REQUESTS_PER_MINUTE,
  MAX_CONNECTIONS,
  BROADCAST_ALLOWLIST_KIND,
  createFileTokenProvider,
  createFileBroadcastAllowlistProvider,
  txidOfRawTransaction,
  validateRpcRequest,
  createReadonlyRpcProxy
};
