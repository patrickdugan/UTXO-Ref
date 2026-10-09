#!/usr/bin/env node

const {
  encodeTradeLayerPublishOracleData,
  decodeTradeLayerPublishOracleData,
  buildOpReturnScriptHex,
  priceDeviationBps,
  buildTradeLayerVwapStateOracle,
  verifyTradeLayerVwapStateOracle,
  buildTradeLayerVwapStateOracleChallenge,
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
  assertEq(trigger.publisherAddress, trigger.designatedOracleAddress);
  assert(trigger.solvencyGuard.withinBand, 'default publish should be inside solvency band');
  assert(trigger.priceDeviationBps <= 500, 'default publish should stay inside 5% band');
  assertEq(trigger.proofShape.requiredPublisherAddressHash, trigger.oracleAddressProof.addressCommitmentHash);
  assertEq(priceDeviationBps('640000000', '650000000'), 156);
});

test('bilateral Lightning DLC has BTC-only collateral and no TAP asset path', () => {
  const contract = buildBilateralLnDlcContract();
  assertEq(contract.kind, 'lightning_bilateral_dlc_contract');
  assertEq(contract.contractCore.settlementAsset, 'btc-only');
  assertEq(contract.contractCore.tapAssetsUsed, false);
  assertEq(contract.contractCore.oraclePolicy.maxDeviationBps, 500);
  assertEq(contract.contractCore.oraclePolicy.designatedOracleAddressHash.length, 64);
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

test('TradeLayer VWAP state oracle commits valid trades and bounded mark movement', () => {
  const vwap = buildTradeLayerVwapStateOracle();
  assertEq(vwap.kind, 'tradelayer_vwap_state_oracle_trigger');
  assertEq(vwap.summaryCore.vwapPrice, '65020');
  assertEq(vwap.summaryCore.validTradeCount, 3);
  assertEq(vwap.summaryCore.totalBaseAmountSats, '10000000');
  assertEq(vwap.summaryCore.totalQuoteAmountMicrousd, '6502000000');
  assertEq(vwap.summaryCore.priceDeviationBps, 159);
  assert(vwap.solvencyGuard.withinBand, 'VWAP should stay inside 5% band');
  const result = verifyTradeLayerVwapStateOracle(vwap, {
    designatedOracleAddress: vwap.designatedOracleAddress,
    lastAcceptedScaledPrice: vwap.summaryCore.lastAcceptedScaledPrice,
    maxDeviationBps: vwap.summaryCore.maxDeviationBps
  });
  assert(result.ok, result.reason);
});

test('TradeLayer VWAP challenge catches bad arithmetic against the valid trade set', () => {
  const vwap = buildTradeLayerVwapStateOracle();
  const challenge = buildTradeLayerVwapStateOracleChallenge(vwap, {
    claimedVwapScaledPrice: '650000000'
  });
  assert(challenge.slashable, 'bad VWAP arithmetic should be slashable');
  assert(
    challenge.challengeCore.violations.includes('bad_vwap_arithmetic'),
    'missing bad VWAP arithmetic violation'
  );
  assertEq(challenge.gateCounts.reduce((sum, gate) => sum + gate.count, 0), 1056);
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
  assertEq(bundle.bitvmOrganizer.gateCounts.reduce((sum, gate) => sum + gate.count, 0), 888);
  assertEq(bundle.vwapStateOracle.summaryCore.vwapPrice, '65020');
  assert(bundle.vwapChallenge.slashable, 'VWAP fraud-proof challenge should be slashable');
  assert(bundle.challenge.slashable, 'wrong-CET challenge should be slashable');
  assert(
    bundle.challenge.challengeCore.violations.includes('wrong_cet_for_published_price'),
    'missing wrong-CET violation'
  );
});

test('bundle rejects a TradeLayer price publish from the wrong oracle address', () => {
  const bundle = buildLightningTradeLayerOracleDlcBundle({
    trigger: {
      price: 65000,
      publisherAddress: 'tb1qwrongtradelayerpublisher0000000000000000000'
    }
  });
  const result = verifyLightningTradeLayerOracleDlcBundle(bundle);
  assert(!result.ok, 'wrong publisher should fail');
  assertEq(result.reason, 'designated oracle address mismatch');
});

test('bundle rejects a TradeLayer price publish outside the 5% solvency band', () => {
  const bundle = buildLightningTradeLayerOracleDlcBundle({
    trigger: {
      price: 72000
    }
  });
  const result = verifyLightningTradeLayerOracleDlcBundle(bundle);
  assert(!result.ok, 'out-of-band price should fail');
  assertEq(result.reason, 'price outside 5pct solvency band');
  assert(
    bundle.challenge.challengeCore.violations.includes('price_outside_5pct_solvency_band'),
    'missing out-of-band challenge violation'
  );
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
