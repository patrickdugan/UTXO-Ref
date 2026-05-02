/**
 * Run: node bitvm3/utxo_referee/tradelayer_send_sweep_psbt.test.js
 */

const {
  satsToCoinString,
  buildTradeLayerSendSweepPlan,
  verifyObservedSweepOutputs
} = require('./tradelayer_send_sweep_psbt');
const {
  buildTradeLayerSendStateOracleFromConsensus
} = require('./tradelayer_send_oracle_extractor');
const {
  buildTradeLayerSendIntentFromStateOracle,
  buildTradeLayerSendRoutePlan
} = require('./tradelayer_pnl_route_adapter');

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

function routePlan() {
  const blob = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  return buildTradeLayerSendRoutePlan(buildTradeLayerSendIntentFromStateOracle(blob));
}

console.log('\n=== TradeLayer Send Sweep PSBT Tests ===\n');

test('formats satoshis as fixed 8-decimal coin amounts', () => {
  assertEq(satsToCoinString(25000), '0.00025000');
  assertEq(satsToCoinString('74000'), '0.00074000');
  assertEq(satsToCoinString(100000000n), '1.00000000');
});

test('builds a deterministic sweep plan and Core RPC templates', () => {
  const plan = buildTradeLayerSendSweepPlan(routePlan());
  assertEq(plan.accounting.inputSats, '100000');
  assertEq(plan.accounting.outputTotalSats, '99000');
  assertEq(plan.accounting.feeSats, '1000');
  assert(plan.accounting.conservationHolds, 'conservation should hold');
  assertEq(plan.outputs[0].sats, '25000');
  assertEq(plan.outputs[1].sats, '74000');
  assertEq(plan.bitcoinCore.createRawTransaction[0], 'createrawtransaction');
  assertEq(plan.bitcoinCore.createPsbt[0], 'createpsbt');
});

test('rejects route plans whose fee does not match input minus outputs', () => {
  const bad = routePlan();
  bad.feeSats = '999';
  let threw = false;
  try {
    buildTradeLayerSendSweepPlan(bad);
  } catch (err) {
    threw = String(err.message).includes('sweep fee mismatch');
  }
  assert(threw, 'expected fee mismatch');
});

test('verifies observed sweep outputs against the committed route', () => {
  const route = routePlan();
  const result = verifyObservedSweepOutputs(route, route.outputPlan);
  assert(result.ok, result.reason);
  assertEq(result.payoutTotalSats, '99000');
});

test('rejects observed sweep outputs to the wrong recipient', () => {
  const route = routePlan();
  const result = verifyObservedSweepOutputs(route, [
    {
      address: 'tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22',
      sats: 25000
    },
    route.outputPlan[1]
  ]);
  assert(!result.ok, 'wrong destination should fail');
  assert(String(result.reason).includes('invalid Merkle proof'), 'expected invalid Merkle proof');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
