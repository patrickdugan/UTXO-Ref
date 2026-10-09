#!/usr/bin/env node

const {
  buildSukukStablecoinHalalDefiPortfolio,
  verifySukukStablecoinHalalDefiPortfolio,
  verifyDynamicHawalaRouteQuote,
  verifyTradeLayerArbMandate,
  verifyTaprootStablecoinPledge
} = require('./sukuk_stablecoin_halal_defi');

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
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

console.log('\n=== Sukuk Stablecoin Halal DeFi Tests ===\n');

test('portfolio verifies with reserve, TAP pledge, routing market, and arb mandate', () => {
  const portfolio = buildSukukStablecoinHalalDefiPortfolio();
  const result = verifySukukStablecoinHalalDefiPortfolio(portfolio);

  assert(result.ok, result.reason);
  assertEq(portfolio.reserve.reserveCore.stablecoinPropertyId, 9001);
  assert(portfolio.portfolioCore.totalServiceFeeUnits !== '0', 'service fees should be non-zero');
});

test('stablecoin principal is separated from service fees', () => {
  const portfolio = buildSukukStablecoinHalalDefiPortfolio();

  assertEq(portfolio.issuance.issuanceCore.yieldEntitlement, false);
  assertEq(portfolio.issuance.issuanceCore.reserveRevenueClaim, false);
  assert(portfolio.routingMarket.feeCreditEvents.every((event) => event.eventCore.feeCharacter.includes('not_interest')));
  assert(portfolio.arbMandate.revenueEvents.every((event) => event.eventCore.feeCharacter.includes('not_interest')));
});

test('taproot pledge verifies and stays within issued stablecoin supply', () => {
  const portfolio = buildSukukStablecoinHalalDefiPortfolio();
  const result = verifyTaprootStablecoinPledge(portfolio.taprootPledge, portfolio.issuance);

  assert(result.ok, result.reason);
  assert(BigInt(portfolio.taprootPledge.pledgeCore.lockedUnits) <= BigInt(portfolio.issuance.issuanceCore.amountUnits));
  assert(portfolio.taprootPledge.taprootVerification.ok, portfolio.taprootPledge.taprootVerification.reason);
});

test('dynamic hawala quotes compute bounded service fees', () => {
  const portfolio = buildSukukStablecoinHalalDefiPortfolio();

  for (const quote of portfolio.routingMarket.routeQuotes) {
    const result = verifyDynamicHawalaRouteQuote(quote, portfolio.taprootPledge);
    assert(result.ok, result.reason);
    assert(quote.quoteCore.computedFeeBps <= quote.quoteCore.feeCapBps, 'fee cap exceeded');
    assertEq(quote.quoteCore.feeCharacter, 'routing_and_settlement_service_fee_not_interest');
  }
});

test('arb mandate bans leverage, lending, shorting, and guaranteed returns', () => {
  const portfolio = buildSukukStablecoinHalalDefiPortfolio();
  const result = verifyTradeLayerArbMandate(portfolio.arbMandate, portfolio.issuance);
  const constraints = portfolio.arbMandate.mandateCore.constraints;

  assert(result.ok, result.reason);
  assertEq(constraints.leverageAllowed, false);
  assertEq(constraints.borrowLendAllowed, false);
  assertEq(constraints.shortSellingAllowed, false);
  assertEq(constraints.guaranteedReturnAllowed, false);
});

test('verifier rejects DeFi allocation exceeding issued stablecoin units', () => {
  const portfolio = buildSukukStablecoinHalalDefiPortfolio({ mintedUnits: 2500000000n });
  const result = verifySukukStablecoinHalalDefiPortfolio(portfolio);

  assert(!result.ok, 'overallocated portfolio should fail');
  assert(String(result.reason).includes('defi allocation exceeds issued stablecoin units'));
});

test('verifier rejects tampered arb halal constraints', () => {
  const portfolio = clone(buildSukukStablecoinHalalDefiPortfolio());
  portfolio.arbMandate.mandateCore.constraints.leverageAllowed = true;
  const result = verifySukukStablecoinHalalDefiPortfolio(portfolio);

  assert(!result.ok, 'tampered arb constraints should fail');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
