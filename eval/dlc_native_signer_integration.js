#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const dlc = require('../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig');
const {
  ALL_EVIDENCE_KINDS,
  REQUIRED_EVIDENCE,
  canonicalJson,
  createDlcContract,
  signValidationReceipt,
  transitionDlcContract
} = require('../bitvm3/utxo_referee/dlc_contract_state');
const { DlcSigningAuthorizationStore } = require('../bitvm3/utxo_referee/dlc_signing_authorization_store');
const {
  DlcNativeSignerProcessClient,
  nativeSignerRuntimeDigest,
  responseSignaturePayload,
  REQUEST_KIND: PROCESS_REQUEST_KIND,
  RESPONSE_KIND: PROCESS_RESPONSE_KIND
} = require('../bitvm3/utxo_referee/dlc_native_signer_process_client');
const {
  nativeCapabilityAttestationPayload,
  adaptorSigningAuthorizationPayload,
  createDlcAdaptorSignAuthorization,
  authorizeDlcAdaptorSign,
  createDlcCryptoProvider
} = require('../bitvm3/utxo_referee/dlc_crypto_provider');

function fail(message) { throw new Error(message); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest(); }
function digest(value) { return sha256(value).toString('hex'); }

const protectDpapiPath = path.resolve(__dirname, '..', 'native', 'dlc-signer', 'protect-dpapi-key.ps1');
const initializeDpapiPath = path.resolve(
  __dirname, '..', 'native', 'dlc-signer', 'initialize-dpapi-key-directory.ps1'
);
const verifyDpapiAccessPath = path.resolve(
  __dirname, '..', 'native', 'dlc-signer', 'verify-dpapi-key-access.ps1'
);

function powershellPathAndEnvironment() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) fail('SystemRoot is required for DPAPI provisioning');
  return {
    powershell: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    environment: { SystemRoot: systemRoot, WINDIR: systemRoot, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  };
}

function initializeDpapiKeyDirectory(directoryPath) {
  const { powershell, environment } = powershellPathAndEnvironment();
  const result = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', initializeDpapiPath, '-DirectoryPath', directoryPath
  ], {
    encoding: 'utf8', windowsHide: true, env: environment, maxBuffer: 8192
  });
  if (result.error || result.status !== 0) {
    fail(`DPAPI directory initialization failed: ${result.error?.message || result.stderr.trim()}`);
  }
  const accountSid = result.stdout.trim();
  if (!/^S-1-[0-9]+(?:-[0-9]+)+$/.test(accountSid)) fail('DPAPI initializer returned no account SID');
  return accountSid;
}

function protectDpapiKey(destinationPath, secretHex) {
  const { powershell, environment } = powershellPathAndEnvironment();
  const result = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', protectDpapiPath, '-DestinationPath', destinationPath
  ], {
    input: secretHex,
    encoding: 'utf8',
    windowsHide: true,
    env: environment,
    maxBuffer: 8192
  });
  if (result.error || result.status !== 0) {
    fail(`DPAPI provisioning failed: ${result.error?.message || result.stderr.trim()}`);
  }
}

function runSignerProcess(executablePath, launchArguments, envelope) {
  return new Promise((resolve) => {
    const environment = {};
    for (const name of ['SystemRoot', 'WINDIR']) {
      if (typeof process.env[name] === 'string') environment[name] = process.env[name];
    }
    const child = spawn(executablePath, launchArguments, {
      env: environment,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 10000);
    const append = (current, chunk) => {
      if (current.length >= 65536) return current;
      return Buffer.concat([current, chunk]).subarray(0, 65536);
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut, stdout, stderr, error });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
    child.stdin.end(envelope);
  });
}

const binaryPath = path.resolve(process.argv[2] || '');
const workDirectory = path.resolve(process.argv[3] || '');
if (!fs.existsSync(binaryPath) || !fs.statSync(binaryPath).isFile()) fail('native signer binary is required');
if (!fs.existsSync(workDirectory) || !fs.statSync(workDirectory).isDirectory()) fail('work directory is required');

