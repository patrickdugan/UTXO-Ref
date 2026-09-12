'use strict';

const crypto = require('crypto');

const KIND = 'utxoref_dlc_contract_state_v1';
const NETWORKS = new Set(['bitcoin-regtest', 'bitcoin-testnet4']);
const STAGES = Object.freeze([
  'DRAFT',
  'AUTHENTICATED_ORACLES',
  'CANONICAL_CETS_AND_REFUND',
  'COUNTERPARTY_SIGNATURES_VERIFIED',
  'LOCAL_SIGNATURES_PERSISTED',
  'FUNDING_PSBT_APPROVED',
  'FUNDING_BROADCAST',
  'CONFIRMED',
  'CET_EXECUTED',
  'REFUND_EXECUTED'
]);

const REQUIRED_EVIDENCE = Object.freeze({
  AUTHENTICATED_ORACLES: ['oracle_policy'],
  CANONICAL_CETS_AND_REFUND: ['cet_set', 'funding_template', 'refund_transaction'],
  COUNTERPARTY_SIGNATURES_VERIFIED: ['counterparty_cet_signatures', 'counterparty_refund_signature'],
  LOCAL_SIGNATURES_PERSISTED: ['local_cet_signatures', 'local_refund_signature', 'refund_restore_test'],
  FUNDING_PSBT_APPROVED: ['bitcoin_core_policy', 'funding_psbt_validation', 'signer_separation'],
  FUNDING_BROADCAST: ['broadcast_transaction', 'host_broadcast_approval'],
  CONFIRMED: ['funding_confirmation'],
  CET_EXECUTED: ['cet_broadcast_transaction', 'oracle_threshold_attestation'],
  REFUND_EXECUTED: ['refund_broadcast_transaction', 'refund_maturity']
});
const ALL_EVIDENCE_KINDS = Object.freeze([...new Set(Object.values(REQUIRED_EVIDENCE).flat())].sort());

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalize(value, path = '$') {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${path} must contain only safe integers`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  if (typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new Error(`${path}.${key} must not be undefined`);
      result[key] = canonicalize(value[key], `${path}.${key}`);
    }
    return result;
  }
  throw new Error(`${path} contains an unsupported value`);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function requireHex(value, bytes, fieldName) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${fieldName} must be lowercase ${bytes}-byte hex`);
  }
  return value;
}

function requireId(value, fieldName, maxLength = 128) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(value) || value.length > maxLength) {
    throw new Error(`${fieldName} must contain 1..${maxLength} safe identifier characters`);
  }
  return value;
}

function normalizeOraclePolicy(policy) {
  if (!policy || !Number.isSafeInteger(policy.threshold) || !Number.isSafeInteger(policy.total) ||
      policy.threshold < 2 || policy.total < policy.threshold || policy.total > 16 ||
      !Array.isArray(policy.pinnedPubkeys) || policy.pinnedPubkeys.length !== policy.total) {
    throw new Error('oraclePolicy must define a 2..16 member threshold set');
  }
  const pinnedPubkeys = policy.pinnedPubkeys.map((key, index) =>
    requireHex(key, 32, `oraclePolicy.pinnedPubkeys[${index}]`));
  if (new Set(pinnedPubkeys).size !== pinnedPubkeys.length) {
    throw new Error('oraclePolicy pinned public keys must be unique');
  }
  return Object.freeze({ threshold: policy.threshold, total: policy.total, pinnedPubkeys: Object.freeze([...pinnedPubkeys].sort()) });
}

function normalizeValidatorPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('validatorPolicy must pin an Ed25519 key for every evidence kind');
  }
  const normalized = {};
  for (const kind of ALL_EVIDENCE_KINDS) {
    const entry = policy[kind];
    if (!entry || typeof entry.publicKeySpki !== 'string' ||
        Buffer.from(entry.publicKeySpki, 'base64').toString('base64') !== entry.publicKeySpki) {
      throw new Error(`validatorPolicy must pin a canonical Ed25519 key for ${kind}`);
    }
    const der = Buffer.from(entry.publicKeySpki, 'base64');
    let publicKey;
    try {
      publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    } catch (_error) {
      throw new Error(`validatorPolicy contains an invalid public key for ${kind}`);
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(`validatorPolicy key for ${kind} must be Ed25519`);
    }
    const keyId = sha256Hex(der);
    if (entry.keyId !== keyId) throw new Error(`validatorPolicy keyId mismatch for ${kind}`);
    normalized[kind] = Object.freeze({ keyId, publicKeySpki: entry.publicKeySpki });
  }
  return Object.freeze(normalized);
}

function recordHash(record) {
  const copy = { ...record };
  delete copy.recordHash;
  return sha256Hex(canonicalJson(copy));
}

function receiptPayload(receipt, context) {
  const payload = {
    kind: receipt.kind,
    digest: receipt.digest,
    validatorKeyId: receipt.validatorKeyId,
    contractId: context.contractId,
    contractDigest: context.contractDigest,
    from: context.from,
    to: context.to,
    idempotencyKey: context.idempotencyKey
  };
  if (receipt.metadata !== undefined) payload.metadata = receipt.metadata;
  return Buffer.from(canonicalJson(payload), 'utf8');
}

