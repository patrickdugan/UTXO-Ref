'use strict';

// The one local JSON-RPC relay behind every watcher-facing proxy. A proxy file
// supplies its method policy, its client authentication and its Core
// credential; everything else (loopback binding, body and response bounds,
// concurrency and rate limits, raw transaction txids, upstream error relay) is
// defined here once.

const crypto = require('crypto');
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
const MAX_RAW_TRANSACTION_HEX = 800000;
const BROADCAST_METHOD = 'sendrawtransaction';

function exactParams(params, length) {
  return Array.isArray(params) && params.length === length;
}

// The txid (non-witness serialization) of a raw transaction, with exact
// consumption and canonical compact sizes; throws on anything else.
function txidOfRawTransaction(hex) {
  if (typeof hex !== 'string' || hex.length > MAX_RAW_TRANSACTION_HEX || !HEX.test(hex)) {
    throw new Error('raw transaction must be bounded lowercase hex');
  }
  const bytes = Buffer.from(hex, 'hex');
  let offset = 0;
  const take = length => {
    if (offset + length > bytes.length) throw new Error('raw transaction is truncated');
    const slice = bytes.subarray(offset, offset + length);
    offset += length;
    return slice;
  };
  const compactSize = () => {
    const first = take(1)[0];
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const value = take(2).readUInt16LE(0);
      if (value < 0xfd) throw new Error('non-canonical compact size');
      return value;
    }
    if (first === 0xfe) {
      const value = take(4).readUInt32LE(0);
      if (value <= 0xffff) throw new Error('non-canonical compact size');
      return value;
    }
    throw new Error('compact size exceeds the raw transaction limit');
  };
  const version = take(4);
  let segwit = false;
  if (bytes[offset] === 0x00) {
    if (bytes[offset + 1] !== 0x01) throw new Error('invalid segwit marker');
    offset += 2;
    segwit = true;
  }
  const bodyStart = offset;
  const inputs = compactSize();
  if (inputs < 1) throw new Error('raw transaction has no inputs');
  for (let index = 0; index < inputs; index++) {
    take(36);
    take(compactSize());
    take(4);
  }
  const outputs = compactSize();
  if (outputs < 1) throw new Error('raw transaction has no outputs');
  for (let index = 0; index < outputs; index++) {
    take(8);
    take(compactSize());
  }
  const bodyEnd = offset;
  if (segwit) {
    let witnessItems = 0;
    for (let index = 0; index < inputs; index++) {
      const items = compactSize();
      witnessItems += items;
      for (let item = 0; item < items; item++) take(compactSize());
    }
    if (witnessItems === 0) throw new Error('segwit marker without witness data');
  }
  const locktime = take(4);
  if (offset !== bytes.length) throw new Error('raw transaction has trailing bytes');
  const stripped = Buffer.concat([version, bytes.subarray(bodyStart, bodyEnd), locktime]);
  const once = crypto.createHash('sha256').update(stripped).digest();
  return Buffer.from(crypto.createHash('sha256').update(once).digest()).reverse().toString('hex');
}

// Only a pinned txid may be broadcast, and only as the bare raw transaction.
function validateBroadcastRequest(params, broadcastTxids) {
  if (!exactParams(params, 1)) return { ok: false, code: -32602, message: 'parameters violate the read-only capability' };
  let txid;
  try { txid = txidOfRawTransaction(params[0]); } catch (_) {
    return { ok: false, code: -32602, message: 'raw transaction is malformed' };
  }
  if (!broadcastTxids.has(txid)) {
    return { ok: false, code: -32602, message: 'transaction is not on the broadcast allowlist' };
  }
  return { ok: true };
}

// Accepts JSON-RPC 1.0 (what the watchtower's RPC client sends) and 2.0. The
// method must be an own key of the policy: a prototype name such as
// "constructor" is not a method.
function validateRpcRequest(value, { methodPolicy, broadcastTxids = null }) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value.jsonrpc !== '2.0' && value.jsonrpc !== '1.0') ||
      (typeof value.id !== 'string' && !Number.isSafeInteger(value.id)) ||
      (typeof value.id === 'string' && (value.id.length < 1 || value.id.length > 64)) ||
      typeof value.method !== 'string' || !Array.isArray(value.params)) {
    return { ok: false, code: -32600, message: 'invalid bounded JSON-RPC request' };
  }
  const envelope = { jsonrpc: value.jsonrpc, id: value.id, method: value.method };
  if (value.method === BROADCAST_METHOD && broadcastTxids instanceof Set && broadcastTxids.size > 0) {
    const checked = validateBroadcastRequest(value.params, broadcastTxids);
    if (!checked.ok) return checked;
    return { ok: true, request: { ...envelope, params: [value.params[0]] } };
  }
  if (!Object.hasOwn(methodPolicy, value.method)) {
    return { ok: false, code: -32601, message: 'method is outside the read-only capability' };
  }
  if (!methodPolicy[value.method](value.params)) {
    return { ok: false, code: -32602, message: 'parameters violate the read-only capability' };
  }
  return { ok: true, request: { ...envelope, params: value.params } };
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

