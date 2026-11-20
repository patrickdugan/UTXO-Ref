'use strict';

// PUBLIC, KNOWN TEST KEYS. This module deliberately owns every role in one
// process. It must never be used with valuable funds or as an oracle service.
// The restore CLI does not import this module or receive these test secrets.
const crypto = require('node:crypto');
const { xOnlyPubkey, buildDlcOracle, dlcAttest, bytes32 } = require('../../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig');
const { buildContractPlan } = require('../src/contract');
const { normalizeReferenceQuote, bindReferenceToTerms } = require('../src/market-data');

const DEMO_NOW_MS = Date.parse('2026-11-19T12:00:00.000Z');
const key = (secret) => xOnlyPubkey(secret).toString('hex');

function buildDemoScenario() {
  const partySecrets = [11n, 12n];
  const oracleSecrets = [31n, 32n, 33n];
  const reference = normalizeReferenceQuote({
    ticker: { instrument: 'inverse_perp', pair: 'btc_usd', mark: 100000, time: new Date(DEMO_NOW_MS).toISOString() },
    apiNetwork: 'signet',
    receivedAtMs: DEMO_NOW_MS,
    nowMs: DEMO_NOW_MS
  });
  const terms = bindReferenceToTerms({
    schemaVersion: 1,
    network: 'bitcoin-regtest',
    quoteId: `lnm-reference-${reference.referenceId}`,
    market: reference.market,
    side: 'long',
    entryPriceUsdCents: reference.priceUsdCents,
    notionalUsdCents: '100000',
    traderCollateralSats: '200000',
    makerCollateralSats: '200000',
    settlementFeeSats: '1000',
    anchorSats: '330',
    minimumPayoutSats: '1000',
    traderPayoutScript: `5120${key(21n)}`,
    makerPayoutScript: `5120${key(22n)}`,
    anchorScript: `5120${key(23n)}`,
    traderPubkeyX: key(partySecrets[0]),
    makerPubkeyX: key(partySecrets[1]),
    refundCsvBlocks: 144,
    maturityHeight: 1000,
    refundHeight: 1200,
    oracleEventId: 'lnm/research/btc-usd/height-1000/demo-v1',
    settlementPricesUsdCents: ['9000000', '10000000', '11000000'],
    oracleThreshold: 2,
    oraclePubkeys: oracleSecrets.map(key)
  }, reference, { nowMs: DEMO_NOW_MS });
  const plan = buildContractPlan(terms);
  const oracles = oracleSecrets.map((secret, index) => buildDlcOracle(secret, 1001n + BigInt(index), {
    eventId: terms.oracleEventId,
    outcomeMessages: plan.outcomes.map((outcome) => Buffer.from(outcome.outcomeMessage, 'hex'))
  }));
  const fundingOutpoint = {
    txid: crypto.createHash('sha256').update('LNMarkets SYNTHETIC funding outpoint v1').digest('hex'),
    vout: 0
  };
  return { plan, reference, fundingOutpoint, partySecrets, oracles };
}

function attestDemoOutcome(scenario, outcomeId) {
  const message = Buffer.from(outcomeId, 'hex');
  return scenario.oracles.map((oracle) => ({
    oraclePubkeyX: oracle.px,
    scalarHex: bytes32(dlcAttest(oracle, message)).toString('hex')
  }));
}

module.exports = { DEMO_NOW_MS, buildDemoScenario, attestDemoOutcome };
