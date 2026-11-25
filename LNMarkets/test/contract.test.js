'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { xOnlyPubkey } = require('../../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig');
const { MAX_MONEY, canonicalJson, buildContractPlan, validateContractPlan } = require('../src/contract');

const key = (n) => xOnlyPubkey(BigInt(n)).toString('hex');
const keys = [11, 12, 21, 22, 23, 31, 32, 33].map(key);
function terms(overrides = {}) {
  return {
    schemaVersion: 1,
    network: 'bitcoin-regtest',
    quoteId: 'lnm-fixture-001',
    market: { venue: 'lnmarkets', instrument: 'inverse_perp', pair: 'btc_usd' },
    side: 'long',
    entryPriceUsdCents: '10000000',
    notionalUsdCents: '100000',
    traderCollateralSats: '200000',
    makerCollateralSats: '200000',
    settlementFeeSats: '1000',
    anchorSats: '330',
    minimumPayoutSats: '1000',
    traderPayoutScript: `5120${keys[2]}`,
    makerPayoutScript: `5120${keys[3]}`,
    anchorScript: `5120${keys[4]}`,
    traderPubkeyX: keys[0],
    makerPubkeyX: keys[1],
    refundCsvBlocks: 144,
    maturityHeight: 1000,
    refundHeight: 1200,
    oracleEventId: 'lnm/regtest/btc-usd/1000',
    settlementPricesUsdCents: ['9000000', '10000000', '11000000'],
    oracleThreshold: 2,
    oraclePubkeys: keys.slice(5),
    ...overrides
  };
}
const copy = (value) => JSON.parse(JSON.stringify(value));

test('USD cents produce exact inverse BTC payouts and round signed fractions toward zero', () => {
  const plan = buildContractPlan(terms());
  assert.deepEqual(plan.outcomes.map((o) => o.pnlSats), ['-111111', '0', '90909']);
  assert.deepEqual(plan.outcomes.map((o) => o.traderPayoutSats), ['88889', '200000', '290909']);
  assert.deepEqual(plan.outcomes.map((o) => o.makerPayoutSats), ['311111', '200000', '109091']);
  assert.equal(plan.fundingValueSats, '401330');
  assert.deepEqual(plan.refund, { traderPayoutSats: '200000', makerPayoutSats: '200000' });
  assert.equal(plan.outcomes.every((o) => !o.capped), true);
  const short = buildContractPlan(terms({ side: 'short' }));
  assert.deepEqual(short.outcomes.map((o) => o.pnlSats), ['111111', '0', '-90909']);
});

test('extreme prices stop at posted collateral while preserving both minimum payouts', () => {
  for (const side of ['long', 'short']) {
    const plan = buildContractPlan(terms({
      side, traderCollateralSats: '50000', makerCollateralSats: '80000',
      settlementPricesUsdCents: ['1', '10000000', '2100000000000000']
    }));
    assert.equal(plan.outcomes[0].capped, true);
    assert.equal(plan.outcomes[2].capped, true);
    assert.equal(plan.outcomes[1].pnlSats, '0');
    const payouts = plan.outcomes.map((o) => [o.traderPayoutSats, o.makerPayoutSats]);
    assert.deepEqual(payouts, side === 'long'
      ? [['1000', '129000'], ['50000', '80000'], ['129000', '1000']]
      : [['129000', '1000'], ['50000', '80000'], ['1000', '129000']]);
  }
});

