const DEFAULT_SIDECAR_URL = 'http://127.0.0.1:8787';

function envValue(env, name, fallback = '') {
  const value = env[name];
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

function sidecarEndpoints(baseUrl) {
  const normalized = baseUrl.replace(/\/$/, '');
  return {
    walletView: `${normalized}/v1/lnbtc-tlusd-liquidity-patch/wallet-view`,
    verify: `${normalized}/v1/lnbtc-tlusd-liquidity-patch/verify`,
    challenge: `${normalized}/v1/lnbtc-tlusd-liquidity-patch/challenge`,
    latestArtifact: `${normalized}/v1/lnbtc-tlusd-liquidity-patch/latest`
  };
}

function buildLocalLitecoinProfile(env = process.env) {
  const sidecarBaseUrl = envValue(env, 'UTXOREF_SIDECAR_URL', DEFAULT_SIDECAR_URL);
  return {
    id: 'litecoin-testnet-local',
    mode: 'local_mock_backend',
    chainSourceBadge: 'litecoin-testnet',
    displayName: 'Local Litecoin testnet backend',
    purpose: 'Use local Litecoin testnet RPC for live UTXORef chain harness while wallet UI consumes TLUSD liquidity patch artifacts.',
    sidecarBaseUrl,
    sidecarEndpoints: sidecarEndpoints(sidecarBaseUrl),
    bitvm: {
      chain: 'litecoin-testnet',
      rpcUrl: envValue(env, 'BITVM_RPC_URL', envValue(env, 'LTC_RPC_URL', 'http://127.0.0.1:19332')),
      rpcUserEnv: env.BITVM_RPC_USER ? 'BITVM_RPC_USER' : 'LTC_RPC_USER',
      rpcPassEnv: env.BITVM_RPC_PASS ? 'BITVM_RPC_PASS' : 'LTC_RPC_PASS',
      wallet: envValue(env, 'BITVM_WALLET', envValue(env, 'LTC_WALLET', 'tl-wallet')),
      liveProbeCommand: 'node bitvm3/utxo_referee/lightning_live_testnet_demo.js'
    },
    lightning: {
      backend: 'artifact_or_local_cli_probe',
      network: 'litecoin-testnet',
      invoiceSource: 'sidecar artifact unless LIVE_DEMO_CREATE_LN_INVOICE=1'
    },
    labels: ['demo-safe', 'local-chain', 'artifact-backed-tlusd', 'ark-prototype']
  };
}

function buildBitcoinLndGoLiveProfile(env = process.env) {
  const sidecarBaseUrl = envValue(env, 'UTXOREF_SIDECAR_URL', DEFAULT_SIDECAR_URL);
  return {
    id: 'bitcoin-testnet-lnd',
    mode: 'bitcoin_testnet_lnd_go_live',
    chainSourceBadge: 'bitcoin-testnet',
    displayName: 'Bitcoin testnet LND go-live backend',
    purpose: 'Switch the wallet fork from local Litecoin mock chain to Bitcoin testnet LND for LN-BTC invoice/payment operations.',
    sidecarBaseUrl,
    sidecarEndpoints: sidecarEndpoints(sidecarBaseUrl),
    bitvm: {
      chain: 'bitcoin-testnet',
      rpcUrl: envValue(env, 'BITVM_RPC_URL', envValue(env, 'BTC_RPC_URL', 'http://127.0.0.1:18332')),
      rpcUserEnv: env.BITVM_RPC_USER ? 'BITVM_RPC_USER' : 'BTC_RPC_USER',
      rpcPassEnv: env.BITVM_RPC_PASS ? 'BITVM_RPC_PASS' : 'BTC_RPC_PASS',
      wallet: envValue(env, 'BITVM_WALLET', envValue(env, 'BTC_WALLET', 'tl-wallet')),
      liveProbeCommand: '$env:BITVM_CHAIN="bitcoin-testnet"; node bitvm3/utxo_referee/lightning_live_testnet_demo.js'
    },
    lnd: {
      network: 'testnet',
      restUrl: envValue(env, 'LND_REST_URL', 'https://127.0.0.1:8080'),
      grpcHost: envValue(env, 'LND_GRPC_HOST', '127.0.0.1:10009'),
      macaroonPath: envValue(env, 'LND_MACAROON_PATH', ''),
      tlsCertPath: envValue(env, 'LND_TLS_CERT_PATH', ''),
      requiredEnv: ['LND_REST_URL or LND_GRPC_HOST', 'LND_MACAROON_PATH or macaroon hex', 'LND_TLS_CERT_PATH']
    },
    labels: ['go-live-candidate', 'bitcoin-testnet', 'lnd', 'remote-or-local-chain-backend']
  };
}

function buildWalletDemoConfig(env = process.env) {
  const requestedProfile = envValue(env, 'WALLET_DEMO_PROFILE', 'litecoin-testnet-local');
  const profiles = {
    'litecoin-testnet-local': buildLocalLitecoinProfile(env),
    'bitcoin-testnet-lnd': buildBitcoinLndGoLiveProfile(env)
  };
  const activeProfile = profiles[requestedProfile] || profiles['litecoin-testnet-local'];
  const warnings = [];
  if (!profiles[requestedProfile]) {
    warnings.push(`unknown WALLET_DEMO_PROFILE ${requestedProfile}; using litecoin-testnet-local`);
  }
  if (activeProfile.id === 'bitcoin-testnet-lnd' && !activeProfile.lnd.macaroonPath) {
    warnings.push('bitcoin-testnet-lnd profile needs LND_MACAROON_PATH or macaroon injection before live payments');
  }

  return {
    kind: 'utxoref_wallet_demo_backend_config',
    activeProfileId: activeProfile.id,
    activeProfile,
    availableProfiles: Object.keys(profiles),
    switchPlan: {
      currentDemo: 'litecoin-testnet-local',
      goLive: 'bitcoin-testnet-lnd',
      invariant:
        'Wallet UI calls the same TLUSD liquidity patch sidecar endpoints; only the chain/LND backend profile changes.'
    },
    warnings
  };
}

function verifyWalletDemoConfig(config) {
  if (!config || config.kind !== 'utxoref_wallet_demo_backend_config') {
    return { ok: false, reason: 'wrong config kind' };
  }
  if (!config.activeProfile || !config.activeProfile.sidecarEndpoints) {
    return { ok: false, reason: 'missing active profile endpoints' };
  }
  if (!config.activeProfile.sidecarEndpoints.walletView.includes('/v1/lnbtc-tlusd-liquidity-patch/wallet-view')) {
    return { ok: false, reason: 'wallet view endpoint mismatch' };
  }
  if (!config.availableProfiles.includes('bitcoin-testnet-lnd')) {
    return { ok: false, reason: 'missing bitcoin-testnet-lnd profile' };
  }
  return { ok: true };
}

module.exports = {
  buildWalletDemoConfig,
  verifyWalletDemoConfig
};
