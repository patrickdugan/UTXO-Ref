'use strict';

const crypto = require('crypto');
const experimental = require('./tradelayer_dlc_adaptor_sig');
const { canonicalJson, validateDlcContract } = require('./dlc_contract_state');
const { DlcSigningAuthorizationStore } = require('./dlc_signing_authorization_store');
const {
  REQUEST_KIND: NATIVE_PROCESS_REQUEST_KIND,
  RESPONSE_KIND: NATIVE_PROCESS_RESPONSE_KIND,
  isDlcNativeSignerProcessClient
} = require('./dlc_native_signer_process_client');

const REQUIRED_NATIVE_OPERATIONS = Object.freeze([
  'adaptorSignAuthorized',
  'adaptorVerify',
  'adaptorComplete',
  'adaptorExtract',
  'schnorrVerify'
]);
const PROVIDER_OPERATIONS = new WeakMap();
const PROVIDER_AUTHORIZATION_STORES = new WeakMap();
const CONSUMED_AUTHORIZATIONS = new WeakMap();
const ADAPTOR_SIGN_AUTHORIZATION_KIND = 'utxoref_dlc_adaptor_sign_authorization_v3';
const NATIVE_ADAPTOR_SIGN_REQUEST_KIND = 'utxoref_dlc_native_adaptor_sign_request_v1';
const DEFAULT_AUTHORIZATION_TTL_SECONDS = 120;
const MAX_AUTHORIZATION_TTL_SECONDS = 300;
const MAX_AUTHORIZATION_CLOCK_SKEW_SECONDS = 30;

function validateNetwork(network) {
  if (!['bitcoin-regtest', 'bitcoin-testnet4', 'bitcoin-mainnet'].includes(network)) {
    throw new Error('DLC crypto network must be bitcoin-regtest, bitcoin-testnet4, or bitcoin-mainnet');
  }
}

