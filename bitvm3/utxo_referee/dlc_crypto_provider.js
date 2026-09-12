'use strict';

const experimental = require('./tradelayer_dlc_adaptor_sig');

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

function validateNativeCapabilities(implementation) {
  const capabilities = implementation && implementation.capabilities;
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
  return Object.freeze({ ...capabilities });
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
    const capabilities = validateNativeCapabilities(options.implementation);
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
  createDlcCryptoProvider,
  requireDlcSigningProvider
};

