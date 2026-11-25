'use strict';

// Public price reference only. A venue mark is not an executable bilateral
// quote, an oracle attestation, proof of reserves, or venue trading volume.
const crypto = require('node:crypto');
const { canonicalJson, snapshotPlainData } = require('../../bitvm3/utxo_referee/dlc_canonical_json');

const MARKET = Object.freeze({ venue: 'lnmarkets', instrument: 'inverse_perp', pair: 'btc_usd' });
const API_ORIGINS = Object.freeze({
  mainnet: 'https://api.lnmarkets.com',
  signet: 'https://api.signet.lnmarkets.com'
});
const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_MAX_AGE_MS = 15_000;
const MAX_FUTURE_SKEW_MS = 2_000;

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} is out of range`);
  return value;
}

function origin(network) {
  if (!Object.hasOwn(API_ORIGINS, network)) throw new Error('API network must be mainnet or signet');
  return API_ORIGINS[network];
}

function usdToCents(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('mark must be a USD decimal');
  const decimal = String(value);
  if (!/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/.test(decimal)) throw new Error('mark must be a finite positive USD decimal');
  const [whole, fraction = ''] = decimal.split('.');
  const cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (cents <= 0n) throw new Error('mark must be at least one cent');
  return { originalUsd: decimal, priceUsdCents: cents.toString(), rounding: 'truncate-to-cent' };
}

function normalizeReferenceQuote({ ticker, apiNetwork, receivedAtMs, nowMs, maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  const apiOrigin = origin(apiNetwork);
  integer(nowMs, 'nowMs', 0, 8_640_000_000_000_000);
  integer(receivedAtMs, 'receivedAtMs', 0, nowMs);
  integer(maxAgeMs, 'maxAgeMs', 1, 60_000);
  if (!ticker || typeof ticker !== 'object' || Array.isArray(ticker)) throw new Error('ticker must be an object');
  if (ticker.instrument !== MARKET.instrument || ticker.pair !== MARKET.pair) throw new Error('ticker market mismatch');
  // Require a timezone and a canonical date; Date.parse otherwise normalizes
  // impossible dates and silently accepts machine-local time strings.
  if (typeof ticker.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(ticker.time)) {
    throw new Error('ticker time must be a UTC ISO timestamp');
  }
  const timestampMs = Date.parse(ticker.time);
  if (!Number.isSafeInteger(timestampMs) || new Date(timestampMs).toISOString() !== ticker.time.replace(/(?<=:\d\d)Z$/, '.000Z')) {
    throw new Error('ticker time is invalid');
  }
  if (timestampMs > receivedAtMs + MAX_FUTURE_SKEW_MS) throw new Error('ticker timestamp is in the future');
  if (nowMs - timestampMs > maxAgeMs || nowMs - receivedAtMs > maxAgeMs) throw new Error('ticker is stale');
  const price = usdToCents(ticker.mark);
  const payload = {
    kind: 'lnmarkets_public_mark_reference_v1',
    apiNetwork,
    apiOrigin,
    market: MARKET,
    timestampMs,
    receivedAtMs,
    expiresAtMs: Math.min(timestampMs + maxAgeMs, receivedAtMs + maxAgeMs),
    ...price,
    executable: false,
    source: '/v3/perp/ticker?instrument=inverse_perp&pair=btc_usd'
  };
  return snapshotPlainData({
    ...payload,
    referenceId: crypto.createHash('sha256').update('UTXORef/LNMarkets/reference/v1\n' + canonicalJson(payload)).digest('hex')
  });
}

function verifyReferenceQuote(reference, { nowMs }) {
  const saved = snapshotPlainData(reference);
  if (saved.kind !== 'lnmarkets_public_mark_reference_v1') throw new Error('unsupported reference quote');
  // Reconstruct the saved local interpretation from only its inputs.
  // This is an integrity check; TLS and the caller's clock supply provenance.
  const maxAgeMs = saved.expiresAtMs - Math.min(saved.timestampMs, saved.receivedAtMs);
  const expected = normalizeReferenceQuote({
    ticker: {
      instrument: saved.market.instrument,
      pair: saved.market.pair,
      time: new Date(saved.timestampMs).toISOString(),
      mark: saved.originalUsd
    },
    apiNetwork: saved.apiNetwork,
    receivedAtMs: saved.receivedAtMs,
    nowMs,
    maxAgeMs
  });
  if (canonicalJson(saved) !== canonicalJson(expected)) throw new Error('reference quote changed');
  if (nowMs >= expected.expiresAtMs) throw new Error('reference quote expired');
  return expected;
}

function bindReferenceToTerms(terms, reference, { nowMs }) {
  const checked = verifyReferenceQuote(reference, { nowMs });
  const input = snapshotPlainData(terms);
  if (input.entryPriceUsdCents !== checked.priceUsdCents ||
      input.quoteId !== `lnm-reference-${checked.referenceId}` ||
      canonicalJson(input.market) !== canonicalJson(checked.market)) {
    throw new Error('contract terms do not match the selected price reference');
  }
  return input;
}

async function publicGet(url, { fetchImpl, signal }) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal
  });
  if (!response.ok) throw new Error(`LN Markets public data HTTP ${response.status}`);
  if (!/\bapplication\/json\b/i.test(response.headers.get('content-type') || '')) throw new Error('public data response must be JSON');
  const announcedSize = response.headers.get('content-length');
  if (announcedSize !== null && (!/^\d+$/.test(announcedSize) || BigInt(announcedSize) > BigInt(MAX_BODY_BYTES))) {
    throw new Error('public data response exceeds size limit');
  }
  if (!response.body) throw new Error('public data response has no body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error('public data response exceeds size limit');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function fetchReferenceQuote({ apiNetwork = 'signet', fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  const apiOrigin = origin(apiNetwork);
  if (typeof fetchImpl !== 'function' || typeof clock !== 'function') throw new Error('fetch and clock must be functions');
  const signal = AbortSignal.timeout(5_000);
  // Fixed public routes. This adapter has no credential, account, order, or
  // withdrawal API, and does not automatically retry.
  const markets = await publicGet(`${apiOrigin}/v3/markets`, { fetchImpl, signal });
  if (!Array.isArray(markets)) throw new Error('markets response must be an array');
  const matches = markets.filter((market) => market.instrument === MARKET.instrument && market.pair === MARKET.pair);
  if (matches.length !== 1 || matches[0].status !== 'released' || matches[0].quantityUnit !== 'usd') {
    throw new Error('BTC/USD inverse market is not uniquely available in USD units');
  }
  const ticker = await publicGet(`${apiOrigin}/v3/perp/ticker?instrument=inverse_perp&pair=btc_usd`, { fetchImpl, signal });
  const nowMs = clock();
  return normalizeReferenceQuote({ ticker, apiNetwork, receivedAtMs: nowMs, nowMs });
}

module.exports = { MARKET, API_ORIGINS, DEFAULT_MAX_AGE_MS, normalizeReferenceQuote, verifyReferenceQuote, bindReferenceToTerms, fetchReferenceQuote };
