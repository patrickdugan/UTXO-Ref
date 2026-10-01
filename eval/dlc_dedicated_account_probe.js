'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  ALL_EVIDENCE_KINDS,
  REQUIRED_EVIDENCE,
  canonicalJson,
  createDlcContract,
  signValidationReceipt,
  transitionDlcContract
} = require('../bitvm3/utxo_referee/dlc_contract_state');
const {
  adaptorSigningAuthorizationPayload,
  createDlcAdaptorSignAuthorization,
  nativeCapabilityAttestationPayload
} = require('../bitvm3/utxo_referee/dlc_crypto_provider');
const {
  REQUEST_KIND,
  RESPONSE_KIND,
  DlcNativeSignerProcessClient,
  nativeSignerExecutableDigest,
  nativeSignerRuntimeDigest
} = require('../bitvm3/utxo_referee/dlc_native_signer_process_client');
const dlc = require('../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig');
const { buildDlcSigningFixture } = require('../bitvm3/utxo_referee/dlc_signing_fixture');

function fail(message) { throw new Error(message); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, 'utf8').trim()); }
function writeExclusive(filePath, value) {
  fs.writeFileSync(filePath, `${canonicalJson(value)}\n`, { encoding: 'utf8', flag: 'wx' });
}

function requireAbsoluteFile(value, label) {
  const resolved = path.resolve(value || '');
  if (!path.isAbsolute(value || '') || !fs.statSync(resolved).isFile()) fail(`${label} must be an absolute file`);
  return resolved;
}

function requireAbsoluteDirectory(value, label) {
  const resolved = path.resolve(value || '');
  if (!path.isAbsolute(value || '') || !fs.statSync(resolved).isDirectory()) {
    fail(`${label} must be an absolute directory`);
  }
  return resolved;
}

