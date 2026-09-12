'use strict';

const crypto = require('crypto');
const { validateDlcTransactionSetCommitments } = require('./dlc_transaction_validator');
const { validateDlcContract } = require('./dlc_contract_state');

const KIND = 'utxoref_dlc_peer_message_v1';
const TESTNET4_CHAIN_HASH = '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043';
const TYPES = Object.freeze({
  OFFER: 'offer_dlc_v0',
  ACCEPT: 'accept_dlc_v0',
  SIGN: 'sign_dlc_v0'
});
const TYPE_POLICY = Object.freeze({
  [TYPES.OFFER]: Object.freeze({
    role: 'offerer',
    keys: Object.freeze([
      'protocolVersion', 'chainHash', 'temporaryContractId', 'fundingOutputSerialId',
      'payoutSerialId', 'changeSerialId', 'fundingInputSerialIds', 'contractDigest',
      'oraclePolicyDigest', 'transactionValidationDigest'
    ])
  }),
  [TYPES.ACCEPT]: Object.freeze({
    role: 'accepter',
    keys: Object.freeze([
      'protocolVersion', 'temporaryContractId', 'payoutSerialId', 'changeSerialId',
      'fundingInputSerialIds', 'contractDigest', 'oraclePolicyDigest',
      'transactionValidationDigest', 'cetSignaturesDigest', 'refundSignatureDigest'
    ])
  }),
  [TYPES.SIGN]: Object.freeze({
    role: 'offerer',
    keys: Object.freeze([
      'protocolVersion', 'contractId', 'fundingWitnessInputSerialIds',
      'fundingWitnessesDigest', 'contractDigest', 'oraclePolicyDigest',
      'transactionValidationDigest', 'cetSignaturesDigest', 'refundSignatureDigest'
    ])
  })
});

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
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new Error(`${path}.${key} must not be undefined`);
      result[key] = canonicalize(value[key], `${path}.${key}`);
    }
    return result;
  }
  throw new Error(`${path} contains unsupported data`);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function computeOraclePolicyDigest(oraclePolicy) {
  if (!oraclePolicy || typeof oraclePolicy !== 'object') throw new Error('oraclePolicy is malformed');
  return sha256Hex(Buffer.from(canonicalJson(oraclePolicy), 'utf8'));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function requireHash(value, fieldName) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${fieldName} must be lowercase 32-byte hex`);
  }
  return value;
}

function requireId(value, fieldName) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error(`${fieldName} is invalid`);
  }
  return value;
}

function requireU64(value, fieldName) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new Error(`${fieldName} must be a canonical u64 decimal string`);
  }
  const number = BigInt(value);
  if (number > 0xffffffffffffffffn) throw new Error(`${fieldName} exceeds u64`);
  return value;
}

function normalizeSerials(values, fieldName) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 4096) {
    throw new Error(`${fieldName} must contain 1..4096 serial IDs`);
  }
  const normalized = values.map((value, index) => requireU64(value, `${fieldName}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${fieldName} contains duplicate serial IDs`);
  for (let index = 1; index < normalized.length; index++) {
    if (BigInt(normalized[index - 1]) >= BigInt(normalized[index])) {
      throw new Error(`${fieldName} must be sorted in ascending order`);
    }
  }
  return normalized;
}

function normalizeBody(messageType, body) {
  const policy = TYPE_POLICY[messageType];
  if (!policy || !body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('unsupported DLC peer message type or body');
  }
  const keys = Object.keys(body).sort();
  const expected = [...policy.keys].sort();
  if (keys.join(':') !== expected.join(':')) throw new Error(`${messageType} fields are not canonical`);
  if (body.protocolVersion !== 1) throw new Error(`${messageType} protocolVersion must be 1`);
  const normalized = { ...body, protocolVersion: 1 };
  if (messageType === TYPES.OFFER) {
    normalized.chainHash = requireHash(body.chainHash, 'offer chainHash');
    normalized.temporaryContractId = requireHash(body.temporaryContractId, 'temporaryContractId');
    normalized.fundingOutputSerialId = requireU64(body.fundingOutputSerialId, 'fundingOutputSerialId');
  } else if (messageType === TYPES.ACCEPT) {
    normalized.temporaryContractId = requireHash(body.temporaryContractId, 'temporaryContractId');
  } else {
    normalized.contractId = requireHash(body.contractId, 'contractId');
    normalized.fundingWitnessInputSerialIds = normalizeSerials(
      body.fundingWitnessInputSerialIds,
      'fundingWitnessInputSerialIds'
    );
  }
  if (messageType !== TYPES.SIGN) {
    normalized.payoutSerialId = requireU64(body.payoutSerialId, 'payoutSerialId');
    normalized.changeSerialId = requireU64(body.changeSerialId, 'changeSerialId');
    normalized.fundingInputSerialIds = normalizeSerials(body.fundingInputSerialIds, 'fundingInputSerialIds');
  }
  normalized.transactionValidationDigest = requireHash(
    body.transactionValidationDigest,
    'transactionValidationDigest'
  );
  normalized.contractDigest = requireHash(body.contractDigest, 'contractDigest');
  normalized.oraclePolicyDigest = requireHash(body.oraclePolicyDigest, 'oraclePolicyDigest');
  if (messageType !== TYPES.OFFER) {
    normalized.cetSignaturesDigest = requireHash(body.cetSignaturesDigest, 'cetSignaturesDigest');
    normalized.refundSignatureDigest = requireHash(body.refundSignatureDigest, 'refundSignatureDigest');
  }
  if (messageType === TYPES.SIGN) {
    normalized.fundingWitnessesDigest = requireHash(body.fundingWitnessesDigest, 'fundingWitnessesDigest');
  }
  return canonicalize(normalized);
}

function messagePayload(message) {
  return Buffer.from(canonicalJson({
    kind: KIND,
    messageType: message.messageType,
    senderRole: message.senderRole,
    peerId: message.peerId,
    previousMessageDigest: message.previousMessageDigest,
    body: message.body
  }), 'utf8');
}

function signDlcPeerMessage({ messageType, peerId, previousMessageDigest = null, body, privateKey }) {
  const policy = TYPE_POLICY[messageType];
  if (!policy) throw new Error('unsupported DLC peer message type');
  requireId(peerId, 'peerId');
  if (previousMessageDigest !== null) requireHash(previousMessageDigest, 'previousMessageDigest');
  const publicKey = crypto.createPublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('DLC peer message key must be Ed25519');
  const message = {
    kind: KIND,
    messageType,
    senderRole: policy.role,
    peerId,
    previousMessageDigest,
    body: normalizeBody(messageType, body)
  };
  message.messageDigest = sha256Hex(messagePayload(message));
  message.signature = crypto.sign(null, Buffer.from(message.messageDigest, 'hex'), privateKey).toString('base64');
  return deepFreeze(message);
}

function verifyDlcPeerMessage(message, pinnedPublicKey) {
  if (!message || message.kind !== KIND || !TYPE_POLICY[message.messageType] ||
      message.senderRole !== TYPE_POLICY[message.messageType].role) {
    throw new Error('invalid DLC peer message envelope');
  }
  requireId(message.peerId, 'peerId');
  if (message.previousMessageDigest !== null) requireHash(message.previousMessageDigest, 'previousMessageDigest');
  const normalizedBody = normalizeBody(message.messageType, message.body);
  if (canonicalJson(normalizedBody) !== canonicalJson(message.body)) throw new Error('DLC peer message body is non-canonical');
  const digest = sha256Hex(messagePayload({ ...message, body: normalizedBody }));
  if (message.messageDigest !== digest) throw new Error('DLC peer message digest mismatch');
  const publicKey = pinnedPublicKey && pinnedPublicKey.type === 'public'
    ? pinnedPublicKey
    : crypto.createPublicKey(pinnedPublicKey);
  if (publicKey.asymmetricKeyType !== 'ed25519' || typeof message.signature !== 'string' ||
      Buffer.from(message.signature, 'base64').toString('base64') !== message.signature ||
      !crypto.verify(null, Buffer.from(digest, 'hex'), publicKey, Buffer.from(message.signature, 'base64'))) {
    throw new Error('DLC peer message authentication failed');
  }
  return true;
}

function computeDlcContractId(fundingTxid, fundingOutputIndex, temporaryContractId) {
  requireHash(fundingTxid, 'fundingTxid');
  requireHash(temporaryContractId, 'temporaryContractId');
  if (!Number.isSafeInteger(fundingOutputIndex) || fundingOutputIndex < 0 || fundingOutputIndex > 0xffff) {
    throw new Error('fundingOutputIndex must fit u16');
  }
  const funding = Buffer.from(fundingTxid, 'hex');
  const temporary = Buffer.from(temporaryContractId, 'hex');
  const contractId = Buffer.alloc(32);
  for (let index = 0; index < 32; index++) contractId[index] = funding[index] ^ temporary[index];
  contractId[30] ^= fundingOutputIndex >>> 8;
  contractId[31] ^= fundingOutputIndex & 0xff;
  return contractId.toString('hex');
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} serial IDs must be globally unique`);
}

