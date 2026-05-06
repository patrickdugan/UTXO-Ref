/**
 * Shared chain environment resolution for referee live workflows.
 *
 * Supports Litecoin mainnet first, while preserving Litecoin testnet defaults
 * for the current local artifact flow.
 */

const CHAIN_PROFILES = Object.freeze({
  'litecoin-mainnet': Object.freeze({
    chainId: 'litecoin-mainnet',
    family: 'litecoin',
    ticker: 'LTC',
    displayName: 'Litecoin mainnet',
    rpcUrl: 'http://127.0.0.1:9332',
    wallet: 'tl-wallet',
    templateId: 'dlc-receipt-ltc-mainnet-v1',
    receiptSymbol: 'rLTC-SAT',
    depositMinConfirmations: 6,
    eventPrefix: 'ltc-mainnet'
  }),
  'litecoin-testnet': Object.freeze({
    chainId: 'litecoin-testnet',
    family: 'litecoin',
    ticker: 'LTC',
    displayName: 'Litecoin testnet',
    rpcUrl: 'http://127.0.0.1:19332',
    wallet: 'tl-wallet',
    templateId: 'dlc-receipt-ltc-testnet-v1',
    receiptSymbol: 'rLTC-SAT',
    depositMinConfirmations: 1,
    eventPrefix: 'ltc-testnet'
  }),
  'bitcoin-mainnet': Object.freeze({
    chainId: 'bitcoin-mainnet',
    family: 'bitcoin',
    ticker: 'BTC',
    displayName: 'Bitcoin mainnet',
    rpcUrl: 'http://127.0.0.1:8332',
    wallet: 'tl-wallet',
    templateId: 'dlc-receipt-btc-mainnet-v1',
    receiptSymbol: 'rBTC-SAT',
    depositMinConfirmations: 6,
    eventPrefix: 'btc-mainnet'
  }),
  'bitcoin-testnet': Object.freeze({
    chainId: 'bitcoin-testnet',
    family: 'bitcoin',
    ticker: 'BTC',
    displayName: 'Bitcoin testnet',
    rpcUrl: 'http://127.0.0.1:18332',
    wallet: 'tl-wallet',
    templateId: 'dlc-receipt-btc-testnet-v1',
    receiptSymbol: 'rBTC-SAT',
    depositMinConfirmations: 1,
    eventPrefix: 'btc-testnet'
  })
});

const DEFAULT_CHAIN_ID = 'litecoin-testnet';

function resolveChainId(env = process.env) {
  const explicit = env.BITVM_CHAIN || env.CHAIN || null;
  if (explicit) {
    return normalizeChainId(explicit);
  }

  if (env.BTC_RPC_URL || env.BTC_RPC_USER || env.BTC_RPC_PASS || env.BTC_WALLET) {
    return 'bitcoin-mainnet';
  }
  if (env.LTC_RPC_URL || env.LTC_RPC_USER || env.LTC_RPC_PASS || env.LTC_WALLET) {
    return DEFAULT_CHAIN_ID;
  }

  return DEFAULT_CHAIN_ID;
}

function normalizeChainId(chainId) {
  const normalized = String(chainId || '').trim().toLowerCase();
  if (!CHAIN_PROFILES[normalized]) {
    throw new Error(`Unsupported BITVM_CHAIN: ${chainId}`);
  }
  return normalized;
}

function getChainProfile(chainId) {
  return CHAIN_PROFILES[normalizeChainId(chainId)];
}

function getLegacyEnvValue(env, profile, suffix) {
  if (profile.family === 'litecoin') {
    return env[`LTC_${suffix}`] || null;
  }
  if (profile.family === 'bitcoin') {
    return env[`BTC_${suffix}`] || null;
  }
  return null;
}

function resolveChainEnv(env = process.env) {
  const chainId = resolveChainId(env);
  const profile = getChainProfile(chainId);

  return {
    ...profile,
    chainId,
    rpcUrl: env.BITVM_RPC_URL || getLegacyEnvValue(env, profile, 'RPC_URL') || profile.rpcUrl,
    rpcUser: env.BITVM_RPC_USER || getLegacyEnvValue(env, profile, 'RPC_USER') || 'user',
    rpcPass: env.BITVM_RPC_PASS || getLegacyEnvValue(env, profile, 'RPC_PASS') || 'pass',
    wallet: env.BITVM_WALLET || getLegacyEnvValue(env, profile, 'WALLET') || profile.wallet
  };
}

function buildEpochEventId(chainId, epochId, now = Date.now()) {
  const profile = getChainProfile(chainId);
  return `${profile.eventPrefix}-epoch-${BigInt(epochId).toString()}-${now}`;
}

module.exports = {
  CHAIN_PROFILES,
  DEFAULT_CHAIN_ID,
  normalizeChainId,
  getChainProfile,
  resolveChainId,
  resolveChainEnv,
  buildEpochEventId
};
