#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const MAX_REQUEST_BYTES = 1048576;
const MAX_RESPONSE_BYTES = 4194304;
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_AUTHENTICATED_REQUESTS_PER_MINUTE = 120;
const MAX_CONNECTIONS = 16;
const UPSTREAM_TIMEOUT_MS = 10000;
const TXID = /^[0-9a-f]{64}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;
const TOKEN = /^[0-9a-f]{64}$/;

function exactParams(params, length) {
  return Array.isArray(params) && params.length === length;
}

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

function validateRpcRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.jsonrpc !== '2.0' ||
      (typeof value.id !== 'string' && !Number.isSafeInteger(value.id)) ||
      (typeof value.id === 'string' && (value.id.length < 1 || value.id.length > 64)) ||
      typeof value.method !== 'string' || !Array.isArray(value.params)) {
    return { ok: false, code: -32600, message: 'invalid bounded JSON-RPC request' };
  }
  const validator = METHOD_POLICY[value.method];
  if (!validator) return { ok: false, code: -32601, message: 'method is outside the read-only capability' };
  if (!validator(value.params)) return { ok: false, code: -32602, message: 'parameters violate the read-only capability' };
  return { ok: true, request: { jsonrpc: '2.0', id: value.id, method: value.method, params: value.params } };
}

