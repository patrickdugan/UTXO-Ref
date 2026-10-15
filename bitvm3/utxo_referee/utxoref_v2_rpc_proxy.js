#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./utxoref_rpc_proxy_core');
const { METHOD_POLICY } = require('./btc_testnet4_readonly_rpc_proxy');
const { readJsonStrict } = require('./strict_artifact_ingress');
const { readJsonStrictProfile } = require('./strict_artifact_profiles');
const { settlementAllowlist } = require('./utxoref_v2_watchtower');

// The watcher's read and preflight calls, and nothing else. Broadcast is not a
// method here: sendrawtransaction is relayed only for the pinned settlements.
const WATCHER_METHOD_POLICY = Object.freeze({
  getblockchaininfo: METHOD_POLICY.getblockchaininfo,
  getblockhash: METHOD_POLICY.getblockhash,
  gettxout: METHOD_POLICY.gettxout,
  getrawtransaction: params => core.exactParams(params, 2) && core.TXID.test(params[0]) && params[1] === true,
  testmempoolaccept: METHOD_POLICY.testmempoolaccept
});
const ALLOWED_METHODS = new Set(Object.keys(WATCHER_METHOD_POLICY));

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

// Core's cookie, read through the same bounded regular-file check as the
// read-only proxy's.
function readCookie(datadir) {
  for (const candidate of [path.join(datadir, 'testnet4', '.cookie'), path.join(datadir, '.cookie')]) {
    if (!fs.existsSync(candidate)) continue;
    const text = core.readBoundedRegularFile(candidate, 4096, 'Bitcoin Core cookie');
    if (/^[^:\r\n]+:[^\r\n]+$/.test(text)) return text;
    throw new Error('Bitcoin Core cookie is malformed');
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

function validateRpcRequest(value, options = {}) {
  let broadcastTxids = null;
  try { broadcastTxids = typeof options.broadcastTxids === 'function' ? options.broadcastTxids() : null; } catch (_err) {}
  return core.validateRpcRequest(value, { methodPolicy: WATCHER_METHOD_POLICY, broadcastTxids });
}

function createProxy(options) {
  const datadir = path.resolve(options.datadir);
  const rpcPort = Number(new URL(options.rpcUrl || 'http://127.0.0.1:48332').port || 48332);
  const expectedUser = String(options.authUser || '');
  const expectedPass = String(options.authPass || '');
  if (!expectedUser || !expectedPass) throw new Error('proxy auth user and password are required');
  return core.createRpcProxy({
    methodPolicy: WATCHER_METHOD_POLICY,
    authorize: (header) => authorized(header, expectedUser, expectedPass),
    cookie: () => readCookie(datadir),
    rpcPort,
    broadcastTxids: options.broadcastTxids || null,
    broadcastMode: options.broadcastTxids ? 'pinned-settlements-only' : false
  }).server;
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
  validateRpcRequest,
  createSettlementBroadcastPolicy,
  createProxy
};
