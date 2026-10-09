const crypto = require('crypto');
const {
  asScriptPubKeyBuffer,
  normalizeBigInt,
  normalizeOptionalBigInt
} = require('../bitvm_escrow/types');

function writeU32LE(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function writeBool(value) {
  return Buffer.from([value ? 1 : 0]);
}

function serializeUtf8(value) {
  const text = value == null ? '' : String(value);
  const buf = Buffer.from(text, 'utf8');
  return Buffer.concat([writeU32LE(buf.length), buf]);
}

function serializeStringList(values) {
  const items = normalizeStringList(values);
  return Buffer.concat([
    writeU32LE(items.length),
    ...items.map((value) => serializeUtf8(value))
  ]);
}

function serializeU64(value) {
  return Buffer.from(BigInt(value).toString(16).padStart(16, '0'), 'hex');
}

function normalizeStringList(values) {
  if (values == null) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error('Expected an array of strings');
  }
  return values.map((value) => String(value).trim()).filter(Boolean);
}

function normalizeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return normalized;
}

function normalizeBps(value, label) {
  return normalizeInteger(value == null ? 0 : value, label, { min: 0, max: 10000 });
}

function normalizeScore(value, label) {
  return normalizeInteger(value == null ? 0 : value, label, { min: 0, max: 100 });
}

class MarketplacePolicy {
  constructor({
    policyId,
    network = 'bitcoin',
    platformFeeScriptPubKey = null,
    platformFeeBps = 0,
    platformFlatFeeSats = 0n,
    escrowExpiryBlocks = 144n,
    requiredWhitelistTag = 'global',
    minNotaryReputation = 0,
    maxResolverFeeBps = 1000,
    allowedPaymentMethods = [],
    allowedRegions = []
  }) {
    if (policyId == null || String(policyId).trim() === '') {
      throw new Error('policyId is required');
    }

    this.policyId = String(policyId);
    this.network = String(network);
    this.platformFeeScriptPubKey = platformFeeScriptPubKey == null
      ? null
      : asScriptPubKeyBuffer(platformFeeScriptPubKey, 'platformFeeScriptPubKey');
    this.platformFeeBps = normalizeBps(platformFeeBps, 'platformFeeBps');
    this.platformFlatFeeSats = normalizeBigInt(platformFlatFeeSats, 'platformFlatFeeSats');
    this.escrowExpiryBlocks = normalizeBigInt(escrowExpiryBlocks, 'escrowExpiryBlocks');
    this.requiredWhitelistTag = String(requiredWhitelistTag || 'global');
    this.minNotaryReputation = normalizeScore(minNotaryReputation, 'minNotaryReputation');
    this.maxResolverFeeBps = normalizeBps(maxResolverFeeBps, 'maxResolverFeeBps');
    this.allowedPaymentMethods = normalizeStringList(allowedPaymentMethods);
    this.allowedRegions = normalizeStringList(allowedRegions);

    if (
      (this.platformFeeBps > 0 || this.platformFlatFeeSats > 0n) &&
      this.platformFeeScriptPubKey == null
    ) {
      throw new Error('platformFeeScriptPubKey is required when platform fees are enabled');
    }
  }

  serialize() {
    return Buffer.concat([
      serializeUtf8(this.policyId),
      serializeUtf8(this.network),
      writeU32LE(this.platformFeeBps),
      serializeU64(this.platformFlatFeeSats),
      serializeU64(this.escrowExpiryBlocks),
      serializeUtf8(this.requiredWhitelistTag),
      writeU32LE(this.minNotaryReputation),
      writeU32LE(this.maxResolverFeeBps),
      this.platformFeeScriptPubKey == null
        ? writeBool(false)
        : Buffer.concat([writeBool(true), serializeUtf8(this.platformFeeScriptPubKey.toString('hex'))]),
      serializeStringList(this.allowedPaymentMethods),
      serializeStringList(this.allowedRegions)
    ]);
  }

  hash() {
    return crypto.createHash('sha256').update(this.serialize()).digest();
  }
}