test('price-grid invariants preserve collateral, monotonicity, cap bounds and rational rounding', () => {
  const prices = ['1', '100000', '1000000', '9000000', '10000000', '10000001', '11000000', '99999999', '2100000000000000'];
  for (const side of ['long', 'short']) {
    for (const notional of ['1', '99999', '100000', '2100000000000000']) {
      const plan = buildContractPlan(terms({ side, notionalUsdCents: notional, settlementPricesUsdCents: prices }));
      let previous;
      for (const outcome of plan.outcomes) {
        const trader = BigInt(outcome.traderPayoutSats);
        const maker = BigInt(outcome.makerPayoutSats);
        assert.equal(trader + maker, 400000n);
        assert.equal(trader + maker + 1000n + 330n, BigInt(plan.fundingValueSats));
        assert.ok(trader >= 1000n && maker >= 1000n);
        assert.ok(trader <= 399000n && maker <= 399000n);
        const pnl = BigInt(outcome.pnlSats);
        if (previous !== undefined) assert.ok(side === 'long' ? pnl >= previous : pnl <= previous);
        previous = pnl;
        const price = BigInt(outcome.priceUsdCents);
        const denominator = price * 10000000n;
        const signedNumerator = (side === 'long' ? 1n : -1n) * BigInt(notional) * 100000000n * (price - 10000000n);
        const roundedNumerator = BigInt(outcome.uncappedPnlSats) * denominator;
        const residual = signedNumerator - roundedNumerator;
        assert.ok((residual < 0n ? -residual : residual) < denominator);
        assert.ok(residual === 0n || (residual > 0n) === (signedNumerator > 0n));
        assert.equal(outcome.capped, pnl !== BigInt(outcome.uncappedPnlSats));
      }
    }
  }
});

test('fractional one-satoshi profit and loss round to zero without destroying collateral', () => {
  for (const side of ['long', 'short']) {
    const plan = buildContractPlan(terms({ side, notionalUsdCents: '1', settlementPricesUsdCents: ['9999999', '10000001'] }));
    assert.deepEqual(plan.outcomes.map((o) => o.pnlSats), ['0', '0']);
    assert.equal(plan.outcomes.every((o) => o.traderPayoutSats === '200000' && o.makerPayoutSats === '200000'), true);
  }
});

test('canonical plans round-trip through JSON and ignore object insertion order', () => {
  const original = terms();
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  reordered.market = Object.fromEntries(Object.entries(original.market).reverse());
  const plan = buildContractPlan(original);
  assert.deepEqual(buildContractPlan(reordered), plan);
  assert.deepEqual(validateContractPlan(copy(plan)), plan);
  assert.equal(plan.contractId, `lnm-${plan.planDigest}`);
  assert.equal(new Set(plan.outcomes.map((o) => o.outcomeMessage)).size, 3);
  assert.equal(canonicalJson(plan), canonicalJson(copy(plan)));
});

test('every economic or recovery term changes the digest and oracle outcome commitment', () => {
  const original = buildContractPlan(terms());
  const changes = [
    { quoteId: 'lnm-fixture-002' }, { side: 'short' }, { entryPriceUsdCents: '10000001' },
    { notionalUsdCents: '100001' }, { traderCollateralSats: '200001' },
    { makerCollateralSats: '200001' }, { settlementFeeSats: '1001' }, { anchorSats: '331' },
    { minimumPayoutSats: '1001' }, { traderPayoutScript: `5120${key(99)}` },
    { makerPayoutScript: `5120${key(99)}` }, { anchorScript: `5120${key(99)}` },
    { traderPubkeyX: key(99) }, { makerPubkeyX: key(99) }, { refundCsvBlocks: 145 },
    { maturityHeight: 1001 }, { refundHeight: 1201 }, { oracleEventId: 'lnm/regtest/btc-usd/1001' },
    { oraclePubkeys: [key(99), ...keys.slice(6)] },
    { settlementPricesUsdCents: ['9000000', '10000000', '11000001'] }
  ];
  for (const change of changes) {
    const changed = buildContractPlan(terms(change));
    assert.notEqual(changed.planDigest, original.planDigest, Object.keys(change)[0]);
    assert.notEqual(changed.outcomes[0].outcomeMessage, original.outcomes[0].outcomeMessage, Object.keys(change)[0]);
  }
});

