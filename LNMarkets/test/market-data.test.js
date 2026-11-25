'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReferenceQuote, verifyReferenceQuote, bindReferenceToTerms, fetchReferenceQuote } = require('../src/market-data');

const nowMs = Date.parse('2026-11-19T12:00:00.000Z');
const ticker = (overrides = {}) => ({ instrument: 'inverse_perp', pair: 'btc_usd', time: new Date(nowMs).toISOString(), mark: 100000.125, ...overrides });
const reference = (overrides = {}) => normalizeReferenceQuote({ ticker: ticker(), apiNetwork: 'signet', receivedAtMs: nowMs, nowMs, ...overrides });

test('public mark is an expiring cent-quantized reference bound into terms', () => {
  const quote = reference();
  assert.equal(quote.priceUsdCents, '10000012');
  assert.equal(quote.executable, false);
  assert.equal(quote.rounding, 'truncate-to-cent');
  assert.deepEqual(verifyReferenceQuote(quote, { nowMs: nowMs + 500 }), quote);
  const terms = { market: quote.market, quoteId: `lnm-reference-${quote.referenceId}`, entryPriceUsdCents: quote.priceUsdCents };
  assert.deepEqual(bindReferenceToTerms(terms, quote, { nowMs }), terms);
  assert.throws(() => bindReferenceToTerms({ ...terms, entryPriceUsdCents: '1' }, quote, { nowMs }), /do not match/);
  assert.throws(() => verifyReferenceQuote({ ...quote, executable: true }, { nowMs }), /changed/);
  assert.throws(() => verifyReferenceQuote({ ...quote, priceUsdCents: '1' }, { nowMs }), /changed/);
  assert.throws(() => verifyReferenceQuote(quote, { nowMs: quote.expiresAtMs }), /expired/);
});

test('reject stale, future, wrong-market, malformed and invalid-price observations', () => {
  for (const values of [
    { time: '2026-11-19T11:59:00.000Z' },
    { time: '2026-11-19T12:00:03.000Z' },
    { time: '2026-02-30T12:00:00.000Z' },
    { time: '2026-11-19 12:00:00' },
    { instrument: 'quanto_perp' },
    { pair: 'eth_usd' },
    { mark: null }, { mark: NaN }, { mark: Infinity },
    { mark: -1 }, { mark: 0 }, { mark: '1e5' }, { mark: '0.001' }
  ]) assert.throws(() => reference({ ticker: ticker(values) }));
  assert.throws(() => reference({ receivedAtMs: nowMs + 1 }));
  assert.throws(() => reference({ apiNetwork: 'https://attacker.invalid' }));
  assert.throws(() => reference({ nowMs: nowMs + 16_000 }));
  const withZeroFraction = reference({ ticker: ticker({ time: '2026-11-19T12:00:00Z' }) });
  assert.equal(withZeroFraction.timestampMs, nowMs);
});

function mockFetch({ markets, tick = ticker(), status = 200, contentType = 'application/json' } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const body = url.endsWith('/markets') ? markets || [{ instrument: 'inverse_perp', pair: 'btc_usd', status: 'released', quantityUnit: 'usd' }] : tick;
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
    }
  };
}

test('fetch uses two fixed public GETs with redirect and credential restrictions', async () => {
  const { calls, fetchImpl } = mockFetch();
  const quote = await fetchReferenceQuote({ fetchImpl, clock: () => nowMs });
  assert.equal(quote.apiNetwork, 'signet');
  assert.deepEqual(calls.map((c) => c.url), [
    'https://api.signet.lnmarkets.com/v3/markets',
    'https://api.signet.lnmarkets.com/v3/perp/ticker?instrument=inverse_perp&pair=btc_usd'
  ]);
  for (const { init } of calls) {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, { Accept: 'application/json' });
    assert.equal(init.body, undefined);
  }
});

test('unknown/disabled markets and HTTP errors fail without retries or a ticker fallback', async () => {
  for (const args of [
    { markets: [] },
    { markets: [{ instrument: 'inverse_perp', pair: 'btc_usd', status: 'hidden', quantityUnit: 'usd' }] },
    { markets: [{ instrument: 'inverse_perp', pair: 'btc_usd', status: 'released', quantityUnit: 'btc' }] },
    { status: 429 }, { status: 503 }, { contentType: 'text/html' }
  ]) {
    const mock = mockFetch(args);
    await assert.rejects(fetchReferenceQuote({ fetchImpl: mock.fetchImpl, clock: () => nowMs }));
    assert.equal(mock.calls.length, 1);
  }
});

test('limits streamed response size before JSON parsing', async () => {
  const fetchImpl = async () => new Response(' '.repeat(256 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(fetchReferenceQuote({ fetchImpl, clock: () => nowMs }), /size limit/);
});
