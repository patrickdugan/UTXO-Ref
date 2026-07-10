#!/usr/bin/env node

const crypto = require('crypto');
const {
  DEFAULT_DURATION_SECONDS,
  buildHourlyRbtcDlcContract,
  buildBalanceOracleObservation,
  chooseOutcomeFromBalanceObservation,
  buildHourlyRbtcCetDecision
} = require('./tradelayer_rbtc_hourly_autoroll');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    failed += 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `expected ${expected}, got ${actual}`);
  }
}

function baseContractInput() {
  return {
    contractId: 'rbtc-hour-001',
    vaultAddress: 'tb1p8l6fdqqyyfp09xda0xv59xgltas6eecem47rvuq2walz0t5zrcgq06pcf9',
    fundingAddress: 'tl-funding-rbtc-addr-1',
    rbtcPropertyId: 70001,
    fundingOutpoint: {
      txid: '93f953df2c89faf386d14217fb4d3de62d91d3789fee83cc53acfd653882f6a6',
      vout: 0
    },
    reserveVaultId: 'btc-testnet4-reserve-143195-93f953df',
    startsAtUnix: 1783368587,
    durationSeconds: DEFAULT_DURATION_SECONDS,
    startingRbtcBalance: '20000'
  };
}

console.log('\n=== TradeLayer rBTC Hourly Auto-Roll Tests ===\n');

test('builds an hour contract with deterministic expiry metadata', () => {
  const contract = buildHourlyRbtcDlcContract(baseContractInput());

  assertEq(contract.core.durationSeconds, 3600);
  assertEq(contract.core.expiresAtUnix, 1783372187);
  assertEq(contract.core.startingRbtcBalance, '20000');
  assert(contract.contractHash.length === 64, 'contract hash missing');
});

test('oracle selects roll CET when funding address rBTC balance is unchanged', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const contract = buildHourlyRbtcDlcContract(baseContractInput());
  const decision = buildHourlyRbtcCetDecision({
    contract,
    observation: {
      observedAtUnix: contract.core.expiresAtUnix,
      currentRbtcBalance: '20000'
    },
    collateralSats: 20000,
    privateKey,
    publicKey
  });

  assertEq(decision.policy.outcomeId, 'roll');
  assertEq(decision.policy.canAutoRoll, true);
  assertEq(decision.selectedCet.selection.outcomeId, 'roll');
  assert(decision.rollHandoff, 'roll handoff should be emitted');
  assertEq(decision.rollHandoff.nextContract.trigger, 'send');
  assertEq(decision.observation.core.deltaRbtcBalance, '0');
});

test('oracle blocks auto-roll and selects settlement when rBTC balance is reduced', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const contract = buildHourlyRbtcDlcContract(baseContractInput());
  const decision = buildHourlyRbtcCetDecision({
    contract,
    observation: {
      observedAtUnix: contract.core.expiresAtUnix,
      currentRbtcBalance: '19500'
    },
    collateralSats: 20000,
    privateKey,
    publicKey
  });

  assertEq(decision.policy.canAutoRoll, false);
  assertEq(decision.policy.reason, 'rbtc_balance_reduced');
  assertEq(decision.selectedCet.selection.outcomeId, 'settle-loss');
  assertEq(decision.rollHandoff, null);
  assertEq(decision.observation.core.deltaRbtcBalance, '-500');
});

test('pre-expiry balance observation waits and does not select a CET', () => {
  const contract = buildHourlyRbtcDlcContract(baseContractInput());
  const observation = buildBalanceOracleObservation(contract, {
    observedAtUnix: contract.core.expiresAtUnix - 30,
    currentRbtcBalance: '20000'
  });
  const policy = chooseOutcomeFromBalanceObservation(observation);
  const decision = buildHourlyRbtcCetDecision({
    contract,
    observation
  });

  assertEq(policy.outcomeId, 'wait');
  assertEq(policy.reason, 'contract_not_mature');
  assertEq(decision.selectedCet, null);
  assertEq(decision.rollHandoff, null);
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
