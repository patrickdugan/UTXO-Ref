const path = require('path');
const os = require('os');

const nostr = require('../nostr_agent');
const { STORE_BACKENDS, createControlPlaneStore } = require('./store');
const { syncThreadToControlPlane } = require('./workflow');
const { runSignerDaemonOnce } = require('./signer_daemon');
const { createNodeRpcClient, createRpcBroadcaster } = require('./rpc_broadcaster');

function parseBoolean(value, fallback = false) {
  if (value == null) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

function parseInteger(value, fallback, label) {
  if (value == null || String(value).trim() === '') {
    return fallback;
  }
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return normalized;
}

function defaultWorkerId() {
  return `worker:${os.hostname()}:${process.pid}`;
}

function loadWorkerConfig(env = process.env) {
  const dataDir = env.CIVKIT_CONTROL_DATA_DIR || path.join(__dirname, 'artifacts', 'runtime');
  const rpcUrl = env.CIVKIT_RPC_URL || env.LTC_RPC_URL || null;
  const rpcUser = env.CIVKIT_RPC_USER || env.LTC_RPC_USER || null;
  const rpcPass = env.CIVKIT_RPC_PASS || env.LTC_RPC_PASS || null;
  const postgresUrl = env.CIVKIT_CONTROL_POSTGRES_URL || env.DATABASE_URL || null;

  return {
    dataDir,
    storeBackend: env.CIVKIT_CONTROL_STORE_BACKEND || STORE_BACKENDS.leveldb,
    casesPath: env.CIVKIT_CONTROL_CASES_PATH || path.join(dataDir, 'cases.json'),
    jobsPath: env.CIVKIT_CONTROL_JOBS_PATH || path.join(dataDir, 'jobs.json'),
    auditPath: env.CIVKIT_CONTROL_AUDIT_PATH || path.join(dataDir, 'audit.json'),
    dbPath: env.CIVKIT_CONTROL_DB_PATH || path.join(dataDir, 'control-plane.db'),
    postgresUrl,
    postgresSchema: env.CIVKIT_CONTROL_POSTGRES_SCHEMA || 'public',
    eventsPath: env.CIVKIT_NOSTR_EVENTS_PATH || path.join(__dirname, '..', 'nostr_agent', 'artifacts', 'runtime_events.jsonl'),
    relayStatePath: env.CIVKIT_NOSTR_RELAY_STATE_PATH || path.join(dataDir, 'relay_state.json'),
    buyerPrivateKeyHex: env.CIVKIT_BUYER_PRIVATE_KEY_HEX || null,
    sellerPrivateKeyHex: env.CIVKIT_SELLER_PRIVATE_KEY_HEX || null,
    notaryPrivateKeyHex: env.CIVKIT_NOTARY_PRIVATE_KEY_HEX || null,
    network: env.CIVKIT_NETWORK || null,
    rpcUrl,
    rpcUser,
    rpcPass,
    rpcWallet: env.CIVKIT_RPC_WALLET || env.LTC_WALLET || null,
    broadcastMode: env.CIVKIT_BROADCAST_MODE || ((rpcUrl && rpcUser && rpcPass) ? 'rpc' : 'dry_run'),
    workerId: env.CIVKIT_CONTROL_WORKER_ID || defaultWorkerId(),
    once: parseBoolean(env.CIVKIT_CONTROL_ONCE, false),
    pollIntervalMs: parseInteger(env.CIVKIT_CONTROL_POLL_INTERVAL_MS, 5000, 'CIVKIT_CONTROL_POLL_INTERVAL_MS'),
    limit: parseInteger(env.CIVKIT_CONTROL_JOB_LIMIT, 10, 'CIVKIT_CONTROL_JOB_LIMIT'),
    leaseMs: parseInteger(env.CIVKIT_CONTROL_LEASE_MS, 30000, 'CIVKIT_CONTROL_LEASE_MS')
  };
}

function createWorkerContext(config) {
  const controlStore = createControlPlaneStore({
    backend: config.storeBackend,
    connectionString: config.postgresUrl,
    schema: config.postgresSchema,
    dbPath: config.dbPath,
    casesPath: config.casesPath,
    jobsPath: config.jobsPath,
    auditPath: config.auditPath
  });
  const eventStore = new nostr.LocalEventStore({
    eventsPath: config.eventsPath,
    relayStatePath: config.relayStatePath
  });

  let broadcaster = null;
  if (String(config.broadcastMode).toLowerCase() === 'rpc') {
    if (!config.rpcUrl || !config.rpcUser || !config.rpcPass) {
      throw new Error('rpc broadcast mode requires CIVKIT_RPC_URL, CIVKIT_RPC_USER, and CIVKIT_RPC_PASS');
    }
    const rpc = createNodeRpcClient({
      rpcUrl: config.rpcUrl,
      rpcUser: config.rpcUser,
      rpcPass: config.rpcPass,
      wallet: config.rpcWallet,
      requestIdPrefix: 'civkit-worker'
    });
    broadcaster = createRpcBroadcaster({ rpc });
  }

  return {
    config,
    controlStore,
    eventStore,
    broadcaster
  };
}

function extractThreadIds(events) {
  const ids = new Set();
  for (const event of events) {
    const tags = Array.isArray(event?.tags) ? event.tags : [];
    const threadTag = tags.find((tag) => Array.isArray(tag) && tag[0] === 'd' && tag[1]);
    if (threadTag) {
      ids.add(String(threadTag[1]));
    }
  }
  return Array.from(ids);
}

async function syncKnownThreads({
  controlStore,
  eventStore,
  nowMs = Date.now()
}) {
  const threadIds = extractThreadIds(eventStore.readAll());
  const results = [];
  for (const threadId of threadIds) {
    results.push(await syncThreadToControlPlane({
      threadId,
      events: eventStore.listThread(threadId),
      store: controlStore,
      nowMs
    }));
  }
  return results;
}

async function runControlPlaneWorkerOnce(contextLike) {
  const context = contextLike.controlStore ? contextLike : createWorkerContext(contextLike);
  const keyring = {
    buyerPrivateKeyHex: context.config.buyerPrivateKeyHex,
    sellerPrivateKeyHex: context.config.sellerPrivateKeyHex,
    notaryPrivateKeyHex: context.config.notaryPrivateKeyHex
  };
  const nowMs = Date.now();
  const syncResults = await syncKnownThreads({
    controlStore: context.controlStore,
    eventStore: context.eventStore,
    nowMs
  });
  const signerResults = await runSignerDaemonOnce({
    controlStore: context.controlStore,
    eventStore: context.eventStore,
    keyring,
    broadcaster: context.broadcaster || undefined,
    nowMs,
    limit: context.config.limit,
    leaseMs: context.config.leaseMs,
    network: context.config.network,
    workerId: context.config.workerId
  });

  return {
    syncedThreads: syncResults.map((result) => result.caseRecord.threadId),
    syncResults,
    signerResults
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runControlPlaneWorkerLoop(contextLike) {
  const context = contextLike.controlStore ? contextLike : createWorkerContext(contextLike);
  try {
    do {
      const iteration = await runControlPlaneWorkerOnce(context);
      if (context.config.once) {
        return iteration;
      }
      await sleep(context.config.pollIntervalMs);
    } while (true);
  } finally {
    if (typeof context.controlStore.close === 'function') {
      await context.controlStore.close();
    }
  }
}

async function main() {
  const config = loadWorkerConfig(process.env);
  const result = await runControlPlaneWorkerLoop(config);
  const signerActions = (result?.signerResults?.results || []).map((entry) => entry.action);
  console.log(JSON.stringify({
    mode: config.broadcastMode,
    storeBackend: config.storeBackend,
    workerId: config.workerId,
    syncedThreads: result.syncedThreads,
    signerActions
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Control plane worker failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  loadWorkerConfig,
  createWorkerContext,
  extractThreadIds,
  syncKnownThreads,
  runControlPlaneWorkerOnce,
  runControlPlaneWorkerLoop,
  defaultWorkerId
};