test('plans detach and deeply freeze caller-owned terms', () => {
  const input = terms();
  const plan = buildContractPlan(input);
  input.oraclePubkeys[0] = key(99);
  input.market.pair = 'eth_usd';
  input.settlementPricesUsdCents[0] = '1';
  assert.equal(plan.terms.market.pair, 'btc_usd');
  assert.equal(plan.terms.oraclePubkeys[0], keys[5]);
  assert.equal(plan.terms.settlementPricesUsdCents[0], '9000000');
  for (const value of [plan, plan.terms, plan.terms.market, plan.terms.oraclePubkeys, plan.outcomes, plan.outcomes[0], plan.refund]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => { plan.outcomes[0].traderPayoutSats = '1'; }, TypeError);
});

test('saved plans reject altered payouts, identifiers, outpoints-independent terms and extra fields', () => {
  const original = buildContractPlan(terms());
  const mutations = [
    (p) => { p.kind = 'another-kind'; },
    (p) => { p.planDigest = '00'.repeat(32); },
    (p) => { p.contractId = 'different'; },
    (p) => { p.fundingValueSats = '1'; },
    (p) => { p.outcomes[0].traderPayoutSats = '1'; },
    (p) => { p.outcomes[0].uncappedPnlSats = '0'; },
    (p) => { p.outcomes[0].capped = true; },
    (p) => { p.outcomes[0].outcomeMessage = '00'.repeat(32); },
    (p) => { p.refund.traderPayoutSats = '1'; },
    (p) => { p.terms.refundHeight++; },
    (p) => { p.outcomes.push(copy(p.outcomes[0])); },
    (p) => { p.extra = true; },
    (p) => { delete p.outcomes; }
  ];
  for (const mutate of mutations) {
    const altered = copy(original);
    mutate(altered);
    assert.throws(() => validateContractPlan(altered));
  }
});

test('terms require the complete exact schema and supported regtest BTC/USD market', () => {
  const valid = terms();
  for (const field of Object.keys(valid)) {
    const incomplete = terms();
    delete incomplete[field];
    assert.throws(() => buildContractPlan(incomplete), /supported fields/);
  }
  for (const override of [
    { extra: true }, { schemaVersion: 2 }, { network: 'bitcoin-mainnet' },
    { network: 'bitcoin-testnet4' }, { side: 'buy' }, { side: '' },
    { quoteId: '' }, { quoteId: 'a'.repeat(129) }, { quoteId: 'bad quote' },
    { oracleEventId: 'a'.repeat(257) }, { oracleEventId: '../bad\n' },
    { market: { ...valid.market, extra: 'ignored' } },
    { market: { ...valid.market, pair: 'eth_usd' } },
    { market: { ...valid.market, instrument: 'quanto_perp' } },
    { market: { ...valid.market, venue: 'other' } }
  ]) assert.throws(() => buildContractPlan(terms(override)));
});

test('all monetary inputs reject floats, ambiguous decimal encodings and unbounded values', () => {
  const fields = ['entryPriceUsdCents', 'notionalUsdCents', 'traderCollateralSats', 'makerCollateralSats',
    'settlementFeeSats', 'anchorSats', 'minimumPayoutSats'];
  for (const field of fields) {
    for (const invalid of [1, 1n, NaN, Infinity, '-1', '+1', '1.0', '01', '1e6', '', ' 1', '1 ', '0', '9'.repeat(100)]) {
      assert.throws(() => buildContractPlan(terms({ [field]: invalid })), `${field}: ${String(invalid)}`);
    }
  }
  assert.throws(() => buildContractPlan(terms({ minimumPayoutSats: '999' })), /minimumPayoutSats/);
  assert.throws(() => buildContractPlan(terms({ traderCollateralSats: '1000' })), /traderCollateralSats/);
  assert.throws(() => buildContractPlan(terms({ makerCollateralSats: '1000' })), /makerCollateralSats/);
  assert.throws(() => buildContractPlan(terms({ anchorSats: '329' })), /anchorSats/);
  assert.throws(() => buildContractPlan(terms({ anchorSats: '10001' })), /anchorSats/);
  assert.throws(() => buildContractPlan(terms({ traderCollateralSats: MAX_MONEY.toString() })), /total funding/);
  assert.throws(() => buildContractPlan(terms({ entryPriceUsdCents: (MAX_MONEY + 1n).toString() })), /entryPriceUsdCents/);
});

