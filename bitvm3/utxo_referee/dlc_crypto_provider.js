'use strict';

const crypto = require('crypto');
const experimental = require('./tradelayer_dlc_adaptor_sig');
const { canonicalJson, validateDlcContract } = require('./dlc_contract_state');

const REQUIRED_NATIVE_OPERATIONS = Object.freeze([
  'adaptorSign',
  'adaptorVerify',
  'adaptorComplete',
  'adaptorExtract',
  'schnorrVerify'
]);
const PROVIDER_OPERATIONS = new WeakMap();
const CONSUMED_AUTHORIZATIONS = new WeakMap();
const ADAPTOR_SIGN_AUTHORIZATION_KIND = 'utxoref_dlc_adaptor_sign_authorization_v1';

function validateNetwork(network) {
  if (!['bitcoin-regtest', 'bitcoin-testnet4', 'bitcoin-mainnet'].includes(network)) {
    throw new Error('DLC crypto network must be bitcoin-regtest, bitcoin-testnet4, or bitcoin-mainnet');
  }
}

function bindOperations(implementation) {
  const operations = {};
  for (const name of REQUIRED_NATIVE_OPERATIONS) {
    if (!implementation || typeof implementation[name] !== 'function') {
      throw new Error(`DLC crypto provider is missing ${name}`);
    }
    operations[name] = (...args) => implementation[name](...args);
  }
  return Object.freeze(operations);
}

function publicOperations(operations) {
  return Object.freeze({
    adaptorVerify: operations.adaptorVerify,
    adaptorComplete: operations.adaptorComplete,
    adaptorExtract: operations.adaptorExtract,
    schnorrVerify: operations.schnorrVerify
  });
}

