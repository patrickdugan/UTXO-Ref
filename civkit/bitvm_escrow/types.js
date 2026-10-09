const crypto = require('crypto');
const { writeU64LE, serializeScriptPubKey } = require('../../bitvm3/utxo_referee/types');

const ORDER_TAG = Buffer.from('CIVKIT_ESCROW_ORDER_V1');
const DECISION_TAG = Buffer.from('CIVKIT_ESCROW_DECISION_V1');
const ROUTE_IDS = Object.freeze({
  release: 0,
  refund: 1,
  split: 2
});

function writeU32LE(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function serializeUtf8(value, label) {
  const text = value == null ? '' : String(value);
  const buf = Buffer.from(text, 'utf8');
  return Buffer.concat([writeU32LE(buf.length), buf]);
}

function asScriptPubKeyBuffer(value, label) {
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  if (typeof value === 'string') {
    const hex = value.startsWith('0x') ? value.slice(2) : value;
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
      throw new Error(`${label} must be a Buffer or hex string`);
    }
    return Buffer.from(hex, 'hex');
  }
  throw new Error(`${label} must be a Buffer or hex string`);
}

function normalizeBigInt(value, label) {
  if (value == null) {
    throw new Error(`${label} is required`);
  }
  const normalized = BigInt(value);
  if (normalized < 0n) {
    throw new Error(`${label} must be non-negative`);
  }
  return normalized;
}

function normalizeOptionalBigInt(value, label) {
  if (value == null) {
    return null;
  }
  return normalizeBigInt(value, label);
}

function normalizeRoute(route) {
  const normalized = String(route || '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ROUTE_IDS, normalized)) {
    throw new Error(`Unsupported escrow route: ${route}`);
  }
  return normalized;
}

class EscrowOrder {
  constructor({
    orderId,
    epochId,
    escrowAmountSats,
    sellerPayoutScriptPubKey,
    buyerRefundScriptPubKey,
    fixedFeeOutputs = null,
    serviceFeeScriptPubKey = null,
    serviceFeeSats = 0n,
    resolverFeeScriptPubKey = null,
    expiryBlock = null,
    residualDest = null
  }) {
    if (orderId == null || String(orderId).trim() === '') {
      throw new Error('orderId is required');
    }

    this.orderId = String(orderId);
    this.epochId = normalizeBigInt(epochId, 'epochId');
    this.escrowAmountSats = normalizeBigInt(escrowAmountSats, 'escrowAmountSats');
    this.sellerPayoutScriptPubKey = asScriptPubKeyBuffer(
      sellerPayoutScriptPubKey,
      'sellerPayoutScriptPubKey'
    );
    this.buyerRefundScriptPubKey = asScriptPubKeyBuffer(
      buyerRefundScriptPubKey,
      'buyerRefundScriptPubKey'
    );
    this.serviceFeeSats = normalizeBigInt(serviceFeeSats, 'serviceFeeSats');
    this.serviceFeeScriptPubKey = serviceFeeScriptPubKey == null
      ? null
      : asScriptPubKeyBuffer(serviceFeeScriptPubKey, 'serviceFeeScriptPubKey');
    this.resolverFeeScriptPubKey = resolverFeeScriptPubKey == null
      ? null
      : asScriptPubKeyBuffer(resolverFeeScriptPubKey, 'resolverFeeScriptPubKey');
    this.expiryBlock = normalizeOptionalBigInt(expiryBlock, 'expiryBlock');
    this.residualDest = residualDest == null
      ? Buffer.from(this.buyerRefundScriptPubKey)
      : asScriptPubKeyBuffer(residualDest, 'residualDest');

    const normalizedFixedFeeOutputs = Array.isArray(fixedFeeOutputs)
      ? fixedFeeOutputs.map((output, index) => ({
        feeId: output && output.feeId != null ? String(output.feeId) : `fee_${index}`,
        role: output && output.role != null ? String(output.role) : 'service_fee',
        recipientScriptPubKey: asScriptPubKeyBuffer(
          output.recipientScriptPubKey,
          `fixedFeeOutputs[${index}].recipientScriptPubKey`
        ),
        amountSats: normalizeBigInt(
          output.amountSats,
          `fixedFeeOutputs[${index}].amountSats`
        )
      }))
      : [];

    if (this.serviceFeeSats > 0n) {
      if (this.serviceFeeScriptPubKey == null) {
        throw new Error('serviceFeeScriptPubKey is required when serviceFeeSats > 0');
      }
      normalizedFixedFeeOutputs.push({
        feeId: 'legacy_service_fee',
        role: 'service_fee',
        recipientScriptPubKey: this.serviceFeeScriptPubKey,
        amountSats: this.serviceFeeSats
      });
    }

    this.fixedFeeOutputs = normalizedFixedFeeOutputs;

    if (this.escrowAmountSats === 0n) {
      throw new Error('escrowAmountSats must be greater than zero');
    }
    const totalFixedFeeSats = this.fixedFeeOutputs.reduce(
      (sum, output) => sum + output.amountSats,
      0n
    );
    if (totalFixedFeeSats > this.escrowAmountSats) {
      throw new Error('Total fixed fees cannot exceed escrowAmountSats');
    }
  }

