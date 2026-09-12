#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dlc = require('../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig');
const {
  ALL_EVIDENCE_KINDS,
  REQUIRED_EVIDENCE,
  createDlcContract,
  signValidationReceipt,
  transitionDlcContract
} = require('../bitvm3/utxo_referee/dlc_contract_state');
const { DlcSigningAuthorizationStore } = require('../bitvm3/utxo_referee/dlc_signing_authorization_store');
const {
  DlcNativeSignerProcessClient,
  nativeSignerRuntimeDigest,
  REQUEST_KIND: PROCESS_REQUEST_KIND,
  RESPONSE_KIND: PROCESS_RESPONSE_KIND
} = require('../bitvm3/utxo_referee/dlc_native_signer_process_client');
const {
  nativeCapabilityAttestationPayload,
  createDlcAdaptorSignAuthorization,
  authorizeDlcAdaptorSign,
  createDlcCryptoProvider
} = require('../bitvm3/utxo_referee/dlc_crypto_provider');

function fail(message) { throw new Error(message); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest(); }
function digest(value) { return sha256(value).toString('hex'); }

const binaryPath = path.resolve(process.argv[2] || '');
const workDirectory = path.resolve(process.argv[3] || '');
if (!fs.existsSync(binaryPath) || !fs.statSync(binaryPath).isFile()) fail('native signer binary is required');
if (!fs.existsSync(workDirectory) || !fs.statSync(workDirectory).isDirectory()) fail('work directory is required');

const keyDirectory = path.join(workDirectory, 'keys');
const authorizationDirectory = path.join(workDirectory, 'authorizations');
const directReplayAuthorizationDirectory = path.join(workDirectory, 'direct-replay-authorizations');
const unpinnedValidatorAuthorizationDirectory = path.join(workDirectory, 'unpinned-validator-authorizations');
const validatorPolicyPath = path.join(workDirectory, 'validator-policy.json');
const unpinnedValidatorPolicyPath = path.join(workDirectory, 'unpinned-validator-policy.json');
fs.mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
fs.mkdirSync(authorizationDirectory, { recursive: true, mode: 0o700 });
fs.mkdirSync(directReplayAuthorizationDirectory, { recursive: true, mode: 0o700 });
fs.mkdirSync(unpinnedValidatorAuthorizationDirectory, { recursive: true, mode: 0o700 });