class NotaryProfile {
  constructor({
    notaryId,
    nostrPubkey,
    settlementScriptPubKey,
    bookingFlatFeeSats = 0n,
    bookingFeeBps = 0,
    resolverFlatFeeSats = 0n,
    resolverFeeBps = 0,
    supportedPaymentMethods = [],
    supportedRegions = [],
    whitelistTags = ['global'],
    reputationScore = 0,
    minTradeSats = 0n,
    maxTradeSats = null,
    active = true
  }) {
    if (notaryId == null || String(notaryId).trim() === '') {
      throw new Error('notaryId is required');
    }
    if (nostrPubkey == null || String(nostrPubkey).trim() === '') {
      throw new Error('nostrPubkey is required');
    }

    this.notaryId = String(notaryId);
    this.nostrPubkey = String(nostrPubkey);
    this.settlementScriptPubKey = asScriptPubKeyBuffer(
      settlementScriptPubKey,
      'settlementScriptPubKey'
    );
    this.bookingFlatFeeSats = normalizeBigInt(bookingFlatFeeSats, 'bookingFlatFeeSats');
    this.bookingFeeBps = normalizeBps(bookingFeeBps, 'bookingFeeBps');
    this.resolverFlatFeeSats = normalizeBigInt(resolverFlatFeeSats, 'resolverFlatFeeSats');
    this.resolverFeeBps = normalizeBps(resolverFeeBps, 'resolverFeeBps');
    this.supportedPaymentMethods = normalizeStringList(supportedPaymentMethods);
    this.supportedRegions = normalizeStringList(supportedRegions);
    this.whitelistTags = normalizeStringList(whitelistTags);
    this.reputationScore = normalizeScore(reputationScore, 'reputationScore');
    this.minTradeSats = normalizeBigInt(minTradeSats, 'minTradeSats');
    this.maxTradeSats = normalizeOptionalBigInt(maxTradeSats, 'maxTradeSats');
    this.active = Boolean(active);
  }

  serialize() {
    return Buffer.concat([
      serializeUtf8(this.notaryId),
      serializeUtf8(this.nostrPubkey),
      serializeUtf8(this.settlementScriptPubKey.toString('hex')),
      serializeU64(this.bookingFlatFeeSats),
      writeU32LE(this.bookingFeeBps),
      serializeU64(this.resolverFlatFeeSats),
      writeU32LE(this.resolverFeeBps),
      serializeStringList(this.supportedPaymentMethods),
      serializeStringList(this.supportedRegions),
      serializeStringList(this.whitelistTags),
      writeU32LE(this.reputationScore),
      serializeU64(this.minTradeSats),
      this.maxTradeSats == null
        ? writeBool(false)
        : Buffer.concat([writeBool(true), serializeU64(this.maxTradeSats)]),
      writeBool(this.active)
    ]);
  }

  hash() {
    return crypto.createHash('sha256').update(this.serialize()).digest();
  }
}

class MarketOffer {
  constructor({
    offerId,
    epochId,
    sellerId,
    amountSats,
    fiatCurrency,
    fiatAmountMinor,
    paymentMethod,
    region,
    sellerPayoutScriptPubKey,
    buyerRefundScriptPubKey,
    preferredNotaryIds = []
  }) {
    if (offerId == null || String(offerId).trim() === '') {
      throw new Error('offerId is required');
    }
    if (sellerId == null || String(sellerId).trim() === '') {
      throw new Error('sellerId is required');
    }
    if (paymentMethod == null || String(paymentMethod).trim() === '') {
      throw new Error('paymentMethod is required');
    }
    if (region == null || String(region).trim() === '') {
      throw new Error('region is required');
    }

    this.offerId = String(offerId);
    this.epochId = normalizeBigInt(epochId, 'epochId');
    this.sellerId = String(sellerId);
    this.amountSats = normalizeBigInt(amountSats, 'amountSats');
    this.fiatCurrency = String(fiatCurrency || '').toUpperCase();
    this.fiatAmountMinor = normalizeBigInt(fiatAmountMinor, 'fiatAmountMinor');
    this.paymentMethod = String(paymentMethod);
    this.region = String(region);
    this.sellerPayoutScriptPubKey = asScriptPubKeyBuffer(
      sellerPayoutScriptPubKey,
      'sellerPayoutScriptPubKey'
    );
    this.buyerRefundScriptPubKey = asScriptPubKeyBuffer(
      buyerRefundScriptPubKey,
      'buyerRefundScriptPubKey'
    );
    this.preferredNotaryIds = normalizeStringList(preferredNotaryIds);
  }

  serialize() {
    return Buffer.concat([
      serializeUtf8(this.offerId),
      serializeU64(this.epochId),
      serializeUtf8(this.sellerId),
      serializeU64(this.amountSats),
      serializeUtf8(this.fiatCurrency),
      serializeU64(this.fiatAmountMinor),
      serializeUtf8(this.paymentMethod),
      serializeUtf8(this.region),
      serializeUtf8(this.sellerPayoutScriptPubKey.toString('hex')),
      serializeUtf8(this.buyerRefundScriptPubKey.toString('hex')),
      serializeStringList(this.preferredNotaryIds)
    ]);
  }

  hash() {
    return crypto.createHash('sha256').update(this.serialize()).digest();
  }
}

module.exports = {
  normalizeStringList,
  normalizeBps,
  MarketplacePolicy,
  NotaryProfile,
  MarketOffer
};
