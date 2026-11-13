'use strict';

/**
 * Ed25519 authentication for the complete typed PnL batch snapshot.
 *
 * The independent verification context pins the signer policy, chain identity,
 * active block hash at snapshotHeight, expected epoch and previous state root.
 * The caller obtains those pins from its own configuration and chain/state view.
 * This module does not fetch a chain view or persist an epoch consumption.
 *
 * A matched previousStateRoot is an authenticated reference. Opening the prior
 * accounting state, enforcing the transactionPolicyHash against a serialized
 * transaction, and atomically consuming the transition belong to the execution
 * adapter. Neither an Ed25519 signature nor these hashes is a ZK proof.
 *
 * Signed artifacts use JSON data. Callers represent large integers with decimal
 * strings. Snapshot fields are preserved without the legacy V2 row projection.
 */

const crypto = require('crypto');
const { snapshotPlainData, canonicalJson } = require('./dlc_canonical_json');
const {
  hashPnlSettlementSnapshot,
  verifyPnlSettlementBatch
} = require('./tradelayer_pnl_batch_settlement');

const CHECKPOINT_KIND = 'utxoref_pnl_batch_checkpoint_v2';
const SIGNED_CHECKPOINT_KIND = 'utxoref_signed_pnl_batch_checkpoint_v2';
const TRUST_POLICY_KIND = 'utxoref_pnl_batch_checkpoint_trust_policy_v1';
const VERSION = 2;
const MAX_SIGNERS = 32;
const SIGNING_DOMAIN = Buffer.from('UTXOREF_PNL_BATCH_CHECKPOINT_V2\0', 'ascii');
const BUILD_FIELDS = Object.freeze(['policyId', 'chainGenesisHash', 'contractId',
  'snapshotHeight', 'snapshotBlockHash', 'transactionPolicyHash', 'snapshot']);
const BODY_FIELDS = Object.freeze(['kind', 'version', ...BUILD_FIELDS, 'snapshotHash']);
const POLICY_FIELDS = Object.freeze(['kind', 'version', 'policyId', 'network',
  'chainGenesisHash', 'contractId', 'threshold', 'maxAgeBlocks', 'trustedSigners']);
const CONTEXT_FIELDS = Object.freeze(['trustPolicy', 'expectedPreviousStateRoot',
  'expectedEpochId', 'currentHeight', 'expectedSnapshotBlockHash']);
const NETWORKS = Object.freeze(['bitcoin', 'bitcoin-testnet', 'bitcoin-testnet4',
  'bitcoin-regtest', 'litecoin', 'litecoin-testnet']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function fail(message, code = 'INVALID_PNL_BATCH_CHECKPOINT') {
  const error = new Error(message);
  Object.defineProperty(error, 'code', { value: code });
  throw error;
}

function failure(error) {
  const message = error && typeof error === 'object'
    ? Object.getOwnPropertyDescriptor(error, 'message') : null;
  const code = error && typeof error === 'object'
    ? Object.getOwnPropertyDescriptor(error, 'code') : null;
  return Object.freeze({ ok: false,
    reason: message && own(message, 'value') && typeof message.value === 'string'
      ? message.value : 'invalid PnL batch checkpoint',
    code: code && own(code, 'value') && typeof code.value === 'string'
      ? code.value : 'INVALID_PNL_BATCH_CHECKPOINT' });
}

function record(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be a plain object`);
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) fail(`${label} has unexpected field ${key}`);
  }
  for (const key of fields) {
    if (!own(value, key)) fail(`${label}.${key} is required`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,96}$/.test(value)) {
    fail(`${label} must be a bounded ASCII identifier`);
  }
  return value;
}

function hex32(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${label} must be lowercase 32-byte hex`);
  }
  return value;
}

function uint32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    fail(`${label} must be an unsigned 32-bit integer`);
  }
  return value;
}

