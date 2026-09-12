'use strict';

const crypto = require('crypto');
const { types: utilTypes } = require('util');
const { canonicalize, canonicalJson } = require('./dlc_contract_state');

const KIND = 'utxoref_dlc_journal_checkpoint_v1';
const SIGNED_KIND = 'utxoref_dlc_signed_journal_checkpoint_v1';
const STORE_KINDS = Object.freeze([
  'contract-state',
  'oracle-event',
  'peer-session',
  'signing-authorization',
  'refund-recovery',
  'broadcast-authorization',
  'watchtower'
]);
const CHECKPOINT_FIELDS = Object.freeze([
  'checkpointHash', 'headRecordHash', 'kind', 'recordCount', 'storeKey', 'storeKind'
]);
const SIGNED_CHECKPOINT_FIELDS = Object.freeze(['checkpoint', 'kind', 'signature', 'signerKeyId']);
const TRUSTED_KEY_FIELDS = Object.freeze(['keyId', 'publicKeySpki']);

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requireHash(value, fieldName) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${fieldName} must be lowercase 32-byte hex`);
  }
  return value;
}

function checkpointHash(checkpoint) {
  const unsigned = { ...checkpoint };
  delete unsigned.checkpointHash;
  return sha256Hex(Buffer.from(canonicalJson(unsigned), 'utf8'));
}

function normalizeDlcJournalCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object' || utilTypes.isProxy(checkpoint) || Array.isArray(checkpoint) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(checkpoint))) {
    throw new Error('invalid DLC journal checkpoint');
  }
  const descriptors = Object.getOwnPropertyDescriptors(checkpoint);
  if (JSON.stringify(Object.keys(descriptors).sort()) !== JSON.stringify(CHECKPOINT_FIELDS) ||
      Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) {
    throw new Error('DLC journal checkpoint must contain only plain data properties');
  }
  const normalized = Object.freeze(Object.fromEntries(
    CHECKPOINT_FIELDS.map((field) => [field, descriptors[field].value])
  ));
  if (
      normalized.kind !== KIND || !STORE_KINDS.includes(normalized.storeKind) ||
      !Number.isSafeInteger(normalized.recordCount) || normalized.recordCount < 1) {
    throw new Error('invalid DLC journal checkpoint');
  }
  requireHash(normalized.storeKey, 'checkpoint.storeKey');
  requireHash(normalized.headRecordHash, 'checkpoint.headRecordHash');
  requireHash(normalized.checkpointHash, 'checkpoint.checkpointHash');
  if (normalized.checkpointHash !== checkpointHash(normalized)) {
    throw new Error('DLC journal checkpoint hash mismatch');
  }
  return normalized;
}

function validateDlcJournalCheckpoint(checkpoint) {
  normalizeDlcJournalCheckpoint(checkpoint);
  return true;
}

function checkpointSignaturePayload(envelope) {
  return Buffer.from(canonicalJson({
    kind: SIGNED_KIND,
    signerKeyId: envelope.signerKeyId,
    checkpoint: envelope.checkpoint
  }), 'utf8');
}

function publicKeyIdentity(publicKey) {
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('DLC journal checkpoint signer must use Ed25519');
  }
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return Object.freeze({
    keyId: sha256Hex(der),
    publicKeySpki: der.toString('base64')
  });
}

function normalizeSignedDlcJournalCheckpoint(envelope) {
  const snapshot = canonicalize(envelope, 'signed DLC journal checkpoint');
  if (JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(SIGNED_CHECKPOINT_FIELDS) ||
      snapshot.kind !== SIGNED_KIND) {
    throw new Error('invalid signed DLC journal checkpoint');
  }
  requireHash(snapshot.signerKeyId, 'signed checkpoint.signerKeyId');
  if (typeof snapshot.signature !== 'string' || snapshot.signature.length > 128) {
    throw new Error('signed checkpoint signature must be canonical Ed25519 base64');
  }
  let signature;
  try { signature = Buffer.from(snapshot.signature, 'base64'); }
  catch (_error) { throw new Error('signed checkpoint signature must be canonical Ed25519 base64'); }
  if (signature.length !== 64 || signature.toString('base64') !== snapshot.signature) {
    throw new Error('signed checkpoint signature must be canonical Ed25519 base64');
  }
  return Object.freeze({
    kind: SIGNED_KIND,
    signerKeyId: snapshot.signerKeyId,
    checkpoint: normalizeDlcJournalCheckpoint(snapshot.checkpoint),
    signature: snapshot.signature
  });
}

function signDlcJournalCheckpoint(checkpoint, privateKeyInput) {
  let privateKey;
  try {
    privateKey = privateKeyInput && privateKeyInput.type === 'private'
      ? privateKeyInput
      : crypto.createPrivateKey(privateKeyInput);
  } catch (_error) {
    throw new Error('DLC journal checkpoint private key is invalid');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('DLC journal checkpoint signer must use Ed25519');
  }
  const identity = publicKeyIdentity(crypto.createPublicKey(privateKey));
  const unsigned = Object.freeze({
    kind: SIGNED_KIND,
    signerKeyId: identity.keyId,
    checkpoint: normalizeDlcJournalCheckpoint(checkpoint)
  });
  return normalizeSignedDlcJournalCheckpoint(Object.freeze({
    ...unsigned,
    signature: crypto.sign(null, checkpointSignaturePayload(unsigned), privateKey).toString('base64')
  }));
}

function normalizeTrustedCheckpointKeys(trustedKeys) {
  const snapshot = canonicalize(trustedKeys, 'trusted DLC checkpoint keys');
  if (!Array.isArray(snapshot) || snapshot.length < 1 || snapshot.length > 32) {
    throw new Error('trusted DLC checkpoint keys must contain 1..32 Ed25519 keys');
  }
  const seen = new Set();
  return snapshot.map((entry, index) => {
    if (!entry || Array.isArray(entry) ||
        JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(TRUSTED_KEY_FIELDS) ||
        typeof entry.publicKeySpki !== 'string' || entry.publicKeySpki.length > 256) {
      throw new Error(`trusted DLC checkpoint key ${index} is invalid`);
    }
    requireHash(entry.keyId, `trusted checkpoint key ${index}.keyId`);
    let der;
    let publicKey;
    try {
      der = Buffer.from(entry.publicKeySpki, 'base64');
      if (der.toString('base64') !== entry.publicKeySpki) throw new Error('noncanonical base64');
      publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    } catch (_error) {
      throw new Error(`trusted DLC checkpoint key ${index} is invalid`);
    }
    const identity = publicKeyIdentity(publicKey);
    if (identity.keyId !== entry.keyId || identity.publicKeySpki !== entry.publicKeySpki) {
      throw new Error(`trusted DLC checkpoint key ${index} identity mismatch`);
    }
    if (seen.has(identity.keyId)) throw new Error('trusted DLC checkpoint keys contain a duplicate');
    seen.add(identity.keyId);
    return Object.freeze({ ...identity, publicKey });
  });
}

function verifySignedDlcJournalCheckpoint(envelope, trustedKeys) {
  const normalized = normalizeSignedDlcJournalCheckpoint(envelope);
  const trusted = normalizeTrustedCheckpointKeys(trustedKeys)
    .find((entry) => entry.keyId === normalized.signerKeyId);
  if (!trusted) throw new Error('signed DLC journal checkpoint key is not trusted');
  const signature = Buffer.from(normalized.signature, 'base64');
  if (!crypto.verify(null, checkpointSignaturePayload(normalized), trusted.publicKey, signature)) {
    throw new Error('signed DLC journal checkpoint signature is invalid');
  }
  return normalized;
}

function createDlcJournalCheckpoint({ storeKind, storeKey, recordCount, headRecordHash }) {
  const unsigned = { kind: KIND, storeKind, storeKey, recordCount, headRecordHash };
  const checkpoint = Object.freeze({ ...unsigned, checkpointHash: checkpointHash(unsigned) });
  validateDlcJournalCheckpoint(checkpoint);
  return checkpoint;
}

function assertDlcJournalCheckpoint(expected, {
  storeKind,
  storeKey,
  currentRecordCount,
  recordHashAtCheckpoint
}) {
  const normalized = normalizeDlcJournalCheckpoint(expected);
  if (normalized.storeKind !== storeKind || normalized.storeKey !== storeKey) {
    throw new Error('DLC journal checkpoint belongs to a different store');
  }
  if (!Number.isSafeInteger(currentRecordCount) || currentRecordCount < 0) {
    throw new Error('current journal record count is invalid');
  }
  if (currentRecordCount < normalized.recordCount) {
    throw new Error('DLC journal rollback detected below the pinned checkpoint');
  }
  requireHash(recordHashAtCheckpoint, 'recordHashAtCheckpoint');
  if (recordHashAtCheckpoint !== normalized.headRecordHash) {
    throw new Error('DLC journal fork detected at the pinned checkpoint');
  }
  return true;
}

module.exports = {
  KIND,
  SIGNED_KIND,
  STORE_KINDS,
  createDlcJournalCheckpoint,
  normalizeDlcJournalCheckpoint,
  validateDlcJournalCheckpoint,
  assertDlcJournalCheckpoint,
  signDlcJournalCheckpoint,
  normalizeSignedDlcJournalCheckpoint,
  verifySignedDlcJournalCheckpoint
};
