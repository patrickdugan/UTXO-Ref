/**
 * Milestone 1 Specification Helpers
 *
 * Canonical schema definitions for:
 * - epochId
 * - payout leaf: (epochId, recipientScriptPubKey, amountSats)
 * - commitment package: (epochId, withdrawalRoot, capSats, residualDest)
 *
 * Plus a deterministic DLC deposit template describing the 1:1 receipt model.
 */

const crypto = require('crypto');
const { PayoutLeaf, CommitmentPackage } = require('./types');

const U64_MAX = (1n << 64n) - 1n;

const PAYOUT_LEAF_SCHEMA_FIELDS = Object.freeze([
  'epochId',
  'recipientScriptPubKey',
  'amountSats'
]);

const COMMITMENT_PACKAGE_SCHEMA_FIELDS = Object.freeze([
  'epochId',
  'withdrawalRoot',
  'capSats',
  'residualDest'
]);

const RECEIPT_DLC_TEMPLATE_V1 = Object.freeze({
  templateId: 'dlc-receipt-ltc-testnet-v1',
  version: 1,
  chain: {
    network: 'litecoin-testnet',
    amountUnit: 'sats'
  },
  receiptToken: {
    symbol: 'rLTC-SAT',
    offChainOnly: true,
    backingUnit: 'sats',
    mintRatioNumerator: 1,
    mintRatioDenominator: 1,
    burnRedeemsBacking: true
  },
  depositContract: {
    type: 'dlc-deposit',
    witnessPolicy: ['p2wpkh', 'p2tr'],
    minConfirmations: 1
  },
  settlement: {
    epochCadence: 'weekly',
    payoutLeafSchema: PAYOUT_LEAF_SCHEMA_FIELDS.slice(),
    commitmentSchema: COMMITMENT_PACKAGE_SCHEMA_FIELDS.slice()
  }
});

function toBigInt(value, fieldName) {
  try {
    return BigInt(value);
  } catch (e) {
    throw new Error(`${fieldName} must be convertible to BigInt`);
  }
}

function normalizeEpochId(epochId) {
  const v = toBigInt(epochId, 'epochId');
  if (v < 0n || v > U64_MAX) {
    throw new Error('epochId must be within uint64 range');
  }
  return v;
}

function normalizeAmountSats(amountSats, fieldName = 'amountSats') {
  const v = toBigInt(amountSats, fieldName);
  if (v < 0n || v > U64_MAX) {
    throw new Error(`${fieldName} must be within uint64 range`);
  }
  return v;
}

function validatePayoutLeafRecord(record) {
  return new PayoutLeaf({
    epochId: normalizeEpochId(record.epochId),
    recipientScriptPubKey: record.recipientScriptPubKey,
    amountSats: normalizeAmountSats(record.amountSats)
  });
}

function validateCommitmentPackageRecord(record) {
  return new CommitmentPackage({
    epochId: normalizeEpochId(record.epochId),
    withdrawalRoot: record.withdrawalRoot,
    capSats: normalizeAmountSats(record.capSats, 'capSats'),
    residualDest: record.residualDest
  });
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map(v => canonicalStringify(v)).join(',');
    return `[${items}]`;
  }

  const keys = Object.keys(value).sort();
  const pairs = keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`);
  return `{${pairs.join(',')}}`;
}

function templateHashHex(template = RECEIPT_DLC_TEMPLATE_V1) {
  const canonical = canonicalStringify(template);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

module.exports = {
  U64_MAX,
  PAYOUT_LEAF_SCHEMA_FIELDS,
  COMMITMENT_PACKAGE_SCHEMA_FIELDS,
  RECEIPT_DLC_TEMPLATE_V1,
  normalizeEpochId,
  normalizeAmountSats,
  validatePayoutLeafRecord,
  validateCommitmentPackageRecord,
  canonicalStringify,
  templateHashHex
};