function epoch(value, label) {
  let parsed;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) parsed = BigInt(value);
  else if (typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value)) parsed = BigInt(value);
  else fail(`${label} must be an exact non-negative integer`);
  if (parsed > (1n << 63n) - 1n) fail(`${label} exceeds the batch epoch bound`);
  return parsed.toString();
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function keyIdentity(publicKey) {
  if (publicKey.asymmetricKeyType !== 'ed25519') fail('checkpoint signer must use Ed25519', 'SIGNER_POLICY');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { keyId: sha256Hex(der), publicKeySpki: der.toString('base64') };
}

function validateBody(body) {
  record(body, BODY_FIELDS, 'checkpoint body');
  if (body.kind !== CHECKPOINT_KIND || body.version !== VERSION) fail('wrong PnL batch checkpoint kind or version');
  identifier(body.policyId, 'body.policyId');
  hex32(body.chainGenesisHash, 'body.chainGenesisHash');
  hex32(body.contractId, 'body.contractId');
  uint32(body.snapshotHeight, 'body.snapshotHeight');
  hex32(body.snapshotBlockHash, 'body.snapshotBlockHash');
  hex32(body.transactionPolicyHash, 'body.transactionPolicyHash');
  const snapshotHash = hashPnlSettlementSnapshot(body.snapshot);
  if (hex32(body.snapshotHash, 'body.snapshotHash') !== snapshotHash) {
    fail('checkpoint snapshot hash mismatch', 'SNAPSHOT_MISMATCH');
  }
  return body;
}

function signingBytes(body) {
  return Buffer.concat([SIGNING_DOMAIN, Buffer.from(canonicalJson(body), 'utf8')]);
}

function pnlBatchCheckpointSigningBytesV2(bodyInput) {
  const body = snapshotPlainData(bodyInput, '$.body', false);
  return signingBytes(validateBody(body));
}

function hashPnlBatchCheckpointBodyV2(bodyInput) {
  return sha256Hex(pnlBatchCheckpointSigningBytesV2(bodyInput));
}

function buildSignedPnlBatchCheckpointV2(input, options) {
  const plainInput = snapshotPlainData(input, '$.checkpointInput', false);
  const plainOptions = snapshotPlainData(options, '$.signingOptions', false);
  record(plainInput, BUILD_FIELDS, 'checkpoint input');
  record(plainOptions, ['privateKeys'], 'signing options');
  if (!Array.isArray(plainOptions.privateKeys) || plainOptions.privateKeys.length < 1
    || plainOptions.privateKeys.length > MAX_SIGNERS) fail(`privateKeys must contain 1..${MAX_SIGNERS} Ed25519 PEM strings`);
  const body = validateBody(snapshotPlainData({ kind: CHECKPOINT_KIND, version: VERSION,
    ...plainInput, snapshotHash: hashPnlSettlementSnapshot(plainInput.snapshot) }, '$.body', false));
  const bytes = signingBytes(body);
  const seen = new Set();
  const signatures = plainOptions.privateKeys.map((pem, index) => {
    if (typeof pem !== 'string' || pem.length > 16384 || !pem.startsWith('-----BEGIN PRIVATE KEY-----')) {
      fail(`privateKeys[${index}] must be an unencrypted PKCS8 PEM string`, 'SIGNER_POLICY');
    }
    const privateKey = crypto.createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== 'ed25519') fail('checkpoint signer must use Ed25519', 'SIGNER_POLICY');
    const { keyId } = keyIdentity(crypto.createPublicKey(privateKey));
    if (seen.has(keyId)) fail('duplicate checkpoint signing key', 'SIGNER_POLICY');
    seen.add(keyId);
    return { algorithm: 'ed25519', keyId,
      signatureHex: crypto.sign(null, bytes, privateKey).toString('hex') };
  }).sort((left, right) => left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0);
  return snapshotPlainData({ kind: SIGNED_CHECKPOINT_KIND, version: VERSION,
    bodyHash: sha256Hex(bytes), body, signatures }, '$.signedCheckpoint', false);
}

