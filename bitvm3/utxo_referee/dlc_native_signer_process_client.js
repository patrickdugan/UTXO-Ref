'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { canonicalJson } = require('./dlc_contract_state');
const publicCrypto = require('./tradelayer_dlc_adaptor_sig');

const REQUEST_KIND = 'utxoref_dlc_native_signer_process_request_v2';
const RESPONSE_KIND = 'utxoref_dlc_native_signer_process_response_v2';
const LIVE_CLIENTS = new WeakSet();
const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const MAX_CODE_FILE_BYTES = 16 * 1024 * 1024;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requireCanonicalBase64(value, fieldName) {
  if (typeof value !== 'string' || Buffer.from(value, 'base64').toString('base64') !== value) {
    throw new Error(`${fieldName} must be canonical base64`);
  }
  return value;
}

function normalizeAuditedFile(value, fieldName, maximumBytes) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${fieldName} must name an existing absolute regular file`);
  }
  const resolved = path.resolve(value);
  const metadata = fs.lstatSync(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    throw new Error(`${fieldName} must name a bounded regular non-symlink file`);
  }
  const realPath = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  const normalizeForComparison = (filePath) => process.platform === 'win32'
    ? path.resolve(filePath).toLowerCase()
    : path.resolve(filePath);
  if (normalizeForComparison(realPath) !== normalizeForComparison(resolved)) {
    throw new Error(`${fieldName} must not traverse filesystem links`);
  }
  return resolved;
}

function normalizeLaunchSpec({ executablePath, arguments: launchArguments = [], codePaths = [] }) {
  const normalizedExecutablePath = normalizeAuditedFile(
    executablePath, 'native signer executablePath', MAX_EXECUTABLE_BYTES
  );
  if (!Array.isArray(launchArguments) || launchArguments.length > 16 || launchArguments.some((value) =>
    typeof value !== 'string' || value.length > 2048 || value.includes('\0'))) {
    throw new Error('native signer arguments must contain at most 16 bounded strings');
  }
  if (!Array.isArray(codePaths) || codePaths.length > 16) {
    throw new Error('native signer codePaths must contain at most 16 files');
  }
  const normalizedCodePaths = codePaths.map((value, index) => {
    return normalizeAuditedFile(value, `native signer codePaths[${index}]`, MAX_CODE_FILE_BYTES);
  });
  if (new Set(normalizedCodePaths.map((value) => value.toLowerCase())).size !== normalizedCodePaths.length) {
    throw new Error('native signer codePaths must be unique');
  }
  return Object.freeze({
    executablePath: normalizedExecutablePath,
    arguments: Object.freeze([...launchArguments]),
    codePaths: Object.freeze(normalizedCodePaths)
  });
}

function nativeSignerRuntimeDigest(launchSpec) {
  const normalized = normalizeLaunchSpec(launchSpec);
  return sha256Hex(Buffer.from(canonicalJson({
    kind: 'utxoref_dlc_native_signer_runtime_closure_v1',
    executableDigest: sha256Hex(fs.readFileSync(normalized.executablePath)),
    arguments: normalized.arguments,
    codeFiles: normalized.codePaths.map((filePath, index) => ({
      index,
      digest: sha256Hex(fs.readFileSync(filePath))
    }))
  }), 'utf8'));
}

function nativeSignerExecutableDigest(launchSpec) {
  const normalized = normalizeLaunchSpec(launchSpec);
  return sha256Hex(fs.readFileSync(normalized.executablePath));
}

function responseSignaturePayload({ challenge, requestDigest, executableSha256, presignature }) {
  if (typeof executableSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(executableSha256)) {
    throw new Error('native signer response executable digest is invalid');
  }
  return Buffer.from(canonicalJson({
    kind: RESPONSE_KIND,
    challenge,
    requestDigest,
    executableSha256,
    presignatureDigest: sha256Hex(Buffer.from(canonicalJson(presignature), 'utf8'))
  }), 'utf8');
}

function runtimeIdentityKey(capabilities) {
  if (!capabilities || typeof capabilities.runtimeIdentityKeyId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(capabilities.runtimeIdentityKeyId) ||
      typeof capabilities.runtimeIdentityPublicKeySpki !== 'string') {
    throw new Error('native signer capabilities lack a runtime identity key');
  }
  requireCanonicalBase64(capabilities.runtimeIdentityPublicKeySpki, 'runtimeIdentityPublicKeySpki');
  const der = Buffer.from(capabilities.runtimeIdentityPublicKeySpki, 'base64');
  const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519' || sha256Hex(der) !== capabilities.runtimeIdentityKeyId) {
    throw new Error('native signer runtime identity key is invalid');
  }
  return key;
}

class DlcNativeSignerProcessClient {
  constructor({
    executablePath,
    arguments: launchArguments = [],
    codePaths = [],
    capabilities,
    timeoutMs = 10000,
    maxResponseBytes = 65536
  }) {
    this.launchSpec = normalizeLaunchSpec({ executablePath, arguments: launchArguments, codePaths });
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
      throw new Error('native signer timeoutMs must be in 100..30000');
    }
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 4096 || maxResponseBytes > 1048576) {
      throw new Error('native signer maxResponseBytes must be in 4096..1048576');
    }
    if (!capabilities || capabilities.binaryDigest !== nativeSignerRuntimeDigest(this.launchSpec)) {
      throw new Error('native signer runtime closure does not match the audited binary digest');
    }
    if (capabilities.executableSha256 !== nativeSignerExecutableDigest(this.launchSpec)) {
      throw new Error('native signer executable does not match the audited executable digest');
    }
    this.capabilities = Object.freeze({
      ...capabilities,
      attestation: capabilities.attestation ? Object.freeze({ ...capabilities.attestation }) : capabilities.attestation
    });
    this.runtimeIdentityKey = runtimeIdentityKey(this.capabilities);
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    LIVE_CLIENTS.add(this);
    Object.freeze(this);
  }

  adaptorSignAuthorized(request) {
    if (nativeSignerRuntimeDigest(this.launchSpec) !== this.capabilities.binaryDigest) {
      throw new Error('native signer runtime closure changed after audit');
    }
    const requestJson = canonicalJson(request);
    if (Buffer.byteLength(requestJson, 'utf8') > 32768) throw new Error('native signer request exceeds 32768 bytes');
    const challenge = crypto.randomBytes(32).toString('hex');
    const requestDigest = sha256Hex(Buffer.from(requestJson, 'utf8'));
    const envelope = `${canonicalJson({
      kind: REQUEST_KIND,
      challenge,
      requestDigest,
      request
    })}\n`;
    const minimalEnvironment = {};
    for (const name of ['SystemRoot', 'WINDIR']) {
      if (typeof process.env[name] === 'string') minimalEnvironment[name] = process.env[name];
    }
    const result = spawnSync(this.launchSpec.executablePath, this.launchSpec.arguments, {
      input: envelope,
      encoding: 'utf8',
      windowsHide: true,
      timeout: this.timeoutMs,
      maxBuffer: this.maxResponseBytes,
      env: minimalEnvironment,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let closureAfterExecution;
    try { closureAfterExecution = nativeSignerRuntimeDigest(this.launchSpec); }
    catch (_error) { throw new Error('native signer runtime closure became unavailable during execution'); }
    if (closureAfterExecution !== this.capabilities.binaryDigest) {
      throw new Error('native signer runtime closure changed during execution');
    }
    if (result.error) throw new Error(`native signer process failed: ${result.error.message}`);
    if (result.status !== 0 || result.signal) {
      throw new Error(`native signer process exited unsuccessfully: ${result.status ?? result.signal}`);
    }
    if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout, 'utf8') > this.maxResponseBytes) {
      throw new Error('native signer response is missing or oversized');
    }
    let response;
    try { response = JSON.parse(result.stdout.trim()); }
    catch (_error) { throw new Error('native signer returned malformed JSON'); }
    if (!response || response.kind !== RESPONSE_KIND || response.challenge !== challenge ||
        response.requestDigest !== requestDigest ||
        response.identityKeyId !== this.capabilities.runtimeIdentityKeyId ||
        typeof response.signature !== 'string') {
      throw new Error('native signer response is not bound to this request challenge');
    }
    if (response.executableSha256 !== this.capabilities.executableSha256) {
      throw new Error('native signer response executable digest does not match the audited executable');
    }
    requireCanonicalBase64(response.signature, 'native signer response signature');
    const signature = Buffer.from(response.signature, 'base64');
    if (signature.length !== 64 || !crypto.verify(
      null,
      responseSignaturePayload({
        challenge,
        requestDigest,
        executableSha256: response.executableSha256,
        presignature: response.presignature
      }),
      this.runtimeIdentityKey,
      signature
    )) throw new Error('native signer response identity signature is invalid');
    return response.presignature;
  }

  adaptorVerify(...args) { return publicCrypto.adaptorVerify(...args); }
  adaptorComplete(...args) { return publicCrypto.adaptorComplete(...args); }
  adaptorExtract(...args) { return publicCrypto.adaptorExtract(...args); }
  schnorrVerify(...args) { return publicCrypto.schnorrVerify(...args); }
}

function isDlcNativeSignerProcessClient(value) {
  return LIVE_CLIENTS.has(value);
}

module.exports = {
  REQUEST_KIND,
  RESPONSE_KIND,
  nativeSignerRuntimeDigest,
  nativeSignerExecutableDigest,
  responseSignaturePayload,
  DlcNativeSignerProcessClient,
  isDlcNativeSignerProcessClient
};
