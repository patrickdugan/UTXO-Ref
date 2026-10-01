/**
 * Sukuk stablecoin halal DeFi rails.
 *
 * This is a deterministic product artifact for a banked stablecoin that can be
 * pledged into Taproot Assets, routed over Lightning, or allocated to bounded
 * TradeLayer arbitrage without mixing principal, reserves, and service fees.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalStringify } = require('./m1_spec');
const {
  buildTaprootAssetsStablecoinBundle,
  verifyTaprootAssetsStablecoinBundle
} = require('./lightning_taproot_assets_stablecoin');
const {
  buildLiquidityLeaseBundle,
  verifyLiquidityLeaseBundle
} = require('./lightning_liquidity_lease');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const OUT_JSON = path.join(ARTIFACTS_DIR, 'sukuk_stablecoin_halal_defi_latest.json');
const OUT_MD = path.join(ARTIFACTS_DIR, 'sukuk_stablecoin_halal_defi_latest.md');

const STABLECOIN_PROPERTY_ID = 9001;
const STABLECOIN_TICKER = 'SUKUSD';
const STABLECOIN_DECIMALS = 6;
const BPS_DENOMINATOR = 10000n;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value) {
  return sha256Hex(canonicalStringify(value));
}

function stringifyJson(value, pretty = false) {
  return JSON.stringify(
    value,
    (_key, current) => (typeof current === 'bigint' ? current.toString() : current),
    pretty ? 2 : 0
  );
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function toUnits(value, fieldName = 'units') {
  const units = BigInt(value);
  if (units < 0n) throw new Error(`${fieldName} must be non-negative`);
  return units;
}

function positiveUnits(value, fieldName = 'units') {
  const units = toUnits(value, fieldName);
  if (units === 0n) throw new Error(`${fieldName} must be positive`);
  return units;
}

function sumUnits(values) {
  return values.reduce((sum, value) => sum + BigInt(value || 0), 0n).toString();
}

function bpsAmount(units, bps) {
  return (BigInt(units) * BigInt(bps)) / BPS_DENOMINATOR;
}

function eventWithId(kind, eventCore) {
  return {
    kind,
    eventId: hashCanonical(eventCore),
    eventCore
  };
}

function defaultSukukHoldings() {
  return [
    {
      issueId: 'oman-sovereign-sukuk-demo-2029',
      issuer: 'Sultanate of Oman demo sovereign sleeve',
      currency: 'USD',
      marketValueUnits: '2200000000',
      liquidityHaircutBps: 700,
      maturityBucket: '1-3y',
      shariaBoardRef: 'sharia-screen-demo-sovereign'
    },
    {
      issueId: 'gcc-ifi-sukuk-demo-2028',
      issuer: 'Islamic finance institution demo sleeve',
      currency: 'USD',
      marketValueUnits: '1600000000',
      liquidityHaircutBps: 900,
      maturityBucket: '1-3y',
      shariaBoardRef: 'sharia-screen-demo-ifi'
    },
    {
      issueId: 'oman-project-sukuk-demo-2030',
      issuer: 'Oman project sukuk demo sleeve',
      currency: 'USD',
      marketValueUnits: '900000000',
      liquidityHaircutBps: 1300,
      maturityBucket: '3-5y',
      shariaBoardRef: 'sharia-screen-demo-project'
    }
  ];
}

function normalizeSukukHolding(holding, index) {
  const marketValueUnits = positiveUnits(holding.marketValueUnits, `sukukHoldings[${index}].marketValueUnits`);
  const liquidityHaircutBps = Number(holding.liquidityHaircutBps ?? 1000);
  if (!Number.isSafeInteger(liquidityHaircutBps) || liquidityHaircutBps < 0 || liquidityHaircutBps > 10000) {
    throw new Error(`sukukHoldings[${index}].liquidityHaircutBps must be 0..10000`);
  }
  const eligibleUnits = marketValueUnits - bpsAmount(marketValueUnits, liquidityHaircutBps);
  return {
    issueId: normalizeString(holding.issueId, `sukukHoldings[${index}].issueId`),
    issuer: normalizeString(holding.issuer, `sukukHoldings[${index}].issuer`),
    currency: normalizeString(holding.currency || 'USD', `sukukHoldings[${index}].currency`),
    marketValueUnits: marketValueUnits.toString(),
    liquidityHaircutBps,
    eligibleUnits: eligibleUnits.toString(),
    maturityBucket: normalizeString(holding.maturityBucket || 'unspecified', `sukukHoldings[${index}].maturityBucket`),
    shariaBoardRef: normalizeString(holding.shariaBoardRef, `sukukHoldings[${index}].shariaBoardRef`)
  };
}

function buildBankedSukukStablecoinReserve(options = {}) {
  const mintedUnits = positiveUnits(options.mintedUnits || 5000000000n, 'mintedUnits');
  const cashUnits = positiveUnits(options.cashUnits || 1600000000n, 'cashUnits');
  const sukukHoldings = (options.sukukHoldings || defaultSukukHoldings()).map(normalizeSukukHolding);
  const eligibleSukukUnits = sukukHoldings.reduce((sum, holding) => sum + BigInt(holding.eligibleUnits), 0n);
  const eligibleReserveUnits = cashUnits + eligibleSukukUnits;
  const coverageBps = eligibleReserveUnits * BPS_DENOMINATOR / mintedUnits;
  const reserveCore = {
    version: 1,
    stablecoinPropertyId: STABLECOIN_PROPERTY_ID,
    ticker: STABLECOIN_TICKER,
    decimals: STABLECOIN_DECIMALS,
    issuerId: normalizeString(options.issuerId || 'oman-sukuk-stablecoin-demo-issuer', 'issuerId'),
    custodianBanks: options.custodianBanks || ['oman-islamic-bank-demo-1', 'oman-islamic-bank-demo-2'],
    mintedUnits: mintedUnits.toString(),
    cashUnits: cashUnits.toString(),
    eligibleSukukUnits: eligibleSukukUnits.toString(),
    eligibleReserveUnits: eligibleReserveUnits.toString(),
    coverageBps: coverageBps.toString(),
    redemptionBufferUnits: (eligibleReserveUnits - mintedUnits > 0n ? eligibleReserveUnits - mintedUnits : 0n).toString(),
    sukukHoldings,
    futureDiversification: {
      farmReitEnabledForBacking: false,
      farmReitRule: 'future REIT sleeves require separate propertyId, appraisal, income proof, and liquidity haircut before backing credit'
    },
    shariaControls: {
      boardRequired: true,
      ribaRevenueAllowed: false,
      principalYieldEntitlement: false,
      serviceFeesSeparated: true
    }
  };

  return {
    kind: 'banked_sukuk_stablecoin_reserve',
    reserveId: hashCanonical(reserveCore),
    reserveCore
  };
}

function verifyBankedSukukStablecoinReserve(reserve) {
  if (!reserve || reserve.kind !== 'banked_sukuk_stablecoin_reserve') {
    return { ok: false, reason: 'wrong reserve kind' };
  }
  if (reserve.reserveId !== hashCanonical(reserve.reserveCore)) {
    return { ok: false, reason: 'reserve id mismatch' };
  }
  if (BigInt(reserve.reserveCore.eligibleReserveUnits) < BigInt(reserve.reserveCore.mintedUnits)) {
    return { ok: false, reason: 'eligible reserves do not cover minted stablecoin units' };
  }
  if (reserve.reserveCore.shariaControls.ribaRevenueAllowed !== false) {
    return { ok: false, reason: 'reserve permits riba revenue' };
  }
  if (reserve.reserveCore.futureDiversification.farmReitEnabledForBacking !== false) {
    return { ok: false, reason: 'farm REIT cannot back stablecoin until separately approved' };
  }
  return { ok: true };
}

function buildTradeLayerStablecoinIssuance(reserve, options = {}) {
  const reserveCheck = verifyBankedSukukStablecoinReserve(reserve);
  if (!reserveCheck.ok) throw new Error(`invalid reserve: ${reserveCheck.reason}`);
  const amountUnits = positiveUnits(options.amountUnits || reserve.reserveCore.mintedUnits, 'amountUnits');
  const issuanceCore = {
    version: 1,
    eventType: 'mint_banked_sukuk_stablecoin',
    propertyId: STABLECOIN_PROPERTY_ID,
    ticker: STABLECOIN_TICKER,
    decimals: STABLECOIN_DECIMALS,
    issuerId: reserve.reserveCore.issuerId,
    reserveId: reserve.reserveId,
    amountUnits: amountUnits.toString(),
    holderAccountId: normalizeString(options.holderAccountId || 'stablecoin-treasury-demo', 'holderAccountId'),
    redemptionRule: 'par redemption through approved Islamic bank rails, subject to compliance controls',
    yieldEntitlement: false,
    reserveRevenueClaim: false
  };

  return {
    kind: 'tradelayer_banked_sukuk_stablecoin_issuance',
    issuanceId: hashCanonical(issuanceCore),
    issuanceCore,
    reserve
  };
}

function verifyTradeLayerStablecoinIssuance(issuance) {
  if (!issuance || issuance.kind !== 'tradelayer_banked_sukuk_stablecoin_issuance') {
    return { ok: false, reason: 'wrong issuance kind' };
  }
  if (issuance.issuanceId !== hashCanonical(issuance.issuanceCore)) {
    return { ok: false, reason: 'issuance id mismatch' };
  }
  const reserveCheck = verifyBankedSukukStablecoinReserve(issuance.reserve);
  if (!reserveCheck.ok) return reserveCheck;
  if (issuance.issuanceCore.reserveId !== issuance.reserve.reserveId) {
    return { ok: false, reason: 'issuance reserve id mismatch' };
  }
  if (BigInt(issuance.issuanceCore.amountUnits) > BigInt(issuance.reserve.reserveCore.mintedUnits)) {
    return { ok: false, reason: 'issuance exceeds reserve minted units' };
  }
  if (issuance.issuanceCore.yieldEntitlement !== false || issuance.issuanceCore.reserveRevenueClaim !== false) {
    return { ok: false, reason: 'stablecoin issuance must not claim portfolio yield' };
  }
  return { ok: true };
}

function buildSupportingLightningLease({ issuance, pledgeId, btcRouteSats }) {
  const preimageHex = sha256Hex(`sukuk-stablecoin-ln-preimage:${pledgeId}`);
  const paymentHashHex = sha256Hex(Buffer.from(preimageHex, 'hex'));
  const fundingTxid = sha256Hex(`sukuk-stablecoin-ln-funding:${pledgeId}`);
  const fundingCommitmentHash = sha256Hex(`sukuk-stablecoin-ln-commitment:${pledgeId}`);
  const lease = buildLiquidityLeaseBundle({
    leaseId: `sukuk-ln-lease-${pledgeId.slice(0, 12)}`,
    promisedInboundSats: BigInt(btcRouteSats),
    leasePremiumSats: BigInt(btcRouteSats) / 100n || 1n,
    paymentHashHex,
    htlcProof: {
      lightning: {
        preimageHex,
        paymentHashHex
      },
      dlcFunding: {
        claimTxid: fundingTxid,
        outputVout: 0,
        commitmentHash: fundingCommitmentHash
      },
      swap: {
        fundingTxid,
        refundLocktime: 410800
      }
    },
    channelOutpoint: `${fundingTxid}:0`,
    fundingCommitmentHash,
    observedInboundSats: BigInt(btcRouteSats),
    observedFeePpm: 450,
    observedCltvDelta: 24,
    observedAtBlock: 410650
  });

  return {
    ...lease,
    verification: verifyLiquidityLeaseBundle(lease),
    htlcProof: {
      lightning: {
        preimageHex,
        paymentHashHex
      },
      dlcFunding: {
        claimTxid: fundingTxid,
        outputVout: 0,
        commitmentHash: fundingCommitmentHash
      },
      swap: {
        fundingTxid,
        refundLocktime: 410800
      }
    },
    issuanceId: issuance.issuanceId
  };
}

function buildTaprootStablecoinPledge(issuance, options = {}) {
  const issuanceCheck = verifyTradeLayerStablecoinIssuance(issuance);
  if (!issuanceCheck.ok) throw new Error(`invalid issuance: ${issuanceCheck.reason}`);
  const lockedUnits = positiveUnits(options.lockedUnits || 2000000000n, 'lockedUnits');
  if (lockedUnits > BigInt(issuance.issuanceCore.amountUnits)) {
    throw new Error('lockedUnits exceed issued stablecoin units');
  }
  const pledgeSeed = {
    issuanceId: issuance.issuanceId,
    lockedUnits: lockedUnits.toString(),
    rail: 'tradelayer_to_taproot_assets_to_lightning'
  };
  const pledgeId = hashCanonical(pledgeSeed);
  const btcRouteSats = positiveUnits(options.btcRouteSats || 250000n, 'btcRouteSats');
  const supportingLease = buildSupportingLightningLease({ issuance, pledgeId, btcRouteSats });
  const taprootBundle = buildTaprootAssetsStablecoinBundle({
    ticker: STABLECOIN_TICKER,
    issuer: issuance.issuanceCore.issuerId,
    amountUnits: lockedUnits,
    assetAmountUnits: lockedUnits,
    btcRouteSats,
    liquidityLease: supportingLease,
    htlcProof: supportingLease.htlcProof,
    observedBlock: 200,
    challengeObservedBlock: 999
  });
  const taprootVerification = verifyTaprootAssetsStablecoinBundle(taprootBundle);
  const lockEvent = eventWithId('sukuk_stablecoin_defi_event', {
    version: 1,
    eventType: 'lock_tradelayer_stablecoin_for_taproot_asset_pledge',
    propertyId: STABLECOIN_PROPERTY_ID,
    issuanceId: issuance.issuanceId,
    pledgeId,
    amountUnits: lockedUnits.toString(),
    taprootAssetBundleId: taprootBundle.bundleId,
    supportingLeaseBundleId: supportingLease.bundleId,
    yieldEntitlement: false
  });
  const pledgeCore = {
    version: 1,
    pledgeId,
    stablecoinPropertyId: STABLECOIN_PROPERTY_ID,
    issuanceId: issuance.issuanceId,
    lockedUnits: lockedUnits.toString(),
    lockEventId: lockEvent.eventId,
    taprootAssetBundleId: taprootBundle.bundleId,
    supportingLeaseBundleId: supportingLease.bundleId,
    taprootVerificationOk: taprootVerification.ok,
    pledgeRule: 'stablecoin receipt is locked before TAP/Lightning service use; fees are separate service revenue'
  };

  return {
    kind: 'taproot_lightning_stablecoin_pledge',
    pledgeId: hashCanonical(pledgeCore),
    pledgeCore,
    lockEvent,
    supportingLease,
    taprootBundle,
    taprootVerification
  };
}

function verifyTaprootStablecoinPledge(pledge, issuance) {
  if (!pledge || pledge.kind !== 'taproot_lightning_stablecoin_pledge') {
    return { ok: false, reason: 'wrong pledge kind' };
  }
  if (pledge.pledgeId !== hashCanonical(pledge.pledgeCore)) {
    return { ok: false, reason: 'pledge id mismatch' };
  }
  if (issuance && pledge.pledgeCore.issuanceId !== issuance.issuanceId) {
    return { ok: false, reason: 'pledge issuance mismatch' };
  }
  if (issuance && BigInt(pledge.pledgeCore.lockedUnits) > BigInt(issuance.issuanceCore.amountUnits)) {
    return { ok: false, reason: 'pledge exceeds issued stablecoin units' };
  }
  if (pledge.lockEvent.eventId !== hashCanonical(pledge.lockEvent.eventCore)) {
    return { ok: false, reason: 'pledge lock event id mismatch' };
  }
  if (pledge.lockEvent.eventCore.yieldEntitlement !== false) {
    return { ok: false, reason: 'pledge lock event cannot grant yield entitlement' };
  }
  const lease = verifyLiquidityLeaseBundle(pledge.supportingLease);
  if (!lease.ok) return { ok: false, reason: `supporting lease failed: ${lease.reason}` };
  const taproot = verifyTaprootAssetsStablecoinBundle(pledge.taprootBundle);
  if (!taproot.ok) return { ok: false, reason: `taproot bundle failed: ${taproot.reason}` };
  return { ok: true };
}

function buildDynamicHawalaRouteQuote(pledge, route = {}) {
  const amountUnits = positiveUnits(route.amountUnits || 300000000n, 'route.amountUnits');
  const baseFeeUnits = toUnits(route.baseFeeUnits ?? 2500n, 'route.baseFeeUnits');
  const baseFeeBps = Number(route.baseFeeBps ?? 7);
  const demandBps = Number(route.demandBps ?? 9);
  const complianceBps = Number(route.complianceBps ?? 3);
  const urgencyBps = Number(route.urgencyBps ?? 2);
  const qualityDiscountBps = Number(route.qualityDiscountBps ?? 1);
  const feeCapBps = Number(route.feeCapBps ?? 45);
  const computedFeeBps = Math.max(1, Math.min(feeCapBps, baseFeeBps + demandBps + complianceBps + urgencyBps - qualityDiscountBps));
  const variableFeeUnits = bpsAmount(amountUnits, computedFeeBps);
  const serviceFeeUnits = baseFeeUnits + variableFeeUnits;
  const quoteCore = {
    version: 1,
    quoteType: 'lightning_hawala_style_service_fee',
    corridorId: normalizeString(route.corridorId || 'oman-muscat-to-uae-dubai', 'route.corridorId'),
    sourceJurisdiction: normalizeString(route.sourceJurisdiction || 'OM', 'route.sourceJurisdiction'),
    destinationJurisdiction: normalizeString(route.destinationJurisdiction || 'AE', 'route.destinationJurisdiction'),
    stablecoinPropertyId: STABLECOIN_PROPERTY_ID,
    pledgeId: pledge.pledgeId,
    amountUnits: amountUnits.toString(),
    baseFeeUnits: baseFeeUnits.toString(),
    baseFeeBps,
    demandBps,
    complianceBps,
    urgencyBps,
    qualityDiscountBps,
    feeCapBps,
    computedFeeBps,
    variableFeeUnits: variableFeeUnits.toString(),
    serviceFeeUnits: serviceFeeUnits.toString(),
    feeCharacter: 'routing_and_settlement_service_fee_not_interest',
    settlementRail: 'Taproot Assets over Lightning with TradeLayer receipt lock'
  };

  return {
    kind: 'sukuk_stablecoin_dynamic_hawala_route_quote',
    quoteId: hashCanonical(quoteCore),
    quoteCore
  };
}

function buildLightningHawalaRoutingMarket(pledge, options = {}) {
  const routes = options.routes || [
    {
      corridorId: 'oman-muscat-to-uae-dubai',
      amountUnits: 650000000n,
      demandBps: 11,
      complianceBps: 3,
      urgencyBps: 2
    },
    {
      corridorId: 'oman-muscat-to-saudi-riyadh',
      destinationJurisdiction: 'SA',
      amountUnits: 450000000n,
      demandBps: 8,
      complianceBps: 4,
      urgencyBps: 1
    },
    {
      corridorId: 'oman-muscat-to-india-kochi',
      destinationJurisdiction: 'IN',
      amountUnits: 300000000n,
      demandBps: 13,
      complianceBps: 5,
      urgencyBps: 3,
      qualityDiscountBps: 2
    }
  ];
  const routeQuotes = routes.map((route) => buildDynamicHawalaRouteQuote(pledge, route));
  const feeCreditEvents = routeQuotes.map((quote) => eventWithId('sukuk_stablecoin_defi_event', {
    version: 1,
    eventType: 'credit_lightning_hawala_service_fee',
    propertyId: STABLECOIN_PROPERTY_ID,
    pledgeId: pledge.pledgeId,
    routeQuoteId: quote.quoteId,
    corridorId: quote.quoteCore.corridorId,
    amountUnits: quote.quoteCore.serviceFeeUnits,
    feeCharacter: quote.quoteCore.feeCharacter
  }));
  const marketCore = {
    version: 1,
    marketType: 'taproot_asset_lightning_hawala_routing',
    pledgeId: pledge.pledgeId,
    routeQuoteIds: routeQuotes.map((quote) => quote.quoteId),
    feeCreditEventIds: feeCreditEvents.map((event) => event.eventId),
    routedUnits: sumUnits(routeQuotes.map((quote) => quote.quoteCore.amountUnits)),
    serviceFeeUnits: sumUnits(routeQuotes.map((quote) => quote.quoteCore.serviceFeeUnits)),
    routingRule: 'fees accrue only for quoted routing and settlement services'
  };

  return {
    kind: 'sukuk_stablecoin_lightning_hawala_routing_market',
    marketId: hashCanonical(marketCore),
    marketCore,
    routeQuotes,
    feeCreditEvents
  };
}

function verifyDynamicHawalaRouteQuote(quote, pledge) {
  if (!quote || quote.kind !== 'sukuk_stablecoin_dynamic_hawala_route_quote') {
    return { ok: false, reason: 'wrong hawala route quote kind' };
  }
  if (quote.quoteId !== hashCanonical(quote.quoteCore)) {
    return { ok: false, reason: 'hawala route quote id mismatch' };
  }
  if (pledge && quote.quoteCore.pledgeId !== pledge.pledgeId) {
    return { ok: false, reason: 'hawala route pledge mismatch' };
  }
  const expectedFeeBps = Math.max(
    1,
    Math.min(
      quote.quoteCore.feeCapBps,
      quote.quoteCore.baseFeeBps + quote.quoteCore.demandBps + quote.quoteCore.complianceBps + quote.quoteCore.urgencyBps - quote.quoteCore.qualityDiscountBps
    )
  );
  if (quote.quoteCore.computedFeeBps !== expectedFeeBps) {
    return { ok: false, reason: 'hawala route fee bps mismatch' };
  }
  const expectedVariableFee = bpsAmount(quote.quoteCore.amountUnits, expectedFeeBps).toString();
  if (quote.quoteCore.variableFeeUnits !== expectedVariableFee) {
    return { ok: false, reason: 'hawala route variable fee mismatch' };
  }
  const expectedFee = (BigInt(quote.quoteCore.baseFeeUnits) + BigInt(expectedVariableFee)).toString();
  if (quote.quoteCore.serviceFeeUnits !== expectedFee) {
    return { ok: false, reason: 'hawala route service fee mismatch' };
  }
  if (quote.quoteCore.feeCharacter !== 'routing_and_settlement_service_fee_not_interest') {
    return { ok: false, reason: 'hawala route fee must be service fee' };
  }
  return { ok: true };
}

function verifyLightningHawalaRoutingMarket(market, pledge) {
  if (!market || market.kind !== 'sukuk_stablecoin_lightning_hawala_routing_market') {
    return { ok: false, reason: 'wrong routing market kind' };
  }
  if (market.marketId !== hashCanonical(market.marketCore)) {
    return { ok: false, reason: 'routing market id mismatch' };
  }
  if (pledge && market.marketCore.pledgeId !== pledge.pledgeId) {
    return { ok: false, reason: 'routing market pledge mismatch' };
  }
  for (const quote of market.routeQuotes || []) {
    const result = verifyDynamicHawalaRouteQuote(quote, pledge);
    if (!result.ok) return result;
  }
  if (pledge && BigInt(market.marketCore.routedUnits) > BigInt(pledge.pledgeCore.lockedUnits)) {
    return { ok: false, reason: 'routing market exceeds pledged stablecoin units' };
  }
  const routedUnits = sumUnits(market.routeQuotes.map((quote) => quote.quoteCore.amountUnits));
  const serviceFeeUnits = sumUnits(market.routeQuotes.map((quote) => quote.quoteCore.serviceFeeUnits));
  if (market.marketCore.routedUnits !== routedUnits) {
    return { ok: false, reason: 'routing market routed units mismatch' };
  }
  if (market.marketCore.serviceFeeUnits !== serviceFeeUnits) {
    return { ok: false, reason: 'routing market service fee mismatch' };
  }
  for (let i = 0; i < market.feeCreditEvents.length; i++) {
    const event = market.feeCreditEvents[i];
    const quote = market.routeQuotes[i];
    if (event.eventId !== hashCanonical(event.eventCore)) {
      return { ok: false, reason: 'routing fee event id mismatch' };
    }
    if (event.eventCore.amountUnits !== quote.quoteCore.serviceFeeUnits) {
      return { ok: false, reason: 'routing fee event amount mismatch' };
    }
  }
  return { ok: true };
}

function buildTradeLayerArbMandate(issuance, options = {}) {
  const issuanceCheck = verifyTradeLayerStablecoinIssuance(issuance);
  if (!issuanceCheck.ok) throw new Error(`invalid issuance: ${issuanceCheck.reason}`);
  const allocatedUnits = positiveUnits(options.allocatedUnits || 1000000000n, 'allocatedUnits');
  const opportunities = options.opportunities || [
    {
      venueA: 'tradelayer-orderbook-a',
      venueB: 'tradelayer-orderbook-b',
      pair: 'SUKUSD/TLUSD',
      amountUnits: 250000000n,
      spreadBps: 34,
      executionFeeBps: 9
    },
    {
      venueA: 'tradelayer-rfq-edge',
      venueB: 'taproot-assets-rfq-edge',
      pair: 'SUKUSD/BTC',
      amountUnits: 200000000n,
      spreadBps: 41,
      executionFeeBps: 14
    },
    {
      venueA: 'tradelayer-vwap-window',
      venueB: 'lightning-edge-liquidity',
      pair: 'SUKUSD/OMRUSD',
      amountUnits: 150000000n,
      spreadBps: 29,
      executionFeeBps: 8
    }
  ].map((opportunity, index) => {
    const amountUnits = positiveUnits(opportunity.amountUnits, `opportunities[${index}].amountUnits`);
    const spreadBps = Number(opportunity.spreadBps);
    const executionFeeBps = Number(opportunity.executionFeeBps);
    const netSpreadBps = spreadBps - executionFeeBps;
    const expectedServiceProfitUnits = netSpreadBps > 0 ? bpsAmount(amountUnits, netSpreadBps) : 0n;
    const core = {
      version: 1,
      venueA: normalizeString(opportunity.venueA, `opportunities[${index}].venueA`),
      venueB: normalizeString(opportunity.venueB, `opportunities[${index}].venueB`),
      pair: normalizeString(opportunity.pair, `opportunities[${index}].pair`),
      amountUnits: amountUnits.toString(),
      spreadBps,
      executionFeeBps,
      netSpreadBps,
      expectedServiceProfitUnits: expectedServiceProfitUnits.toString(),
      settlementMode: 'atomic_or_precommitted_trade_settlement',
      impermissibleAssetTouch: false
    };
    return {
      opportunityId: hashCanonical(core),
      core
    };
  });
  const revenueEvents = opportunities.map((opportunity) => eventWithId('sukuk_stablecoin_defi_event', {
    version: 1,
    eventType: 'credit_tradelayer_arb_service_profit',
    propertyId: STABLECOIN_PROPERTY_ID,
    issuanceId: issuance.issuanceId,
    opportunityId: opportunity.opportunityId,
    amountUnits: opportunity.core.expectedServiceProfitUnits,
    feeCharacter: 'trade_execution_service_profit_not_interest'
  }));
  const mandateCore = {
    version: 1,
    mandateType: 'bounded_tradelayer_halal_arb',
    issuanceId: issuance.issuanceId,
    stablecoinPropertyId: STABLECOIN_PROPERTY_ID,
    allocatedUnits: allocatedUnits.toString(),
    opportunityIds: opportunities.map((opportunity) => opportunity.opportunityId),
    revenueEventIds: revenueEvents.map((event) => event.eventId),
    usedInventoryUnits: sumUnits(opportunities.map((opportunity) => opportunity.core.amountUnits)),
    expectedServiceProfitUnits: sumUnits(opportunities.map((opportunity) => opportunity.core.expectedServiceProfitUnits)),
    constraints: {
      leverageAllowed: false,
      borrowLendAllowed: false,
      shortSellingAllowed: false,
      guaranteedReturnAllowed: false,
      impermissibleAssetTouchAllowed: false,
      principalLossPossibleAndDisclosed: true
    }
  };

  return {
    kind: 'sukuk_stablecoin_tradelayer_arb_mandate',
    mandateId: hashCanonical(mandateCore),
    mandateCore,
    opportunities,
    revenueEvents
  };
}

function verifyTradeLayerArbMandate(mandate, issuance) {
  if (!mandate || mandate.kind !== 'sukuk_stablecoin_tradelayer_arb_mandate') {
    return { ok: false, reason: 'wrong arb mandate kind' };
  }
  if (mandate.mandateId !== hashCanonical(mandate.mandateCore)) {
    return { ok: false, reason: 'arb mandate id mismatch' };
  }
  if (issuance && mandate.mandateCore.issuanceId !== issuance.issuanceId) {
    return { ok: false, reason: 'arb mandate issuance mismatch' };
  }
  const constraints = mandate.mandateCore.constraints || {};
  if (
    constraints.leverageAllowed ||
    constraints.borrowLendAllowed ||
    constraints.shortSellingAllowed ||
    constraints.guaranteedReturnAllowed ||
    constraints.impermissibleAssetTouchAllowed
  ) {
    return { ok: false, reason: 'arb mandate violates halal constraints' };
  }
  for (const opportunity of mandate.opportunities || []) {
    if (opportunity.opportunityId !== hashCanonical(opportunity.core)) {
      return { ok: false, reason: 'arb opportunity id mismatch' };
    }
    const expectedProfit = opportunity.core.netSpreadBps > 0
      ? bpsAmount(opportunity.core.amountUnits, opportunity.core.netSpreadBps).toString()
      : '0';
    if (opportunity.core.expectedServiceProfitUnits !== expectedProfit) {
      return { ok: false, reason: 'arb opportunity expected profit mismatch' };
    }
    if (opportunity.core.impermissibleAssetTouch !== false) {
      return { ok: false, reason: 'arb opportunity touches impermissible asset' };
    }
  }
  if (BigInt(mandate.mandateCore.usedInventoryUnits) > BigInt(mandate.mandateCore.allocatedUnits)) {
    return { ok: false, reason: 'arb mandate uses more inventory than allocated' };
  }
  for (let i = 0; i < mandate.revenueEvents.length; i++) {
    const event = mandate.revenueEvents[i];
    const opportunity = mandate.opportunities[i];
    if (event.eventId !== hashCanonical(event.eventCore)) {
      return { ok: false, reason: 'arb revenue event id mismatch' };
    }
    if (event.eventCore.amountUnits !== opportunity.core.expectedServiceProfitUnits) {
      return { ok: false, reason: 'arb revenue event amount mismatch' };
    }
    if (event.eventCore.feeCharacter !== 'trade_execution_service_profit_not_interest') {
      return { ok: false, reason: 'arb revenue must be service profit' };
    }
  }
  return { ok: true };
}

function buildSukukStablecoinHalalDefiPortfolio(options = {}) {
  const reserve = options.reserve || buildBankedSukukStablecoinReserve(options);
  const issuance = options.issuance || buildTradeLayerStablecoinIssuance(reserve, options);
  const taprootPledge = options.taprootPledge || buildTaprootStablecoinPledge(issuance, options.taprootPledgeOptions || {});
  const routingMarket = options.routingMarket || buildLightningHawalaRoutingMarket(taprootPledge, options.routingMarketOptions || {});
  const arbMandate = options.arbMandate || buildTradeLayerArbMandate(issuance, options.arbMandateOptions || {});
  const totalDefiAllocatedUnits = BigInt(taprootPledge.pledgeCore.lockedUnits) + BigInt(arbMandate.mandateCore.allocatedUnits);
  const issuedUnits = BigInt(issuance.issuanceCore.amountUnits);
  const portfolioCore = {
    version: 1,
    product: 'banked_sukuk_stablecoin_halal_defi_rails',
    reserveId: reserve.reserveId,
    issuanceId: issuance.issuanceId,
    stablecoinPropertyId: STABLECOIN_PROPERTY_ID,
    taprootPledgeId: taprootPledge.pledgeId,
    routingMarketId: routingMarket.marketId,
    arbMandateId: arbMandate.mandateId,
    issuedUnits: issuedUnits.toString(),
    taprootLightningAllocatedUnits: taprootPledge.pledgeCore.lockedUnits,
    tradeLayerArbAllocatedUnits: arbMandate.mandateCore.allocatedUnits,
    totalDefiAllocatedUnits: totalDefiAllocatedUnits.toString(),
    redemptionBufferUnits: (issuedUnits > totalDefiAllocatedUnits ? issuedUnits - totalDefiAllocatedUnits : 0n).toString(),
    totalServiceFeeUnits: (
      BigInt(routingMarket.marketCore.serviceFeeUnits) +
      BigInt(arbMandate.mandateCore.expectedServiceProfitUnits)
    ).toString(),
    halalDefiRule: 'stablecoin principal is banked and redeemable; DeFi fees are explicit service revenues from separate pledged mandates'
  };

  return {
    kind: 'sukuk_stablecoin_halal_defi_portfolio',
    portfolioId: hashCanonical(portfolioCore),
    portfolioCore,
    reserve,
    issuance,
    taprootPledge,
    routingMarket,
    arbMandate
  };
}

function verifySukukStablecoinHalalDefiPortfolio(portfolio) {
  if (!portfolio || portfolio.kind !== 'sukuk_stablecoin_halal_defi_portfolio') {
    return { ok: false, reason: 'wrong halal DeFi portfolio kind' };
  }
  if (portfolio.portfolioId !== hashCanonical(portfolio.portfolioCore)) {
    return { ok: false, reason: 'halal DeFi portfolio id mismatch' };
  }
  const reserve = verifyBankedSukukStablecoinReserve(portfolio.reserve);
  if (!reserve.ok) return { ok: false, reason: `reserve failed: ${reserve.reason}` };
  const issuance = verifyTradeLayerStablecoinIssuance(portfolio.issuance);
  if (!issuance.ok) return { ok: false, reason: `issuance failed: ${issuance.reason}` };
  const pledge = verifyTaprootStablecoinPledge(portfolio.taprootPledge, portfolio.issuance);
  if (!pledge.ok) return { ok: false, reason: `taproot pledge failed: ${pledge.reason}` };
  const routing = verifyLightningHawalaRoutingMarket(portfolio.routingMarket, portfolio.taprootPledge);
  if (!routing.ok) return { ok: false, reason: `routing market failed: ${routing.reason}` };
  const arb = verifyTradeLayerArbMandate(portfolio.arbMandate, portfolio.issuance);
  if (!arb.ok) return { ok: false, reason: `arb mandate failed: ${arb.reason}` };

  const issuedUnits = BigInt(portfolio.issuance.issuanceCore.amountUnits);
  const totalDefiAllocatedUnits = BigInt(portfolio.taprootPledge.pledgeCore.lockedUnits) + BigInt(portfolio.arbMandate.mandateCore.allocatedUnits);
  if (totalDefiAllocatedUnits > issuedUnits) {
    return { ok: false, reason: 'defi allocation exceeds issued stablecoin units' };
  }
  if (portfolio.portfolioCore.totalDefiAllocatedUnits !== totalDefiAllocatedUnits.toString()) {
    return { ok: false, reason: 'portfolio allocation total mismatch' };
  }
  const totalServiceFeeUnits = (
    BigInt(portfolio.routingMarket.marketCore.serviceFeeUnits) +
    BigInt(portfolio.arbMandate.mandateCore.expectedServiceProfitUnits)
  ).toString();
  if (portfolio.portfolioCore.totalServiceFeeUnits !== totalServiceFeeUnits) {
    return { ok: false, reason: 'portfolio service fee total mismatch' };
  }
  return {
    ok: true,
    portfolioId: portfolio.portfolioId,
    issuedUnits: issuedUnits.toString(),
    totalDefiAllocatedUnits: totalDefiAllocatedUnits.toString(),
    totalServiceFeeUnits
  };
}

function renderHalalDefiMarkdown(portfolio) {
  const lines = [];
  lines.push('# Sukuk Stablecoin Halal DeFi Rails');
  lines.push('');
  lines.push(`- Portfolio id: \`${portfolio.portfolioId}\``);
  lines.push(`- Stablecoin propertyId: \`${portfolio.portfolioCore.stablecoinPropertyId}\``);
  lines.push(`- Issued units: \`${portfolio.portfolioCore.issuedUnits}\``);
  lines.push(`- DeFi allocated units: \`${portfolio.portfolioCore.totalDefiAllocatedUnits}\``);
  lines.push(`- Redemption buffer units: \`${portfolio.portfolioCore.redemptionBufferUnits}\``);
  lines.push(`- Total service fee units: \`${portfolio.portfolioCore.totalServiceFeeUnits}\``);
  lines.push('');
  lines.push('## Flow');
  lines.push('');
  lines.push('```mermaid');
  lines.push('flowchart LR');
  lines.push('  B[Islamic bank reserve] --> S[TradeLayer stablecoin propertyId 9001]');
  lines.push('  S --> P[TAP asset pledge]');
  lines.push('  P --> L[Lightning routing corridors]');
  lines.push('  L --> F[hawala-style service fee credits]');
  lines.push('  S --> A[TradeLayer arb mandate]');
  lines.push('  A --> G[bounded execution service profit]');
  lines.push('  S --> R[redemption buffer]');
  lines.push('```');
  lines.push('');
  lines.push('## Reserve');
  lines.push('');
  lines.push(`- Reserve id: \`${portfolio.reserve.reserveId}\``);
  lines.push(`- Eligible reserve units: \`${portfolio.reserve.reserveCore.eligibleReserveUnits}\``);
  lines.push(`- Coverage bps: \`${portfolio.reserve.reserveCore.coverageBps}\``);
  lines.push(`- Farm REIT backing enabled: \`${portfolio.reserve.reserveCore.futureDiversification.farmReitEnabledForBacking}\``);
  lines.push('');
  lines.push('## Lightning Hawala-Style Routes');
  lines.push('');
  lines.push('| corridor | routed units | computed fee bps | service fee units |');
  lines.push('| --- | --- | --- | --- |');
  for (const quote of portfolio.routingMarket.routeQuotes) {
    lines.push(
      `| ${quote.quoteCore.corridorId} | ${quote.quoteCore.amountUnits} | ${quote.quoteCore.computedFeeBps} | ${quote.quoteCore.serviceFeeUnits} |`
    );
  }
  lines.push('');
  lines.push('## TradeLayer Arb Mandate');
  lines.push('');
  lines.push('| pair | venues | amount units | net spread bps | expected service profit |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const opportunity of portfolio.arbMandate.opportunities) {
    lines.push(
      `| ${opportunity.core.pair} | ${opportunity.core.venueA} -> ${opportunity.core.venueB} | ${opportunity.core.amountUnits} | ${opportunity.core.netSpreadBps} | ${opportunity.core.expectedServiceProfitUnits} |`
    );
  }
  lines.push('');
  lines.push('## Halal Controls');
  lines.push('');
  lines.push('- Stablecoin holders do not receive portfolio yield by holding the par token.');
  lines.push('- Lightning and arb revenues are service fees or execution profits from explicit pledged mandates.');
  lines.push('- Leverage, borrowing/lending, short selling, guaranteed returns, and impermissible asset touch are disabled in the deterministic mandate.');
  lines.push('- Farm REIT diversification is modeled as future work and receives no reserve backing credit in this artifact.');
  return lines.join('\n');
}

function writeSukukStablecoinHalalDefiPortfolio(portfolio, outJsonPath = OUT_JSON, outMdPath = OUT_MD) {
  ensureDir(path.dirname(outJsonPath));
  fs.writeFileSync(outJsonPath, stringifyJson(portfolio, true));
  fs.writeFileSync(outMdPath, renderHalalDefiMarkdown(portfolio));
  return { outJsonPath, outMdPath };
}

function run() {
  const portfolio = buildSukukStablecoinHalalDefiPortfolio();
  const verification = verifySukukStablecoinHalalDefiPortfolio(portfolio);
  if (!verification.ok) {
    throw new Error(verification.reason);
  }
  const written = writeSukukStablecoinHalalDefiPortfolio(portfolio);
  console.log('=== Sukuk Stablecoin Halal DeFi Rails ===');
  console.log(`portfolioId=${portfolio.portfolioId}`);
  console.log(`issuedUnits=${portfolio.portfolioCore.issuedUnits}`);
  console.log(`defiAllocatedUnits=${portfolio.portfolioCore.totalDefiAllocatedUnits}`);
  console.log(`serviceFeeUnits=${portfolio.portfolioCore.totalServiceFeeUnits}`);
  console.log(`jsonPath=${written.outJsonPath}`);
  console.log(`mdPath=${written.outMdPath}`);
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error('Sukuk stablecoin halal DeFi generation failed:', err.message);
    process.exit(1);
  }
}

module.exports = {
  ARTIFACTS_DIR,
  OUT_JSON,
  OUT_MD,
  STABLECOIN_PROPERTY_ID,
  STABLECOIN_TICKER,
  buildBankedSukukStablecoinReserve,
  verifyBankedSukukStablecoinReserve,
  buildTradeLayerStablecoinIssuance,
  verifyTradeLayerStablecoinIssuance,
  buildTaprootStablecoinPledge,
  verifyTaprootStablecoinPledge,
  buildDynamicHawalaRouteQuote,
  verifyDynamicHawalaRouteQuote,
  buildLightningHawalaRoutingMarket,
  verifyLightningHawalaRoutingMarket,
  buildTradeLayerArbMandate,
  verifyTradeLayerArbMandate,
  buildSukukStablecoinHalalDefiPortfolio,
  verifySukukStablecoinHalalDefiPortfolio,
  writeSukukStablecoinHalalDefiPortfolio,
  renderHalalDefiMarkdown
};