function normalizePolicy(policy) {
  record(policy, POLICY_FIELDS, 'trust policy');
  if (policy.kind !== TRUST_POLICY_KIND || policy.version !== 1) fail('wrong PnL batch trust policy kind or version', 'SIGNER_POLICY');
  identifier(policy.policyId, 'trustPolicy.policyId');
  if (typeof policy.network !== 'string' || !NETWORKS.includes(policy.network)) fail('unsupported trust policy network', 'SIGNER_POLICY');
  hex32(policy.chainGenesisHash, 'trustPolicy.chainGenesisHash');
  hex32(policy.contractId, 'trustPolicy.contractId');
  uint32(policy.maxAgeBlocks, 'trustPolicy.maxAgeBlocks');
  if (!Array.isArray(policy.trustedSigners) || policy.trustedSigners.length < 1
    || policy.trustedSigners.length > MAX_SIGNERS) fail(`trustedSigners must contain 1..${MAX_SIGNERS} keys`, 'SIGNER_POLICY');
  if (!Number.isSafeInteger(policy.threshold) || policy.threshold < 1
    || policy.threshold > policy.trustedSigners.length) fail('signer threshold exceeds the available distinct keys', 'SIGNER_POLICY');
  const signers = new Map();
  policy.trustedSigners.forEach((entry, index) => {
    record(entry, ['keyId', 'publicKeySpki'], `trustedSigners[${index}]`);
    hex32(entry.keyId, `trustedSigners[${index}].keyId`);
    if (typeof entry.publicKeySpki !== 'string' || entry.publicKeySpki.length > 256) fail('trusted signer requires canonical SPKI DER base64', 'SIGNER_POLICY');
    const der = Buffer.from(entry.publicKeySpki, 'base64');
    if (der.toString('base64') !== entry.publicKeySpki) fail('trusted signer SPKI encoding is not canonical', 'SIGNER_POLICY');
    const publicKey = crypto.createPublicKey({ key: der, type: 'spki', format: 'der' });
    const identity = keyIdentity(publicKey);
    if (identity.keyId !== entry.keyId || identity.publicKeySpki !== entry.publicKeySpki) {
      fail('trusted signer key identity mismatch', 'SIGNER_POLICY');
    }
    if (signers.has(identity.keyId)) fail('trust policy reuses a signing key', 'SIGNER_POLICY');
    signers.set(identity.keyId, publicKey);
  });
  return { policy, signers };
}

