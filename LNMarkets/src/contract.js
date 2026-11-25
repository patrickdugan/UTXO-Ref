'use strict';

// An enumerated, bounded inverse BTC/USD future. Every outcome conserves the
// collateral supplied by the trader and maker; settlement fees and the recovery
// anchor are funded separately. This module has no wallet or venue connection.
const crypto = require('node:crypto');
const { canonicalJson, snapshotPlainData } = require('../../bitvm3/utxo_referee/dlc_canonical_json');
const { liftX, bufToBig } = require('../../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig');

const KIND = 'lnmarkets_bounded_inverse_plan_v1';
const MAX_MONEY = 21000000n * 100000000n;
const SATS_PER_BTC = 100000000n;
const MAX_OUTCOMES = 9;
const PLAN_DOMAIN = 'UTXORef/LNMarkets/bounded-inverse-plan/v1';
const OUTCOME_DOMAIN = 'UTXORef/LNMarkets/price-outcome/v1';
const TERMS_KEYS = Object.freeze([
  'schemaVersion', 'network', 'quoteId', 'market', 'side',
  'entryPriceUsdCents', 'notionalUsdCents', 'traderCollateralSats',
  'makerCollateralSats', 'settlementFeeSats', 'anchorSats', 'minimumPayoutSats',
  'traderPayoutScript', 'makerPayoutScript', 'anchorScript',
  'traderPubkeyX', 'makerPubkeyX', 'refundCsvBlocks', 'maturityHeight',
  'refundHeight', 'oracleEventId', 'settlementPricesUsdCents',
  'oracleThreshold', 'oraclePubkeys'
]);
const PLAN_KEYS = Object.freeze([
  'kind', 'terms', 'planDigest', 'contractId', 'fundingValueSats', 'outcomes', 'refund'
]);

function exactKeys(value, expected, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new Error(`${field} must contain exactly the supported fields`);
  }
}

function decimal(value, field, minimum = 1n, maximum = MAX_MONEY) {
  // Bound the input before constructing a BigInt. Scientific notation, signs,
  // leading zeroes and JS numbers cannot silently change the monetary unit.
  if (typeof value !== 'string' || value.length > 16 || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be a canonical decimal integer string`);
  }
  const parsed = BigInt(value);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be in ${minimum}..${maximum}`);
  }
  return parsed;
}

function integer(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer in ${minimum}..${maximum}`);
  }
}

function identifier(value, field, maxLength) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) {
    throw new Error(`${field} must be a safe ASCII identifier of 1..${maxLength} characters`);
  }
}

function xOnlyKey(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${field} must be a lowercase 32-byte x-only public key`);
  }
  try {
    liftX(bufToBig(Buffer.from(value, 'hex')));
  } catch (_error) {
    throw new Error(`${field} must be a valid secp256k1 x-only public key`);
  }
}

