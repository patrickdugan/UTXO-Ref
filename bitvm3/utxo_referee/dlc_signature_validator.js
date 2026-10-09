'use strict';

const crypto = require('crypto');
const {
  parseCanonicalUnsignedTransaction,
  parseCanonicalSignedTaprootTransaction,
  normalizeDlcTransactionSet,
  dlcFundingOutputForTransactionSet
} = require('./dlc_transaction_validator');
const { dlcSettlementSighash, settlementLeaf, buildDlcSettlementWitness } = require('./dlc_funding_output');
const { outpoint, varint } = require('./tradelayer_taproot');
const {
  adaptorVerify,
  schnorrVerify,
  bytes32
} = require('./tradelayer_dlc_adaptor_sig');
const { canonicalJson } = require('./dlc_contract_state');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requireHex(value, bytes, fieldName) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${fieldName} must be lowercase ${bytes}-byte hex`);
  }
  return value;
}

function normalizeSignerPubkey(signerPubkeyX) {
  if (Buffer.isBuffer(signerPubkeyX) && signerPubkeyX.length === 32) return Buffer.from(signerPubkeyX);
  requireHex(signerPubkeyX, 32, 'signerPubkeyX');
  return Buffer.from(signerPubkeyX, 'hex');
}

function toBip341Transaction(transaction) {
  return {
    version: transaction.version,
    vin: transaction.inputs.map((input) => ({
      outpoint: Buffer.from(outpoint(input.txid, input.vout), 'hex'),
      scriptSig: Buffer.alloc(0),
      sequence: input.sequence
    })),
    vout: transaction.outputs.map((output) => ({
      value: output.valueSats,
      script: Buffer.from(output.scriptPubKeyHex, 'hex')
    })),
    locktime: transaction.locktime
  };
}

function cetIdentity(cet) {
  return `${cet.outcomeMessage}:${cet.oraclePubkeys.join(':')}:${cet.txid}`;
}

// The funding output is derived from the validated transaction set, never
// taken from the caller. A separately supplied `funding` must describe the
// same output, and the signer must be one of its two committed parties: a
// signature under any other key cannot appear in a valid settlement witness.
function settlementContext({ transactionSet, funding, signerPubkeyX }) {
  const output = dlcFundingOutputForTransactionSet(transactionSet);
  const committed = transactionSet.funding;
  if (!funding || typeof funding.valueSats !== 'bigint') throw new Error('funding value is required');
  requireHex(funding.scriptPubKeyHex, 34, 'funding.scriptPubKeyHex');
  if (funding.valueSats !== BigInt(committed.valueSats) || funding.scriptPubKeyHex !== output.scriptPubKeyHex ||
      (funding.txid !== undefined && funding.txid !== committed.txid) ||
      (funding.vout !== undefined && funding.vout !== committed.vout)) {
    throw new Error('funding does not match the validated DLC transaction set');
  }
  const publicKey = normalizeSignerPubkey(signerPubkeyX);
  if (!output.partyPubkeyXs.includes(publicKey.toString('hex'))) {
    throw new Error('signer is not a party to the two-party DLC funding output');
  }
  return { output, publicKey, fundingValueSats: funding.valueSats };
}

function settlementSighash(output, fundingValueSats, parsed, executionType) {
  return dlcSettlementSighash({
    bip341Transaction: toBip341Transaction(parsed),
    fundingValueSats,
    output,
    executionType
  });
}

function validateCetAdaptorSignatures({
  transactionSet,
  funding,
  signerPubkeyX,
  signatures,
  thresholdOutcomeSets
}) {
  if (!transactionSet || !Array.isArray(transactionSet.cets) || !Array.isArray(signatures) ||
      signatures.length !== transactionSet.cets.length || !Array.isArray(thresholdOutcomeSets)) {
    throw new Error('CET signature validation requires every transaction and outcome point');
  }
  const { output, publicKey, fundingValueSats } = settlementContext({ transactionSet, funding, signerPubkeyX });
  const points = new Map(thresholdOutcomeSets.map((entry) => {
    if (!entry || !Array.isArray(entry.oraclePubkeys) || !entry.outcomePoint) {
      throw new Error('invalid threshold outcome point entry');
    }
    return [`${entry.outcomeMessage}:${entry.oraclePubkeys.join(':')}`, entry.outcomePoint];
  }));
  const byIdentity = new Map(signatures.map((entry) => {
    if (!entry || typeof entry.identity !== 'string' || !entry.presignature) throw new Error('invalid CET adaptor signature entry');
    if (entry.signerPubkeyX !== publicKey.toString('hex')) throw new Error('CET adaptor signature signer mismatch');
    if (byDuplicate(signatures, entry.identity) > 1) throw new Error('duplicate CET adaptor signature identity');
    return [entry.identity, entry];
  }));

  const normalized = transactionSet.cets.map((cet, index) => {
    const identity = cetIdentity(cet);
    const entry = byIdentity.get(identity);
    if (!entry) throw new Error(`missing adaptor signature for CET ${index}`);
    const point = points.get(`${cet.outcomeMessage}:${cet.oraclePubkeys.join(':')}`);
    if (!point) throw new Error(`missing threshold outcome point for CET ${index}`);
    if (entry.presignature.Tx !== bytes32(point.x).toString('hex') ||
        entry.presignature.Ty !== bytes32(point.y).toString('hex')) {
      throw new Error(`CET ${index} adaptor point does not match its oracle subset`);
    }
    const parsed = parseCanonicalUnsignedTransaction(cet.rawTxHex);
    if (parsed.txid !== cet.txid) throw new Error(`CET ${index} transaction digest changed after validation`);
    const sighash = settlementSighash(output, fundingValueSats, parsed, 'cet');
    if (!adaptorVerify(publicKey, sighash, entry.presignature)) {
      throw new Error(`CET ${index} adaptor signature is invalid`);
    }
    return {
      identity,
      signerPubkeyX: entry.signerPubkeyX,
      sighash: sighash.toString('hex'),
      presignature: entry.presignature
    };
  }).sort((left, right) => left.identity.localeCompare(right.identity));
  if (byIdentity.size !== normalized.length) throw new Error('unexpected CET adaptor signature entry');
  return Object.freeze({
    digest: sha256Hex(canonicalJson(normalized)),
    signatures: Object.freeze(normalized.map(Object.freeze))
  });
}

function byDuplicate(entries, identity) {
  let count = 0;
  for (const entry of entries) if (entry && entry.identity === identity) count++;
  return count;
}

function validateRefundSignature({ transactionSet, funding, signerPubkeyX, signature }) {
  if (!transactionSet || !transactionSet.refund) {
    throw new Error('validated refund transaction and funding value are required');
  }
  const { output, publicKey, fundingValueSats } = settlementContext({ transactionSet, funding, signerPubkeyX });
  let signatureBytes;
  if (Buffer.isBuffer(signature)) signatureBytes = Buffer.from(signature);
  else {
    requireHex(signature, 64, 'refund signature');
    signatureBytes = Buffer.from(signature, 'hex');
  }
  const parsed = parseCanonicalUnsignedTransaction(transactionSet.refund.rawTxHex);
  if (parsed.txid !== transactionSet.refund.txid) throw new Error('refund transaction digest changed after validation');
  const sighash = settlementSighash(output, fundingValueSats, parsed, 'refund');
  if (!schnorrVerify(publicKey, sighash, signatureBytes)) throw new Error('refund signature is invalid');
  const normalized = {
    txid: parsed.txid,
    signerPubkeyX: publicKey.toString('hex'),
    sighash: sighash.toString('hex'),
    signature: signatureBytes.toString('hex')
  };
  return Object.freeze({ digest: sha256Hex(canonicalJson(normalized)), ...normalized });
}

function selectSettlementTransaction(transactionSet, executionType, cetTxid) {
  if (executionType === 'refund') {
    if (cetTxid !== undefined) throw new Error('refund settlement must not select a CET');
    return transactionSet.refund;
  }
  if (executionType !== 'cet') throw new Error('executionType must be cet or refund');
  requireHex(cetTxid, 32, 'cetTxid');
  const transaction = transactionSet.cets.find((cet) => cet.txid === cetTxid);
  if (!transaction) throw new Error('selected CET is absent from the committed transaction set');
  return transaction;
}

// BIP341 script-path sighash both parties sign for one committed settlement.
function settlementSighashForTransactionSet({ transactionSet, executionType, cetTxid }) {
  transactionSet = normalizeDlcTransactionSet(transactionSet);
  const output = dlcFundingOutputForTransactionSet(transactionSet);
  const selected = selectSettlementTransaction(transactionSet, executionType, cetTxid);
  const parsed = parseCanonicalUnsignedTransaction(selected.rawTxHex);
  if (parsed.txid !== selected.txid) throw new Error('settlement transaction digest changed after validation');
  return settlementSighash(output, BigInt(transactionSet.funding.valueSats), parsed, executionType);
}

// Attach the two-signature script-path witness to a committed settlement.
// `signatures` maps each party's x-only key to its 64-byte signature hex.
function assembleSignedSettlement({ transactionSet, executionType, cetTxid, signatures }) {
  transactionSet = normalizeDlcTransactionSet(transactionSet);
  const output = dlcFundingOutputForTransactionSet(transactionSet);
  const selected = selectSettlementTransaction(transactionSet, executionType, cetTxid);
  const witness = buildDlcSettlementWitness({ output, executionType, signatures });
  const unsigned = Buffer.from(selected.rawTxHex, 'hex');
  const stack = Buffer.concat([
    varint(witness.length),
    ...witness.map((item) => {
      const bytes = Buffer.from(item, 'hex');
      return Buffer.concat([varint(bytes.length), bytes]);
    })
  ]);
  const signedTxHex = Buffer.concat([
    unsigned.subarray(0, 4),
    Buffer.from([0x00, 0x01]),
    unsigned.subarray(4, unsigned.length - 4),
    stack,
    unsigned.subarray(unsigned.length - 4)
  ]).toString('hex');
  verifySettlementWitness({ transactionSet, executionType, cetTxid, signedTxHex });
  return signedTxHex;
}

// A signed settlement is only acceptable when its witness is exactly the
// committed leaf, the committed control block, and one valid signature from
// each party over the script-path sighash. Anything else cannot confirm.
function verifySettlementWitness({ transactionSet, executionType, cetTxid, signedTxHex }) {
  transactionSet = normalizeDlcTransactionSet(transactionSet);
  const output = dlcFundingOutputForTransactionSet(transactionSet);
  const selected = selectSettlementTransaction(transactionSet, executionType, cetTxid);
  const parsed = parseCanonicalSignedTaprootTransaction(signedTxHex);
  if (parsed.strippedRawTxHex !== selected.rawTxHex || parsed.txid !== selected.txid) {
    throw new Error('signed settlement does not match the validated unsigned transaction');
  }
  const leaf = settlementLeaf(output, executionType);
  const [secondSignature, firstSignature, scriptHex, controlBlock] = parsed.witness[0];
  if (scriptHex !== leaf.scriptHex || controlBlock !== leaf.controlBlock) {
    throw new Error(`signed settlement does not spend the committed ${executionType} leaf of the funding output`);
  }
  const sighash = settlementSighash(output, BigInt(transactionSet.funding.valueSats), parsed.unsignedTransaction, executionType);
  const [firstKey, secondKey] = output.partyPubkeyXs;
  if (!schnorrVerify(Buffer.from(firstKey, 'hex'), sighash, Buffer.from(firstSignature, 'hex')) ||
      !schnorrVerify(Buffer.from(secondKey, 'hex'), sighash, Buffer.from(secondSignature, 'hex'))) {
    throw new Error('signed settlement witness does not carry a valid signature from both parties');
  }
  return parsed;
}

module.exports = {
  toBip341Transaction,
  cetIdentity,
  validateCetAdaptorSignatures,
  validateRefundSignature,
  settlementSighashForTransactionSet,
  assembleSignedSettlement,
  verifySettlementWitness
};
