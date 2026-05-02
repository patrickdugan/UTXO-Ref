/**
 * Run: node bitvm3/utxo_referee/tradelayer_send_rpc_sweep.test.js
 */

const {
  buildTradeLayerSendStateOracleFromConsensus
} = require('./tradelayer_send_oracle_extractor');
const {
  buildTradeLayerSendIntentFromStateOracle,
  buildTradeLayerSendRoutePlan
} = require('./tradelayer_pnl_route_adapter');
const {
  buildTradeLayerSendSweepPlan
} = require('./tradelayer_send_sweep_psbt');
const {
  createPsbtParams,
  executeTradeLayerSendRpcSweep,
  attachRpcSweepToSweepPlan
} = require('./tradelayer_send_rpc_sweep');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
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

function sampleSweepPlan() {
  const stateOracle = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  const sendIntent = buildTradeLayerSendIntentFromStateOracle(stateOracle, { sendId: 'live-send' });
  const routePlan = buildTradeLayerSendRoutePlan(sendIntent);
  return buildTradeLayerSendSweepPlan(routePlan);
}

function mockRpc(calls, overrides = {}) {
  return async function rpc(method, params, wallet) {
    calls.push({ method, params, wallet: wallet || null });
    if (overrides[method]) return overrides[method](params, wallet);
    if (method === 'createpsbt') return 'unsigned-psbt';
    if (method === 'walletprocesspsbt') return { complete: true, psbt: 'signed-psbt' };
    if (method === 'finalizepsbt') return { complete: true, hex: '020000000001' };
    if (method === 'decoderawtransaction') {
      return {
        txid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        vsize: 123,
        locktime: 0
      };
    }
    if (method === 'testmempoolaccept') return [{ allowed: true }];
    if (method === 'sendrawtransaction') return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    throw new Error(`unexpected RPC method: ${method}`);
  };
}

async function run() {
  console.log('\n=== TradeLayer Send RPC Sweep Tests ===\n');

  await test('extracts createpsbt params from the deterministic sweep plan', () => {
    const params = createPsbtParams(sampleSweepPlan());
    assertEq(params[0][0].vout, 1);
    assertEq(params[1][0].tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz, '0.00025000');
    assertEq(params[1][1].tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa, '0.00074000');
    assertEq(params[2], 0);
    assertEq(params[3], true);
  });

  await test('signs and finalizes without broadcasting by default', async () => {
    const calls = [];
    const result = await executeTradeLayerSendRpcSweep(sampleSweepPlan(), {
      rpc: mockRpc(calls),
      wallet: 'tl-wallet'
    });

    assert(result.ok, result.error);
    assertEq(result.status, 'finalized');
    assertEq(result.broadcast.attempted, false);
    assertEq(result.decodedTx.txid, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert(calls.some((call) => call.method === 'walletprocesspsbt' && call.wallet === 'tl-wallet'), 'wallet signer call missing');
    assert(!calls.some((call) => call.method === 'sendrawtransaction'), 'should not broadcast');
  });

  await test('broadcasts only when requested', async () => {
    const calls = [];
    const result = await executeTradeLayerSendRpcSweep(sampleSweepPlan(), {
      rpc: mockRpc(calls),
      wallet: 'tl-wallet',
      broadcast: true
    });

    assert(result.ok, result.error);
    assertEq(result.status, 'broadcast');
    assertEq(result.broadcast.sent, true);
    assert(calls.some((call) => call.method === 'sendrawtransaction'), 'broadcast call missing');
  });

  await test('returns incomplete status if finalization does not produce hex', async () => {
    const result = await executeTradeLayerSendRpcSweep(sampleSweepPlan(), {
      rpc: mockRpc([], {
        finalizepsbt: () => ({ complete: false })
      }),
      wallet: 'tl-wallet'
    });

    assert(!result.ok, 'incomplete result should not be ok');
    assertEq(result.status, 'incomplete');
    assertEq(result.error, 'PSBT finalization incomplete');
  });

  await test('attaches finalized tx details back to the sweep plan', async () => {
    const sweepPlan = sampleSweepPlan();
    const result = await executeTradeLayerSendRpcSweep(sweepPlan, {
      rpc: mockRpc([]),
      wallet: 'tl-wallet'
    });
    const attached = attachRpcSweepToSweepPlan(sweepPlan, result);

    assertEq(attached.status, 'attached');
    assertEq(attached.liveTxid, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assertEq(attached.signedPsbt, 'signed-psbt');
    assertEq(attached.finalHex, '020000000001');
  });

  if (failed > 0) {
    console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
    process.exit(1);
  }

  console.log(`\nPASS: ${passed} tests\n`);
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