function jsonRpcError(id, code, message) {
  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), 'utf8');
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function readBoundedRegularFile(filePath, maximumBytes, label) {
  const metadata = fs.lstatSync(filePath, { bigint: true });
  const resolved = path.resolve(filePath);
  const real = fs.realpathSync.native(filePath);
  const samePath = process.platform === 'win32'
    ? resolved.toLowerCase() === real.toLowerCase()
    : resolved === real;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n ||
      metadata.size < 1n || metadata.size > BigInt(maximumBytes) ||
      !samePath) {
    throw new Error(`${label} must be a bounded regular non-linked file`);
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== metadata.dev ||
        opened.ino !== metadata.ino || opened.size !== metadata.size ||
        opened.mtimeNs !== metadata.mtimeNs || opened.ctimeNs !== metadata.ctimeNs) {
      throw new Error(`${label} identity changed while opening`);
    }
    bytes = fs.readFileSync(descriptor);
    if (BigInt(bytes.length) !== opened.size) throw new Error(`${label} changed while reading`);
    return bytes.toString('utf8').trim();
  } finally {
    if (bytes) bytes.fill(0);
    fs.closeSync(descriptor);
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

function timingSafeToken(received, expected) {
  if (typeof received !== 'string' || !received.startsWith('Bearer ') ||
      typeof expected !== 'string' || !TOKEN.test(expected)) return false;
  const actualText = received.slice(7);
  if (!TOKEN.test(actualText)) return false;
  const actual = Buffer.from(actualText, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  try {
    return require('crypto').timingSafeEqual(actual, wanted);
  } finally {
    actual.fill(0);
    wanted.fill(0);
  }
}

function forwardToCore({ rpcPort, cookie, request }) {
  const payload = Buffer.from(JSON.stringify(request), 'utf8');
  return new Promise((resolve, reject) => {
    const upstream = http.request({
      host: '127.0.0.1',
      port: rpcPort,
      method: 'POST',
      path: '/',
      headers: {
        Authorization: `Basic ${Buffer.from(cookie, 'utf8').toString('base64')}`,
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      },
      timeout: UPSTREAM_TIMEOUT_MS
    }, response => {
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('Bitcoin Core response exceeds proxy limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`Bitcoin Core returned HTTP ${response.statusCode}`));
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.id !== request.id ||
              parsed.jsonrpc !== '2.0' || (!Object.hasOwn(parsed, 'result') && !Object.hasOwn(parsed, 'error'))) {
            throw new Error('Bitcoin Core returned an invalid JSON-RPC envelope');
          }
          resolve(Buffer.from(JSON.stringify(parsed), 'utf8'));
        } catch (error) {
          reject(error);
        }
      });
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Bitcoin Core RPC timed out')));
    upstream.on('error', reject);
    upstream.end(payload);
  });
}

function createReadonlyRpcProxy({
  cookiePath,
  token,
  tokenProvider,
  rpcPort = 48332,
  maxConcurrent = MAX_CONCURRENT_REQUESTS,
  maxRequestsPerMinute = MAX_AUTHENTICATED_REQUESTS_PER_MINUTE,
  now = Date.now
}) {
  const hasStaticToken = typeof token === 'string';
  const hasTokenProvider = typeof tokenProvider === 'function';
  if (!path.isAbsolute(cookiePath) || hasStaticToken === hasTokenProvider ||
      (hasStaticToken && !TOKEN.test(token)) ||
      !Number.isSafeInteger(rpcPort) || rpcPort < 1 || rpcPort > 65535 ||
      !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > MAX_CONNECTIONS ||
      !Number.isSafeInteger(maxRequestsPerMinute) || maxRequestsPerMinute < 1 || maxRequestsPerMinute > 3600 ||
      typeof now !== 'function') {
    throw new Error('invalid read-only RPC proxy configuration');
  }
  let lastRefillMs = Number(now());
  if (!Number.isFinite(lastRefillMs)) throw new Error('invalid read-only RPC proxy clock');
  let requestTokens = maxRequestsPerMinute;
  const consumeRequestToken = () => {
    const currentMs = Number(now());
    if (!Number.isFinite(currentMs)) return false;
    const elapsedMs = Math.max(0, currentMs - lastRefillMs);
    requestTokens = Math.min(
      maxRequestsPerMinute,
      requestTokens + elapsedMs * maxRequestsPerMinute / 60000
    );
    if (currentMs > lastRefillMs) lastRefillMs = currentMs;
    if (requestTokens < 1) return false;
    requestTokens -= 1;
    return true;
  };
  let active = 0;
  const stats = { accepted: 0, denied: 0, failed: 0 };
  const server = http.createServer((incoming, outgoing) => {
    const send = (status, body) => {
      outgoing.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      outgoing.end(body);
    };
    if (!isLoopback(incoming.socket.remoteAddress) || incoming.method !== 'POST' || incoming.url !== '/') {
      stats.denied++;
      send(403, jsonRpcError(null, -32001, 'proxy capability authentication failed'));
      return;
    }
    let expectedToken;
    try {
      expectedToken = hasTokenProvider ? tokenProvider() : token;
    } catch (_) {
      expectedToken = null;
    }
    if (!timingSafeToken(incoming.headers.authorization, expectedToken)) {
      stats.denied++;
      send(403, jsonRpcError(null, -32001, 'proxy capability authentication failed'));
      return;
    }
    if (!consumeRequestToken()) {
      stats.denied++;
      send(429, jsonRpcError(null, -32004, 'proxy authenticated request rate exceeded'));
      return;
    }
    if (active >= maxConcurrent) {
      stats.denied++;
      send(429, jsonRpcError(null, -32002, 'proxy concurrency limit reached'));
      return;
    }
    active++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active--;
      }
    };
    incoming.once('aborted', release);
    incoming.once('error', release);
    const chunks = [];
    let length = 0;
    let oversized = false;
    incoming.on('data', chunk => {
      length += chunk.length;
      if (length > MAX_REQUEST_BYTES) {
        oversized = true;
        return;
      }
      chunks.push(chunk);
    });
    incoming.on('end', async () => {
      try {
        if (oversized || length < 1) {
          stats.denied++;
          send(413, jsonRpcError(null, -32600, 'request exceeds proxy limit'));
          return;
        }
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch (_) {
          stats.denied++;
          send(400, jsonRpcError(null, -32700, 'invalid JSON'));
          return;
        }
        const validated = validateRpcRequest(value);
        if (!validated.ok) {
          stats.denied++;
          send(400, jsonRpcError(value && value.id, validated.code, validated.message));
          return;
        }
        const cookie = readBoundedRegularFile(cookiePath, 4096, 'Bitcoin Core cookie');
        if (!/^[^:\r\n]+:[^\r\n]+$/.test(cookie)) throw new Error('Bitcoin Core cookie is malformed');
        const response = await forwardToCore({ rpcPort, cookie, request: validated.request });
        stats.accepted++;
        send(200, response);
      } catch (_) {
        stats.failed++;
        send(502, jsonRpcError(null, -32003, 'read-only upstream RPC failed'));
      } finally {
        release();
      }
    });
  });
  server.requestTimeout = UPSTREAM_TIMEOUT_MS + 2000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = MAX_CONNECTIONS;
  return { server, stats, methods: Object.freeze(Object.keys(METHOD_POLICY).sort()) };
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
    const proxy = createReadonlyRpcProxy({ cookiePath, tokenProvider, rpcPort });
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
        broadcastAllowed: false,
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
  createFileTokenProvider,
  validateRpcRequest,
  createReadonlyRpcProxy
};