function prepare(args) {
  if (args.length !== 8) fail('prepare requires binary, code, keys, provisioning, pipe, signer SID, client SID, and PowerShell');
  const [binaryArg, codeArg, keysArg, provisioningArg, pipeName, signerSid, clientSid, powershellArg] = args;
  const binaryPath = requireAbsoluteFile(binaryArg, 'binary');
  const codeDirectory = requireAbsoluteDirectory(codeArg, 'code directory');
  const keyDirectory = requireAbsoluteDirectory(keysArg, 'key directory');
  const provisioningPath = requireAbsoluteFile(provisioningArg, 'provisioning result');
  const powershell = requireAbsoluteFile(powershellArg, 'PowerShell');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(pipeName)) fail('pipe name is invalid');
  for (const [label, sid] of [['signer', signerSid], ['client', clientSid]]) {
    if (!/^S-1-[0-9]+(?:-[0-9]+)+$/.test(sid)) fail(`${label} SID is invalid`);
  }
  if (signerSid === clientSid) fail('dedicated-account probe requires distinct signer and client SIDs');

  const provisioning = readJson(provisioningPath);
  if (provisioning.schema !== 'utxoref_dlc_dpapi_keyset_provisioning_v1' ||
      provisioning.accountSid !== signerSid ||
      !/^[0-9a-f]{64}$/.test(provisioning.signerPubkeyX) ||
      !/^[0-9a-f]{64}$/.test(provisioning.runtimeIdentityKeyId) ||
      typeof provisioning.runtimeIdentityPublicKeySpki !== 'string') {
    fail('provisioning result is invalid or belongs to a different account');
  }
  const runtimeSpki = Buffer.from(provisioning.runtimeIdentityPublicKeySpki, 'base64');
  if (runtimeSpki.toString('base64') !== provisioning.runtimeIdentityPublicKeySpki ||
      digest(runtimeSpki) !== provisioning.runtimeIdentityKeyId) {
    fail('provisioned runtime identity is invalid');
  }

  const brokerPath = requireAbsoluteFile(path.join(codeDirectory, 'run-named-pipe-broker.ps1'), 'broker');
  const invokerPath = requireAbsoluteFile(path.join(codeDirectory, 'invoke-named-pipe-signer.ps1'), 'invoker');
  const verifierPath = requireAbsoluteFile(path.join(codeDirectory, 'verify-dpapi-key-access.ps1'), 'verifier');
  const validatorKeys = crypto.generateKeyPairSync('ed25519');
  const validatorSpki = validatorKeys.publicKey.export({ format: 'der', type: 'spki' });
  const validatorKeyId = digest(validatorSpki);
  const validatorPolicy = {
    kind: 'utxoref_dlc_native_validator_policy_v1',
    network: 'bitcoin-testnet4',
    signerPubkeyXs: [provisioning.signerPubkeyX],
    validatorKeyIds: [validatorKeyId]
  };
  const validatorPolicyPath = path.join(codeDirectory, 'validator-policy.json');
  fs.writeFileSync(validatorPolicyPath, canonicalJson(validatorPolicy), { encoding: 'utf8', flag: 'wx' });
  const validatorPolicyDigest = digest(fs.readFileSync(validatorPolicyPath));
  const verifierDigest = digest(fs.readFileSync(verifierPath));
  const binarySha256 = digest(fs.readFileSync(binaryPath));
  if (binarySha256 !== provisioning.signerBinarySha256 || verifierDigest !== provisioning.accessVerifierSha256) {
    fail('staged signer files differ from the provisioned closure');
  }

  const validatorPolicyMap = Object.fromEntries(ALL_EVIDENCE_KINDS.map((kind) => [kind, {
    keyId: validatorKeyId,
    publicKeySpki: validatorSpki.toString('base64')
  }]));
  // MAIN-3: receipts over a real transaction set and pinned oracle announcements.
  const announcements = [101n, 202n, 303n].map((secret, index) => dlc.buildDlcOracle(secret, 1001n + BigInt(index), {
    eventId: 'dedicated-account-testnet4-event',
    outcomeMessages: [
      crypto.createHash('sha256').update('dedicated-account:yes').digest(),
      crypto.createHash('sha256').update('dedicated-account:no').digest()
    ]
  }));
  const signingFixture = buildDlcSigningFixture({
    signerPubkeyX: provisioning.signerPubkeyX,
    counterpartySecret: 31337n,
    announcements
  });
  const requestFor = (contract, to) => {
    const idempotencyKey = `dedicated-account:${to}`;
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
        digest: signingFixture.receiptDigests[kind] || digest(`dedicated-account:${to}:${kind}`)
      }))
    };
  };
  let contract = createDlcContract({
    contractId: `dedicated-account-${crypto.randomBytes(12).toString('hex')}`,
    network: 'bitcoin-testnet4',
    contractDigest: digest('dedicated-account-testnet4-contract'),
    oraclePolicy: {
      threshold: 2, total: 3, pinnedPubkeys: signingFixture.oracleAnnouncements.map((announcement) => announcement.px)
    },
    validatorPolicy: validatorPolicyMap
  });
  for (const stage of ['AUTHENTICATED_ORACLES', 'CANONICAL_CETS_AND_REFUND', 'COUNTERPARTY_SIGNATURES_VERIFIED']) {
    contract = transitionDlcContract(contract, requestFor(contract, stage));
  }
  const signingContext = signingFixture.signingContext;
  const authorization = createDlcAdaptorSignAuthorization({
    privateKey: validatorKeys.privateKey,
    contract,
    authorizationId: `dedicated-account:${crypto.randomBytes(12).toString('hex')}`,
    signerPubkeyX: provisioning.signerPubkeyX,
    signingContext,
    ttlSeconds: 300
  });
  const sighash = authorization.sighash;
  const authorizationPayload = adaptorSigningAuthorizationPayload({
    contract,
    authorizationId: authorization.authorizationId,
    signerPubkeyX: authorization.signerPubkeyX,
    signingContext,
    issuedAtUnixSeconds: authorization.issuedAtUnixSeconds,
    expiresAtUnixSeconds: authorization.expiresAtUnixSeconds
  });
  const cetTransition = contract.history.find((entry) => entry.to === 'CANONICAL_CETS_AND_REFUND');
  const cetReceipt = cetTransition.evidence.find((entry) => entry.kind === 'cet_set');
  const authorizationDigest = digest(Buffer.from(canonicalJson(authorization), 'utf8'));
  const request = {
    kind: 'utxoref_dlc_native_adaptor_sign_request_v2',
    network: contract.network,
    contractId: contract.contractId,
    contractDigest: contract.contractDigest,
    stateRecordHash: contract.recordHash,
    transcriptHash: contract.transcriptHash,
    revision: contract.revision,
    stage: contract.stage,
    cetSetDigest: cetReceipt.digest,
    fundingTemplateDigest: authorizationPayload.target.fundingTemplateDigest,
    oracleAnnouncementsDigest: authorizationPayload.target.oracleAnnouncementsDigest,
    cetTxid: authorizationPayload.target.cetTxid,
    authorizationDigest,
    authorizationPayload: authorizationPayload.payload.toString('base64'),
    authorization: JSON.parse(canonicalJson(authorization)),
    validatorPublicKeySpki: validatorSpki.toString('base64'),
    signerPubkeyX: authorization.signerPubkeyX,
    sighash: authorization.sighash,
    adaptorPoint: authorization.adaptorPoint,
    signingContext: authorizationPayload.target.signingContext
  };
  const launchSpec = {
    executablePath: powershell,
    attestedExecutablePath: binaryPath,
    arguments: [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', invokerPath, '-PipeName', pipeName, '-TimeoutMs', '15000'
    ],
    codePaths: [invokerPath, brokerPath, validatorPolicyPath, verifierPath],
    transportDescriptor: {
      kind: 'utxoref_dlc_named_pipe_transport_v1',
      pipeName,
      brokerScriptSha256: digest(fs.readFileSync(brokerPath)),
      invokerScriptSha256: digest(fs.readFileSync(invokerPath)),
      allowedClientSid: clientSid,
      expectedSignerAccountSid: signerSid,
      signerBinarySha256: binarySha256,
      validatorPolicySha256: validatorPolicyDigest,
      accessVerifierSha256: verifierDigest,
      requestMaxBytes: 65536,
      responseMaxBytes: 1048576
    }
  };
  const manifest = {
    apiVersion: 1,
    curve: 'secp256k1',
    adaptorScheme: 'bip340-schnorr',
    nativeSecretArithmetic: true,
    constantTimeSecretOperations: true,
    secretZeroization: true,
    processIsolated: true,
    signingRequestKind: 'utxoref_dlc_native_adaptor_sign_request_v2',
    callerSuppliesSecret: false,
    keySelection: 'authorized-xonly-pubkey',
    independentAuthorizationVerification: true,
    processRequestKind: REQUEST_KIND,
    processResponseKind: RESPONSE_KIND,
    challengeBoundResponses: true,
    environmentPolicy: 'systemroot-only',
    runtimeIdentityKeyId: provisioning.runtimeIdentityKeyId,
    runtimeIdentityPublicKeySpki: provisioning.runtimeIdentityPublicKeySpki,
    executableSha256: nativeSignerExecutableDigest(launchSpec),
    binaryDigest: nativeSignerRuntimeDigest(launchSpec),
    auditDigest: digest('dedicated-account-external-audit-pending')
  };
  const auditKeys = crypto.generateKeyPairSync('ed25519');
  const auditSpki = auditKeys.publicKey.export({ format: 'der', type: 'spki' });
  const capabilities = {
    ...manifest,
    attestation: {
      keyId: digest(auditSpki),
      signature: crypto.sign(null, nativeCapabilityAttestationPayload(manifest), auditKeys.privateKey).toString('base64')
    }
  };
  const probePath = path.join(codeDirectory, 'dedicated-account-probe.json');
  writeExclusive(probePath, {
    schema: 'utxoref_dlc_dedicated_account_probe_v1',
    launchSpec,
    capabilities,
    trustedAuditKey: { keyId: digest(auditSpki), publicKeySpki: auditSpki.toString('base64') },
    request,
    signerPubkeyX: provisioning.signerPubkeyX,
    sighash,
    signerSid,
    clientSid,
    validatorPolicyPath,
    validatorPolicyDigest,
    verifierPath,
    verifierDigest,
    binaryPath,
    binarySha256,
    keyDirectory
  });
  process.stdout.write(`${JSON.stringify({ probePath, validatorPolicyPath, validatorPolicyDigest, verifierDigest, binarySha256 })}\n`);
}