test('height and relative-delay fields reject timestamp reinterpretation and premature refunds', () => {
  for (const field of ['maturityHeight', 'refundHeight', 'refundCsvBlocks']) {
    for (const invalid of ['144', NaN, Infinity, -0, -1, 1.5]) {
      assert.throws(() => buildContractPlan(terms({ [field]: invalid })));
    }
  }
  assert.throws(() => buildContractPlan(terms({ maturityHeight: 500000000 })), /maturityHeight/);
  assert.throws(() => buildContractPlan(terms({ refundHeight: 500000000 })), /refundHeight/);
  assert.throws(() => buildContractPlan(terms({ refundHeight: 1000 })), /refundHeight/);
  assert.throws(() => buildContractPlan(terms({ refundCsvBlocks: 65536 })), /refundCsvBlocks/);
  assert.doesNotThrow(() => buildContractPlan(terms({ refundCsvBlocks: 65535 })));
});

test('oracle and script identities reject missing quorum, duplicates and invalid curve points', () => {
  const valid = terms();
  for (const override of [
    { oracleThreshold: 1 }, { oracleThreshold: 3 }, { oracleThreshold: '2' },
    { oraclePubkeys: keys.slice(5, 7) }, { oraclePubkeys: [...keys.slice(5), key(99)] },
    { oraclePubkeys: [keys[5], keys[5], keys[7]] },
    { oraclePubkeys: ['ff'.repeat(32), keys[6], keys[7]] },
    { traderPubkeyX: keys[1] }, { makerPubkeyX: '00'.repeat(32) },
    { traderPubkeyX: keys[0].toUpperCase() }, { makerPubkeyX: '01' },
    { traderPayoutScript: valid.makerPayoutScript }, { anchorScript: valid.traderPayoutScript },
    { makerPayoutScript: `5120${'00'.repeat(32)}` }, { traderPayoutScript: `0014${'11'.repeat(20)}` }
  ]) assert.throws(() => buildContractPlan(terms(override)));
});

test('settlement prices are a bounded ordered enumeration with no implicit rounding buckets', () => {
  for (const prices of [[], ['0'], ['01'], [1], ['1.01'], ['2', '1'], ['1', '1'], Array.from({ length: 10 }, (_, i) => String(i + 1))]) {
    assert.throws(() => buildContractPlan(terms({ settlementPricesUsdCents: prices })));
  }
  assert.equal(buildContractPlan(terms({ settlementPricesUsdCents: ['10000000'] })).outcomes.length, 1);
});

test('canonical ingress rejects accessors without invoking them and refuses non-JSON objects', () => {
  let evaluated = false;
  const withGetter = terms();
  Object.defineProperty(withGetter, 'notionalUsdCents', { enumerable: true, get() { evaluated = true; return '100000'; } });
  assert.throws(() => buildContractPlan(withGetter), /enumerable data property/);
  assert.equal(evaluated, false);
  const sparse = new Array(3);
  sparse[0] = keys[5];
  sparse[2] = keys[7];
  assert.throws(() => buildContractPlan(terms({ oraclePubkeys: sparse })), /dense array/);
  assert.throws(() => buildContractPlan(new Proxy(terms(), {})), /Proxy/);
  assert.throws(() => buildContractPlan(terms({ market: new Date() })), /plain objects/);
  const symbol = terms();
  symbol[Symbol('hidden')] = true;
  assert.throws(() => buildContractPlan(symbol), /symbol properties/);
});
