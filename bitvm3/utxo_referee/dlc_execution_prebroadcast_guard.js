'use strict';

const crypto = require('crypto');
const { canonicalJson, normalizeDlcContract } = require('./dlc_contract_state');
const {
  parseCanonicalSignedTaprootTransaction,
  normalizeDlcTransactionSet
} = require('./dlc_transaction_validator');

const KIND = 'utxoref_dlc_execution_prebroadcast_policy_v1';
const MAX_ATTEMPTS = 3;
const MAX_POLICY_TTL_SECONDS = 30;
const EXECUTION_TYPES = Object.freeze(['cet', 'refund']);
const RPC_METHODS = Object.freeze([
  'getblockchaininfo',
  'getrawmempool',
  'decoderawtransaction',
  'testmempoolaccept'
]);

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requireHash(value, fieldName) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${fieldName} must be lowercase 32-byte hex`);
  }
  return value;
}

function requireSafeInteger(value, fieldName, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${fieldName} is invalid`);
  return value;
}

function policyWindow(now, ttlSeconds) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('now must be a valid Date');
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_POLICY_TTL_SECONDS) {
    throw new Error(`ttlSeconds must be an integer from 1 to ${MAX_POLICY_TTL_SECONDS}`);
  }
  const issuedAtUnixSeconds = Math.floor(now.getTime() / 1000);
  return Object.freeze({ issuedAtUnixSeconds, expiresAtUnixSeconds: issuedAtUnixSeconds + ttlSeconds });
}

function callRpc(rpc, method, params = []) {
  if (typeof rpc !== 'function') throw new Error('Bitcoin Core RPC adapter must be a function');
  const result = rpc(method, params);
  if (result && typeof result.then === 'function') {
    throw new Error('Bitcoin Core RPC adapter must be synchronous at the DLC execution boundary');
  }
  return result;
}

function chainInfo(value, network) {
  const expectedChain = network === 'bitcoin-testnet4' ? 'testnet4' : 'regtest';
  if (!value || value.chain !== expectedChain) throw new Error(`Bitcoin Core must report ${expectedChain} for this DLC`);
  return Object.freeze({
    height: requireSafeInteger(value.blocks, 'Bitcoin Core block height'),
    bestBlockHash: requireHash(value.bestblockhash, 'Bitcoin Core best block hash')
  });
}

function mempoolSequence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Bitcoin Core mempool sequence is unavailable');
  }
  return requireSafeInteger(value.mempool_sequence, 'Bitcoin Core mempool sequence');
}

function decodedIdentity(value, parsed, signedTxHex) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Bitcoin Core returned an invalid decoded execution transaction');
  }
  const decoded = Object.freeze({
    txid: requireHash(value.txid, 'decoded execution txid'),
    wtxid: requireHash(value.hash, 'decoded execution wtxid'),
    version: requireSafeInteger(value.version, 'decoded execution version', 1),
    size: requireSafeInteger(value.size, 'decoded execution size', 1),
    vsize: requireSafeInteger(value.vsize, 'decoded execution vsize', 1),
    weight: requireSafeInteger(value.weight, 'decoded execution weight', 1),
    locktime: requireSafeInteger(value.locktime, 'decoded execution locktime')
  });
  if (decoded.txid !== parsed.txid || decoded.wtxid !== parsed.wtxid ||
      decoded.version !== parsed.version || decoded.locktime !== parsed.locktime) {
    throw new Error('local parser and Bitcoin Core disagree on the execution transaction');
  }
  const totalSize = signedTxHex.length / 2;
  const strippedSize = parsed.strippedRawTxHex.length / 2;
  const expectedWeight = strippedSize * 4 + totalSize - strippedSize;
  if (decoded.size !== totalSize || decoded.weight !== expectedWeight ||
      decoded.vsize !== Math.ceil(expectedWeight / 4)) {
    throw new Error('Bitcoin Core execution size, weight, and vsize are inconsistent');
  }
  return decoded;
}

function acceptedPolicy(value, decoded) {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object') {
    throw new Error('Bitcoin Core returned an invalid execution testmempoolaccept result');
  }
  const result = value[0];
  const txid = requireHash(result.txid, 'execution policy txid');
  const wtxid = requireHash(result.wtxid, 'execution policy wtxid');
  if (txid !== decoded.txid || wtxid !== decoded.wtxid) {
    throw new Error('Bitcoin Core decode and execution policy transaction identities differ');
  }
  if (result.allowed !== true) {
    const reason = typeof result['reject-reason'] === 'string'
      ? result['reject-reason'].slice(0, 256)
      : 'unspecified policy rejection';
    throw new Error(`Bitcoin Core rejected the execution transaction: ${reason}`);
  }
  return Object.freeze({ txid, wtxid, allowed: true, rejectReason: null });
}