function verifyCopiedCheckpoint(envelope, context) {
  record(envelope, ['kind', 'version', 'bodyHash', 'body', 'signatures'], 'signed checkpoint');
  record(context, CONTEXT_FIELDS, 'verification context');
  if (envelope.kind !== SIGNED_CHECKPOINT_KIND || envelope.version !== VERSION) fail('wrong signed PnL batch checkpoint kind or version');
  const { policy, signers } = normalizePolicy(context.trustPolicy);
  const expectedPreviousStateRoot = hex32(context.expectedPreviousStateRoot, 'expectedPreviousStateRoot');
  const expectedEpochId = epoch(context.expectedEpochId, 'expectedEpochId');
  const currentHeight = uint32(context.currentHeight, 'currentHeight');
  const expectedSnapshotBlockHash = hex32(context.expectedSnapshotBlockHash, 'expectedSnapshotBlockHash');
  const body = validateBody(envelope.body);
  if (body.policyId !== policy.policyId) fail('checkpoint signer policy mismatch', 'SIGNER_POLICY');
  if (body.snapshot.network !== policy.network) fail('checkpoint network mismatch', 'CHAIN_MISMATCH');
  if (body.chainGenesisHash !== policy.chainGenesisHash) fail('checkpoint genesis mismatch', 'CHAIN_MISMATCH');
  if (body.contractId !== policy.contractId) fail('checkpoint contract mismatch', 'CHAIN_MISMATCH');
  if (body.snapshotBlockHash !== expectedSnapshotBlockHash) fail('checkpoint block is not the independently pinned active block', 'CHAIN_MISMATCH');
  if (body.snapshot.previousStateRoot.toLowerCase() !== expectedPreviousStateRoot) {
    fail('checkpoint previous state root differs from the independent pin', 'STATE_MISMATCH');
  }
  if (epoch(body.snapshot.epochId, 'snapshot.epochId') !== expectedEpochId) {
    fail('checkpoint epoch differs from the independent pin', 'STATE_MISMATCH');
  }
  const ageBlocks = currentHeight - body.snapshotHeight;
  if (ageBlocks < 0) fail('checkpoint height is ahead of the current chain view', 'FRESHNESS');
  if (ageBlocks > policy.maxAgeBlocks) fail('checkpoint exceeds the signer policy freshness limit', 'FRESHNESS');
  const bytes = signingBytes(body);
  const bodyHash = sha256Hex(bytes);
  if (hex32(envelope.bodyHash, 'bodyHash') !== bodyHash) fail('checkpoint body hash mismatch', 'BODY_MISMATCH');
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length < 1
    || envelope.signatures.length > MAX_SIGNERS) fail(`checkpoint must contain 1..${MAX_SIGNERS} signatures`, 'QUORUM');
  const signerKeyIds = new Set();
  for (const signature of envelope.signatures) {
    record(signature, ['algorithm', 'keyId', 'signatureHex'], 'checkpoint signature');
    if (signature.algorithm !== 'ed25519') fail('unsupported checkpoint signature algorithm', 'SIGNER_POLICY');
    hex32(signature.keyId, 'signature.keyId');
    if (signerKeyIds.has(signature.keyId)) fail('duplicate checkpoint signature', 'QUORUM');
    signerKeyIds.add(signature.keyId);
    const publicKey = signers.get(signature.keyId);
    if (!publicKey) fail('checkpoint signer is not allowlisted', 'SIGNER_POLICY');
    if (typeof signature.signatureHex !== 'string' || !/^[0-9a-f]{128}$/.test(signature.signatureHex)) {
      fail('checkpoint signature must be lowercase 64-byte hex', 'SIGNATURE');
    }
    if (!crypto.verify(null, bytes, publicKey, Buffer.from(signature.signatureHex, 'hex'))) {
      fail('invalid checkpoint signature', 'SIGNATURE');
    }
  }
  if (signerKeyIds.size < policy.threshold) fail('checkpoint signature quorum is below the pinned threshold', 'QUORUM');
  return Object.freeze({ ok: true, authenticationVerified: true,
    body, bodyHash, snapshot: body.snapshot, snapshotHash: body.snapshotHash,
    transactionPolicyHash: body.transactionPolicyHash,
    signerKeyIds: Object.freeze([...signerKeyIds].sort()), threshold: policy.threshold, ageBlocks,
    priorStateRootMatched: true, priorStateOpeningVerified: false,
    executionVerified: false, zkProofVerified: false });
}

function verifySignedPnlBatchCheckpointV2(envelopeInput, contextInput) {
  try {
    const envelope = snapshotPlainData(envelopeInput, '$.signedCheckpoint', false);
    const context = snapshotPlainData(contextInput, '$.verificationContext', false);
    return verifyCopiedCheckpoint(envelope, context);
  } catch (error) {
    return failure(error);
  }
}

function verifyAuthenticatedPnlBatchV2(batchInput, envelopeInput, contextInput) {
  try {
    const batch = snapshotPlainData(batchInput, '$.batch', false);
    const envelope = snapshotPlainData(envelopeInput, '$.signedCheckpoint', false);
    const context = snapshotPlainData(contextInput, '$.verificationContext', false);
    const authenticated = verifyCopiedCheckpoint(envelope, context);
    const accounting = verifyPnlSettlementBatch(batch, {
      snapshot: authenticated.snapshot, expectedSnapshotHash: authenticated.snapshotHash
    });
    if (!accounting.ok) fail(`authenticated batch accounting failed: ${accounting.reason}`, 'BATCH_MISMATCH');
    return Object.freeze({ ...authenticated, accountingVerified: true,
      batchHash: accounting.batchHash, statement: accounting.statement,
      statementHash: accounting.statementHash });
  } catch (error) {
    return failure(error);
  }
}

module.exports = { CHECKPOINT_KIND, SIGNED_CHECKPOINT_KIND, TRUST_POLICY_KIND, VERSION, MAX_SIGNERS,
  pnlBatchCheckpointSigningBytesV2, hashPnlBatchCheckpointBodyV2,
  buildSignedPnlBatchCheckpointV2, verifySignedPnlBatchCheckpointV2,
  verifyAuthenticatedPnlBatchV2 };
