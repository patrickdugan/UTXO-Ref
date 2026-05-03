/**
 * Run: node bitvm3/utxo_referee/tradelayer_send_watchtower.test.js
 */

const {
  buildTradeLayerSendStateOracleFromConsensus
} = require('./tradelayer_send_oracle_extractor');
const {
  buildTradeLayerSendIntentFromStateOracle,
  buildTradeLayerSendRoutePlan,
  buildTradeLayerSendRouteTranscript
} = require('./tradelayer_pnl_route_adapter');
const {
  buildTradeLayerSendSweepPlan
} = require('./tradelayer_send_sweep_psbt');
const {
  buildTradeLayerSendWatchtowerReport,
  verifyTradeLayerSendWatchtowerReport
} = require('./tradelayer_send_watchtower');

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

function stateOracle() {
  return buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
}

function routeArtifacts(blob = stateOracle()) {
  const intent = buildTradeLayerSendIntentFromStateOracle(blob, { sendId: 'live-send' });
  const routePlan = buildTradeLayerSendRoutePlan(intent);
  const routeTranscript = buildTradeLayerSendRouteTranscript(routePlan);
  const sweepPlan = buildTradeLayerSendSweepPlan(routePlan, { routeTranscript });
  return { routePlan, routeTranscript, sweepPlan };
}

console.log('\n=== TradeLayer Send Watchtower Tests ===\n');

test('allows a coherent state oracle, route transcript, sweep plan, flow, and policy', () => {
  const blob = stateOracle();
  const report = buildTradeLayerSendWatchtowerReport(blob, { sendId: 'live-send' });
  const result = verifyTradeLayerSendWatchtowerReport(report);

  assert(result.ok, result.reason);
  assert(report.ok, 'coherent artifacts should pass');
  assertEq(report.action, 'allow_cooperative_sweep');
  assertEq(report.alerts.length, 0);
  assertEq(report.challengeBundle, null);
});

test('pauses and emits a challenge bundle when the sweep transcript is rebound', () => {
  const blob = stateOracle();
  const artifacts = routeArtifacts(blob);
  const sweepPlan = clone(artifacts.sweepPlan);
  sweepPlan.routeTranscriptHash = '00'.repeat(32);
  const report = buildTradeLayerSendWatchtowerReport({
    stateOracleBlob: blob,
    routePlan: artifacts.routePlan,
    routeTranscript: artifacts.routeTranscript,
    sweepPlan
  }, { sendId: 'live-send' });
  const result = verifyTradeLayerSendWatchtowerReport(report);

  assert(result.ok, result.reason);
  assert(!report.ok, 'mismatched transcript should fail');
  assertEq(report.action, 'pause_and_challenge');
  assert(report.alerts.some((alert) => alert.code === 'sweep_transcript_mismatch'), 'expected sweep transcript alert');
  assert(report.challengeBundle, 'challenge bundle should be attached');
});

test('detects a stale expected state oracle subscription hash', () => {
  const report = buildTradeLayerSendWatchtowerReport(stateOracle(), {
    sendId: 'live-send',
    expectedStateOracleHash: '11'.repeat(32)
  });

  assert(!report.ok, 'wrong subscribed oracle hash should fail');
  assert(report.alerts.some((alert) => alert.code === 'state_oracle_hash_mismatch'), 'expected state oracle hash alert');
});

test('detects report tampering', () => {
  const report = buildTradeLayerSendWatchtowerReport(stateOracle(), { sendId: 'live-send' });
  const tampered = clone(report);
  tampered.reportCore.routeTranscriptHash = '00'.repeat(32);
  const result = verifyTradeLayerSendWatchtowerReport(tampered);

  assert(!result.ok, 'tampered report should fail');
  assert(String(result.reason).includes('report hash mismatch'), 'expected report hash mismatch');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
