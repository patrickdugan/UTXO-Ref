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
const { getChainProfile } = require('./m1_chain_env');

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

const SETTLEMENT_PATH_SCHEMA_FIELDS = Object.freeze([
  'pathId',
  'kind',
  'winnerRole',
  'winnerAddress',
  'refundRole',
  'refundAddress',
  'feeRole',
  'feeAddress',
  'dustRole',
  'dustAddress',
  'bucketCapBps',
  'realizedPnlBps',
  'effectivePnlBps',
  'feeBps',
  'actualPayoutSats',
  'feeSats',
  'refundSats',
  'timeoutRemainderSats',
  'rolloverCollateralSats',
  'payoutSats',
  'residualSats',
  'dustCarrySats',
  'defaultOnExpiry'
]);

function buildReceiptDlcTemplate(chainId = 'litecoin-testnet') {
  const profile = getChainProfile(chainId);

  return Object.freeze({
    templateId: profile.templateId,
    version: 1,
    chain: {
      network: profile.chainId,
      family: profile.family,
      ticker: profile.ticker,
      amountUnit: 'sats'
    },
    receiptToken: {
      symbol: profile.receiptSymbol,
      offChainOnly: true,
      backingUnit: 'sats',
      mintRatioNumerator: 1,
      mintRatioDenominator: 1,
      burnRedeemsBacking: true
    },
    depositContract: {
      type: 'dlc-deposit',
      witnessPolicy: ['p2wpkh', 'p2tr'],
      minConfirmations: profile.depositMinConfirmations
    },
    settlement: {
      epochCadence: 'weekly',
      fastRollCadence: 'event-driven',
      pathModel: 'binary-settlement',
      amountComputation: 'bounded-loss-carry-forward',
      payoutRatioBps: 5000,
      activePaths: ['flat', 'pnl'],
      timeoutPath: 'roll',
      deltaPublicationTransport: 'op_return',
      deltaPublicationMapsTo: 'adaptorSignatureSlots',
      challengeWindowLength: 0n,
      dustCarryField: 'dustCarrySats',
      feeField: 'feeSats',
      refundField: 'refundSats',
      carryForwardField: 'rolloverCollateralSats',
      realizedPnlField: 'realizedPnlBps',
      bucketCapField: 'bucketCapBps',
      payoutLeafSchema: PAYOUT_LEAF_SCHEMA_FIELDS.slice(),
      commitmentSchema: COMMITMENT_PACKAGE_SCHEMA_FIELDS.slice(),
      settlementPathSchema: SETTLEMENT_PATH_SCHEMA_FIELDS.slice()
    }
  });
}

const RECEIPT_DLC_TEMPLATE_V1 = Object.freeze(buildReceiptDlcTemplate('litecoin-testnet'));

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
  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString());
  }
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
  SETTLEMENT_PATH_SCHEMA_FIELDS,
  RECEIPT_DLC_TEMPLATE_V1,
  buildReceiptDlcTemplate,
  normalizeEpochId,
  normalizeAmountSats,
  validatePayoutLeafRecord,
  validateCommitmentPackageRecord,
  canonicalStringify,
  templateHashHex
};