function bindOperations(implementation, mode) {
  const required = mode === 'native-isolated'
    ? REQUIRED_NATIVE_OPERATIONS
    : ['adaptorSign', 'adaptorVerify', 'adaptorComplete', 'adaptorExtract', 'schnorrVerify'];
  const operations = {};
  for (const name of required) {
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

function normalizeAuthorizationStore(store) {
  if (store === undefined || store === null) return null;
  if (!(store instanceof DlcSigningAuthorizationStore)) {
    throw new Error('authorizationStore must be a DlcSigningAuthorizationStore');
  }
  return store;
}

function providerIdentity(provider) {
  return crypto.createHash('sha256').update(Buffer.from(canonicalJson({
    kind: provider.kind,
    mode: provider.mode,
    network: provider.network,
    securityLevel: provider.securityLevel,
    capabilities: provider.capabilities
  }), 'utf8')).digest('hex');
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

function requireUnixSeconds(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe UNIX timestamp`);
  }
  return value;
}

function authorizationWindow(issuedAtUnixSeconds, expiresAtUnixSeconds) {
  const issuedAt = requireUnixSeconds(issuedAtUnixSeconds, 'issuedAtUnixSeconds');
  const expiresAt = requireUnixSeconds(expiresAtUnixSeconds, 'expiresAtUnixSeconds');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_AUTHORIZATION_TTL_SECONDS) {
    throw new Error(`DLC signing authorization lifetime must be 1..${MAX_AUTHORIZATION_TTL_SECONDS} seconds`);
  }
  return Object.freeze({ issuedAtUnixSeconds: issuedAt, expiresAtUnixSeconds: expiresAt });
}

function authorizationNow(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('DLC signing authorization clock must be a valid Date');
  }
  return Math.floor(now.getTime() / 1000);
}

function assertAuthorizationFreshness(authorization, now = new Date()) {
  const window = authorizationWindow(
    authorization && authorization.issuedAtUnixSeconds,
    authorization && authorization.expiresAtUnixSeconds
  );
  const current = authorizationNow(now);
  if (window.issuedAtUnixSeconds > current + MAX_AUTHORIZATION_CLOCK_SKEW_SECONDS) {
    throw new Error('DLC signing authorization is not yet valid');
  }
  if (window.expiresAtUnixSeconds < current) {
    throw new Error('DLC signing authorization has expired');
  }
  return window;
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

function adaptorSigningAuthorizationPayload({
  contract,
  authorizationId,
  signerPubkeyX,
  sighash,
  adaptorPoint,
  issuedAtUnixSeconds,
  expiresAtUnixSeconds
}) {
  validateDlcContract(contract);
  if (contract.stage !== 'COUNTERPARTY_SIGNATURES_VERIFIED') {
    throw new Error('DLC adaptor signing requires COUNTERPARTY_SIGNATURES_VERIFIED contract state');
  }
  const window = authorizationWindow(issuedAtUnixSeconds, expiresAtUnixSeconds);
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
    signerPubkeyX: requireLowerHex(signerPubkeyX, 32, 'signerPubkeyX'),
    sighash: requireLowerHex(sighash, 32, 'sighash'),
    adaptorPoint: normalizeAdaptorPoint(adaptorPoint),
    issuedAtUnixSeconds: window.issuedAtUnixSeconds,
    expiresAtUnixSeconds: window.expiresAtUnixSeconds
  };
  return Buffer.from(canonicalJson(normalized), 'utf8');
}

function createDlcAdaptorSignAuthorization({
  privateKey,
  contract,
  authorizationId,
  signerPubkeyX,
  sighash,
  adaptorPoint,
  now = new Date(),
  ttlSeconds = DEFAULT_AUTHORIZATION_TTL_SECONDS
}) {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_AUTHORIZATION_TTL_SECONDS) {
    throw new Error(`ttlSeconds must be an integer from 1 through ${MAX_AUTHORIZATION_TTL_SECONDS}`);
  }
  const issuedAtUnixSeconds = authorizationNow(now);
  const expiresAtUnixSeconds = issuedAtUnixSeconds + ttlSeconds;
  const payload = adaptorSigningAuthorizationPayload({
    contract, authorizationId, signerPubkeyX, sighash, adaptorPoint,
    issuedAtUnixSeconds, expiresAtUnixSeconds
  });
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
    signerPubkeyX,
    sighash,
    adaptorPoint: normalizeAdaptorPoint(adaptorPoint),
    issuedAtUnixSeconds,
    expiresAtUnixSeconds,
    validatorKeyId,
    signature: crypto.sign(null, payload, privateKey).toString('base64')
  });
}

function verifyAuthorizedPresignature(result, signerPubkeyX, sighash) {
  if (!experimental.adaptorVerify(
    Buffer.from(signerPubkeyX, 'hex'),
    Buffer.from(sighash, 'hex'),
    result
  )) {
    throw new Error('DLC signer returned an invalid authorized adaptor signature');
  }
  return result;
}

function authorizeDlcAdaptorSign(provider, { contract, authorization, now = new Date() } = {}) {
  requireDlcSigningProvider(provider);
  const authorizationStore = PROVIDER_AUTHORIZATION_STORES.get(provider);
  if (!authorizationStore) {
    throw new Error('DLC adaptor signing requires a durable authorizationStore configured on the provider');
  }
  validateDlcContract(contract);
  if (provider.network !== contract.network) throw new Error('DLC provider and contract networks differ');
  if (!authorization || authorization.kind !== ADAPTOR_SIGN_AUTHORIZATION_KIND ||
      authorization.stateRecordHash !== contract.recordHash ||
      authorization.validatorKeyId !== contract.validatorPolicy.local_cet_signatures.keyId ||
      typeof authorization.signature !== 'string' ||
      Buffer.from(authorization.signature, 'base64').toString('base64') !== authorization.signature) {
    throw new Error('DLC adaptor signing authorization is malformed or not bound to this contract state');
  }
  assertAuthorizationFreshness(authorization, now);
  const adaptorPoint = normalizeAdaptorPoint(authorization.adaptorPoint);
  const payload = adaptorSigningAuthorizationPayload({
    contract,
    authorizationId: authorization.authorizationId,
    signerPubkeyX: authorization.signerPubkeyX,
    sighash: authorization.sighash,
    adaptorPoint,
    issuedAtUnixSeconds: authorization.issuedAtUnixSeconds,
    expiresAtUnixSeconds: authorization.expiresAtUnixSeconds
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
    execute(...args) {
      if (executed || consumed.has(replayKey)) {
        throw new Error('DLC adaptor signing authorization was already consumed');
      }
      assertAuthorizationFreshness(authorization);
      if (provider.mode === 'experimental-js') {
        if (args.length < 1 || args.length > 2 || (args[1] !== undefined &&
            (!Buffer.isBuffer(args[1]) || args[1].length !== 32))) {
          throw new Error('experimental adaptor signing requires a secret and optional 32-byte aux input');
        }
        const derivedPubkey = experimental.xOnlyPubkey(args[0]).toString('hex');
        if (derivedPubkey !== authorization.signerPubkeyX) {
          throw new Error('experimental signer secret does not match the authorized signer public key');
        }
      } else if (args.length !== 0) {
        throw new Error('native isolated adaptor signing accepts no host-supplied secret or key handle');
      }
      executed = true;
      const authorizationDigest = crypto.createHash('sha256')
        .update(Buffer.from(canonicalJson(authorization), 'utf8')).digest('hex');
      authorizationStore.consume({
        network: contract.network,
        contractId: contract.contractId,
        authorizationId: authorization.authorizationId,
        stateRecordHash: contract.recordHash,
        authorizationDigest,
        providerIdentity: providerIdentity(provider)
      });
      consumed.add(replayKey);
      const operations = PROVIDER_OPERATIONS.get(provider);
      let result;
      if (provider.mode === 'experimental-js') {
        result = operations.adaptorSign(
          args[0],
          Buffer.from(authorization.sighash, 'hex'),
          { x: BigInt(`0x${adaptorPoint.x}`), y: BigInt(`0x${adaptorPoint.y}`) },
          args[1]
        );
      } else {
        result = operations.adaptorSignAuthorized(Object.freeze({
          kind: NATIVE_ADAPTOR_SIGN_REQUEST_KIND,
          network: contract.network,
          contractId: contract.contractId,
          contractDigest: contract.contractDigest,
          stateRecordHash: contract.recordHash,
          transcriptHash: contract.transcriptHash,
          revision: contract.revision,
          stage: contract.stage,
          cetSetDigest: cetSetDigest(contract),
          authorizationDigest,
          authorizationPayload: payload.toString('base64'),
          authorization: Object.freeze(JSON.parse(canonicalJson(authorization))),
          validatorPublicKeySpki: contract.validatorPolicy.local_cet_signatures.publicKeySpki,
          signerPubkeyX: authorization.signerPubkeyX,
          sighash: authorization.sighash,
          adaptorPoint
        }));
      }
      if (result && typeof result.then === 'function') {
        return result.then((value) => verifyAuthorizedPresignature(
          value, authorization.signerPubkeyX, authorization.sighash
        ));
      }
      return verifyAuthorizedPresignature(result, authorization.signerPubkeyX, authorization.sighash);
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
      capabilities.signingRequestKind !== NATIVE_ADAPTOR_SIGN_REQUEST_KIND ||
      capabilities.callerSuppliesSecret !== false ||
      capabilities.keySelection !== 'authorized-xonly-pubkey' ||
      capabilities.independentAuthorizationVerification !== true ||
      capabilities.processRequestKind !== NATIVE_PROCESS_REQUEST_KIND ||
      capabilities.processResponseKind !== NATIVE_PROCESS_RESPONSE_KIND ||
      capabilities.challengeBoundResponses !== true ||
      capabilities.environmentPolicy !== 'systemroot-only' ||
      typeof capabilities.runtimeIdentityKeyId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(capabilities.runtimeIdentityKeyId) ||
      typeof capabilities.runtimeIdentityPublicKeySpki !== 'string' ||
      typeof capabilities.executableSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(capabilities.executableSha256) ||
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
    signingRequestKind: capabilities.signingRequestKind,
    callerSuppliesSecret: capabilities.callerSuppliesSecret,
    keySelection: capabilities.keySelection,
    independentAuthorizationVerification: capabilities.independentAuthorizationVerification,
    processRequestKind: capabilities.processRequestKind,
    processResponseKind: capabilities.processResponseKind,
    challengeBoundResponses: capabilities.challengeBoundResponses,
    environmentPolicy: capabilities.environmentPolicy,
    runtimeIdentityKeyId: capabilities.runtimeIdentityKeyId,
    runtimeIdentityPublicKeySpki: capabilities.runtimeIdentityPublicKeySpki,
    executableSha256: capabilities.executableSha256,
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
    const operations = bindOperations(experimental, mode);
    const authorizationStore = normalizeAuthorizationStore(options.authorizationStore);
    const provider = Object.freeze({
      kind: 'utxoref_dlc_crypto_provider_v1',
      mode,
      network,
      securityLevel: 'research-only',
      productionReady: false,
      signingAuthorizationPersistence: authorizationStore ? 'durable-before-sign' : 'unconfigured',
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
    PROVIDER_AUTHORIZATION_STORES.set(provider, authorizationStore);
    CONSUMED_AUTHORIZATIONS.set(provider, new Set());
    return provider;
  }

  if (mode === 'native-isolated') {
    const capabilities = validateNativeCapabilities(options.implementation, options.trustedAuditKeys);
    if (!isDlcNativeSignerProcessClient(options.implementation)) {
      throw new Error('native-isolated mode requires a verified DlcNativeSignerProcessClient');
    }
    const operations = bindOperations(options.implementation, mode);
    const authorizationStore = normalizeAuthorizationStore(options.authorizationStore);
    const provider = Object.freeze({
      kind: 'utxoref_dlc_crypto_provider_v1',
      mode,
      network,
      securityLevel: 'production-candidate',
      productionReady: false,
      signingAuthorizationPersistence: authorizationStore ? 'durable-before-sign' : 'unconfigured',
      capabilities,
      operations: publicOperations(operations)
    });
    PROVIDER_OPERATIONS.set(provider, operations);
    PROVIDER_AUTHORIZATION_STORES.set(provider, authorizationStore);
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
  DEFAULT_AUTHORIZATION_TTL_SECONDS,
  MAX_AUTHORIZATION_TTL_SECONDS,
  MAX_AUTHORIZATION_CLOCK_SKEW_SECONDS,
  nativeCapabilityAttestationPayload,
  adaptorSigningAuthorizationPayload,
  createDlcAdaptorSignAuthorization,
  authorizeDlcAdaptorSign,
  createDlcCryptoProvider,
  requireDlcSigningProvider
};
