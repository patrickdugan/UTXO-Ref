/**
 * Run: node bitvm3/utxo_referee/tradelayer_pnl_route_adapter.test.js
 */

const {
  addressToScriptPubKey,
  computeTradeLayerPlanHash,
  buildTradeLayerSendRoutePlan,
  buildTradeLayerPnlCommitment,
  verifyTradeLayerPnlRoutePlan,
  verifyTradeLayerSendRoutePlan
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const ROUTE_PLAN = {
  revealTxid: 'cad205c65afaf6b2dc72f3e6e47e9b7fc3d3284d7ed95c5f965bfced2a0327b1',
  payloadHash: 'db736014390df5c72d66fa365f6307b74d5fe1bfaed620bc0bfb87564117a1fd',
  planHash: 'b55881472150bad9c821926d81cc9963c48f4f5b35583df8b88e07cb163ba895',
  dlcInput: {
    txid: '26228560e070a76e7516aaa502d2e74acdf2359f71ea9aa7b5d8623279c5d510',
    vout: 0,
    address: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
    amount: 0.001,
    sats: 100000
  },
  feeSats: 2000,
  outputPlan: [
    {
      address: 'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz',
      sats: 98000,
      amount: 0.00098
    }
  ],
  envelope: {
    dlcRef: 'ltc-testnet-epoch-2-1777489615629-fda7a8a8'
  }
};

const SEND_INTENT = {
  revealTxid: '58ff891cf904aaa6b85f8f34e20637d8b6ef7fbc7baa2cfeff41fd9bf6481d7f',
  dlcInput: {
    txid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    vout: 1,
    address: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
    sats: 100000
  },
  oracleAddress: 'tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22',
  refundAddress: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
  sendBps: 2500,
  feeSats: 1000,
  dlcFunderRegistry: {
    tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22: {
      dlcRef: 'dlc-next-epoch-42',
      dlcAddress: 'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz'
    }
  }
};

console.log('\n=== TradeLayer PNL Route Adapter Tests ===\n');

test('decodes Litecoin testnet segwit address into scriptPubKey', () => {
  const spk = addressToScriptPubKey(
    'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz',
    'litecoin-testnet'
  );
  assertEq(spk.toString('hex'), '0014fb5602448f1f61d21da016ad854cc6d09302e4b2');
});

test('recomputes the TradeLayer route plan hash exactly', () => {
  assertEq(computeTradeLayerPlanHash(ROUTE_PLAN), ROUTE_PLAN.planHash);
});

test('builds a UTXORef commitment for the routed PNL output vector', () => {
  const bundle = buildTradeLayerPnlCommitment(ROUTE_PLAN);
  assert(bundle.withdrawalRootHex.length === 64, 'withdrawal root should be 32 bytes');
  assert(bundle.commitmentHashHex.length === 64, 'commitment hash should be 32 bytes');
  assertEq(bundle.payoutTotalSats.toString(), '98000');
});

test('verifies the route plan as payout vector plus explicit miner fee', () => {
  const result = verifyTradeLayerPnlRoutePlan(ROUTE_PLAN);
  assert(result.ok, result.reason);
  assertEq(result.payoutTotalSats, '98000');
  assertEq(result.feeSats, '2000');
});

test('rejects a changed route plan hash', () => {
  const bad = clone(ROUTE_PLAN);
  bad.outputPlan[0].sats = 97999;
  const result = verifyTradeLayerPnlRoutePlan(bad);
  assert(!result.ok, 'mutated plan should fail');
  assert(String(result.reason).includes('planHash mismatch'), 'expected planHash mismatch');
});

test('rejects an observed output that does not match the committed payout leaf', () => {
  const result = verifyTradeLayerPnlRoutePlan(ROUTE_PLAN, {
    observedOutputs: [
      {
        address: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
        sats: 98000
      }
    ]
  });
  assert(!result.ok, 'wrong recipient should fail');
  assert(String(result.reason).includes('invalid Merkle proof'), 'expected invalid proof');
});

test('rejects payout plus fee accounting mismatch', () => {
  const bad = clone(ROUTE_PLAN);
  bad.feeSats = 1999;
  const result = verifyTradeLayerPnlRoutePlan(bad);
  assert(!result.ok, 'wrong fee should fail');
  assert(String(result.reason).includes('route accounting mismatch'), 'expected accounting mismatch');
});

test('builds a send route that maps a TL recipient funder to its DLC output', () => {
  const routePlan = buildTradeLayerSendRoutePlan(SEND_INTENT);
  assertEq(routePlan.route, 'send');
  assertEq(routePlan.sendSats, '25000');
  assertEq(routePlan.residualSats, '74000');
  assertEq(routePlan.resolvedDestinationAddress, 'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz');
  assertEq(routePlan.outputPlan[0].role, 'send-to-dlc-funding-output');
  assertEq(routePlan.outputPlan[0].matchedDlcRef, 'dlc-next-epoch-42');
});

test('verifies a percent-of-deposit send route including refund remainder', () => {
  const result = verifyTradeLayerSendRoutePlan(SEND_INTENT);
  assert(result.ok, result.reason);
  assertEq(result.sendBps, 2500);
  assertEq(result.sendSats, '25000');
  assertEq(result.payoutTotalSats, '99000');
  assertEq(result.feeSats, '1000');
});

test('rejects a send route sweep to the oracle address when registry maps it to a DLC address', () => {
  const result = verifyTradeLayerSendRoutePlan(SEND_INTENT, {
    observedOutputs: [
      {
        address: 'tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22',
        sats: 25000
      },
      {
        address: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
        sats: 74000
      }
    ]
  });
  assert(!result.ok, 'wrong mapped recipient should fail');
  assert(String(result.reason).includes('invalid Merkle proof'), 'expected invalid proof');
});

test('rejects a send route amount that does not equal the committed basis points', () => {
  const bad = clone(SEND_INTENT);
  bad.sendSats = 25001;
  let threw = false;
  try {
    verifyTradeLayerSendRoutePlan(bad);
  } catch (err) {
    threw = String(err.message).includes('send amount mismatch');
  }
  assert(threw, 'expected send amount mismatch');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