  serialize() {
    const expiryFlag = this.expiryBlock == null ? Buffer.from([0]) : Buffer.from([1]);
    const resolverFlag = this.resolverFeeScriptPubKey == null ? Buffer.from([0]) : Buffer.from([1]);
    const fixedFeeCount = writeU32LE(this.fixedFeeOutputs.length);
    const fixedFeeBytes = this.fixedFeeOutputs.map((output) => Buffer.concat([
      serializeUtf8(output.feeId),
      serializeUtf8(output.role),
      writeU64LE(output.amountSats),
      serializeScriptPubKey(output.recipientScriptPubKey)
    ]));

    return Buffer.concat([
      ORDER_TAG,
      serializeUtf8(this.orderId),
      writeU64LE(this.epochId),
      writeU64LE(this.escrowAmountSats),
      serializeScriptPubKey(this.sellerPayoutScriptPubKey),
      serializeScriptPubKey(this.buyerRefundScriptPubKey),
      fixedFeeCount,
      ...fixedFeeBytes,
      resolverFlag,
      this.resolverFeeScriptPubKey == null
        ? Buffer.alloc(0)
        : serializeScriptPubKey(this.resolverFeeScriptPubKey),
      expiryFlag,
      this.expiryBlock == null ? Buffer.alloc(0) : writeU64LE(this.expiryBlock),
      serializeScriptPubKey(this.residualDest)
    ]);
  }

  hash() {
    return crypto.createHash('sha256').update(this.serialize()).digest();
  }
}

class EscrowDecision {
  constructor({
    route,
    sellerAmountSats = null,
    buyerAmountSats = null,
    resolverFeeSats = 0n,
    decisionId = ''
  }) {
    this.route = normalizeRoute(route);
    this.sellerAmountSats = sellerAmountSats == null
      ? null
      : normalizeBigInt(sellerAmountSats, 'sellerAmountSats');
    this.buyerAmountSats = buyerAmountSats == null
      ? null
      : normalizeBigInt(buyerAmountSats, 'buyerAmountSats');
    this.resolverFeeSats = normalizeBigInt(resolverFeeSats, 'resolverFeeSats');
    this.decisionId = String(decisionId || '');

    if (this.route === 'split') {
      if (this.sellerAmountSats == null || this.buyerAmountSats == null) {
        throw new Error('split route requires sellerAmountSats and buyerAmountSats');
      }
    } else if (this.sellerAmountSats != null || this.buyerAmountSats != null) {
      throw new Error('sellerAmountSats and buyerAmountSats are only valid for split route');
    }
  }

  serialize() {
    return Buffer.concat([
      DECISION_TAG,
      Buffer.from([ROUTE_IDS[this.route]]),
      writeU64LE(this.sellerAmountSats == null ? 0n : this.sellerAmountSats),
      writeU64LE(this.buyerAmountSats == null ? 0n : this.buyerAmountSats),
      writeU64LE(this.resolverFeeSats),
      serializeUtf8(this.decisionId)
    ]);
  }

  hash() {
    return crypto.createHash('sha256').update(this.serialize()).digest();
  }
}

module.exports = {
  ORDER_TAG,
  DECISION_TAG,
  ROUTE_IDS,
  asScriptPubKeyBuffer,
  normalizeBigInt,
  normalizeOptionalBigInt,
  normalizeRoute,
  EscrowOrder,
  EscrowDecision
};