function selectSettlement(transactionSet, executionType, cetTxid) {
  if (!EXECUTION_TYPES.includes(executionType)) throw new Error('executionType must be cet or refund');
  if (executionType === 'refund') {
    if (cetTxid !== undefined) throw new Error('refund execution must not select a CET');
    return Object.freeze({
      transaction: transactionSet.refund,
      commitmentDigest: transactionSet.refundTransactionDigest,
      receiptKind: 'refund_prebroadcast_bitcoin_core_policy'
    });
  }
  requireHash(cetTxid, 'cetTxid');
  const transaction = transactionSet.cets.find((cet) => cet.txid === cetTxid);
  if (!transaction) throw new Error('selected CET is absent from the committed transaction set');
  return Object.freeze({
    transaction,
    commitmentDigest: transactionSet.cetSetDigest,
    receiptKind: 'cet_prebroadcast_bitcoin_core_policy'
  });
}

function validateExecutionPrebroadcastPolicy({
  contractState,
  transactionSet,
  executionType,
  cetTxid,
  signedTxHex,
  executionEvidenceDigest,
  rpc,
  maxAttempts = MAX_ATTEMPTS,
  now = new Date(),
  ttlSeconds = 15
}) {
  contractState = normalizeDlcContract(contractState);
  transactionSet = normalizeDlcTransactionSet(transactionSet);
  if (contractState.stage !== 'CONFIRMED') {
    throw new Error('DLC execution prebroadcast policy requires the CONFIRMED stage');
  }
  const selected = selectSettlement(transactionSet, executionType, cetTxid);
  requireHash(executionEvidenceDigest, 'executionEvidenceDigest');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    throw new Error(`maxAttempts must be an integer from 1 to ${MAX_ATTEMPTS}`);
  }
  const parsed = parseCanonicalSignedTaprootTransaction(signedTxHex);
  if (parsed.txid !== selected.transaction.txid || parsed.strippedRawTxHex !== selected.transaction.rawTxHex) {
    throw new Error('signed execution transaction differs from the committed settlement transaction');
  }
  const rawTransactionSha256 = sha256Hex(Buffer.from(signedTxHex, 'hex'));
  const window = policyWindow(now, ttlSeconds);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const before = chainInfo(callRpc(rpc, 'getblockchaininfo'), contractState.network);
    const mempoolBefore = mempoolSequence(callRpc(rpc, 'getrawmempool', [false, true]));
    const decoded = decodedIdentity(callRpc(rpc, 'decoderawtransaction', [signedTxHex]), parsed, signedTxHex);
    const corePolicy = acceptedPolicy(callRpc(rpc, 'testmempoolaccept', [[signedTxHex]]), decoded);
    const mempoolAfter = mempoolSequence(callRpc(rpc, 'getrawmempool', [false, true]));
    const after = chainInfo(callRpc(rpc, 'getblockchaininfo'), contractState.network);
    if (before.height !== after.height || before.bestBlockHash !== after.bestBlockHash || mempoolBefore !== mempoolAfter) {
      if (attempt < maxAttempts) continue;
      throw new Error('Bitcoin Core tip or mempool changed during DLC execution policy evaluation');
    }
    if (executionType === 'refund' && after.height < selected.transaction.locktime) {
      throw new Error('refund is immature at the stable Bitcoin Core height');
    }

    const record = Object.freeze({
      kind: KIND,
      receiptKind: selected.receiptKind,
      executionType,
      network: contractState.network,
      contractId: contractState.contractId,
      contractDigest: contractState.contractDigest,
      contractRevision: contractState.revision,
      contractRecordHash: contractState.recordHash,
      contractTranscriptHash: contractState.transcriptHash,
      transactionSetValidationDigest: transactionSet.validationDigest,
      settlementCommitmentDigest: selected.commitmentDigest,
      executionEvidenceDigest,
      rawTransactionSha256,
      txid: parsed.txid,
      wtxid: parsed.wtxid,
      version: parsed.version,
      locktime: parsed.locktime,
      size: decoded.size,
      vsize: decoded.vsize,
      weight: decoded.weight,
      chainTip: after.bestBlockHash,
      chainHeight: after.height,
      mempoolSequence: mempoolAfter,
      corePolicy,
      ...window,
      rpcMethods: RPC_METHODS,
      signingAllowed: false,
      sendRawTransactionAllowed: false
    });
    const receiptMetadata = Object.freeze({
      executionType,
      rawTransactionSha256,
      txid: parsed.txid,
      wtxid: parsed.wtxid,
      contractRevision: contractState.revision,
      contractTranscriptHash: contractState.transcriptHash,
      settlementCommitmentDigest: selected.commitmentDigest,
      executionEvidenceDigest,
      ...window,
      chainTip: after.bestBlockHash,
      chainHeight: after.height,
      mempoolSequence: mempoolAfter,
      corePolicyAllowed: true,
      signingAllowed: false,
      sendRawTransactionAllowed: false
    });
    return Object.freeze({ record, receiptMetadata, policyDigest: sha256Hex(canonicalJson(record)) });
  }
  throw new Error('DLC execution prebroadcast policy evaluation failed');
}

module.exports = {
  KIND,
  MAX_ATTEMPTS,
  MAX_POLICY_TTL_SECONDS,
  EXECUTION_TYPES,
  RPC_METHODS,
  validateExecutionPrebroadcastPolicy
};