function run(args) {
  if (args.length !== 1) fail('run requires one prepared probe path');
  const probe = readJson(requireAbsoluteFile(args[0], 'probe'));
  if (probe.schema !== 'utxoref_dlc_dedicated_account_probe_v1' || probe.signerSid === probe.clientSid) {
    fail('dedicated-account probe is malformed');
  }
  const client = new DlcNativeSignerProcessClient({
    ...probe.launchSpec,
    capabilities: probe.capabilities,
    timeoutMs: 20000
  });
  const presignature = client.adaptorSignAuthorized(probe.request);
  if (!dlc.adaptorVerify(
    Buffer.from(probe.signerPubkeyX, 'hex'),
    Buffer.from(probe.sighash, 'hex'),
    presignature
  )) fail('dedicated-account signer returned an invalid pre-signature');
  process.stdout.write(`${JSON.stringify({
    schema: 'utxoref_dlc_dedicated_account_probe_result_v1',
    signerSid: probe.signerSid,
    clientSid: probe.clientSid,
    signerPubkeyX: probe.signerPubkeyX,
    executableSha256: probe.capabilities.executableSha256,
    runtimeClosureDigest: probe.capabilities.binaryDigest,
    presignatureDigest: digest(Buffer.from(canonicalJson(presignature), 'utf8')),
    verified: true
  })}\n`);
}

const [mode, ...args] = process.argv.slice(2);
try {
  if (mode === 'prepare') prepare(args);
  else if (mode === 'run') run(args);
  else fail('expected prepare or run mode');
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
