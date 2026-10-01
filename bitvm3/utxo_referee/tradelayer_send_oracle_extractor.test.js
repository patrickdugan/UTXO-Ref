/**
 * Run: node bitvm3/utxo_referee/tradelayer_send_oracle_extractor.test.js
 */

const {
  decimalToUnits,
  buildTradeLayerSendStateOracleFromConsensus
} = require('./tradelayer_send_oracle_extractor');
const {
  verifyTradeLayerSendStateOracleRoute
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
      txType: 1,
      txid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      valid: true
    },
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

console.log('\n=== TradeLayer Send Oracle Extractor Tests ===\n');

test('converts decimal token amounts into integer units', () => {
  assertEq(decimalToUnits('1.25', 'amount'), '125000000');
  assertEq(decimalToUnits('0.00000001', 'amount'), '1');
});

test('extracts only consensus-valid tx type 2 sends into state oracle blob', () => {
  const blob = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  assertEq(blob.sends.length, 1);
  assertEq(blob.sends[0].id, 'live-send');
  assertEq(blob.sends[0].amountUnits, '2500');
  assertEq(blob.sends[0].depositUnits, '10000');
  assertEq(blob.source.sourceRowCount, 3);
  assertEq(blob.source.validSendCount, 1);
  assertEq(blob.source.skippedCount, 2);
  assertEq(blob.source.sourceHash.length, 64);
});

test('extracted state oracle blob verifies through the BitVM route adapter', () => {
  const blob = buildTradeLayerSendStateOracleFromConsensus(CONSENSUS_INPUT, {
    selectedSendId: 'live-send'
  });
  const result = verifyTradeLayerSendStateOracleRoute(blob);
  assert(result.ok, result.reason);
  assertEq(result.sendBps, 2500);
  assertEq(result.sendSats, '25000');
  assertEq(result.residualSats, '74000');
  assertEq(result.matchedDlcRef, 'dlc-live-77');
});

test('expands TradeLayer multi-send rows into individually selectable sends', () => {
  const blob = buildTradeLayerSendStateOracleFromConsensus({
    ...CONSENSUS_INPUT,
    selectedSendId: 'multi:1',
    depositUnits: '20000',
    dlcInputs: {
      'multi:1': CONSENSUS_INPUT.dlcInputs['live-send']
    },
    transactions: [
      {
        txType: 2,
        id: 'multi',
        txid: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        senderAddress: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
        recipientAddresses: [
          'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
          'tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22'
        ],
        propertyIds: [380, 380],
        amounts: ['2500', '5000'],
        valid: true
      }
    ]
  });

  assertEq(blob.sends.length, 2);
  assertEq(blob.sends[1].id, 'multi:1');
  assertEq(blob.sends[1].amountUnits, '5000');
  assertEq(blob.sends[1].depositUnits, '20000');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