try {
  const validatorKeys = crypto.generateKeyPairSync('ed25519');
  const validatorSpki = validatorKeys.publicKey.export({ format: 'der', type: 'spki' });
  const validatorKeyId = digest(validatorSpki);
  const validatorPolicyText = JSON.stringify({
    kind: 'utxoref_dlc_native_validator_policy_v1',
    validatorKeyIds: [validatorKeyId]
  });
  const unpinnedValidatorPolicyText = JSON.stringify({
    kind: 'utxoref_dlc_native_validator_policy_v1',
    validatorKeyIds: [digest('deliberately-unpinned-validator')]
  });
  fs.writeFileSync(validatorPolicyPath, validatorPolicyText, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.writeFileSync(unpinnedValidatorPolicyPath, unpinnedValidatorPolicyText, {
    encoding: 'utf8', mode: 0o600, flag: 'wx'
  });
  const validatorPolicyDigest = digest(Buffer.from(validatorPolicyText, 'utf8'));
  const unpinnedValidatorPolicyDigest = digest(Buffer.from(unpinnedValidatorPolicyText, 'utf8'));
  const validatorPolicy = Object.fromEntries(ALL_EVIDENCE_KINDS.map((kind) => [kind, {
    keyId: validatorKeyId,
    publicKeySpki: validatorSpki.toString('base64')
  }]));
  const requestFor = (contract, to) => {
    const idempotencyKey = `native-rust:${to}`;
    return {
      to,
      idempotencyKey,
      evidence: REQUIRED_EVIDENCE[to].map((kind) => signValidationReceipt({
        privateKey: validatorKeys.privateKey,
        contractId: contract.contractId,
        contractDigest: contract.contractDigest,
        from: contract.stage,
        to,
        idempotencyKey,
        kind,
        digest: digest(`native-rust:${to}:${kind}`)
      }))
    };
  };

  let contract = createDlcContract({
    contractId: 'native-rust-integration',
    network: 'bitcoin-testnet4',
    contractDigest: digest('native-rust-integration-contract'),
    oraclePolicy: {
      threshold: 2,
      total: 3,
      pinnedPubkeys: ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)]
    },
    validatorPolicy
  });
  for (const stage of ['AUTHENTICATED_ORACLES', 'CANONICAL_CETS_AND_REFUND', 'COUNTERPARTY_SIGNATURES_VERIFIED']) {
    contract = transitionDlcContract(contract, requestFor(contract, stage));
  }

  const signerSecret = 606n;
  const signerPubkeyX = dlc.xOnlyPubkey(signerSecret).toString('hex');
  fs.writeFileSync(
    path.join(keyDirectory, `${signerPubkeyX}.key`),
    `${dlc.bytes32(signerSecret).toString('hex')}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  );
  const runtimeKeys = crypto.generateKeyPairSync('ed25519');
  const runtimePrivateDer = runtimeKeys.privateKey.export({ format: 'der', type: 'pkcs8' });
  const runtimeSeed = runtimePrivateDer.subarray(runtimePrivateDer.length - 32);
  const runtimeSpki = runtimeKeys.publicKey.export({ format: 'der', type: 'spki' });
  fs.writeFileSync(
    path.join(keyDirectory, 'runtime-identity.key'),
    `${runtimeSeed.toString('hex')}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  );

  const launchSpec = {
    executablePath: binaryPath,
    arguments: [keyDirectory, validatorPolicyPath, validatorPolicyDigest],
    codePaths: [validatorPolicyPath]
  };
  const unpinnedValidatorLaunchSpec = {
    executablePath: binaryPath,
    arguments: [keyDirectory, unpinnedValidatorPolicyPath, unpinnedValidatorPolicyDigest],
    codePaths: [unpinnedValidatorPolicyPath]
  };
  const manifestFor = (spec) => ({
    apiVersion: 1,
    curve: 'secp256k1',
    adaptorScheme: 'bip340-schnorr',
    nativeSecretArithmetic: true,
    constantTimeSecretOperations: true,
    secretZeroization: true,
    processIsolated: true,
    signingRequestKind: 'utxoref_dlc_native_adaptor_sign_request_v1',
    callerSuppliesSecret: false,
    keySelection: 'authorized-xonly-pubkey',
    independentAuthorizationVerification: true,
    processRequestKind: PROCESS_REQUEST_KIND,
    processResponseKind: PROCESS_RESPONSE_KIND,
    challengeBoundResponses: true,
    environmentPolicy: 'systemroot-only',
    runtimeIdentityKeyId: digest(runtimeSpki),
    runtimeIdentityPublicKeySpki: runtimeSpki.toString('base64'),
    binaryDigest: nativeSignerRuntimeDigest(spec),
    auditDigest: digest('native-rust-candidate-external-audit-pending')
  });
  const auditKeys = crypto.generateKeyPairSync('ed25519');
  const auditSpki = auditKeys.publicKey.export({ format: 'der', type: 'spki' });
  const capabilitiesFor = (spec) => {
    const manifest = manifestFor(spec);
    return {
      ...manifest,
      attestation: {
        keyId: digest(auditSpki),
        signature: crypto.sign(
          null,
          nativeCapabilityAttestationPayload(manifest),
          auditKeys.privateKey
        ).toString('base64')
      }
    };
  };
  const capabilities = capabilitiesFor(launchSpec);
  const unpinnedValidatorCapabilities = capabilitiesFor(unpinnedValidatorLaunchSpec);
  const trustedAuditKeys = [{ keyId: digest(auditSpki), publicKeySpki: auditSpki.toString('base64') }];
  const providerOptions = {
    network: 'bitcoin-testnet4',
    mode: 'native-isolated',
    implementation: new DlcNativeSignerProcessClient({ ...launchSpec, capabilities, timeoutMs: 10000 }),
    trustedAuditKeys,
    authorizationStore: new DlcSigningAuthorizationStore(authorizationDirectory)
  };
  const provider = createDlcCryptoProvider(providerOptions);
  const sighash = digest('native-rust-cet-sighash');
  const adaptorPoint = dlc.pointMul(dlc.G, 717n);
  const authorization = createDlcAdaptorSignAuthorization({
    privateKey: validatorKeys.privateKey,
    contract,
    authorizationId: 'native-rust:cet:0',
    signerPubkeyX,
    sighash,
    adaptorPoint
  });
  const unpinnedValidatorProvider = createDlcCryptoProvider({
    network: 'bitcoin-testnet4',
    mode: 'native-isolated',
    implementation: new DlcNativeSignerProcessClient({
      ...unpinnedValidatorLaunchSpec,
      capabilities: unpinnedValidatorCapabilities,
      timeoutMs: 10000
    }),
    trustedAuditKeys,
    authorizationStore: new DlcSigningAuthorizationStore(unpinnedValidatorAuthorizationDirectory)
  });
  let unpinnedValidatorRejected = false;
  try { authorizeDlcAdaptorSign(unpinnedValidatorProvider, { contract, authorization }).execute(); }
  catch (error) { unpinnedValidatorRejected = /native signer process exited unsuccessfully/.test(error.message); }
  if (!unpinnedValidatorRejected) fail('Rust signer accepted a validator absent from its audited policy');
  const presignature = authorizeDlcAdaptorSign(provider, { contract, authorization }).execute();
  if (!dlc.adaptorVerify(Buffer.from(signerPubkeyX, 'hex'), Buffer.from(sighash, 'hex'), presignature)) {
    fail('Rust signer pre-signature failed JavaScript verification');
  }
  const completedSignature = dlc.adaptorComplete(presignature, 717n);
  if (!dlc.schnorrVerify(Buffer.from(signerPubkeyX, 'hex'), Buffer.from(sighash, 'hex'), completedSignature)) {
    fail('Rust signer pre-signature did not complete to a valid BIP340 signature');
  }
  if (dlc.adaptorExtract(
    presignature,
    completedSignature,
    Buffer.from(signerPubkeyX, 'hex'),
    Buffer.from(sighash, 'hex')
  ) !== 717n) fail('Rust signer pre-signature did not extract its adaptor scalar');
  const restartedProvider = createDlcCryptoProvider({
    ...providerOptions,
    implementation: new DlcNativeSignerProcessClient({ ...launchSpec, capabilities, timeoutMs: 10000 }),
    authorizationStore: new DlcSigningAuthorizationStore(authorizationDirectory)
  });
  let replayRejected = false;
  try { authorizeDlcAdaptorSign(restartedProvider, { contract, authorization }).execute(); }
  catch (error) { replayRejected = /durably consumed/.test(error.message); }
  if (!replayRejected) fail('Rust signer authorization replay was not rejected after provider restart');
  const directReplayProvider = createDlcCryptoProvider({
    ...providerOptions,
    implementation: new DlcNativeSignerProcessClient({ ...launchSpec, capabilities, timeoutMs: 10000 }),
    authorizationStore: new DlcSigningAuthorizationStore(directReplayAuthorizationDirectory)
  });
  let signerLocalReplayRejected = false;
  try { authorizeDlcAdaptorSign(directReplayProvider, { contract, authorization }).execute(); }
  catch (error) { signerLocalReplayRejected = /native signer process exited unsuccessfully/.test(error.message); }
  if (!signerLocalReplayRejected) fail('Rust signer local replay store accepted a consumed authorization');

  const report = {
    schema: 'utxoref_dlc_native_rust_signer_integration_v1',
    network: 'bitcoin-testnet4',
    syntheticKeysOnly: true,
    productionReady: false,
    externalAuditRequired: true,
    binaryPath,
    binarySha256: digest(fs.readFileSync(binaryPath)),
    runtimeClosureDigest: capabilities.binaryDigest,
    validatorPolicyDigest,
    signerPubkeyX,
    contractRecordHash: contract.recordHash,
    authorizationDigest: digest(Buffer.from(JSON.stringify(authorization))),
    presignatureDigest: digest(Buffer.from(JSON.stringify(presignature))),
    assertions: {
      rustProcessSigned: true,
      javascriptHostVerified: true,
      bip340CompletionVerified: true,
      adaptorExtractionVerified: true,
      validatorAuthorizationVerifiedBySigner: true,
      unpinnedValidatorRejected: true,
      runtimeIdentityVerifiedByHost: true,
      restartReplayRejected: true,
      signerLocalReplayRejected: true,
      hostSuppliedNoSecret: true
    }
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  fs.rmSync(keyDirectory, { recursive: true, force: true });
  fs.rmSync(authorizationDirectory, { recursive: true, force: true });
  fs.rmSync(directReplayAuthorizationDirectory, { recursive: true, force: true });
  fs.rmSync(unpinnedValidatorAuthorizationDirectory, { recursive: true, force: true });
  fs.rmSync(validatorPolicyPath, { force: true });
  fs.rmSync(unpinnedValidatorPolicyPath, { force: true });
}
