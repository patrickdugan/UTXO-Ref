const path = require('path');

function integer(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer in ${minimum}..${maximum}`);
  }
  return parsed;
}

function basePath(value) {
  const normalized = String(value || '').trim().replace(/\/$/, '');
  if (normalized === '') return '';
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(normalized)) {
    throw new Error('BETA_BASE_PATH must be empty or an absolute URL path without a trailing slash');
  }
  return normalized;
}

function loadPolicy(env = process.env) {
  const root = path.join(__dirname, '..', '..');
  return {
    serviceName: 'utxoref-testnet-beta',
    chain: 'testnet4',
    host: env.BETA_BIND_HOST || '127.0.0.1',
    port: integer(env.PORT, 8790, 1, 65535, 'PORT'),
    basePath: basePath(env.BETA_BASE_PATH),
    wallet: env.BTC_WALLET || 'utxoref-testnet',
    statePath: path.resolve(env.BETA_STATE_PATH || path.join(__dirname, 'runtime', 'state.json')),
    artifactPath: path.resolve(env.BETA_ARTIFACT_PATH || path.join(root, 'bitvm3', 'utxo_referee', 'artifacts', 'live', 'btc_testnet4_utxoref_v2_latest.json')),
    trustPolicyPath: path.resolve(env.BETA_TRUST_POLICY_PATH || path.join(root, 'bitvm3', 'utxo_referee', 'artifacts', 'live', 'utxoref_v2_watchtower_trust_policy.json')),
    faucetAmountSats: integer(env.BETA_FAUCET_AMOUNT_SATS, 1000, 330, 100000, 'BETA_FAUCET_AMOUNT_SATS'),
    walletReserveFloorSats: integer(env.BETA_WALLET_RESERVE_FLOOR_SATS, 250000, 0, 2100000000000000, 'BETA_WALLET_RESERVE_FLOOR_SATS'),
    dailyBudgetSats: integer(env.BETA_DAILY_BUDGET_SATS, 50000, 330, 10000000, 'BETA_DAILY_BUDGET_SATS'),
    feeBufferSats: integer(env.BETA_FEE_BUFFER_SATS, 1000, 0, 100000, 'BETA_FEE_BUFFER_SATS'),
    ipClaimsPerDay: integer(env.BETA_IP_CLAIMS_PER_DAY, 1, 1, 20, 'BETA_IP_CLAIMS_PER_DAY'),
    addressClaimsTotal: integer(env.BETA_ADDRESS_CLAIMS_TOTAL, 1, 1, 20, 'BETA_ADDRESS_CLAIMS_TOTAL'),
    postRequestsPerMinute: integer(env.BETA_POSTS_PER_MINUTE, 20, 1, 1000, 'BETA_POSTS_PER_MINUTE'),
    postRequestsPerHour: integer(env.BETA_POSTS_PER_HOUR, 100, 1, 10000, 'BETA_POSTS_PER_HOUR'),
    maxStressIterations: integer(env.BETA_MAX_STRESS_ITERATIONS, 50, 1, 1000, 'BETA_MAX_STRESS_ITERATIONS'),
    maxStressRunsPerInvite: integer(env.BETA_MAX_STRESS_RUNS_PER_INVITE, 10, 1, 100, 'BETA_MAX_STRESS_RUNS_PER_INVITE'),
    maxConcurrentStressRuns: integer(env.BETA_MAX_CONCURRENT_STRESS_RUNS, 2, 1, 16, 'BETA_MAX_CONCURRENT_STRESS_RUNS'),
    maxChainLagBlocks: integer(env.BETA_MAX_CHAIN_LAG_BLOCKS, 12, 0, 1000, 'BETA_MAX_CHAIN_LAG_BLOCKS'),
    statusCacheMs: integer(env.BETA_STATUS_CACHE_MS, 3000, 0, 60000, 'BETA_STATUS_CACHE_MS'),
    publicOrigin: env.BETA_PUBLIC_ORIGIN || null,
    trustProxy: env.BETA_TRUST_PROXY === '1'
  };
}

module.exports = { integer, basePath, loadPolicy };