// Sends the request to the local Core. Core answers a failed call with an HTTP
// 500 whose body is still the JSON-RPC envelope with the reason, so that
// envelope is returned as it is; anything else is an upstream failure.
function forwardToCore({ rpcPort, cookie, request }) {
  const payload = Buffer.from(JSON.stringify(request), 'utf8');
  const isEnvelopeFor = (parsed) => parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
    parsed.id === request.id && (Object.hasOwn(parsed, 'result') || Object.hasOwn(parsed, 'error'));
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
      response.on('error', reject);
      response.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!isEnvelopeFor(parsed) || (response.statusCode !== 200 && !Object.hasOwn(parsed, 'error'))) {
            throw new Error(`Bitcoin Core returned HTTP ${response.statusCode}`);
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

function createRpcProxy({
  methodPolicy,
  authorize,
  cookie,
  rpcPort = 48332,
  broadcastTxids = null,
  broadcastMode = false,
  maxConcurrent = MAX_CONCURRENT_REQUESTS,
  maxRequestsPerMinute = MAX_AUTHENTICATED_REQUESTS_PER_MINUTE,
  now = Date.now
}) {
  if (!methodPolicy || typeof authorize !== 'function' || typeof cookie !== 'function' ||
      (broadcastTxids !== null && typeof broadcastTxids !== 'function') ||
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
  const broadcastAllowed = () => {
    try { return broadcastTxids(); } catch (_) { return null; }
  };
  let active = 0;
  const stats = { accepted: 0, denied: 0, failed: 0 };
  const server = http.createServer((incoming, outgoing) => {
    const send = (status, body) => {
      outgoing.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      outgoing.end(body);
    };
    if (!isLoopback(incoming.socket.remoteAddress)) {
      stats.denied++;
      send(403, jsonRpcError(null, -32001, 'proxy capability authentication failed'));
      return;
    }
    if (incoming.method === 'GET' && incoming.url === '/health') {
      send(200, Buffer.from(JSON.stringify({
        ok: true,
        allowedMethods: Object.keys(methodPolicy).sort(),
        broadcast: broadcastMode
      }), 'utf8'));
      return;
    }
    if (incoming.method !== 'POST' || incoming.url !== '/') {
      stats.denied++;
      send(403, jsonRpcError(null, -32001, 'proxy capability authentication failed'));
      return;
    }
    let authorized = false;
    try { authorized = authorize(incoming.headers.authorization) === true; } catch (_) { authorized = false; }
    if (!authorized) {
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
      let value = null;
      try {
        if (oversized || length < 1) {
          stats.denied++;
          send(413, jsonRpcError(null, -32600, 'request exceeds proxy limit'));
          return;
        }
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch (_) {
          stats.denied++;
          send(400, jsonRpcError(null, -32700, 'invalid JSON'));
          return;
        }
        const validated = validateRpcRequest(value, {
          methodPolicy,
          broadcastTxids: broadcastTxids && value && value.method === BROADCAST_METHOD ? broadcastAllowed() : null
        });
        if (!validated.ok) {
          stats.denied++;
          send(400, jsonRpcError(value && value.id, validated.code, validated.message));
          return;
        }
        const response = await forwardToCore({ rpcPort, cookie: cookie(), request: validated.request });
        stats.accepted++;
        send(200, response);
      } catch (_) {
        stats.failed++;
        send(502, jsonRpcError(value && value.id, -32003, 'upstream RPC failed'));
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
  return { server, stats };
}

module.exports = {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_CONCURRENT_REQUESTS,
  MAX_AUTHENTICATED_REQUESTS_PER_MINUTE,
  MAX_CONNECTIONS,
  exactParams,
  txidOfRawTransaction,
  validateRpcRequest,
  readBoundedRegularFile,
  createRpcProxy,
  TXID
};