function signValidationReceipt({
  privateKey,
  contractId,
  contractDigest,
  from,
  to,
  idempotencyKey,
  kind,
  digest,
  metadata
}) {
  requireId(contractId, 'contractId');
  requireHex(contractDigest, 32, 'contractDigest');
  requireId(idempotencyKey, 'idempotencyKey');
  requireId(kind, 'kind', 64);
  requireHex(digest, 32, 'digest');
  if (!STAGES.includes(from) || !STAGES.includes(to)) throw new Error('receipt stages are invalid');
  const publicKey = crypto.createPublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('validation receipt key must be Ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const receipt = {
    kind,
    digest,
    validatorKeyId: sha256Hex(publicKeyDer)
  };
  if (metadata !== undefined) receipt.metadata = canonicalize(metadata, 'receipt.metadata');
  receipt.signature = crypto.sign(null, receiptPayload(receipt, {
    contractId,
    contractDigest,
    from,
    to,
    idempotencyKey
  }), privateKey).toString('base64');
  return Object.freeze(receipt);
}

function validateEvidence(evidence, targetStage, context) {
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 32) {
    throw new Error('evidence must contain 1..32 validation receipts');
  }
  if (!context || context.to !== targetStage) throw new Error('validation receipt context mismatch');
  const normalized = evidence.map((receipt, index) => {
    if (!receipt || typeof receipt !== 'object') throw new Error(`evidence[${index}] must be an object`);
    const kind = requireId(receipt.kind, `evidence[${index}].kind`, 64);
    const digest = requireHex(receipt.digest, 32, `evidence[${index}].digest`);
    const policy = context.validatorPolicy[kind];
    if (!policy || receipt.validatorKeyId !== policy.keyId) {
      throw new Error(`evidence[${index}] is not signed by the pinned ${kind} validator`);
    }
    if (typeof receipt.signature !== 'string' ||
        Buffer.from(receipt.signature, 'base64').toString('base64') !== receipt.signature) {
      throw new Error(`evidence[${index}] has a non-canonical signature`);
    }
    const normalizedReceipt = { kind, digest, validatorKeyId: receipt.validatorKeyId };
    if (receipt.metadata !== undefined) normalizedReceipt.metadata = canonicalize(receipt.metadata, `evidence[${index}].metadata`);
    normalizedReceipt.signature = receipt.signature;
    if (canonicalJson(normalizedReceipt).length > 8192) throw new Error(`evidence[${index}] exceeds 8192 bytes`);
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(policy.publicKeySpki, 'base64'),
      format: 'der',
      type: 'spki'
    });
    if (!crypto.verify(null, receiptPayload(normalizedReceipt, context), publicKey, Buffer.from(receipt.signature, 'base64'))) {
      throw new Error(`evidence[${index}] signature is invalid`);
    }
    return normalizedReceipt;
  });
  const kinds = normalized.map((receipt) => receipt.kind);
  if (new Set(kinds).size !== kinds.length) throw new Error('evidence receipt kinds must be unique per transition');
  for (const required of REQUIRED_EVIDENCE[targetStage] || []) {
    if (!kinds.includes(required)) throw new Error(`transition to ${targetStage} requires ${required} evidence`);
  }
  return normalized.sort((left, right) => left.kind.localeCompare(right.kind));
}

function initialTranscriptHash(record) {
  return sha256Hex(canonicalJson({
    kind: KIND,
    contractId: record.contractId,
    network: record.network,
    contractDigest: record.contractDigest,
    oraclePolicy: record.oraclePolicy,
    validatorPolicy: record.validatorPolicy
  }));
}

function createDlcContract({ contractId, network, contractDigest, oraclePolicy, validatorPolicy }) {
  requireId(contractId, 'contractId');
  if (!NETWORKS.has(network)) throw new Error('network must be bitcoin-regtest or bitcoin-testnet4');
  requireHex(contractDigest, 32, 'contractDigest');
  const record = {
    kind: KIND,
    contractId,
    network,
    contractDigest,
    oraclePolicy: normalizeOraclePolicy(oraclePolicy),
    validatorPolicy: normalizeValidatorPolicy(validatorPolicy),
    stage: 'DRAFT',
    revision: 0,
    transcriptHash: null,
    history: []
  };
  record.transcriptHash = initialTranscriptHash(record);
  return Object.freeze({ ...record, recordHash: recordHash(record) });
}