function requireLowerHex(value, bytes, fieldName) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${fieldName} must be lowercase ${bytes}-byte hex`);
  }
  return value;
}

function requireAuthorizationId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error('authorizationId must contain 1..128 safe identifier characters');
  }
  return value;
}

function cetSetDigest(contract) {
  const transition = contract.history.find((entry) => entry.to === 'CANONICAL_CETS_AND_REFUND');
  const receipt = transition && transition.evidence.find((entry) => entry.kind === 'cet_set');
  if (!receipt) throw new Error('DLC contract has no authenticated CET set commitment');
  return requireLowerHex(receipt.digest, 32, 'cetSetDigest');
}

function normalizeAdaptorPoint(point) {
  if (!point || typeof point !== 'object') throw new Error('adaptorPoint is required');
  if (typeof point.x === 'bigint' && typeof point.y === 'bigint') {
    return Object.freeze({
      x: experimental.bytes32(point.x).toString('hex'),
      y: experimental.bytes32(point.y).toString('hex')
    });
  }
  return Object.freeze({
    x: requireLowerHex(point.x, 32, 'adaptorPoint.x'),
    y: requireLowerHex(point.y, 32, 'adaptorPoint.y')
  });
}

function adaptorSigningAuthorizationPayload({ contract, authorizationId, sighash, adaptorPoint }) {
  validateDlcContract(contract);
  if (contract.stage !== 'COUNTERPARTY_SIGNATURES_VERIFIED') {
    throw new Error('DLC adaptor signing requires COUNTERPARTY_SIGNATURES_VERIFIED contract state');
  }
  const normalized = {
    kind: ADAPTOR_SIGN_AUTHORIZATION_KIND,
    authorizationId: requireAuthorizationId(authorizationId),
    contractId: contract.contractId,
    network: contract.network,
    contractDigest: contract.contractDigest,
    stateRecordHash: contract.recordHash,
    transcriptHash: contract.transcriptHash,
    revision: contract.revision,
    stage: contract.stage,
    cetSetDigest: cetSetDigest(contract),
    sighash: requireLowerHex(sighash, 32, 'sighash'),
    adaptorPoint: normalizeAdaptorPoint(adaptorPoint)
  };
  return Buffer.from(canonicalJson(normalized), 'utf8');
}

function createDlcAdaptorSignAuthorization({ privateKey, contract, authorizationId, sighash, adaptorPoint }) {
  const payload = adaptorSigningAuthorizationPayload({ contract, authorizationId, sighash, adaptorPoint });
  const publicKey = crypto.createPublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('DLC signing authorization key must be Ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const validatorKeyId = crypto.createHash('sha256').update(publicKeyDer).digest('hex');
  if (contract.validatorPolicy.local_cet_signatures.keyId !== validatorKeyId) {
    throw new Error('DLC signing authorization key is not the pinned local CET validator');
  }
  return Object.freeze({
    kind: ADAPTOR_SIGN_AUTHORIZATION_KIND,
    authorizationId,
    stateRecordHash: contract.recordHash,
    sighash,
    adaptorPoint: normalizeAdaptorPoint(adaptorPoint),
    validatorKeyId,
    signature: crypto.sign(null, payload, privateKey).toString('base64')
  });
}

function authorizeDlcAdaptorSign(provider, { contract, authorization } = {}) {
  requireDlcSigningProvider(provider);
  validateDlcContract(contract);
  if (provider.network !== contract.network) throw new Error('DLC provider and contract networks differ');
  if (!authorization || authorization.kind !== ADAPTOR_SIGN_AUTHORIZATION_KIND ||
      authorization.stateRecordHash !== contract.recordHash ||
      authorization.validatorKeyId !== contract.validatorPolicy.local_cet_signatures.keyId ||
      typeof authorization.signature !== 'string' ||
      Buffer.from(authorization.signature, 'base64').toString('base64') !== authorization.signature) {
    throw new Error('DLC adaptor signing authorization is malformed or not bound to this contract state');
  }
  const adaptorPoint = normalizeAdaptorPoint(authorization.adaptorPoint);
  const payload = adaptorSigningAuthorizationPayload({
    contract,
    authorizationId: authorization.authorizationId,
    sighash: authorization.sighash,
    adaptorPoint
  });
  const policy = contract.validatorPolicy.local_cet_signatures;
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(policy.publicKeySpki, 'base64'),
    format: 'der',
    type: 'spki'
  });
  const signature = Buffer.from(authorization.signature, 'base64');
  if (signature.length !== 64 || !crypto.verify(null, payload, publicKey, signature)) {
    throw new Error('DLC adaptor signing authorization signature is invalid');
  }
  const replayKey = `${contract.contractId}:${authorization.authorizationId}`;
  const consumed = CONSUMED_AUTHORIZATIONS.get(provider);
  if (consumed.has(replayKey)) throw new Error('DLC adaptor signing authorization was already consumed');
  let executed = false;
  return Object.freeze({
    kind: 'utxoref_dlc_adaptor_sign_session_v1',
    contractId: contract.contractId,
    authorizationId: authorization.authorizationId,
    sighash: authorization.sighash,
    adaptorPoint,
    execute(secret, aux32) {
      if (executed || consumed.has(replayKey)) {
        throw new Error('DLC adaptor signing authorization was already consumed');
      }
      executed = true;
      consumed.add(replayKey);
      return PROVIDER_OPERATIONS.get(provider).adaptorSign(
        secret,
        Buffer.from(authorization.sighash, 'hex'),
        { x: BigInt(`0x${adaptorPoint.x}`), y: BigInt(`0x${adaptorPoint.y}`) },
        aux32
      );
    }
  });
}

function nativeCapabilityAttestationPayload(capabilities) {
  if (!capabilities || capabilities.apiVersion !== 1 ||
      capabilities.curve !== 'secp256k1' ||
      capabilities.adaptorScheme !== 'bip340-schnorr' ||
      capabilities.nativeSecretArithmetic !== true ||
      capabilities.constantTimeSecretOperations !== true ||
      capabilities.secretZeroization !== true ||
      capabilities.processIsolated !== true ||
      typeof capabilities.binaryDigest !== 'string' || !/^[0-9a-f]{64}$/.test(capabilities.binaryDigest) ||
      typeof capabilities.auditDigest !== 'string' || !/^[0-9a-f]{64}$/.test(capabilities.auditDigest)) {
    throw new Error('native DLC provider does not satisfy the required capability manifest');
  }
  return Buffer.from(canonicalJson({
    kind: 'utxoref_dlc_native_capability_attestation_v1',
    apiVersion: capabilities.apiVersion,
    curve: capabilities.curve,
    adaptorScheme: capabilities.adaptorScheme,
    nativeSecretArithmetic: capabilities.nativeSecretArithmetic,
    constantTimeSecretOperations: capabilities.constantTimeSecretOperations,
    secretZeroization: capabilities.secretZeroization,
    processIsolated: capabilities.processIsolated,
    binaryDigest: capabilities.binaryDigest,
    auditDigest: capabilities.auditDigest
  }), 'utf8');
}

function trustedAuditKeyMap(trustedAuditKeys) {
  if (!Array.isArray(trustedAuditKeys) || trustedAuditKeys.length < 1 || trustedAuditKeys.length > 8) {
    throw new Error('native DLC provider requires 1..8 pinned audit keys');
  }
  const keys = new Map();
  trustedAuditKeys.forEach((entry, index) => {
    if (!entry || typeof entry.keyId !== 'string' || !/^[0-9a-f]{64}$/.test(entry.keyId) ||
        typeof entry.publicKeySpki !== 'string' ||
        Buffer.from(entry.publicKeySpki, 'base64').toString('base64') !== entry.publicKeySpki) {
      throw new Error(`trusted audit key ${index} is malformed`);
    }
    const der = Buffer.from(entry.publicKeySpki, 'base64');
    let publicKey;
    try { publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }); }
    catch (_error) { throw new Error(`trusted audit key ${index} is invalid`); }
    if (publicKey.asymmetricKeyType !== 'ed25519' ||
        crypto.createHash('sha256').update(der).digest('hex') !== entry.keyId || keys.has(entry.keyId)) {
      throw new Error(`trusted audit key ${index} identity is invalid or duplicated`);
    }
    keys.set(entry.keyId, publicKey);
  });
  return keys;
}

function validateNativeCapabilities(implementation, trustedAuditKeys) {
  const capabilities = implementation && implementation.capabilities;
  const payload = nativeCapabilityAttestationPayload(capabilities);
  const keys = trustedAuditKeyMap(trustedAuditKeys);
  const attestation = capabilities.attestation;
  if (!attestation || typeof attestation.keyId !== 'string' || !keys.has(attestation.keyId) ||
      typeof attestation.signature !== 'string') {
    throw new Error('native DLC provider capability manifest lacks a trusted audit attestation');
  }
  let signature;
  try { signature = Buffer.from(attestation.signature, 'base64'); }
  catch (_error) { throw new Error('native DLC provider audit attestation is malformed'); }
  if (signature.length !== 64 || signature.toString('base64') !== attestation.signature ||
      !crypto.verify(null, payload, keys.get(attestation.keyId), signature)) {
    throw new Error('native DLC provider audit attestation is invalid');
  }
  return Object.freeze({ ...capabilities, attestationVerified: true });
}

function createDlcCryptoProvider(options = {}) {
  const network = options.network;
  const mode = options.mode || 'disabled';
  validateNetwork(network);
  if (network === 'bitcoin-mainnet') {
    throw new Error('DLC signing is disabled on Bitcoin mainnet');
  }

  if (mode === 'experimental-js') {
    if (options.allowExperimental !== true) {
      throw new Error('experimental JavaScript DLC crypto requires explicit allowExperimental=true');
    }
    const operations = bindOperations(experimental);
    const provider = Object.freeze({
      kind: 'utxoref_dlc_crypto_provider_v1',
      mode,
      network,
      securityLevel: 'research-only',
      productionReady: false,
      capabilities: Object.freeze({
        apiVersion: 1,
        curve: 'secp256k1',
        adaptorScheme: 'bip340-schnorr',
        nativeSecretArithmetic: false,
        constantTimeSecretOperations: false,
        secretZeroization: false,
        processIsolated: false
      }),
      operations: publicOperations(operations)
    });
    PROVIDER_OPERATIONS.set(provider, operations);
    CONSUMED_AUTHORIZATIONS.set(provider, new Set());
    return provider;
  }

  if (mode === 'native-isolated') {
    const capabilities = validateNativeCapabilities(options.implementation, options.trustedAuditKeys);
    const operations = bindOperations(options.implementation);
    const provider = Object.freeze({
      kind: 'utxoref_dlc_crypto_provider_v1',
      mode,
      network,
      securityLevel: 'production-candidate',
      productionReady: false,
      capabilities,
      operations: publicOperations(operations)
    });
    PROVIDER_OPERATIONS.set(provider, operations);
    CONSUMED_AUTHORIZATIONS.set(provider, new Set());
    return provider;
  }

  if (mode !== 'disabled') throw new Error('unknown DLC crypto provider mode');
  return Object.freeze({
    kind: 'utxoref_dlc_crypto_provider_v1',
    mode: 'disabled',
    network,
    securityLevel: 'disabled',
    productionReady: false,
    capabilities: Object.freeze({}),
    operations: Object.freeze({})
  });
}

function requireDlcSigningProvider(provider) {
  if (!provider || provider.kind !== 'utxoref_dlc_crypto_provider_v1' ||
      !['experimental-js', 'native-isolated'].includes(provider.mode) || !PROVIDER_OPERATIONS.has(provider)) {
    throw new Error('an enabled DLC signing provider is required');
  }
  if (provider.network === 'bitcoin-mainnet') throw new Error('DLC signing is disabled on Bitcoin mainnet');
  return provider;
}

module.exports = {
  REQUIRED_NATIVE_OPERATIONS,
  nativeCapabilityAttestationPayload,
  adaptorSigningAuthorizationPayload,
  createDlcAdaptorSignAuthorization,
  authorizeDlcAdaptorSign,
  createDlcCryptoProvider,
  requireDlcSigningProvider
};
