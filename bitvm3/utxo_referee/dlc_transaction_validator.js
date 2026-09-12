'use strict';

const crypto = require('crypto');
const { canonicalJson } = require('./dlc_contract_state');

const MAX_MONEY = 21000000n * 100000000n;

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
  if (version !== 2) throw new Error('DLC transaction version must be 2');
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
  if (!feePolicy || feePolicy.strategy !== 'cpfp-anchor-v1' ||
      typeof feePolicy.anchorAmountSats !== 'bigint' ||
      feePolicy.anchorAmountSats < 330n || feePolicy.anchorAmountSats > 10000n ||
      typeof feePolicy.anchorScriptPubKeyHex !== 'string' ||
      !/^(0014[0-9a-f]{40}|5120[0-9a-f]{64})$/.test(feePolicy.anchorScriptPubKeyHex)) {
    throw new Error('feePolicy must define a 330..10000 sat cpfp-anchor-v1 P2WPKH or P2TR output');
  }
  return Object.freeze({
    strategy: 'cpfp-anchor-v1',
    anchorAmountSats: feePolicy.anchorAmountSats,
    anchorScriptPubKeyHex: feePolicy.anchorScriptPubKeyHex
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
    throw new Error(`${label} must contain exactly one committed CPFP anchor as its last output`);
  }
}

function validateSpend({ rawTxHex, funding, expectedOutputs, expectedLocktime, minFeeSats, maxFeeSats, feePolicy, label }) {
  const transaction = parseCanonicalUnsignedTransaction(rawTxHex);
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
  const feePolicyDigest = sha256Hex(canonicalJson({
    strategy: normalizedFeePolicy.strategy,
    anchorAmountSats: normalizedFeePolicy.anchorAmountSats.toString(),
    anchorScriptPubKeyHex: normalizedFeePolicy.anchorScriptPubKeyHex
  }));
  const serializedFeePolicy = {
    strategy: normalizedFeePolicy.strategy,
    anchorAmountSats: normalizedFeePolicy.anchorAmountSats.toString(),
    anchorScriptPubKeyHex: normalizedFeePolicy.anchorScriptPubKeyHex
  };
  return Object.freeze({
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
    funding: Object.freeze(serializedFunding),
    feePolicy: Object.freeze(serializedFeePolicy),
    cets: Object.freeze(validatedCets.map(Object.freeze)),
    refund: Object.freeze(serializedRefund)
  });
}

function validateDlcTransactionSetCommitments(transactionSet) {
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

module.exports = {
  MAX_MONEY,
  parseCanonicalUnsignedTransaction,
  validateDlcTransactionSet,
  validateDlcTransactionSetCommitments
};