const keyDirectory = path.join(workDirectory, 'keys');
const plaintextKeyDirectory = path.join(workDirectory, 'plaintext-keys');
const looseAclKeyDirectory = path.join(workDirectory, 'loose-acl-keys');
const authorizationDirectory = path.join(workDirectory, 'authorizations');
const directReplayAuthorizationDirectory = path.join(workDirectory, 'direct-replay-authorizations');
const unpinnedValidatorAuthorizationDirectory = path.join(workDirectory, 'unpinned-validator-authorizations');
const unpinnedSignerAuthorizationDirectory = path.join(workDirectory, 'unpinned-signer-authorizations');
const validatorPolicyPath = path.join(workDirectory, 'validator-policy.json');
const unpinnedValidatorPolicyPath = path.join(workDirectory, 'unpinned-validator-policy.json');
const unpinnedSignerPolicyPath = path.join(workDirectory, 'unpinned-signer-policy.json');
fs.mkdirSync(plaintextKeyDirectory, { recursive: true, mode: 0o700 });
fs.mkdirSync(looseAclKeyDirectory, { recursive: true, mode: 0o700 });
fs.mkdirSync(authorizationDirectory, { recursive: true, mode: 0o700 });
fs.mkdirSync(directReplayAuthorizationDirectory, { recursive: true, mode: 0o700 });
fs.mkdirSync(unpinnedValidatorAuthorizationDirectory, { recursive: true, mode: 0o700 });
fs.mkdirSync(unpinnedSignerAuthorizationDirectory, { recursive: true, mode: 0o700 });

