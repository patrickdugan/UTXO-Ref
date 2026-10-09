#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const { txidOfRawTransaction } = require('./btc_testnet4_readonly_rpc_proxy');
const { readJsonStrict } = require('./strict_artifact_ingress');
const { readJsonStrictProfile } = require('./strict_artifact_profiles');
const { settlementAllowlist } = require('./utxoref_v2_watchtower');

const ALLOWED_METHODS = new Set([
  'getblockchaininfo',
  'getblockhash',
  'gettxout',
  'testmempoolaccept'
]);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    args[key] = value;
  }
  return args;
}

function readCookie(datadir) {
  for (const candidate of [path.join(datadir, 'testnet4', '.cookie'), path.join(datadir, '.cookie')]) {
    if (!fs.existsSync(candidate)) continue;
    const text = fs.readFileSync(candidate, 'utf8').trim();
    const separator = text.indexOf(':');
    if (separator > 0) return { user: text.slice(0, separator), pass: text.slice(separator + 1) };
  }
  throw new Error('Bitcoin Core RPC cookie is unavailable');
}

function authorized(header, expectedUser, expectedPass) {
  if (!header || !header.startsWith('Basic ')) return false;
  let received;
  try { received = Buffer.from(header.slice(6), 'base64').toString('utf8'); }
  catch (_err) { return false; }
  const expected = Buffer.from(`${expectedUser}:${expectedPass}`, 'utf8');
  const actual = Buffer.from(received, 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function sendJson(response, statusCode, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': encoded.length });
  response.end(encoded);
}

// WT-2: the transactions this proxy may relay are derived on this host from
// the pinned trust policy and the public artifacts: only the committed
// settlement of a graph that verifies against the policy, is honest and is
// predicate-bound (the watchtower's settlementAllowlist rules). Nothing the
// remote watchtower sends can widen it. Re-derived when a file changes.
function createSettlementBroadcastPolicy({ artifactPaths, trustPolicyPath, log = () => {} }) {
  if (!Array.isArray(artifactPaths) || artifactPaths.length < 1 || !trustPolicyPath) {
    throw new Error('settlement broadcast needs --settlement-artifact and --trust-policy');
  }
  const files = [trustPolicyPath, ...artifactPaths].map((file) => path.resolve(file));
  let cache = null;
  const policy = () => {
    let key;
    try {
      key = files.map((file) => { const stat = fs.statSync(file); return `${file}:${stat.size}:${stat.mtimeMs}`; }).join('|');
    } catch (err) {
      log(`settlement broadcast policy unavailable: ${err.message}`);
      return new Set();
    }
    if (cache && cache.key === key) return cache.txids;
    const txids = new Set();
    const refused = [];
    try {
      const trustPolicy = readJsonStrict(files[0], 'pinned UTXORef V2 trust policy', { maxBytes: 1024 * 1024 });
      for (const artifactPath of files.slice(1)) {
        try {
          const artifact = readJsonStrictProfile(artifactPath, 'utxoref-v2-public-artifact', 'settlement artifact');
          for (const txid of settlementAllowlist(artifact, trustPolicy).txids) txids.add(txid);
        } catch (err) {
          refused.push({ artifactPath, reason: err.message });
        }
      }
    } catch (err) {
      refused.push({ artifactPath: files[0], reason: err.message });
    }
    for (const entry of refused) log(`not relaying the settlement of ${entry.artifactPath}: ${entry.reason}`);
    cache = { key, txids, refused };
    return txids;
  };
  policy.describe = () => (cache ? { txids: [...cache.txids], refused: cache.refused } : null);
  return policy;
}

function validateBroadcastPayload(params, broadcastTxids) {
  if (params.length !== 1 || typeof params[0] !== 'string') {
    return { ok: false, statusCode: 403, error: 'only an exact pinned settlement transaction may be broadcast' };
  }
  let txid;
  try { txid = txidOfRawTransaction(params[0]); } catch (_err) {
    return { ok: false, statusCode: 400, error: 'raw transaction is malformed' };
  }
  let allowed;
  try { allowed = broadcastTxids(); } catch (_err) { allowed = new Set(); }
  if (!allowed.has(txid)) return { ok: false, statusCode: 403, error: 'transaction is not a pinned settlement' };
  return { ok: true };
}

function validateRpcPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, statusCode: 400, error: 'invalid JSON-RPC request' };
  }
  if (typeof payload.method !== 'string' || !Array.isArray(payload.params || [])) {
    return { ok: false, statusCode: 400, error: 'invalid JSON-RPC request' };
  }
  if (payload.method === 'sendrawtransaction' && typeof options.broadcastTxids === 'function') {
    return validateBroadcastPayload(payload.params || [], options.broadcastTxids);
  }
  if (!ALLOWED_METHODS.has(payload.method)) {
    return { ok: false, statusCode: 403, error: 'RPC method is not permitted' };
  }
  return { ok: true };
}

