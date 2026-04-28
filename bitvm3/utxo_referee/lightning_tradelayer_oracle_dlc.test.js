#!/usr/bin/env node

const {
  encodeTradeLayerPublishOracleData,
  decodeTradeLayerPublishOracleData,
  buildOpReturnScriptHex,
  buildTradeLayerPricePublishTrigger,
  buildBilateralLnDlcContract,
  selectOutcomeForPrice,
  buildLightningTradeLayerOracleDlcBundle,
  verifyLightningTradeLayerOracleDlcBundle
} = require('./lightning_tradelayer_oracle_dlc');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  OK  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `expected ${expected}, got ${actual}`);
  }
}

console.log('\n=== Lightning TradeLayer Oracle DLC Tests ===\n');

test('TradeLayer tx14 price publish encoding matches local BTCTEST payload', () => {
  const payload = encodeTradeLayerPublishOracleData({ oracleId: 1, price: 65000 });
  assertEq(payload, 'tle1,aqzr7k');
  const decoded = decodeTradeLayerPublishOracleData(payload);
  assertEq(decoded.txType, 14);
  assertEq(decoded.oracleId, 1);
  assertEq(decoded.price, '65000');
  assertEq(buildOpReturnScriptHex(payload), '6a0b746c65312c61717a72376b');
});

test('price publish trigger binds payload, OP_RETURN script, and proof shape', () => {
  const trigger = buildTradeLayerPricePublishTrigger({
    oracleId: 1,
    price: '65000',
    publishTxid: '22accff5ad661d6bc9fcf8d972ef822305965da866f597dade40ac322124fd63'
  });
  assertEq(trigger.kind, 'tradelayer_tx14_price_publish_trigger');
  assertEq(trigger.payloadText, 'tle1,aqzr7k');
  assert(trigger.opReturnScriptHex.startsWith('6a'), 'missing OP_RETURN');
  assertEq(trigger.proofShape.txid, trigger.publishTxid);
  assertEq(trigger.proofShape.requiredPayloadHash, trigger.payloadHash);
});

test('bilateral Lightning DLC has BTC-only collateral and no TAP asset path', () => {
  const contract = buildBilateralLnDlcContract();
  assertEq(contract.kind, 'lightning_bilateral_dlc_contract');
  assertEq(contract.contractCore.settlementAsset, 'btc-only');
  assertEq(contract.contractCore.tapAssetsUsed, false);
  assertEq(contract.lightningFunding.mode, 'bilateral-ln-hold-invoices');
  assertEq(contract.lightningFunding.receipts.length, 2);
  assert(contract.lightningFunding.receipts.every(receipt => receipt.paymentHashHex.length === 64));
});

test('TradeLayer published price selects exactly one DLC outcome bucket', () => {
  const contract = buildBilateralLnDlcContract();
  const trigger = buildTradeLayerPricePublishTrigger({ oracleId: 1, price: 65000 });
  const selected = selectOutcomeForPrice(contract.outcomes, trigger.scaledPrice);
  assert(selected, 'missing selected outcome');
  assertEq(selected.outcomeId, 'price_at_entry');
  assertEq(
    BigInt(selected.longPayoutSats) + BigInt(selected.shortPayoutSats),
    BigInt(contract.contractCore.totalCollateralSats)
  );
});

test('bundle verifies and exposes a slashable wrong-CET BitVM challenge', () => {
  const bundle = buildLightningTradeLayerOracleDlcBundle({
    trigger: {
      publishTxid: '22accff5ad661d6bc9fcf8d972ef822305965da866f597dade40ac322124fd63',
      price: 65000
    },
    challengeClaimedOutcomeId: 'price_above_entry'
  });
  const result = verifyLightningTradeLayerOracleDlcBundle(bundle);
  assert(result.ok, result.reason);
  assertEq(bundle.trigger.payloadText, 'tle1,aqzr7k');
  assertEq(bundle.settlement.settlementCore.settlementRail, 'lightning');
  assertEq(bundle.settlement.settlementCore.tapAssetsUsed, false);
  assert(bundle.challenge.slashable, 'wrong-CET challenge should be slashable');
  assert(
    bundle.challenge.challengeCore.violations.includes('wrong_cet_for_published_price'),
    'missing wrong-CET violation'
  );
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
