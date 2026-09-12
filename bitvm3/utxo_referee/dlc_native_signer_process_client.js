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
const MAX_TRANSPORT_DESCRIPTOR_BYTES = 8192;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sameFileIdentity(metadata, expected) {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1n &&
    metadata.dev === expected.dev && metadata.ino === expected.ino &&
    metadata.size === expected.size && metadata.mtimeNs === expected.mtimeNs &&
    metadata.ctimeNs === expected.ctimeNs;
}

function sameDirectoryIdentity(metadata, expected) {
  return metadata.isDirectory() && !metadata.isSymbolicLink() &&
    metadata.dev === expected.dev && metadata.ino === expected.ino;
}

function identityBoundFileSha256(filePath, fieldName, maximumBytes) {
  const parentPath = path.dirname(filePath);
  const parentBefore = fs.lstatSync(parentPath, { bigint: true });
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) {
    throw new Error(`${fieldName} parent must be a non-symlink directory`);
  }
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size > BigInt(maximumBytes)) {
    throw new Error(`${fieldName} must name a bounded regular file with one filesystem link`);
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const hash = crypto.createHash('sha256');
  const chunk = Buffer.alloc(Math.min(65536, Math.max(1, Number(before.size))));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(opened, before)) throw new Error(`${fieldName} changed while opening`);
    let offset = 0;
    while (offset < Number(opened.size)) {
      const requested = Math.min(chunk.length, Number(opened.size) - offset);
      const count = fs.readSync(fd, chunk, 0, requested, offset);
      if (count < 1) throw new Error(`${fieldName} was truncated while hashing`);
      hash.update(chunk.subarray(0, count));
      chunk.fill(0, 0, count);
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(after, opened)) throw new Error(`${fieldName} changed while hashing`);
    const pathAfter = fs.lstatSync(filePath, { bigint: true });
    if (!sameFileIdentity(pathAfter, opened)) throw new Error(`${fieldName} path changed while hashing`);
    const parentAfter = fs.lstatSync(parentPath, { bigint: true });
    if (!sameDirectoryIdentity(parentAfter, parentBefore)) {
      throw new Error(`${fieldName} parent changed while hashing`);
    }
    return hash.digest('hex');
  } finally {
    chunk.fill(0);
    fs.closeSync(fd);
  }
}

function requireCanonicalBase64(value, fieldName) {
  if (typeof value !== 'string' || Buffer.from(value, 'base64').toString('base64') !== value) {
    throw new Error(`${fieldName} must be canonical base64`);
  }
  return value;
}

function freezeJson(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeAuditedFile(value, fieldName, maximumBytes) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${fieldName} must name an existing absolute regular file`);
  }
  const resolved = path.resolve(value);
  const metadata = fs.lstatSync(resolved, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n ||
      metadata.size > BigInt(maximumBytes)) {
    throw new Error(`${fieldName} must name a bounded regular non-symlink file with one filesystem link`);
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

function normalizeLaunchSpec({
  executablePath,
  attestedExecutablePath = executablePath,
  arguments: launchArguments = [],
  codePaths = [],
  transportDescriptor = null
}) {
  const normalizedExecutablePath = normalizeAuditedFile(
    executablePath, 'native signer executablePath', MAX_EXECUTABLE_BYTES
  );
  const normalizedAttestedExecutablePath = normalizeAuditedFile(
    attestedExecutablePath, 'native signer attestedExecutablePath', MAX_EXECUTABLE_BYTES
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
  if (transportDescriptor !== null &&
      (typeof transportDescriptor !== 'object' || Array.isArray(transportDescriptor))) {
    throw new Error('native signer transportDescriptor must be a JSON object or null');
  }
  let normalizedTransportDescriptor = null;
  if (transportDescriptor !== null) {
    const descriptorJson = canonicalJson(transportDescriptor);
    if (Buffer.byteLength(descriptorJson, 'utf8') > MAX_TRANSPORT_DESCRIPTOR_BYTES) {
      throw new Error('native signer transportDescriptor exceeds 8192 bytes');
    }
    normalizedTransportDescriptor = freezeJson(JSON.parse(descriptorJson));
  }
  if (normalizedExecutablePath !== normalizedAttestedExecutablePath && normalizedTransportDescriptor === null) {
    throw new Error('native signer proxy launch requires an attested transportDescriptor');
  }
  return Object.freeze({
    executablePath: normalizedExecutablePath,
    attestedExecutablePath: normalizedAttestedExecutablePath,
    arguments: Object.freeze([...launchArguments]),
    codePaths: Object.freeze(normalizedCodePaths),
    transportDescriptor: normalizedTransportDescriptor
  });
}

function nativeSignerRuntimeDigest(launchSpec) {
  const normalized = normalizeLaunchSpec(launchSpec);
  return sha256Hex(Buffer.from(canonicalJson({
    kind: 'utxoref_dlc_native_signer_runtime_closure_v3',
    launcherExecutableDigest: identityBoundFileSha256(
      normalized.executablePath, 'native signer executablePath', MAX_EXECUTABLE_BYTES
    ),
    attestedExecutableDigest: identityBoundFileSha256(
      normalized.attestedExecutablePath, 'native signer attestedExecutablePath', MAX_EXECUTABLE_BYTES
    ),
    arguments: normalized.arguments,
    transportDescriptor: normalized.transportDescriptor,
    codeFiles: normalized.codePaths.map((filePath, index) => ({
      index,
      digest: identityBoundFileSha256(
        filePath, `native signer codePaths[${index}]`, MAX_CODE_FILE_BYTES
      )
    }))
  }), 'utf8'));
}

function nativeSignerExecutableDigest(launchSpec) {
  const normalized = normalizeLaunchSpec(launchSpec);
  return identityBoundFileSha256(
    normalized.attestedExecutablePath, 'native signer attestedExecutablePath', MAX_EXECUTABLE_BYTES
  );
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
    attestedExecutablePath = executablePath,
    arguments: launchArguments = [],
    codePaths = [],
    transportDescriptor = null,
    capabilities,
    timeoutMs = 10000,
    maxResponseBytes = 65536
  }) {
    this.launchSpec = normalizeLaunchSpec({
      executablePath,
      attestedExecutablePath,
      arguments: launchArguments,
      codePaths,
      transportDescriptor
    });
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
      const diagnostic = typeof result.stderr === 'string'
        ? result.stderr.trim().replace(/[\r\n]+/g, ' ').slice(0, 2048)
        : '';
      throw new Error(
        `native signer process exited unsuccessfully: ${result.status ?? result.signal}${
          diagnostic ? `: ${diagnostic}` : ''
        }`
      );
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
