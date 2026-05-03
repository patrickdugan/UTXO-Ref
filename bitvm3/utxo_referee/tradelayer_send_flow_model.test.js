/**
 * Run: node bitvm3/utxo_referee/tradelayer_send_flow_model.test.js
 */

const {
  buildTradeLayerSendStateOracleFromConsensus
} = require('./tradelayer_send_oracle_extractor');
const {
  buildTradeLayerSendFraudChallengeBundle
} = require('./tradelayer_send_fraud_challenges');
const {
  buildTradeLayerSendWalletFlow,
  verifyTradeLayerSendWalletFlow
} = require('./tradelayer_send_flow_model');

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

console.log('\n=== TradeLayer Send Flow Model Tests ===\n');

test('builds a four-step wallet flow for a DLC-mapped send', () => {
  const stateOracle = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  const fraudChallenges = buildTradeLayerSendFraudChallengeBundle(stateOracle, {
    sendId: 'live-send'
  });
  const flow = buildTradeLayerSendWalletFlow(stateOracle, {
    sendId: 'live-send',
    fraudChallengeBundle: fraudChallenges
  });

  assertEq(flow.steps.length, 4);
  assertEq(flow.steps[0].id, 'tl-send');
  assertEq(flow.steps[1].id, 'state-oracle');
  assertEq(flow.steps[2].id, 'dlc-mapping');
  assertEq(flow.steps[3].id, 'bitvm-utxoref-sweep');
  assertEq(flow.destination.kind, 'dlc-funding-output');
  assertEq(flow.destination.matchedDlcRef, 'dlc-live-77');
  assertEq(flow.hashes.fraudChallengeRoot, fraudChallenges.challengeRoot);
  assertEq(flow.hashes.routeTranscriptHash, flow.routeTranscript.hash);
  assertEq(flow.routeTranscript.core.stateOracleHash, flow.hashes.stateOracleHash);
  assertEq(flow.routeTranscript.core.withdrawalRootHex, flow.hashes.withdrawalRootHex);
  assert(flow.flowHash.length === 64, 'flow hash should be present');
});

test('verifies a wallet flow hash and statuses', () => {
  const stateOracle = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  const flow = buildTradeLayerSendWalletFlow(stateOracle, {
    sendId: 'live-send'
  });
  const result = verifyTradeLayerSendWalletFlow(flow);

  assert(result.ok, result.reason);
  assertEq(result.destinationKind, 'dlc-funding-output');
  assertEq(result.sweepStatus, 'planned');
});

test('reflects live sweep txid attachment', () => {
  const stateOracle = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  const flow = buildTradeLayerSendWalletFlow(stateOracle, {
    sendId: 'live-send',
    liveTxid: '1111111111111111111111111111111111111111111111111111111111111111'
  });

  assertEq(flow.live.sweepStatus, 'attached');
  assertEq(flow.live.txid, '1111111111111111111111111111111111111111111111111111111111111111');
  assertEq(flow.steps[3].status, 'attached');
});

test('detects flow tampering', () => {
  const stateOracle = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  const flow = buildTradeLayerSendWalletFlow(stateOracle, {
    sendId: 'live-send'
  });
  const tampered = clone(flow);
  tampered.destination.resolvedSweepAddress = 'tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22';

  const result = verifyTradeLayerSendWalletFlow(tampered);
  assert(!result.ok, 'tampered flow should fail');
  assert(String(result.reason).includes('flow hash mismatch'), 'expected hash mismatch');
});

test('detects route transcript tampering inside the wallet flow', () => {
  const stateOracle = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  const flow = buildTradeLayerSendWalletFlow(stateOracle, {
    sendId: 'live-send'
  });
  const tampered = clone(flow);
  tampered.routeTranscript.core.outputPlanHash = '00'.repeat(32);

  const result = verifyTradeLayerSendWalletFlow(tampered);
  assert(!result.ok, 'tampered route transcript should fail');
  assert(String(result.reason).includes('route transcript hash mismatch'), 'expected route transcript hash mismatch');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
