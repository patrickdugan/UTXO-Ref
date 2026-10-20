/**
 * Run: node bitvm3/utxo_referee/tradelayer_perp_pnl_referee.test.js
 */

const { sha256Hex } = require('./tradelayer_pnl_route_adapter');
const {
  buildTradeLayerPerpPnlSettlement,
  verifyTradeLayerPerpPnlSettlement,
  buildTradeLayerPerpPnlChallenge,
  verifyTradeLayerPerpPnlChallenge
} = require('./tradelayer_perp_pnl_referee');

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

const POSITION = {
  contractId: 'tl-perp-1',
  side: 'short',
  entryPrice: 2200,
  quantityUnits: 100,
  collateralSats: 50000,
  traderAddress: 'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz',
  counterpartyAddress: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa'
};

console.log('\n=== TradeLayer Perp PNL Referee Tests ===\n');

test('settles short-side PNL into UTXORef payout outputs', () => {
  const settlement = buildTradeLayerPerpPnlSettlement({
    epochId: 7,
    position: POSITION,
    close: {
      txid: '11'.repeat(32),
      price: 2100,
      vwap: { price: 2100, samples: 3 }
    }
  });
  const result = verifyTradeLayerPerpPnlSettlement(settlement);

  assert(result.ok, result.reason);
  assertEq(result.transferSats, '10000');
  assertEq(result.winnerAddress, POSITION.traderAddress);
  assertEq(settlement.settlementCore.outputs[0].role, 'pnl-winner');
});

test('rejects settlement hash tampering', () => {
  const settlement = buildTradeLayerPerpPnlSettlement({
    position: POSITION,
    close: { price: 2100 }
  });
  const tampered = clone(settlement);
  tampered.settlementCore.transferSats = '1';
  const result = verifyTradeLayerPerpPnlSettlement(tampered);

  assert(!result.ok, 'tampered settlement should fail');
  assert(String(result.reason).includes('settlement hash mismatch'), 'expected hash mismatch');
});

test('rejects outputs that do not follow from the committed position and close', () => {
  const honest = buildTradeLayerPerpPnlSettlement({ position: POSITION, close: { price: 2100 } });
  // A larger honest settlement whose winner payout is 1 BTC; its outputs and root are internally consistent.
  const large = buildTradeLayerPerpPnlSettlement({
    position: { ...POSITION, collateralSats: 100000000 },
    close: { price: 2200 - 1000000 }
  });
  const forged = clone(honest);
  forged.settlementCore.outputs = large.settlementCore.outputs;
  forged.settlementCore.withdrawalRootHex = large.settlementCore.withdrawalRootHex;
  forged.settlementCore.commitmentHashHex = large.settlementCore.commitmentHashHex;
  forged.payout = large.payout;
  forged.settlementHash = sha256Hex(forged.settlementCore);
  const result = verifyTradeLayerPerpPnlSettlement(forged);

  assert(!result.ok, 'outputs inconsistent with the committed PNL must not verify');
});

test('refuses a zero quantity instead of defaulting it to one', () => {
  let threw = false;
  try {
    buildTradeLayerPerpPnlSettlement({ position: { ...POSITION, quantityUnits: 0 }, close: { price: 2100 } });
  } catch (err) {
    threw = String(err.message).includes('quantityUnits must be positive');
  }
  assert(threw, 'quantityUnits 0 must be rejected');
});

test('builds challengeable wrong-pnl and wrong-destination proofs', () => {
  const settlement = buildTradeLayerPerpPnlSettlement({
    position: POSITION,
    close: { price: 2100 }
  });
  const pnl = buildTradeLayerPerpPnlChallenge(settlement, { challengeType: 'wrong_pnl_transfer' });
  const dest = buildTradeLayerPerpPnlChallenge(settlement, { challengeType: 'wrong_destination' });

  assert(verifyTradeLayerPerpPnlChallenge(pnl, settlement).ok, 'pnl challenge should verify');
  assert(verifyTradeLayerPerpPnlChallenge(dest, settlement).ok, 'destination challenge should verify');
  assert(pnl.challengeable, 'pnl challenge should be challengeable');
  assert(dest.challengeable, 'destination challenge should be challengeable');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
