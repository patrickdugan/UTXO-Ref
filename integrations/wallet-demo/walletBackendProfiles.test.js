#!/usr/bin/env node

const {
  buildWalletDemoConfig,
  verifyWalletDemoConfig
} = require('./walletBackendProfiles');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  OK  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log('\n=== Wallet Demo Backend Profile Tests ===\n');

test('defaults to local Litecoin testnet mock backend', () => {
  const config = buildWalletDemoConfig({});
  assert(config.activeProfileId === 'litecoin-testnet-local', 'wrong default profile');
  assert(config.activeProfile.bitvm.chain === 'litecoin-testnet', 'wrong default chain');
  assert(config.activeProfile.sidecarEndpoints.walletView.includes('lnbtc-tlusd-liquidity-patch'), 'missing patch endpoint');
  assert(verifyWalletDemoConfig(config).ok, 'config should verify');
});

test('bitcoin testnet profile carries LND go-live settings', () => {
  const config = buildWalletDemoConfig({
    WALLET_DEMO_PROFILE: 'bitcoin-testnet-lnd',
    LND_REST_URL: 'https://lnd.example.test:8080',
    LND_GRPC_HOST: 'lnd.example.test:10009',
    LND_MACAROON_PATH: '/tmp/admin.macaroon',
    LND_TLS_CERT_PATH: '/tmp/tls.cert'
  });
  assert(config.activeProfileId === 'bitcoin-testnet-lnd', 'wrong active profile');
  assert(config.activeProfile.lnd.network === 'testnet', 'wrong LND network');
  assert(config.activeProfile.bitvm.chain === 'bitcoin-testnet', 'wrong BitVM chain');
  assert(config.warnings.length === 0, 'unexpected warnings');
});

test('unknown profile falls back safely', () => {
  const config = buildWalletDemoConfig({ WALLET_DEMO_PROFILE: 'bogus' });
  assert(config.activeProfileId === 'litecoin-testnet-local', 'should fall back to litecoin');
  assert(config.warnings.length === 1, 'expected warning');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
