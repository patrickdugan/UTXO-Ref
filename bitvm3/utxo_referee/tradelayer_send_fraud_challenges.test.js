/**
 * Run: node bitvm3/utxo_referee/tradelayer_send_fraud_challenges.test.js
 */

const {
  buildTradeLayerSendStateOracleFromConsensus
} = require('./tradelayer_send_oracle_extractor');
const {
  buildTradeLayerSendFraudChallengeBundle,
  verifyTradeLayerSendFraudChallengeBundle
} = require('./tradelayer_send_fraud_challenges');

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
      id: 'bad-send',
      txid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      senderAddress: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
      address: 'tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22',
      propertyId: 380,
      amount: '1',
      valid: false,
      reason: 'insufficient balance'
    },
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

console.log('\n=== TradeLayer Send Fraud Challenge Tests ===\n');

test('builds one challenge for every send-route fraud surface', () => {
  const stateOracle = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  const bundle = buildTradeLayerSendFraudChallengeBundle(stateOracle, {
    sendId: 'live-send'
  });

  assertEq(bundle.challenges.length, 7);
  assert(bundle.binding.oracleBlobHash.length === 64, 'oracle hash should be present');
  assert(bundle.binding.dlcFunderRegistryHash.length === 64, 'registry hash should be present');
  assert(bundle.challengeRoot.length === 64, 'challenge root should be present');
  assert(bundle.bundleHash.length === 64, 'bundle hash should be present');
});

test('verifies challenge ids, root, bundle hash and predicates', () => {
  const stateOracle = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  const bundle = buildTradeLayerSendFraudChallengeBundle(stateOracle, {
    sendId: 'live-send'
  });
  const result = verifyTradeLayerSendFraudChallengeBundle(bundle);

  assert(result.ok, result.reason);
  assert(result.challengeableCount >= 6, 'expected adversarial fixtures to be challengeable');
});

test('binds every challenge to the same oracle and registry hashes', () => {
  const stateOracle = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  const bundle = buildTradeLayerSendFraudChallengeBundle(stateOracle, {
    sendId: 'live-send'
  });

  for (const challenge of bundle.challenges) {
    assertEq(challenge.challengeCore.binding.oracleBlobHash, bundle.binding.oracleBlobHash);
    assertEq(challenge.challengeCore.binding.dlcFunderRegistryHash, bundle.binding.dlcFunderRegistryHash);
    assertEq(challenge.challengeCore.binding.routePlanHash, bundle.binding.routePlanHash);
  }
});

test('detects challenge tampering', () => {
  const stateOracle = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  const bundle = buildTradeLayerSendFraudChallengeBundle(stateOracle, {
    sendId: 'live-send'
  });
  const tampered = clone(bundle);
  tampered.challenges[0].challengeCore.claimed.consensusRejectReason = 'different';

  const result = verifyTradeLayerSendFraudChallengeBundle(tampered);
  assert(!result.ok, 'tampered challenge should fail');
  assert(String(result.reason).includes('challenge id mismatch'), 'expected id mismatch');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
