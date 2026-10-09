#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { rpcFactory } = require('../../bitvm3/utxo_referee/tradelayer_send_rpc_sweep');
const { loadPolicy } = require('./betaPolicy');
const { StateStore } = require('./betaStore');
const { BitcoinBackend } = require('./bitcoinBackend');
const { createBetaService } = require('./betaService');

function readCookie(datadir) {
  const candidates = [
    path.join(datadir, 'testnet4', '.cookie'),
    path.join(datadir, '.cookie')
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const text = fs.readFileSync(candidate, 'utf8').trim();
    const split = text.indexOf(':');
    if (split > 0) return { user: text.slice(0, split), pass: text.slice(split + 1) };
  }
  return null;
}

// BETA-2: the service calls exactly these Core methods. Its RPC user should be
// an rpcauth user restricted to them with rpcwhitelist, never the datadir
// cookie, which grants every method (including wallet export and node stop).
const SERVICE_RPC_METHODS = Object.freeze([
  'getblockchaininfo', 'getbalances', 'validateaddress', 'sendtoaddress', 'gettxout', 'listtransactions'
]);

function resolveRpcCredentials(env = process.env) {
  if (env.BTC_RPC_USER || env.BTC_RPC_PASS) {
    if (!env.BTC_RPC_USER || !env.BTC_RPC_PASS) throw new Error('BTC_RPC_USER and BTC_RPC_PASS must be set together');
    return { rpcUser: env.BTC_RPC_USER, rpcPass: env.BTC_RPC_PASS, source: 'rpcauth' };
  }
  const datadir = path.resolve(env.BTCTEST_DATADIR || 'D:\\BitcoinTestnet');
  const cookie = readCookie(datadir);
  if (!cookie) throw new Error('Bitcoin testnet4 RPC credentials are unavailable');
  if (env.BETA_ALLOW_COOKIE_RPC !== '1') {
    throw new Error('refusing Core cookie authentication: it grants every RPC method. Configure an rpcauth user ' +
      `restricted with rpcwhitelist=<user>:${SERVICE_RPC_METHODS.join(',')} and set BTC_RPC_USER/BTC_RPC_PASS, ` +
      'or set BETA_ALLOW_COOKIE_RPC=1 for a disposable local node');
  }
  return { rpcUser: cookie.user, rpcPass: cookie.pass, source: 'cookie' };
}

function resolveRpc(env = process.env) {
  const rpcUrl = env.BTC_RPC_URL || 'http://127.0.0.1:48332';
  const { rpcUser, rpcPass } = resolveRpcCredentials(env);
  return rpcFactory({ rpcUrl, rpcUser, rpcPass, requestId: 'utxoref-testnet-beta' });
}

// Startup self-check for rpcauth credentials: a harmless method outside the
// service's set must be refused by Core (HTTP 403 under rpcwhitelist).
async function assertRestrictedRpc(rpc) {
  try {
    await rpc('uptime');
  } catch (error) {
    if (/HTTP 403/.test(error.message)) return true;
    throw new Error(`could not confirm the RPC user's method whitelist: ${error.message}`);
  }
  throw new Error('the configured RPC user is not restricted by rpcwhitelist (uptime was allowed); refusing to start');
}

function recoverInterruptedRuns(state, recoveredAt = new Date().toISOString()) {
  let count = 0;
  for (const run of Object.values(state.stressRuns)) {
    if (run.status !== 'running') continue;
    run.status = 'failed';
    run.errorCode = 'service_restarted';
    run.updatedAt = recoveredAt;
    count += 1;
  }
  return count;
}

async function start(env = process.env) {
  const policy = loadPolicy(env);
  if (policy.host !== '127.0.0.1' && policy.host !== '::1' && !env.BETA_PUBLIC_ORIGIN) {
    throw new Error('remote binding requires BETA_PUBLIC_ORIGIN and a TLS reverse proxy');
  }
  const store = new StateStore(policy.statePath);
  await store.transact((state) => recoverInterruptedRuns(state));
  const rpc = resolveRpc(env);
  if (resolveRpcCredentials(env).source === 'rpcauth') await assertRestrictedRpc(rpc);
  const bitcoin = new BitcoinBackend(rpc, policy.wallet);
  const service = createBetaService({ policy, store, bitcoin });
  // BETA-1: counters from before the rate-limit file now live there.
  if (Object.keys(store.read().rateLimits).length > 0) {
    await store.transact((state) => { state.rateLimits = {}; });
  }
  const server = service.createServer();
  server.listen(policy.port, policy.host, () => {
    console.log(JSON.stringify({
      service: policy.serviceName,
      url: `http://${policy.host}:${policy.port}${policy.basePath || ''}/`,
      chain: policy.chain,
      wallet: policy.wallet,
      statePath: policy.statePath
    }));
  });
  const shutdown = (signal) => {
    console.log(JSON.stringify({ service: policy.serviceName, signal, stopping: true }));
    server.close((err) => process.exit(err ? 1 : 0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.error(`UTXORef beta service failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  SERVICE_RPC_METHODS,
  readCookie,
  resolveRpcCredentials,
  resolveRpc,
  assertRestrictedRpc,
  recoverInterruptedRuns,
  start
};