function validateDlcContract(record) {
  if (!record || record.kind !== KIND) throw new Error('invalid DLC contract state kind');
  requireId(record.contractId, 'contractId');
  if (!NETWORKS.has(record.network)) throw new Error('invalid DLC contract network');
  requireHex(record.contractDigest, 32, 'contractDigest');
  normalizeOraclePolicy(record.oraclePolicy);
  const validatorPolicy = normalizeValidatorPolicy(record.validatorPolicy);
  if (!STAGES.includes(record.stage)) throw new Error('invalid DLC contract stage');
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) throw new Error('invalid DLC contract revision');
  requireHex(record.transcriptHash, 32, 'transcriptHash');
  requireHex(record.recordHash, 32, 'recordHash');
  if (!Array.isArray(record.history) || record.history.length !== record.revision) throw new Error('history/revision mismatch');
  if (recordHash(record) !== record.recordHash) throw new Error('DLC contract state hash mismatch');

  let expectedFrom = 'DRAFT';
  let expectedRevision = 1;
  let expectedTranscriptHash = initialTranscriptHash(record);
  const idempotencyKeys = new Set();
  for (const entry of record.history) {
    if (entry.revision !== expectedRevision || entry.from !== expectedFrom || entry.to !== nextAllowedStage(expectedFrom, entry.to)) {
      throw new Error('invalid DLC transition history');
    }
    requireId(entry.idempotencyKey, 'history.idempotencyKey');
    requireHex(entry.requestHash, 32, 'history.requestHash');
    requireHex(entry.priorTranscriptHash, 32, 'history.priorTranscriptHash');
    requireHex(entry.transcriptHash, 32, 'history.transcriptHash');
    const evidence = validateEvidence(entry.evidence, entry.to, {
      contractId: record.contractId,
      contractDigest: record.contractDigest,
      from: entry.from,
      to: entry.to,
      idempotencyKey: entry.idempotencyKey,
      validatorPolicy
    });
    const expectedRequestHash = sha256Hex(canonicalJson({
      to: entry.to,
      idempotencyKey: entry.idempotencyKey,
      evidence
    }));
    if (entry.requestHash !== expectedRequestHash || entry.priorTranscriptHash !== expectedTranscriptHash) {
      throw new Error('DLC transition request or prior transcript hash mismatch');
    }
    expectedTranscriptHash = sha256Hex(Buffer.concat([
      Buffer.from(expectedTranscriptHash, 'hex'),
      Buffer.from(entry.requestHash, 'hex')
    ]));
    if (entry.transcriptHash !== expectedTranscriptHash) throw new Error('DLC transition transcript hash mismatch');
    if (idempotencyKeys.has(entry.idempotencyKey)) throw new Error('duplicate transition idempotency key');
    idempotencyKeys.add(entry.idempotencyKey);
    expectedFrom = entry.to;
    expectedRevision++;
  }
  if (expectedFrom !== record.stage) throw new Error('history does not terminate at current stage');
  if (expectedTranscriptHash !== record.transcriptHash) throw new Error('current DLC transcript hash mismatch');
  return true;
}

function nextAllowedStage(from, requested) {
  if (from === 'CONFIRMED' && (requested === 'CET_EXECUTED' || requested === 'REFUND_EXECUTED')) return requested;
  const index = STAGES.indexOf(from);
  if (index >= 0 && index < STAGES.indexOf('CONFIRMED')) return STAGES[index + 1];
  return null;
}

function transitionDlcContract(record, request) {
  validateDlcContract(record);
  if (!request || typeof request !== 'object') throw new Error('transition request must be an object');
  requireId(request.idempotencyKey, 'idempotencyKey');
  if (!STAGES.includes(request.to)) throw new Error('invalid target DLC stage');
  const prior = record.history.find((entry) => entry.idempotencyKey === request.idempotencyKey);
  const evidence = validateEvidence(request.evidence, request.to, {
    contractId: record.contractId,
    contractDigest: record.contractDigest,
    from: prior ? prior.from : record.stage,
    to: request.to,
    idempotencyKey: request.idempotencyKey,
    validatorPolicy: normalizeValidatorPolicy(record.validatorPolicy)
  });
  const normalizedRequest = { to: request.to, idempotencyKey: request.idempotencyKey, evidence };
  const requestHash = sha256Hex(canonicalJson(normalizedRequest));

  if (prior) {
    if (prior.requestHash !== requestHash) throw new Error('idempotency key was already used for a different transition');
    return record;
  }

  const expected = nextAllowedStage(record.stage, request.to);
  if (expected !== request.to) {
    throw new Error(`invalid DLC transition ${record.stage} -> ${request.to}`);
  }
  const transcriptHash = sha256Hex(Buffer.concat([
    Buffer.from(record.transcriptHash, 'hex'),
    Buffer.from(requestHash, 'hex')
  ]));
  const entry = Object.freeze({
    revision: record.revision + 1,
    from: record.stage,
    to: request.to,
    idempotencyKey: request.idempotencyKey,
    requestHash,
    priorTranscriptHash: record.transcriptHash,
    transcriptHash,
    evidence: Object.freeze(evidence.map((receipt) => Object.freeze(receipt)))
  });
  const next = {
    ...record,
    stage: request.to,
    revision: record.revision + 1,
    transcriptHash,
    history: Object.freeze([...record.history, entry])
  };
  delete next.recordHash;
  const completed = Object.freeze({ ...next, recordHash: recordHash(next) });
  validateDlcContract(completed);
  return completed;
}

module.exports = {
  KIND,
  STAGES,
  REQUIRED_EVIDENCE,
  ALL_EVIDENCE_KINDS,
  canonicalJson,
  recordHash,
  signValidationReceipt,
  createDlcContract,
  validateDlcContract,
  transitionDlcContract
};
