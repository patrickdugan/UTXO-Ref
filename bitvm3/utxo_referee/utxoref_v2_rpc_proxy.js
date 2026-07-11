#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');

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

function createProxy(options) {
  const datadir = path.resolve(options.datadir);
  const rpcUrl = options.rpcUrl || 'http://127.0.0.1:48332';
  const expectedUser = String(options.authUser || '');
  const expectedPass = String(options.authPass || '');
  if (!expectedUser || !expectedPass) throw new Error('proxy auth user and password are required');

  return http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { ok: true, allowedMethods: [...ALLOWED_METHODS] });
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
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        request.destroy(new Error('request too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', () => {});
    request.on('end', async () => {
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (_err) { sendJson(response, 400, { error: 'invalid JSON-RPC request' }); return; }
      if (!ALLOWED_METHODS.has(payload.method) || !Array.isArray(payload.params || [])) {
        sendJson(response, 403, { error: 'RPC method is not permitted' });
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
  return 'Usage: node utxoref_v2_rpc_proxy.js --datadir D:\\BitcoinTestnet --port 48334';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  const server = createProxy({
    datadir: args.datadir || process.env.BTCTEST_DATADIR || 'D:\\BitcoinTestnet',
    rpcUrl: args.rpcUrl || process.env.BTC_CORE_RPC_URL || 'http://127.0.0.1:48332',
    authUser: process.env.UTXOREF_WATCHTOWER_PROXY_USER,
    authPass: process.env.UTXOREF_WATCHTOWER_PROXY_PASS
  });
  const host = args.host || '127.0.0.1';
  const port = Number(args.port || 48434);
  server.listen(port, host, () => console.log(`UTXORef V2 RPC proxy listening on ${host}:${port}`));
}

if (require.main === module) main();

module.exports = { ALLOWED_METHODS, parseArgs, readCookie, authorized, createProxy };
