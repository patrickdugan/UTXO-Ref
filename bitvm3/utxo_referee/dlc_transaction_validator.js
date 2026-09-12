'use strict';

const crypto = require('crypto');
const { canonicalize, canonicalJson } = require('./dlc_canonical_json');

const MAX_MONEY = 21000000n * 100000000n;
const P2A_SCRIPT_PUBKEY_HEX = '51024e73';
const TRUC_VERSION = 3;
const TRUC_MAX_VSIZE = 10000;
const TRUC_CHILD_MAX_VSIZE = 1000;
const TRUC_MAX_UNCONFIRMED_CLUSTER_TRANSACTIONS = 2;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function sha256Hex(value) {
  return sha256(value).toString('hex');
}

function requireHex(value, bytes, fieldName) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${fieldName} must be lowercase ${bytes}-byte hex`);
  }
  return value;
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  remaining() { return this.bytes.length - this.offset; }

  read(length, fieldName) {
    if (!Number.isSafeInteger(length) || length < 0 || this.remaining() < length) {
      throw new Error(`truncated transaction while reading ${fieldName}`);
    }
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  u32(fieldName) {
    return this.read(4, fieldName).readUInt32LE(0);
  }

  u64(fieldName) {
    return this.read(8, fieldName).readBigUInt64LE(0);
  }

  compactSize(fieldName, maximum = 10000) {
    const prefix = this.read(1, fieldName)[0];
    let value;
    if (prefix < 0xfd) value = BigInt(prefix);
    else if (prefix === 0xfd) {
      value = BigInt(this.read(2, fieldName).readUInt16LE(0));
      if (value < 0xfdn) throw new Error(`${fieldName} uses a non-canonical CompactSize`);
    } else if (prefix === 0xfe) {
      value = BigInt(this.read(4, fieldName).readUInt32LE(0));
      if (value <= 0xffffn) throw new Error(`${fieldName} uses a non-canonical CompactSize`);
    } else {
      value = this.read(8, fieldName).readBigUInt64LE(0);
      if (value <= 0xffffffffn) throw new Error(`${fieldName} uses a non-canonical CompactSize`);
    }
    if (value > BigInt(maximum)) throw new Error(`${fieldName} exceeds ${maximum}`);
    return Number(value);
  }
}

function parseCanonicalUnsignedTransaction(rawTxHex) {
  if (typeof rawTxHex !== 'string' || rawTxHex.length < 20 || rawTxHex.length % 2 !== 0 ||
      !/^[0-9a-f]+$/.test(rawTxHex)) {
    throw new Error('raw transaction must be canonical lowercase hex');
  }
  const bytes = Buffer.from(rawTxHex, 'hex');
  const reader = new Reader(bytes);
  const version = reader.u32('version');
  if (version !== 2 && version !== TRUC_VERSION) {
    throw new Error('DLC transaction version must be 2 or TRUC version 3');
  }
  const inputCount = reader.compactSize('input count', 16);
  if (inputCount < 1) throw new Error('DLC transaction must contain an input');
  const inputs = [];
  for (let index = 0; index < inputCount; index++) {
    const txid = Buffer.from(reader.read(32, `input ${index} txid`)).reverse().toString('hex');
    const vout = reader.u32(`input ${index} vout`);
    const scriptLength = reader.compactSize(`input ${index} script length`, 10000);
    const scriptSig = reader.read(scriptLength, `input ${index} scriptSig`).toString('hex');
    const sequence = reader.u32(`input ${index} sequence`);
    if (scriptSig !== '') throw new Error(`DLC input ${index} scriptSig must be empty before signing`);
    inputs.push(Object.freeze({ txid, vout, scriptSig, sequence }));
  }
  const outputCount = reader.compactSize('output count', 1000);
  if (outputCount < 1) throw new Error('DLC transaction must contain an output');
  const outputs = [];
  for (let index = 0; index < outputCount; index++) {
    const valueSats = reader.u64(`output ${index} value`);
    if (valueSats > MAX_MONEY) throw new Error(`DLC output ${index} exceeds MAX_MONEY`);
    const scriptLength = reader.compactSize(`output ${index} script length`, 10000);
    if (scriptLength < 2) throw new Error(`DLC output ${index} scriptPubKey is too short`);
    const scriptPubKeyHex = reader.read(scriptLength, `output ${index} scriptPubKey`).toString('hex');
    outputs.push(Object.freeze({ valueSats, scriptPubKeyHex }));
  }
  const locktime = reader.u32('locktime');
  if (reader.remaining() !== 0) throw new Error('raw transaction has trailing bytes');
  if (locktime !== 0 && inputs.every((input) => input.sequence === 0xffffffff)) {
    throw new Error('DLC transaction locktime is disabled by final input sequences');
  }
  const txid = Buffer.from(sha256(sha256(bytes))).reverse().toString('hex');
  return Object.freeze({
    version,
    inputs: Object.freeze(inputs),
    outputs: Object.freeze(outputs),
    locktime,
    txid,
    rawTxHex
  });
}

function parseCanonicalSignedTaprootTransaction(rawTxHex) {
  if (typeof rawTxHex !== 'string' || rawTxHex.length < 24 || rawTxHex.length % 2 !== 0 ||
      rawTxHex.length > 40000 || !/^[0-9a-f]+$/.test(rawTxHex)) {
    throw new Error('signed transaction must be bounded canonical lowercase hex');
  }
  const bytes = Buffer.from(rawTxHex, 'hex');
  const reader = new Reader(bytes);
  const versionStart = reader.offset;
  const version = reader.u32('version');
  if (version !== 2 && version !== TRUC_VERSION) throw new Error('signed DLC transaction version must be 2 or 3');
  const versionBytes = bytes.subarray(versionStart, reader.offset);
  if (reader.read(1, 'segwit marker')[0] !== 0 || reader.read(1, 'segwit flag')[0] !== 1) {
    throw new Error('signed refund must use canonical SegWit marker and flag');
  }
  const strippedBodyStart = reader.offset;
  const inputCount = reader.compactSize('input count', 16);
  if (inputCount < 1) throw new Error('signed DLC transaction must contain an input');
  for (let index = 0; index < inputCount; index++) {
    reader.read(32, `input ${index} txid`);
    reader.u32(`input ${index} vout`);
    const scriptLength = reader.compactSize(`input ${index} script length`, 10000);
    if (scriptLength !== 0) throw new Error(`signed DLC input ${index} scriptSig must be empty`);
    reader.u32(`input ${index} sequence`);
  }
  const outputCount = reader.compactSize('output count', 1000);
  if (outputCount < 1) throw new Error('signed DLC transaction must contain an output');
  for (let index = 0; index < outputCount; index++) {
    const value = reader.u64(`output ${index} value`);
    if (value > MAX_MONEY) throw new Error(`signed DLC output ${index} exceeds MAX_MONEY`);
    const scriptLength = reader.compactSize(`output ${index} script length`, 10000);
    if (scriptLength < 2) throw new Error(`signed DLC output ${index} scriptPubKey is too short`);
    reader.read(scriptLength, `output ${index} scriptPubKey`);
  }
  const strippedBodyEnd = reader.offset;
  const witness = [];
  for (let index = 0; index < inputCount; index++) {
    const itemCount = reader.compactSize(`input ${index} witness item count`, 16);
    if (itemCount !== 1) throw new Error('signed refund must contain one Taproot key-path witness item per input');
    const itemLength = reader.compactSize(`input ${index} witness item length`, 65);
    if (itemLength !== 64) throw new Error('signed refund must use one 64-byte SIGHASH_DEFAULT Schnorr signature');
    witness.push(Object.freeze([reader.read(itemLength, `input ${index} witness signature`).toString('hex')]));
  }
  const locktimeStart = reader.offset;
  reader.u32('locktime');
  if (reader.remaining() !== 0) throw new Error('signed transaction has trailing bytes');
  const stripped = Buffer.concat([
    versionBytes,
    bytes.subarray(strippedBodyStart, strippedBodyEnd),
    bytes.subarray(locktimeStart)
  ]);
  const unsignedTransaction = parseCanonicalUnsignedTransaction(stripped.toString('hex'));
  return Object.freeze({
    ...unsignedTransaction,
    wtxid: Buffer.from(sha256(sha256(bytes))).reverse().toString('hex'),
    strippedRawTxHex: unsignedTransaction.rawTxHex,
    signedRawTxHex: rawTxHex,
    witness: Object.freeze(witness),
    unsignedTransaction
  });
}

function normalizeFunding(funding) {
  if (!funding || !Number.isSafeInteger(funding.vout) || funding.vout < 0 || funding.vout > 0xffffffff ||
      typeof funding.valueSats !== 'bigint' || funding.valueSats < 1n || funding.valueSats > MAX_MONEY) {
    throw new Error('funding outpoint/value is invalid');
  }
  return Object.freeze({
    txid: requireHex(funding.txid, 32, 'funding.txid'),
    vout: funding.vout,
    valueSats: funding.valueSats,
    scriptPubKeyHex: requireHex(funding.scriptPubKeyHex, 34, 'funding.scriptPubKeyHex')
  });
}

function validateExpectedOutputs(actual, expected, label) {
  if (!Array.isArray(expected) || expected.length !== actual.length) {
    throw new Error(`${label} output count mismatch`);
  }
  for (let index = 0; index < actual.length; index++) {
    const item = expected[index];
    if (!item || typeof item.valueSats !== 'bigint' || item.valueSats < 0n ||
        typeof item.scriptPubKeyHex !== 'string' || !/^[0-9a-f]+$/.test(item.scriptPubKeyHex) ||
        actual[index].valueSats !== item.valueSats || actual[index].scriptPubKeyHex !== item.scriptPubKeyHex) {
      throw new Error(`${label} output ${index} does not match the committed payout`);
    }
  }
}

function normalizeFeePolicy(feePolicy) {
  const commonValid = feePolicy &&
      typeof feePolicy.maxRecoveryFeeSats === 'bigint' &&
      feePolicy.maxRecoveryFeeSats > 0n && feePolicy.maxRecoveryFeeSats <= MAX_MONEY &&
      Number.isSafeInteger(feePolicy.maxRecoveryFeerateSatPerVb) &&
      feePolicy.maxRecoveryFeerateSatPerVb >= 1 && feePolicy.maxRecoveryFeerateSatPerVb <= 10000 &&
      Number.isSafeInteger(feePolicy.minRelayPeers) && feePolicy.minRelayPeers >= 1 && feePolicy.minRelayPeers <= 16;
  if (!commonValid) {
    throw new Error('feePolicy must define bounded recovery fee, feerate, and relay quorum');
  }
  if (feePolicy.strategy === 'truc-p2a-v1') {
    if (feePolicy.anchorAmountSats !== 0n || feePolicy.anchorScriptPubKeyHex !== P2A_SCRIPT_PUBKEY_HEX) {
      throw new Error('truc-p2a-v1 requires one zero-sat P2A anchor with script 51024e73');
    }
    return Object.freeze({
      strategy: 'truc-p2a-v1',
      transactionVersion: TRUC_VERSION,
      anchorAmountSats: 0n,
      anchorScriptPubKeyHex: P2A_SCRIPT_PUBKEY_HEX,
      maxRecoveryFeeSats: feePolicy.maxRecoveryFeeSats,
      maxRecoveryFeerateSatPerVb: feePolicy.maxRecoveryFeerateSatPerVb,
      minRelayPeers: feePolicy.minRelayPeers,
      maxSettlementVsize: TRUC_MAX_VSIZE,
      maxRecoveryVsize: TRUC_CHILD_MAX_VSIZE,
      maxUnconfirmedClusterTransactions: TRUC_MAX_UNCONFIRMED_CLUSTER_TRANSACTIONS
    });
  }
  if (feePolicy.strategy !== 'cpfp-anchor-v1' ||
      typeof feePolicy.anchorAmountSats !== 'bigint' ||
      feePolicy.anchorAmountSats < 330n || feePolicy.anchorAmountSats > 10000n ||
      typeof feePolicy.anchorScriptPubKeyHex !== 'string' ||
      !/^(0014[0-9a-f]{40}|5120[0-9a-f]{64})$/.test(feePolicy.anchorScriptPubKeyHex) ||
      feePolicy.maxRecoveryFeeSats < feePolicy.anchorAmountSats) {
    throw new Error('feePolicy must define a 330..10000 sat P2WPKH or P2TR anchor plus bounded recovery fee, feerate, and relay quorum');
  }
  return Object.freeze({
    strategy: 'cpfp-anchor-v1',
    transactionVersion: 2,
    anchorAmountSats: feePolicy.anchorAmountSats,
    anchorScriptPubKeyHex: feePolicy.anchorScriptPubKeyHex,
    maxRecoveryFeeSats: feePolicy.maxRecoveryFeeSats,
    maxRecoveryFeerateSatPerVb: feePolicy.maxRecoveryFeerateSatPerVb,
    minRelayPeers: feePolicy.minRelayPeers
  });
}

function validateAnchor(outputs, feePolicy, label) {
  const matches = outputs.reduce((count, output) => count + Number(
    output.valueSats === feePolicy.anchorAmountSats &&
    output.scriptPubKeyHex === feePolicy.anchorScriptPubKeyHex
  ), 0);
  const last = outputs[outputs.length - 1];
  if (matches !== 1 || last.valueSats !== feePolicy.anchorAmountSats ||
      last.scriptPubKeyHex !== feePolicy.anchorScriptPubKeyHex) {
    const anchorType = feePolicy.strategy === 'truc-p2a-v1' ? 'zero-sat P2A anchor' : 'CPFP anchor';
    throw new Error(`${label} must contain exactly one committed ${anchorType} as its last output`);
  }
}

function validateSpend({ rawTxHex, funding, expectedOutputs, expectedLocktime, minFeeSats, maxFeeSats, feePolicy, label }) {
  const transaction = parseCanonicalUnsignedTransaction(rawTxHex);
  if (transaction.version !== feePolicy.transactionVersion) {
    throw new Error(`${label} transaction version must be ${feePolicy.transactionVersion} for ${feePolicy.strategy}`);
  }
  if (feePolicy.strategy === 'truc-p2a-v1' && Buffer.byteLength(rawTxHex, 'hex') > TRUC_MAX_VSIZE) {
    throw new Error(`${label} exceeds the TRUC 10000-vB transaction limit before signing`);
  }
  if (transaction.inputs.length !== 1 || transaction.inputs[0].txid !== funding.txid ||
      transaction.inputs[0].vout !== funding.vout) {
    throw new Error(`${label} must spend exactly the committed funding outpoint`);
  }
  if (!Number.isSafeInteger(expectedLocktime) || expectedLocktime < 0 || expectedLocktime > 0xffffffff ||
      transaction.locktime !== expectedLocktime) {
    throw new Error(`${label} locktime mismatch`);
  }
  validateExpectedOutputs(transaction.outputs, expectedOutputs, label);
  validateAnchor(transaction.outputs, feePolicy, label);
  const totalOutput = transaction.outputs.reduce((sum, output) => sum + output.valueSats, 0n);
  if (totalOutput > funding.valueSats) throw new Error(`${label} spends more than the funding value`);
  const feeSats = funding.valueSats - totalOutput;
  if (feeSats < minFeeSats || feeSats > maxFeeSats) throw new Error(`${label} fee is outside the committed range`);
  return Object.freeze({ transaction, feeSats });
}

function serializeValidatedSpend(result) {
  return {
    txid: result.transaction.txid,
    rawTxHex: result.transaction.rawTxHex,
    version: result.transaction.version,
    locktime: result.transaction.locktime,
    feeSats: result.feeSats.toString(),
    outputs: result.transaction.outputs.map((output) => ({
      valueSats: output.valueSats.toString(),
      scriptPubKeyHex: output.scriptPubKeyHex
    }))
  };
}

function validateDlcTransactionSet({ funding, cets, refund, minFeeSats = 0n, maxFeeSats, feePolicy }) {
  const normalizedFunding = normalizeFunding(funding);
  const normalizedFeePolicy = normalizeFeePolicy(feePolicy);
  if (typeof minFeeSats !== 'bigint' || minFeeSats < 0n || typeof maxFeeSats !== 'bigint' ||
      maxFeeSats < minFeeSats || maxFeeSats > normalizedFunding.valueSats) {
    throw new Error('DLC fee range is invalid');
  }
  if (!Array.isArray(cets) || cets.length < 1 || cets.length > 4096 || !refund) {
    throw new Error('DLC transaction set requires 1..4096 CETs and one refund');
  }
  const identities = new Set();
  const validatedCets = cets.map((cet, index) => {
    requireHex(cet.outcomeMessage, 32, `cets[${index}].outcomeMessage`);
    if (!Array.isArray(cet.oraclePubkeys) || cet.oraclePubkeys.length < 2 ||
        cet.oraclePubkeys.some((key) => typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) ||
        new Set(cet.oraclePubkeys).size !== cet.oraclePubkeys.length ||
        [...cet.oraclePubkeys].sort().join(':') !== cet.oraclePubkeys.join(':')) {
      throw new Error(`cets[${index}].oraclePubkeys must be a sorted unique threshold subset`);
    }
    const identity = `${cet.outcomeMessage}:${cet.oraclePubkeys.join(':')}`;
    if (identities.has(identity)) throw new Error('DLC transaction set contains a duplicate CET identity');
    identities.add(identity);
    const spend = validateSpend({
      rawTxHex: cet.rawTxHex,
      funding: normalizedFunding,
      expectedOutputs: cet.expectedOutputs,
      expectedLocktime: cet.locktime,
      minFeeSats,
      maxFeeSats,
      feePolicy: normalizedFeePolicy,
      label: `CET ${index}`
    });
    return {
      outcomeMessage: cet.outcomeMessage,
      oraclePubkeys: [...cet.oraclePubkeys],
      ...serializeValidatedSpend(spend)
    };
  }).sort((left, right) =>
    `${left.outcomeMessage}:${left.oraclePubkeys.join(':')}`.localeCompare(`${right.outcomeMessage}:${right.oraclePubkeys.join(':')}`));

  const refundSpend = validateSpend({
    rawTxHex: refund.rawTxHex,
    funding: normalizedFunding,
    expectedOutputs: refund.expectedOutputs,
    expectedLocktime: refund.locktime,
    minFeeSats,
    maxFeeSats,
    feePolicy: normalizedFeePolicy,
    label: 'refund'
  });
  if (validatedCets.some((cet) => refund.locktime <= cet.locktime)) {
    throw new Error('refund locktime must be greater than every CET locktime');
  }
  const settlementTxids = [...validatedCets.map((cet) => cet.txid), refundSpend.transaction.txid];
  if (new Set(settlementTxids).size !== settlementTxids.length) {
    throw new Error('every CET and refund must have a unique transaction id');
  }
  const serializedFunding = {
    txid: normalizedFunding.txid,
    vout: normalizedFunding.vout,
    valueSats: normalizedFunding.valueSats.toString(),
    scriptPubKeyHex: normalizedFunding.scriptPubKeyHex
  };
  const serializedRefund = serializeValidatedSpend(refundSpend);
  const fundingTemplateDigest = sha256Hex(canonicalJson(serializedFunding));
  const cetSetDigest = sha256Hex(canonicalJson(validatedCets));
  const refundTransactionDigest = sha256Hex(canonicalJson(serializedRefund));
  const serializedFeePolicy = {
    strategy: normalizedFeePolicy.strategy,
    transactionVersion: normalizedFeePolicy.transactionVersion,
    anchorAmountSats: normalizedFeePolicy.anchorAmountSats.toString(),
    anchorScriptPubKeyHex: normalizedFeePolicy.anchorScriptPubKeyHex,
    maxRecoveryFeeSats: normalizedFeePolicy.maxRecoveryFeeSats.toString(),
    maxRecoveryFeerateSatPerVb: normalizedFeePolicy.maxRecoveryFeerateSatPerVb,
    minRelayPeers: normalizedFeePolicy.minRelayPeers
  };
  if (normalizedFeePolicy.strategy === 'truc-p2a-v1') {
    serializedFeePolicy.maxSettlementVsize = normalizedFeePolicy.maxSettlementVsize;
    serializedFeePolicy.maxRecoveryVsize = normalizedFeePolicy.maxRecoveryVsize;
    serializedFeePolicy.maxUnconfirmedClusterTransactions = normalizedFeePolicy.maxUnconfirmedClusterTransactions;
  }
  const feePolicyDigest = sha256Hex(canonicalJson(serializedFeePolicy));
  return normalizeDlcTransactionSet({
    fundingTemplateDigest,
    cetSetDigest,
    refundTransactionDigest,
    feePolicyDigest,
    validationDigest: sha256Hex(canonicalJson({
      fundingTemplateDigest,
      cetSetDigest,
      refundTransactionDigest,
      feePolicyDigest
    })),
    funding: serializedFunding,
    feePolicy: serializedFeePolicy,
    cets: validatedCets,
    refund: serializedRefund
  });
}

function validateNormalizedDlcTransactionSetCommitments(transactionSet) {
  if (!transactionSet || !transactionSet.funding || !transactionSet.feePolicy ||
      !Array.isArray(transactionSet.cets) || !transactionSet.refund) {
    throw new Error('validated DLC transaction set is malformed');
  }
  const fundingTemplateDigest = sha256Hex(canonicalJson(transactionSet.funding));
  const cetSetDigest = sha256Hex(canonicalJson(transactionSet.cets));
  const refundTransactionDigest = sha256Hex(canonicalJson(transactionSet.refund));
  const feePolicyDigest = sha256Hex(canonicalJson(transactionSet.feePolicy));
  const validationDigest = sha256Hex(canonicalJson({
    fundingTemplateDigest,
    cetSetDigest,
    refundTransactionDigest,
    feePolicyDigest
  }));
  if (transactionSet.fundingTemplateDigest !== fundingTemplateDigest ||
      transactionSet.cetSetDigest !== cetSetDigest ||
      transactionSet.refundTransactionDigest !== refundTransactionDigest ||
      transactionSet.feePolicyDigest !== feePolicyDigest ||
      transactionSet.validationDigest !== validationDigest) {
    throw new Error('validated DLC transaction set commitment mismatch');
  }
  return true;
}

function normalizeDlcTransactionSet(transactionSet) {
  const normalized = canonicalize(transactionSet, 'validated DLC transaction set');
  validateNormalizedDlcTransactionSetCommitments(normalized);
  return normalized;
}

function validateDlcTransactionSetCommitments(transactionSet) {
  normalizeDlcTransactionSet(transactionSet);
  return true;
}

module.exports = {
  MAX_MONEY,
  P2A_SCRIPT_PUBKEY_HEX,
  TRUC_VERSION,
  TRUC_MAX_VSIZE,
  TRUC_CHILD_MAX_VSIZE,
  TRUC_MAX_UNCONFIRMED_CLUSTER_TRANSACTIONS,
  parseCanonicalUnsignedTransaction,
  parseCanonicalSignedTaprootTransaction,
  validateDlcTransactionSet,
  normalizeDlcTransactionSet,
  validateDlcTransactionSetCommitments
};