async function main() {
try {
  const signerAccountSid = initializeDpapiKeyDirectory(keyDirectory);
  const validatorKeys = crypto.generateKeyPairSync('ed25519');
  const validatorSpki = validatorKeys.publicKey.export({ format: 'der', type: 'spki' });
  const validatorKeyId = digest(validatorSpki);
  const signerSecret = 606n;
  const signerPubkeyX = dlc.xOnlyPubkey(signerSecret).toString('hex');
  const validatorPolicyText = JSON.stringify({
    kind: 'utxoref_dlc_native_validator_policy_v1',
    network: 'bitcoin-testnet4',
    signerPubkeyXs: [signerPubkeyX],
    validatorKeyIds: [validatorKeyId]
  });
  const unpinnedValidatorPolicyText = JSON.stringify({
    kind: 'utxoref_dlc_native_validator_policy_v1',
    network: 'bitcoin-testnet4',
    signerPubkeyXs: [signerPubkeyX],
    validatorKeyIds: [digest('deliberately-unpinned-validator')]
  });
  const unpinnedSignerPolicyText = JSON.stringify({
    kind: 'utxoref_dlc_native_validator_policy_v1',
    network: 'bitcoin-testnet4',
    signerPubkeyXs: [dlc.xOnlyPubkey(607n).toString('hex')],
    validatorKeyIds: [validatorKeyId]
  });
  fs.writeFileSync(validatorPolicyPath, validatorPolicyText, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.writeFileSync(unpinnedValidatorPolicyPath, unpinnedValidatorPolicyText, {
    encoding: 'utf8', mode: 0o600, flag: 'wx'
  });
  fs.writeFileSync(unpinnedSignerPolicyPath, unpinnedSignerPolicyText, {
    encoding: 'utf8', mode: 0o600, flag: 'wx'
  });
  const validatorPolicyDigest = digest(Buffer.from(validatorPolicyText, 'utf8'));
  const unpinnedValidatorPolicyDigest = digest(Buffer.from(unpinnedValidatorPolicyText, 'utf8'));
  const unpinnedSignerPolicyDigest = digest(Buffer.from(unpinnedSignerPolicyText, 'utf8'));
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

  const signerSecretBytes = dlc.bytes32(signerSecret);
  const signerSecretHex = signerSecretBytes.toString('hex');
  const signerBlobPath = path.join(keyDirectory, `${signerPubkeyX}.key.dpapi`);
  protectDpapiKey(signerBlobPath, signerSecretHex);
  const runtimeKeys = crypto.generateKeyPairSync('ed25519');
  const runtimePrivateDer = runtimeKeys.privateKey.export({ format: 'der', type: 'pkcs8' });
  const runtimeSeed = runtimePrivateDer.subarray(runtimePrivateDer.length - 32);
  const runtimeSpki = runtimeKeys.publicKey.export({ format: 'der', type: 'spki' });
  const runtimeSeedHex = runtimeSeed.toString('hex');
  const runtimeBlobPath = path.join(keyDirectory, 'runtime-identity.key.dpapi');
  protectDpapiKey(runtimeBlobPath, runtimeSeedHex);
  fs.copyFileSync(signerBlobPath, path.join(looseAclKeyDirectory, path.basename(signerBlobPath)));
  fs.copyFileSync(runtimeBlobPath, path.join(looseAclKeyDirectory, path.basename(runtimeBlobPath)));
  const signerBlob = fs.readFileSync(signerBlobPath);
  const runtimeBlob = fs.readFileSync(runtimeBlobPath);
  const dpapiBlobsOpaque = !signerBlob.includes(signerSecretBytes) &&
    !signerBlob.includes(Buffer.from(signerSecretHex, 'utf8')) &&
    !runtimeBlob.includes(runtimeSeed) &&
    !runtimeBlob.includes(Buffer.from(runtimeSeedHex, 'utf8'));
  if (!dpapiBlobsOpaque) fail('DPAPI key blob exposed raw key material');

  const verifyDpapiAccessDigest = digest(fs.readFileSync(verifyDpapiAccessPath));

  const launchSpec = {
    executablePath: binaryPath,
    arguments: [keyDirectory, validatorPolicyPath, validatorPolicyDigest,
      verifyDpapiAccessPath, verifyDpapiAccessDigest, signerAccountSid],
    codePaths: [validatorPolicyPath, verifyDpapiAccessPath]
  };
  const unpinnedValidatorLaunchSpec = {
    executablePath: binaryPath,
    arguments: [keyDirectory, unpinnedValidatorPolicyPath, unpinnedValidatorPolicyDigest,
      verifyDpapiAccessPath, verifyDpapiAccessDigest, signerAccountSid],
    codePaths: [unpinnedValidatorPolicyPath, verifyDpapiAccessPath]
  };
  const unpinnedSignerLaunchSpec = {
    executablePath: binaryPath,
    arguments: [keyDirectory, unpinnedSignerPolicyPath, unpinnedSignerPolicyDigest,
      verifyDpapiAccessPath, verifyDpapiAccessDigest, signerAccountSid],
    codePaths: [unpinnedSignerPolicyPath, verifyDpapiAccessPath]
  };
  fs.writeFileSync(
    path.join(plaintextKeyDirectory, `${signerPubkeyX}.KEY`),
    `${signerSecretHex}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  );
  const plaintextLaunchArguments = [plaintextKeyDirectory, validatorPolicyPath,
    validatorPolicyDigest, verifyDpapiAccessPath, verifyDpapiAccessDigest, signerAccountSid];
  const plaintextResult = await runSignerProcess(binaryPath, plaintextLaunchArguments, '{}\n');
  const plaintextKeyFilesRejected = plaintextResult.code !== 0 &&
    /plaintext \.key files are forbidden/.test(plaintextResult.stderr.toString('utf8'));
  if (!plaintextKeyFilesRejected) fail('Rust signer accepted a plaintext key file');
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
  const unpinnedSignerCapabilities = capabilitiesFor(unpinnedSignerLaunchSpec);
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
  const unpinnedSignerProvider = createDlcCryptoProvider({
    network: 'bitcoin-testnet4',
    mode: 'native-isolated',
    implementation: new DlcNativeSignerProcessClient({
      ...unpinnedSignerLaunchSpec,
      capabilities: unpinnedSignerCapabilities,
      timeoutMs: 10000
    }),
    trustedAuditKeys,
    authorizationStore: new DlcSigningAuthorizationStore(unpinnedSignerAuthorizationDirectory)
  });
  let unpinnedSignerRejected = false;
  try { authorizeDlcAdaptorSign(unpinnedSignerProvider, { contract, authorization }).execute(); }
  catch (error) { unpinnedSignerRejected = /native signer process exited unsuccessfully/.test(error.message); }
  if (!unpinnedSignerRejected) fail('Rust signer accepted a signing key absent from its audited policy');
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

  const raceAuthorization = createDlcAdaptorSignAuthorization({
    privateKey: validatorKeys.privateKey,
    contract,
    authorizationId: 'native-rust:race:0',
    signerPubkeyX,
    sighash,
    adaptorPoint
  });
  const racePayload = adaptorSigningAuthorizationPayload({
    contract,
    authorizationId: raceAuthorization.authorizationId,
    signerPubkeyX,
    sighash,
    adaptorPoint,
    issuedAtUnixSeconds: raceAuthorization.issuedAtUnixSeconds,
    expiresAtUnixSeconds: raceAuthorization.expiresAtUnixSeconds
  });
  const cetTransition = contract.history.find((entry) => entry.to === 'CANONICAL_CETS_AND_REFUND');
  const cetReceipt = cetTransition?.evidence.find((entry) => entry.kind === 'cet_set');
  if (!cetReceipt) fail('race probe could not resolve the authenticated CET set digest');
  const raceAuthorizationDigest = digest(Buffer.from(canonicalJson(raceAuthorization), 'utf8'));
  const raceRequest = {
    kind: 'utxoref_dlc_native_adaptor_sign_request_v1',
    network: contract.network,
    contractId: contract.contractId,
    contractDigest: contract.contractDigest,
    stateRecordHash: contract.recordHash,
    transcriptHash: contract.transcriptHash,
    revision: contract.revision,
    stage: contract.stage,
    cetSetDigest: cetReceipt.digest,
    authorizationDigest: raceAuthorizationDigest,
    authorizationPayload: racePayload.toString('base64'),
    authorization: JSON.parse(canonicalJson(raceAuthorization)),
    validatorPublicKeySpki: contract.validatorPolicy.local_cet_signatures.publicKeySpki,
    signerPubkeyX,
    sighash,
    adaptorPoint: { x: dlc.bytes32(adaptorPoint.x).toString('hex'), y: dlc.bytes32(adaptorPoint.y).toString('hex') }
  };
  const raceRequestDigest = digest(Buffer.from(canonicalJson(raceRequest), 'utf8'));
  const raceAttempts = Array.from({ length: 16 }, () => {
    const challenge = crypto.randomBytes(32).toString('hex');
    const envelope = `${canonicalJson({
      kind: PROCESS_REQUEST_KIND,
      challenge,
      requestDigest: raceRequestDigest,
      request: raceRequest
    })}\n`;
    return { challenge, promise: runSignerProcess(binaryPath, launchSpec.arguments, envelope) };
  });
  const raceResults = await Promise.all(raceAttempts.map((attempt) => attempt.promise));
  const winners = raceResults.map((result, index) => ({ result, challenge: raceAttempts[index].challenge }))
    .filter(({ result }) => result.code === 0 && !result.signal && !result.timedOut);
  if (winners.length !== 1) fail(`signer race admitted ${winners.length} of 16 workers`);
  const raceResponse = JSON.parse(winners[0].result.stdout.toString('utf8'));
  const runtimePublicKey = crypto.createPublicKey({ key: runtimeSpki, format: 'der', type: 'spki' });
  if (raceResponse.kind !== PROCESS_RESPONSE_KIND || raceResponse.challenge !== winners[0].challenge ||
      raceResponse.requestDigest !== raceRequestDigest || raceResponse.identityKeyId !== digest(runtimeSpki) ||
      !crypto.verify(null, responseSignaturePayload({
        challenge: raceResponse.challenge,
        requestDigest: raceResponse.requestDigest,
        presignature: raceResponse.presignature
      }), runtimePublicKey, Buffer.from(raceResponse.signature, 'base64')) ||
      !dlc.adaptorVerify(Buffer.from(signerPubkeyX, 'hex'), Buffer.from(sighash, 'hex'), raceResponse.presignature)) {
    fail('signer race winner returned an invalid authenticated pre-signature');
  }

  const directEnvelopeFor = (directAuthorization, directPayload) => {
    const request = {
      ...raceRequest,
      authorizationDigest: digest(Buffer.from(canonicalJson(directAuthorization), 'utf8')),
      authorizationPayload: directPayload.toString('base64'),
      authorization: JSON.parse(canonicalJson(directAuthorization))
    };
    const requestDigest = digest(Buffer.from(canonicalJson(request), 'utf8'));
    const challenge = crypto.randomBytes(32).toString('hex');
    return {
      requestDigest,
      envelope: `${canonicalJson({ kind: PROCESS_REQUEST_KIND, challenge, requestDigest, request })}\n`
    };
  };
  const freshnessAuthorizationFor = (authorizationId, now) => createDlcAdaptorSignAuthorization({
    privateKey: validatorKeys.privateKey,
    contract,
    authorizationId,
    signerPubkeyX,
    sighash,
    adaptorPoint,
    now,
    ttlSeconds: 60
  });
  const freshnessPayloadFor = (freshnessAuthorization) => adaptorSigningAuthorizationPayload({
    contract,
    authorizationId: freshnessAuthorization.authorizationId,
    signerPubkeyX,
    sighash,
    adaptorPoint,
    issuedAtUnixSeconds: freshnessAuthorization.issuedAtUnixSeconds,
    expiresAtUnixSeconds: freshnessAuthorization.expiresAtUnixSeconds
  });
  const accountAuthorization = freshnessAuthorizationFor('native-rust:account-mismatch:0', new Date());
  const accountProbe = directEnvelopeFor(
    accountAuthorization,
    freshnessPayloadFor(accountAuthorization)
  );
  const wrongAccountSid = signerAccountSid === 'S-1-5-18' ? 'S-1-5-32-544' : 'S-1-5-18';
  const wrongAccountArguments = [...launchSpec.arguments.slice(0, -1), wrongAccountSid];
  const accountResult = await runSignerProcess(
    binaryPath,
    wrongAccountArguments,
    accountProbe.envelope
  );
  const unexpectedSignerAccountRejected = accountResult.code !== 0 &&
    /unexpected Windows account SID/.test(accountResult.stderr.toString('utf8'));
  if (!unexpectedSignerAccountRejected) fail('Rust signer accepted an unexpected Windows account SID');

  const looseAclAuthorization = freshnessAuthorizationFor('native-rust:loose-acl:0', new Date());
  const looseAclProbe = directEnvelopeFor(
    looseAclAuthorization,
    freshnessPayloadFor(looseAclAuthorization)
  );
  const looseAclArguments = [looseAclKeyDirectory, ...launchSpec.arguments.slice(1)];
  const looseAclResult = await runSignerProcess(binaryPath, looseAclArguments, looseAclProbe.envelope);
  const inheritedKeyDirectoryAclRejected = looseAclResult.code !== 0 &&
    /must disable inherited ACLs/.test(looseAclResult.stderr.toString('utf8'));
  if (!inheritedKeyDirectoryAclRejected) fail('Rust signer accepted an inherited key-directory ACL');

  const expiredAuthorization = freshnessAuthorizationFor(
    'native-rust:expired:0',
    new Date(Date.now() - 10 * 60 * 1000)
  );
  const expiredProbe = directEnvelopeFor(expiredAuthorization, freshnessPayloadFor(expiredAuthorization));
  const expiredResult = await runSignerProcess(binaryPath, launchSpec.arguments, expiredProbe.envelope);
  const expiredAuthorizationRejected = expiredResult.code !== 0 &&
    /authorization has expired/.test(expiredResult.stderr.toString('utf8'));
  if (!expiredAuthorizationRejected) fail('Rust signer accepted an expired signed authorization');
  const futureAuthorization = freshnessAuthorizationFor(
    'native-rust:future:0',
    new Date(Date.now() + 2 * 60 * 1000)
  );
  const futureProbe = directEnvelopeFor(futureAuthorization, freshnessPayloadFor(futureAuthorization));
  const futureResult = await runSignerProcess(binaryPath, launchSpec.arguments, futureProbe.envelope);
  const futureAuthorizationRejected = futureResult.code !== 0 &&
    /authorization is not yet valid/.test(futureResult.stderr.toString('utf8'));
  if (!futureAuthorizationRejected) fail('Rust signer accepted a not-yet-valid signed authorization');
  const futureClockUnixSeconds = Math.floor(Date.now() / 1000) + 120;
  const clockPayload = {
    kind: 'utxoref_dlc_signer_clock_observation_v1',
    identityKeyId: digest(runtimeSpki),
    unixSeconds: futureClockUnixSeconds
  };
  const clockObservation = {
    ...clockPayload,
    signature: crypto.sign(
      null,
      Buffer.from(canonicalJson(clockPayload), 'utf8'),
      runtimeKeys.privateKey
    ).toString('base64')
  };
  const clockDirectory = path.join(keyDirectory, 'clock-observations');
  fs.writeFileSync(
    path.join(clockDirectory, `${futureClockUnixSeconds}.clock`),
    canonicalJson(clockObservation),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  );
  const rollbackAuthorization = freshnessAuthorizationFor('native-rust:clock-rollback:0', new Date());
  const rollbackProbe = directEnvelopeFor(
    rollbackAuthorization,
    freshnessPayloadFor(rollbackAuthorization)
  );
  const rollbackResult = await runSignerProcess(binaryPath, launchSpec.arguments, rollbackProbe.envelope);
  const signedClockRollbackRejected = rollbackResult.code !== 0 &&
    /clock rollback exceeds/.test(rollbackResult.stderr.toString('utf8'));
  if (!signedClockRollbackRejected) fail('Rust signer accepted an authorization after signed clock rollback');

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
    signerRaceWorkers: raceResults.length,
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
      unpinnedSignerRejected: true,
      runtimeIdentityVerifiedByHost: true,
      restartReplayRejected: true,
      signerLocalReplayRejected: true,
      exactOneSignerRaceWinner: true,
      expiredAuthorizationRejected: true,
      futureAuthorizationRejected: true,
      signedClockRollbackRejected: true,
      dpapiProtectedKeyBlobsOnly: true,
      dpapiBlobsOpaque,
      plaintextKeyFilesRejected,
      expectedWindowsAccountSidBound: true,
      unexpectedSignerAccountRejected,
      protectedKeyDirectoryAclRequired: true,
      inheritedKeyDirectoryAclRejected,
      nativeDpapiDecryption: true,
      decryptionSecretIpcEliminated: true,
      dpapiAccessVerifierSilent: true,
      unsafeDpapiFfiBlocks: 7,
      dpapiOutputMemoryLocked: true,
      decryptedKeyBufferMemoryLocked: true,
      memoryLockFailureFailsClosed: true,
      processMitigationsApplied: true,
      system32OnlyDllSearch: true,
      dynamicCodeProhibited: true,
      extensionPointsDisabled: true,
      microsoftSignedImagesOnly: true,
      remoteAndLowIntegrityImagesRejected: true,
      hostSuppliedNoSecret: true
    }
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  fs.rmSync(keyDirectory, { recursive: true, force: true });
  fs.rmSync(plaintextKeyDirectory, { recursive: true, force: true });
  fs.rmSync(looseAclKeyDirectory, { recursive: true, force: true });
  fs.rmSync(authorizationDirectory, { recursive: true, force: true });
  fs.rmSync(directReplayAuthorizationDirectory, { recursive: true, force: true });
  fs.rmSync(unpinnedValidatorAuthorizationDirectory, { recursive: true, force: true });
  fs.rmSync(unpinnedSignerAuthorizationDirectory, { recursive: true, force: true });
  fs.rmSync(validatorPolicyPath, { force: true });
  fs.rmSync(unpinnedValidatorPolicyPath, { force: true });
  fs.rmSync(unpinnedSignerPolicyPath, { force: true });
}
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
