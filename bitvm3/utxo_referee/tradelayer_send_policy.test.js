/**
 * Run: node bitvm3/utxo_referee/tradelayer_send_policy.test.js
 */

const {
  buildTradeLayerSendStateOracleFromConsensus
} = require('./tradelayer_send_oracle_extractor');
const {
  buildTradeLayerSendProductionPolicy,
  verifyTradeLayerSendProductionPolicy
} = require('./tradelayer_send_policy');
const { buildTradeLayerWithdrawalQueue } = require('./tradelayer_withdrawal_queue_referee');
const {
  buildTradeLayerReserveReconciliation
} = require('./tradelayer_reserve_reconciliation_referee');
const { sha256Hex } = require('./tradelayer_pnl_route_adapter');

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
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEq(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const CONSENSUS_INPUT = {
  chain: 'litecoin-testnet',
  epochId: '77',
  snapshotHeight: 4696000,
  snapshotTxid: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  oracleAddress: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
  registryHeight: 4695998,
  depositUnits: '10000',
  feeSats: 1000,
  dlcInputs: {
    'live-send': {
      txid: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      vout: 1,
      address: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
      sats: 100000
    }
  },
  dlcFunderRegistry: {
    tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22: {
      dlcRef: 'dlc-live-77',
      dlcAddress: 'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz'
    }
  },
  transactions: [
    {
      txType: 2,
      id: 'live-send',
      txid: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      blockHeight: 4695999,
      senderAddress: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
      address: 'tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22',
      propertyId: 380,
      amountUnits: '2500',
      valid: true
    }
  ]
};

console.log('\n=== TradeLayer Send Production Policy Tests ===\n');

test('allows a route that satisfies production policy gates', () => {
  const stateOracle = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  stateOracle.registryHeight = CONSENSUS_INPUT.registryHeight;

  const policy = buildTradeLayerSendProductionPolicy(stateOracle, {
    sendId: 'live-send',
    currentHeight: 4696000,
    allowedOracleAddresses: [CONSENSUS_INPUT.oracleAddress]
  });
  const result = verifyTradeLayerSendProductionPolicy(policy);

  assert(result.ok, result.reason);
  assert(policy.ok, 'policy should pass');
  assertEq(policy.walletAction, 'allow_sweep');
  assert(policy.policyHash.length === 64, 'policy hash should be present');
});

test('pauses wallet spend on excessive fee', () => {
  const badInput = clone(CONSENSUS_INPUT);
  badInput.feeSats = 6000;
  badInput.dlcInputs['live-send'].sats = 100000;
  const stateOracle = buildTradeLayerSendStateOracleFromConsensus(badInput, {
    selectedSendId: 'live-send'
  });

  const policy = buildTradeLayerSendProductionPolicy(stateOracle, {
    sendId: 'live-send',
    maxFeeSats: '5000',
    maxFeeBpsOfInput: 500
  });

  assert(!policy.ok, 'policy should fail');
  assert(policy.failedChecks.includes('fee_cap'), 'fee cap should fail');
  assertEq(policy.walletAction, 'pause_spend');
});

test('pauses on stale registry height', () => {
  const stateOracle = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  stateOracle.registryHeight = 4690000;

  const policy = buildTradeLayerSendProductionPolicy(stateOracle, {
    sendId: 'live-send',
    currentHeight: 4696000,
    maxRegistryAgeBlocks: 10
  });

  assert(!policy.ok, 'policy should fail');
  assert(policy.failedChecks.includes('registry_freshness'), 'registry freshness should fail');
});

test('rejects an unapproved oracle address', () => {
  const stateOracle = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  const policy = buildTradeLayerSendProductionPolicy(stateOracle, {
    sendId: 'live-send',
    allowedOracleAddresses: ['tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22']
  });

  assert(!policy.ok, 'policy should fail');
  assert(policy.failedChecks.includes('oracle_address_allowed'), 'oracle address allow list should fail');
});

test('reserve_solvency follows the verified reserve, not the reconciliation flag', () => {
  const stateOracle = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  stateOracle.registryHeight = CONSENSUS_INPUT.registryHeight;
  const queue = buildTradeLayerWithdrawalQueue({
    requests: [{ id: 'w1', txid: '11'.repeat(32), address: 'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz', sats: 5000, propertyId: 380 }]
  });
  const honest = buildTradeLayerReserveReconciliation({ queue, reserve: 1000 });
  const forged = clone(honest);
  forged.core.reservedSats = '999999';
  forged.core.marginSats = '994999';
  forged.core.mathSolvent = true;
  forged.core.solvent = true;
  forged.solvent = true;
  forged.reconciliationHash = sha256Hex(forged.core);

  const policy = buildTradeLayerSendProductionPolicy(stateOracle, {
    sendId: 'live-send',
    currentHeight: 4696000,
    allowedOracleAddresses: [CONSENSUS_INPUT.oracleAddress],
    reserveReconciliation: forged,
    withdrawalQueue: queue,
    reserveEvidence: 1000
  });

  assert(!policy.ok, 'a reserve that does not match its evidence must block the sweep');
  assert(policy.failedChecks.includes('reserve_solvency'), 'reserve_solvency should fail');
});

test('detects policy hash tampering', () => {
  const stateOracle = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  const policy = buildTradeLayerSendProductionPolicy(stateOracle, {
    sendId: 'live-send'
  });
  const tampered = clone(policy);
  tampered.policy.maxFeeSats = '1';

  const result = verifyTradeLayerSendProductionPolicy(tampered);
  assert(!result.ok, 'tampered policy should fail');
  assert(String(result.reason).includes('policy hash mismatch'), 'expected hash mismatch');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
