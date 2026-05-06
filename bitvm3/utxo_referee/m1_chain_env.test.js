/**
 * Shared chain environment tests
 *
 * Run: node bitvm3/utxo_referee/m1_chain_env.test.js
 */

const {
  DEFAULT_CHAIN_ID,
  resolveChainId,
  resolveChainEnv,
  buildEpochEventId
} = require('./m1_chain_env');
const { buildReceiptDlcTemplate } = require('./m1_spec');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `expected ${expected}, got ${actual}`);
  }
}

console.log('\n=== M1 Chain Env Tests ===\n');

test('default chain stays on litecoin testnet for backward compatibility', () => {
  const chainId = resolveChainId({});
  const chainEnv = resolveChainEnv({});

  assertEq(chainId, DEFAULT_CHAIN_ID);
  assertEq(chainEnv.chainId, 'litecoin-testnet');
  assertEq(chainEnv.rpcUrl, 'http://127.0.0.1:19332');
  assertEq(chainEnv.wallet, 'tl-wallet');
});

test('explicit litecoin mainnet profile uses mainnet defaults', () => {
  const chainEnv = resolveChainEnv({
    BITVM_CHAIN: 'litecoin-mainnet'
  });
  const template = buildReceiptDlcTemplate(chainEnv.chainId);

  assertEq(chainEnv.chainId, 'litecoin-mainnet');
  assertEq(chainEnv.rpcUrl, 'http://127.0.0.1:9332');
  assertEq(template.templateId, 'dlc-receipt-ltc-mainnet-v1');
  assertEq(template.depositContract.minConfirmations, 6);
  assertEq(template.receiptToken.symbol, 'rLTC-SAT');
});

test('bitcoin family can be selected explicitly with generic env vars', () => {
  const chainEnv = resolveChainEnv({
    BITVM_CHAIN: 'bitcoin-mainnet',
    BITVM_RPC_URL: 'http://127.0.0.1:18443',
    BITVM_RPC_USER: 'alice',
    BITVM_RPC_PASS: 'secret',
    BITVM_WALLET: 'btc-wallet'
  });
  const template = buildReceiptDlcTemplate(chainEnv.chainId);

  assertEq(chainEnv.chainId, 'bitcoin-mainnet');
  assertEq(chainEnv.rpcUrl, 'http://127.0.0.1:18443');
  assertEq(chainEnv.rpcUser, 'alice');
  assertEq(chainEnv.rpcPass, 'secret');
  assertEq(chainEnv.wallet, 'btc-wallet');
  assertEq(template.templateId, 'dlc-receipt-btc-mainnet-v1');
  assertEq(template.receiptToken.symbol, 'rBTC-SAT');
});

test('legacy LTC env vars still resolve into the Litecoin profile', () => {
  const chainEnv = resolveChainEnv({
    LTC_RPC_URL: 'http://litecoin.local:19332',
    LTC_RPC_USER: 'ltc-user',
    LTC_RPC_PASS: 'ltc-pass',
    LTC_WALLET: 'ltc-wallet'
  });

  assertEq(chainEnv.chainId, 'litecoin-testnet');
  assertEq(chainEnv.rpcUrl, 'http://litecoin.local:19332');
  assertEq(chainEnv.rpcUser, 'ltc-user');
  assertEq(chainEnv.rpcPass, 'ltc-pass');
  assertEq(chainEnv.wallet, 'ltc-wallet');
});

test('event ids are chain-scoped and epoch-stable', () => {
  const eventId = buildEpochEventId('litecoin-mainnet', 7n, 1234567890);
  assertEq(eventId, 'ltc-mainnet-epoch-7-1234567890');
});

test('unsupported chain ids are rejected', () => {
  let threw = false;
  try {
    resolveChainEnv({
      BITVM_CHAIN: 'dogecoin-mainnet'
    });
  } catch (err) {
    threw = true;
    assert(String(err.message).includes('Unsupported BITVM_CHAIN'), 'expected unsupported chain error');
  }

  assert(threw, 'expected invalid chain id to throw');
});

console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