function createProxy(options) {
  const datadir = path.resolve(options.datadir);
  const rpcUrl = options.rpcUrl || 'http://127.0.0.1:48332';
  const expectedUser = String(options.authUser || '');
  const expectedPass = String(options.authPass || '');
  if (!expectedUser || !expectedPass) throw new Error('proxy auth user and password are required');

  return http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, {
        ok: true,
        allowedMethods: [...ALLOWED_METHODS],
        broadcast: options.broadcastTxids ? 'pinned-settlements-only' : false
      });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/') {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    if (!authorized(request.headers.authorization, expectedUser, expectedPass)) {
      response.setHeader('WWW-Authenticate', 'Basic realm="utxoref-watchtower"');
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > 1024 * 1024) {
        tooLarge = true;
        sendJson(response, 413, { error: 'request too large' });
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', () => {});
    request.on('end', async () => {
      if (tooLarge) return;
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (_err) { sendJson(response, 400, { error: 'invalid JSON-RPC request' }); return; }
      const validation = validateRpcPayload(payload, { broadcastTxids: options.broadcastTxids });
      if (!validation.ok) {
        sendJson(response, validation.statusCode, { error: validation.error });
        return;
      }
      try {
        const cookie = readCookie(datadir);
        const rpc = rpcFactory({ rpcUrl, rpcUser: cookie.user, rpcPass: cookie.pass, requestId: 'utxoref-v2-watchtower-proxy' });
        const result = await rpc(payload.method, payload.params);
        sendJson(response, 200, { result, error: null, id: payload.id ?? null });
      } catch (err) {
        sendJson(response, 502, { result: null, error: { message: err.message }, id: payload.id ?? null });
      }
    });
  });
}

function usage() {
  return [
    'Usage: node utxoref_v2_rpc_proxy.js --datadir D:\\BitcoinTestnet --port 48334',
    '  [--settlement-artifact <artifact.json>[,<artifact.json>...] --trust-policy <policy.json>]',
    'With the settlement options, sendrawtransaction is relayed only for the committed',
    'settlement of a pinned, honest, predicate-bound graph.'
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  if (Boolean(args.settlementArtifact) !== Boolean(args.trustPolicy)) {
    throw new Error('--settlement-artifact and --trust-policy go together');
  }
  const broadcastTxids = args.settlementArtifact
    ? createSettlementBroadcastPolicy({
      artifactPaths: args.settlementArtifact.split(',').map((item) => item.trim()).filter(Boolean),
      trustPolicyPath: args.trustPolicy,
      log: (message) => console.error(`[utxoref-v2-rpc-proxy] ${message}`)
    })
    : null;
  const server = createProxy({
    broadcastTxids,
    datadir: args.datadir || process.env.BTCTEST_DATADIR || 'D:\\BitcoinTestnet',
    rpcUrl: args.rpcUrl || process.env.BTC_CORE_RPC_URL || 'http://127.0.0.1:48332',
    authUser: process.env.UTXOREF_WATCHTOWER_PROXY_USER,
    authPass: process.env.UTXOREF_WATCHTOWER_PROXY_PASS
  });
  const host = args.host || '127.0.0.1';
  const port = Number(args.port || 48434);
  server.listen(port, host, () => console.log(`UTXORef V2 RPC proxy listening on ${host}:${port}` +
    (broadcastTxids ? ' (relays pinned settlements only)' : ' (no broadcast)')));
}

if (require.main === module) main();

module.exports = {
  ALLOWED_METHODS,
  parseArgs,
  readCookie,
  authorized,
  validateRpcPayload,
  createSettlementBroadcastPolicy,
  createProxy
};
