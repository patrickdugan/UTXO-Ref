'use strict';

const crypto = require('crypto');
const experimental = require('./tradelayer_dlc_adaptor_sig');
const { canonicalJson } = require('./dlc_contract_state');

const REQUIRED_NATIVE_OPERATIONS = Object.freeze([
  'adaptorSign',
  'adaptorVerify',
  'adaptorComplete',
  'adaptorExtract',
  'schnorrVerify'
]);

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
    return Object.freeze({
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
      operations: bindOperations(experimental)
    });
  }

  if (mode === 'native-isolated') {
    const capabilities = validateNativeCapabilities(options.implementation, options.trustedAuditKeys);
    return Object.freeze({
      kind: 'utxoref_dlc_crypto_provider_v1',
      mode,
      network,
      securityLevel: 'production-candidate',
      productionReady: false,
      capabilities,
      operations: bindOperations(options.implementation)
    });
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
      !['experimental-js', 'native-isolated'].includes(provider.mode)) {
    throw new Error('an enabled DLC signing provider is required');
  }
  if (provider.network === 'bitcoin-mainnet') throw new Error('DLC signing is disabled on Bitcoin mainnet');
  return provider;
}

module.exports = {
  REQUIRED_NATIVE_OPERATIONS,
  nativeCapabilityAttestationPayload,
  createDlcCryptoProvider,
  requireDlcSigningProvider
};
