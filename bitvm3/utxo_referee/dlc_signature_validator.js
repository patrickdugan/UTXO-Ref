'use strict';

const crypto = require('crypto');
const { parseCanonicalUnsignedTransaction } = require('./dlc_transaction_validator');
const { bip341SighashDefault, outpoint } = require('./tradelayer_taproot');
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
  if (!funding || typeof funding.valueSats !== 'bigint') throw new Error('funding value is required');
  requireHex(funding.scriptPubKeyHex, 34, 'funding.scriptPubKeyHex');
  const publicKey = normalizeSignerPubkey(signerPubkeyX);
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
    const sighash = bip341SighashDefault(
      toBip341Transaction(parsed),
      [{ amountSats: funding.valueSats, scriptPubKey: funding.scriptPubKeyHex }],
      0
    );
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
  if (!transactionSet || !transactionSet.refund || !funding || typeof funding.valueSats !== 'bigint') {
    throw new Error('validated refund transaction and funding value are required');
  }
  requireHex(funding.scriptPubKeyHex, 34, 'funding.scriptPubKeyHex');
  const publicKey = normalizeSignerPubkey(signerPubkeyX);
  let signatureBytes;
  if (Buffer.isBuffer(signature)) signatureBytes = Buffer.from(signature);
  else {
    requireHex(signature, 64, 'refund signature');
    signatureBytes = Buffer.from(signature, 'hex');
  }
  const parsed = parseCanonicalUnsignedTransaction(transactionSet.refund.rawTxHex);
  if (parsed.txid !== transactionSet.refund.txid) throw new Error('refund transaction digest changed after validation');
  const sighash = bip341SighashDefault(
    toBip341Transaction(parsed),
    [{ amountSats: funding.valueSats, scriptPubKey: funding.scriptPubKeyHex }],
    0
  );
  if (!schnorrVerify(publicKey, sighash, signatureBytes)) throw new Error('refund signature is invalid');
  const normalized = {
    txid: parsed.txid,
    signerPubkeyX: publicKey.toString('hex'),
    sighash: sighash.toString('hex'),
    signature: signatureBytes.toString('hex')
  };
  return Object.freeze({ digest: sha256Hex(canonicalJson(normalized)), ...normalized });
}

module.exports = {
  toBip341Transaction,
  cetIdentity,
  validateCetAdaptorSignatures,
  validateRefundSignature
};

