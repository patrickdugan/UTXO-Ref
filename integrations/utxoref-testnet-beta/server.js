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

function resolveRpc(env = process.env) {
  const datadir = path.resolve(env.BTCTEST_DATADIR || 'D:\\BitcoinTestnet');
  const cookie = readCookie(datadir);
  const rpcUrl = env.BTC_RPC_URL || 'http://127.0.0.1:48332';
  const rpcUser = env.BTC_RPC_USER || cookie?.user;
  const rpcPass = env.BTC_RPC_PASS || cookie?.pass;
  if (!rpcUser || !rpcPass) throw new Error('Bitcoin testnet4 RPC credentials are unavailable');
  return rpcFactory({ rpcUrl, rpcUser, rpcPass, requestId: 'utxoref-testnet-beta' });
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
  const bitcoin = new BitcoinBackend(resolveRpc(env), policy.wallet);
  const service = createBetaService({ policy, store, bitcoin });
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

module.exports = { readCookie, resolveRpc, recoverInterruptedRuns, start };