function payoutScript(value, field) {
  if (typeof value !== 'string' || !/^5120[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${field} must be a P2TR scriptPubKey`);
  }
  xOnlyKey(value.slice(4), field);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeTerms(input) {
  // The existing canonical boundary rejects accessors, proxies, sparse arrays,
  // cycles and non-JSON objects before any field is evaluated or hashed.
  const terms = snapshotPlainData(input, 'LNMarkets terms');
  exactKeys(terms, TERMS_KEYS, 'terms');
  if (terms.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  if (terms.network !== 'bitcoin-regtest') throw new Error('only bitcoin-regtest is supported by this prototype');
  identifier(terms.quoteId, 'quoteId', 128);
  exactKeys(terms.market, ['venue', 'instrument', 'pair'], 'market');
  if (terms.market.venue !== 'lnmarkets' || terms.market.instrument !== 'inverse_perp' ||
      terms.market.pair !== 'btc_usd') {
    throw new Error('market must identify lnmarkets inverse_perp btc_usd');
  }
  if (terms.side !== 'long' && terms.side !== 'short') throw new Error('side must be long or short');
  decimal(terms.entryPriceUsdCents, 'entryPriceUsdCents');
  decimal(terms.notionalUsdCents, 'notionalUsdCents');
  const minimum = decimal(terms.minimumPayoutSats, 'minimumPayoutSats', 1000n);
  decimal(terms.traderCollateralSats, 'traderCollateralSats', minimum + 1n);
  decimal(terms.makerCollateralSats, 'makerCollateralSats', minimum + 1n);
  decimal(terms.settlementFeeSats, 'settlementFeeSats');
  decimal(terms.anchorSats, 'anchorSats', 330n, 10000n);
  for (const field of ['traderPayoutScript', 'makerPayoutScript', 'anchorScript']) {
    payoutScript(terms[field], field);
  }
  if (new Set([terms.traderPayoutScript, terms.makerPayoutScript, terms.anchorScript]).size !== 3) {
    throw new Error('trader, maker and anchor scripts must be distinct');
  }
  xOnlyKey(terms.traderPubkeyX, 'traderPubkeyX');
  xOnlyKey(terms.makerPubkeyX, 'makerPubkeyX');
  if (terms.traderPubkeyX === terms.makerPubkeyX) throw new Error('trader and maker keys must be distinct');
  integer(terms.refundCsvBlocks, 'refundCsvBlocks', 1, 65535);
  // Both absolute locktimes use Bitcoin block heights. Crossing 500,000,000
  // would reinterpret the value as a timestamp and change the contract.
  integer(terms.maturityHeight, 'maturityHeight', 1, 499999999);
  integer(terms.refundHeight, 'refundHeight', terms.maturityHeight + 1, 499999999);
  identifier(terms.oracleEventId, 'oracleEventId', 256);
  if (!Array.isArray(terms.settlementPricesUsdCents) || terms.settlementPricesUsdCents.length < 1 ||
      terms.settlementPricesUsdCents.length > MAX_OUTCOMES) {
    throw new Error(`settlementPricesUsdCents must contain 1..${MAX_OUTCOMES} prices`);
  }
  let previous = 0n;
  for (const [index, price] of terms.settlementPricesUsdCents.entries()) {
    const current = decimal(price, `settlementPricesUsdCents[${index}]`);
    if (current <= previous) throw new Error('settlement prices must be strictly increasing');
    previous = current;
  }
  if (terms.oracleThreshold !== 2 || !Array.isArray(terms.oraclePubkeys) || terms.oraclePubkeys.length !== 3) {
    throw new Error('oracle policy must specify 2 of exactly 3 oracles');
  }
  terms.oraclePubkeys.forEach((key, index) => xOnlyKey(key, `oraclePubkeys[${index}]`));
  if (new Set(terms.oraclePubkeys).size !== 3) throw new Error('oracle public keys must be distinct');
  return terms;
}

function buildContractPlan(input) {
  const terms = normalizeTerms(input);
  const trader = BigInt(terms.traderCollateralSats);
  const maker = BigInt(terms.makerCollateralSats);
  const minimum = BigInt(terms.minimumPayoutSats);
  const funding = trader + maker + BigInt(terms.settlementFeeSats) + BigInt(terms.anchorSats);
  if (funding > MAX_MONEY) throw new Error('total funding exceeds MAX_MONEY');
  const planDigest = sha256(canonicalJson([PLAN_DOMAIN, terms]));
  const entry = BigInt(terms.entryPriceUsdCents);
  const notional = BigInt(terms.notionalUsdCents);
  const direction = terms.side === 'long' ? 1n : -1n;
  const lossFloor = minimum - trader;
  const gainCeiling = maker - minimum;
  const outcomes = terms.settlementPricesUsdCents.map((priceUsdCents) => {
    const price = BigInt(priceUsdCents);
    // Q * (1/P_entry - 1/P_settlement), denominated in BTC. Both prices and
    // notional use USD cents so their factors of 100 cancel. BigInt division
    // rounds each signed PnL toward zero; the maker receives the complement.
    const uncapped = direction * notional * SATS_PER_BTC * (price - entry) / (entry * price);
    const pnl = uncapped < lossFloor ? lossFloor : uncapped > gainCeiling ? gainCeiling : uncapped;
    return {
      priceUsdCents,
      outcomeMessage: sha256(canonicalJson([OUTCOME_DOMAIN, terms.oracleEventId, priceUsdCents, planDigest])),
      uncappedPnlSats: uncapped.toString(),
      pnlSats: pnl.toString(),
      traderPayoutSats: (trader + pnl).toString(),
      makerPayoutSats: (maker - pnl).toString(),
      capped: pnl !== uncapped
    };
  });
  return snapshotPlainData({
    kind: KIND,
    terms,
    planDigest,
    contractId: `lnm-${planDigest}`,
    fundingValueSats: funding.toString(),
    outcomes,
    refund: { traderPayoutSats: trader.toString(), makerPayoutSats: maker.toString() }
  }, 'LNMarkets plan');
}

function validateContractPlan(input) {
  const supplied = snapshotPlainData(input, 'LNMarkets saved plan');
  exactKeys(supplied, PLAN_KEYS, 'plan');
  const rebuilt = buildContractPlan(supplied.terms);
  if (canonicalJson(supplied) !== canonicalJson(rebuilt)) {
    throw new Error('saved plan differs from its committed terms or derived payouts');
  }
  return rebuilt;
}

module.exports = { KIND, MAX_MONEY, MAX_OUTCOMES, canonicalJson, buildContractPlan, validateContractPlan };