function validateDlcPeerTranscript({
  offer,
  accept,
  sign,
  offererPublicKey,
  accepterPublicKey,
  transactionSet,
  contractState,
  fundingTxid,
  fundingOutputIndex,
  expectedSignatures,
  verifyFundingWitnesses,
  expectedChainHash = TESTNET4_CHAIN_HASH,
  knownTemporaryContractIds = []
}) {
  validateDlcContract(contractState);
  validateDlcTransactionSetCommitments(transactionSet);
  if (!Array.isArray(knownTemporaryContractIds) ||
      knownTemporaryContractIds.some((value) => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) {
    throw new Error('knownTemporaryContractIds must be an array of lowercase hashes');
  }
  verifyDlcPeerMessage(offer, offererPublicKey);
  verifyDlcPeerMessage(accept, accepterPublicKey);
  verifyDlcPeerMessage(sign, offererPublicKey);
  if (offer.messageType !== TYPES.OFFER || accept.messageType !== TYPES.ACCEPT || sign.messageType !== TYPES.SIGN ||
      offer.previousMessageDigest !== null || accept.previousMessageDigest !== offer.messageDigest ||
      sign.previousMessageDigest !== accept.messageDigest) {
    throw new Error('DLC peer messages are not an ordered offer/accept/sign transcript');
  }
  if (offer.peerId === accept.peerId || sign.peerId !== offer.peerId) throw new Error('DLC peer role identities are inconsistent');
  if (offer.body.chainHash !== requireHash(expectedChainHash, 'expectedChainHash')) throw new Error('DLC offer targets the wrong chain');
  if (contractState.network !== 'bitcoin-testnet4') throw new Error('peer transcript is restricted to Bitcoin testnet4');
  if (accept.body.temporaryContractId !== offer.body.temporaryContractId) {
    throw new Error('accept temporaryContractId does not match offer');
  }
  if (knownTemporaryContractIds.includes(offer.body.temporaryContractId)) {
    throw new Error('temporaryContractId was already used with this peer');
  }
  if (fundingTxid !== transactionSet.funding.txid || fundingOutputIndex !== transactionSet.funding.vout) {
    throw new Error('peer transcript funding outpoint does not match validated transaction set');
  }
  if (offer.body.transactionValidationDigest !== transactionSet.validationDigest ||
      accept.body.transactionValidationDigest !== transactionSet.validationDigest ||
      sign.body.transactionValidationDigest !== transactionSet.validationDigest) {
    throw new Error('peer transcript does not bind the validated transaction set');
  }
  const oraclePolicyDigest = computeOraclePolicyDigest(contractState.oraclePolicy);
  for (const message of [offer, accept, sign]) {
    if (message.body.contractDigest !== contractState.contractDigest ||
        message.body.oraclePolicyDigest !== oraclePolicyDigest) {
      throw new Error('peer transcript does not bind the signed contract and oracle policy');
    }
  }
  const canonicalTransition = contractState.history.find((entry) => entry.to === 'CANONICAL_CETS_AND_REFUND');
  const receiptDigest = (kind) => canonicalTransition?.evidence.find((receipt) => receipt.kind === kind)?.digest;
  if (receiptDigest('funding_template') !== transactionSet.fundingTemplateDigest ||
      receiptDigest('cet_set') !== transactionSet.cetSetDigest ||
      receiptDigest('refund_transaction') !== transactionSet.refundTransactionDigest) {
    throw new Error('peer transcript transaction set does not match signed contract receipts');
  }
  assertUnique([
    ...offer.body.fundingInputSerialIds,
    ...accept.body.fundingInputSerialIds
  ], 'funding input');
  assertUnique([
    offer.body.changeSerialId,
    accept.body.changeSerialId,
    offer.body.fundingOutputSerialId
  ], 'funding output');
  assertUnique([offer.body.payoutSerialId, accept.body.payoutSerialId], 'CET payout');
  if (canonicalJson(sign.body.fundingWitnessInputSerialIds) !== canonicalJson(offer.body.fundingInputSerialIds)) {
    throw new Error('funding witnesses do not match offer funding inputs in serial order');
  }
  if (!expectedSignatures ||
      accept.body.cetSignaturesDigest !== requireHash(expectedSignatures.accepterCet, 'accepter CET digest') ||
      accept.body.refundSignatureDigest !== requireHash(expectedSignatures.accepterRefund, 'accepter refund digest') ||
      sign.body.cetSignaturesDigest !== requireHash(expectedSignatures.offererCet, 'offerer CET digest') ||
      sign.body.refundSignatureDigest !== requireHash(expectedSignatures.offererRefund, 'offerer refund digest') ||
      sign.body.fundingWitnessesDigest !== requireHash(expectedSignatures.fundingWitnesses, 'funding witnesses digest')) {
    throw new Error('peer transcript signature validation digests do not match');
  }
  const contractId = computeDlcContractId(fundingTxid, fundingOutputIndex, offer.body.temporaryContractId);
  if (sign.body.contractId !== contractId) throw new Error('sign contractId does not match funding transaction and offer');
  if (typeof verifyFundingWitnesses !== 'function' || verifyFundingWitnesses({
    fundingTxid,
    fundingOutputIndex,
    inputSerialIds: [...sign.body.fundingWitnessInputSerialIds],
    fundingWitnessesDigest: sign.body.fundingWitnessesDigest,
    contractId
  }) !== true) {
    throw new Error('funding witnesses were not independently validated');
  }
  return Object.freeze({
    ok: true,
    contractId,
    temporaryContractId: offer.body.temporaryContractId,
    transcriptDigest: sha256Hex(Buffer.concat([
      Buffer.from(offer.messageDigest, 'hex'),
      Buffer.from(accept.messageDigest, 'hex'),
      Buffer.from(sign.messageDigest, 'hex')
    ])),
    transactionValidationDigest: transactionSet.validationDigest,
    offererPeerId: offer.peerId,
    accepterPeerId: accept.peerId
  });
}

module.exports = {
  TESTNET4_CHAIN_HASH,
  TYPES,
  computeOraclePolicyDigest,
  computeDlcContractId,
  signDlcPeerMessage,
  verifyDlcPeerMessage,
  validateDlcPeerTranscript
};
