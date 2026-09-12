'use strict';

const crypto = require('crypto');
const { canonicalJson, validateDlcContract } = require('./dlc_contract_state');

const KIND = 'utxoref_dlc_funding_prebroadcast_policy_v1';
const MAX_RAW_TRANSACTION_BYTES = 400000;
const MAX_ATTEMPTS = 3;
const MAX_POLICY_TTL_SECONDS = 30;
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
    throw new Error('Bitcoin Core RPC adapter must be synchronous at the funding broadcast boundary');
  }
  return result;
}

function validateChainInfo(value, contractState) {
  const expectedChain = contractState.network === 'bitcoin-testnet4' ? 'testnet4' : 'regtest';
  if (!value || value.chain !== expectedChain) {
    throw new Error(`Bitcoin Core must report ${expectedChain} for this DLC`);
  }
  return Object.freeze({
    chain: value.chain,
    height: requireSafeInteger(value.blocks, 'Bitcoin Core block height'),
    bestBlockHash: requireHash(value.bestblockhash, 'Bitcoin Core best block hash')
  });
}

function validateMempool(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Bitcoin Core mempool sequence is unavailable');
  }
  return requireSafeInteger(value.mempool_sequence, 'Bitcoin Core mempool sequence');
}

function validateDecodedTransaction(value, rawTxHex) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Bitcoin Core returned an invalid decoded funding transaction');
  }
  const decoded = {
    txid: requireHash(value.txid, 'decoded funding txid'),
    wtxid: requireHash(value.hash, 'decoded funding wtxid'),
    version: requireSafeInteger(value.version, 'decoded funding version', 1),
    size: requireSafeInteger(value.size, 'decoded funding size', 1),
    vsize: requireSafeInteger(value.vsize, 'decoded funding vsize', 1),
    weight: requireSafeInteger(value.weight, 'decoded funding weight', 1),
    locktime: requireSafeInteger(value.locktime, 'decoded funding locktime')
  };
  if (decoded.size > MAX_RAW_TRANSACTION_BYTES || decoded.vsize > MAX_RAW_TRANSACTION_BYTES ||
      decoded.weight > MAX_RAW_TRANSACTION_BYTES * 4) {
    throw new Error('decoded funding transaction exceeds the bounded policy size');
  }
  if (decoded.size !== rawTxHex.length / 2 || decoded.weight < decoded.size ||
      decoded.weight > decoded.size * 4 || decoded.vsize !== Math.ceil(decoded.weight / 4)) {
    throw new Error('Bitcoin Core funding size, weight, and vsize are inconsistent');
  }
  return Object.freeze(decoded);
}

function validatePolicyResult(value, decoded) {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object') {
    throw new Error('Bitcoin Core returned an invalid testmempoolaccept result');
  }
  const result = value[0];
  const txid = requireHash(result.txid, 'policy funding txid');
  const wtxid = requireHash(result.wtxid, 'policy funding wtxid');
  if (txid !== decoded.txid || wtxid !== decoded.wtxid) {
    throw new Error('Bitcoin Core decode and policy transaction identities differ');
  }
  if (result.allowed !== true) {
    const rejectReason = typeof result['reject-reason'] === 'string'
      ? result['reject-reason'].slice(0, 256)
      : 'unspecified policy rejection';
    throw new Error(`Bitcoin Core rejected the funding transaction: ${rejectReason}`);
  }
  return Object.freeze({ txid, wtxid, allowed: true, rejectReason: null });
}

function approvedFundingPsbtDigest(contractState) {
  const transition = contractState.history.find((entry) => entry.to === 'FUNDING_PSBT_APPROVED');
  const receipt = transition && transition.evidence.find((entry) => entry.kind === 'funding_psbt_validation');
  if (!receipt) throw new Error('approved funding PSBT receipt is missing');
  return requireHash(receipt.digest, 'approved funding PSBT digest');
}

function validateFundingPrebroadcastPolicy({
  contractState,
  rawTxHex,
  rpc,
  maxAttempts = MAX_ATTEMPTS,
  now = new Date(),
  ttlSeconds = 15
}) {
  validateDlcContract(contractState);
  if (contractState.stage !== 'FUNDING_PSBT_APPROVED') {
    throw new Error('funding prebroadcast policy requires the FUNDING_PSBT_APPROVED stage');
  }
  if (typeof rawTxHex !== 'string' || rawTxHex.length < 20 || (rawTxHex.length & 1) !== 0 ||
      rawTxHex.length > MAX_RAW_TRANSACTION_BYTES * 2 || !/^[0-9a-f]+$/.test(rawTxHex)) {
    throw new Error('raw funding transaction must be bounded canonical lowercase hex');
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    throw new Error(`maxAttempts must be an integer from 1 to ${MAX_ATTEMPTS}`);
  }

  const rawTransactionSha256 = sha256Hex(Buffer.from(rawTxHex, 'hex'));
  const fundingPsbtDigest = approvedFundingPsbtDigest(contractState);
  const window = policyWindow(now, ttlSeconds);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const chainBefore = validateChainInfo(callRpc(rpc, 'getblockchaininfo'), contractState);
    const mempoolBefore = validateMempool(callRpc(rpc, 'getrawmempool', [false, true]));
    const decoded = validateDecodedTransaction(callRpc(rpc, 'decoderawtransaction', [rawTxHex]), rawTxHex);
    const corePolicy = validatePolicyResult(callRpc(rpc, 'testmempoolaccept', [[rawTxHex]]), decoded);
    const mempoolAfter = validateMempool(callRpc(rpc, 'getrawmempool', [false, true]));
    const chainAfter = validateChainInfo(callRpc(rpc, 'getblockchaininfo'), contractState);
    if (chainBefore.height !== chainAfter.height || chainBefore.bestBlockHash !== chainAfter.bestBlockHash ||
        mempoolBefore !== mempoolAfter) {
      if (attempt < maxAttempts) continue;
      throw new Error('Bitcoin Core tip or mempool changed during funding prebroadcast policy evaluation');
    }

    const record = Object.freeze({
      kind: KIND,
      network: contractState.network,
      contractId: contractState.contractId,
      contractDigest: contractState.contractDigest,
      contractRevision: contractState.revision,
      contractRecordHash: contractState.recordHash,
      contractTranscriptHash: contractState.transcriptHash,
      fundingPsbtDigest,
      rawTransactionSha256,
      txid: decoded.txid,
      wtxid: decoded.wtxid,
      version: decoded.version,
      size: decoded.size,
      vsize: decoded.vsize,
      weight: decoded.weight,
      locktime: decoded.locktime,
      chainTip: chainAfter.bestBlockHash,
      chainHeight: chainAfter.height,
      mempoolSequence: mempoolAfter,
      corePolicy,
      ...window,
      rpcMethods: RPC_METHODS,
      signingAllowed: false,
      sendRawTransactionAllowed: false
    });
    const receiptMetadata = Object.freeze({
      rawTransactionSha256,
      txid: decoded.txid,
      wtxid: decoded.wtxid,
      contractRevision: contractState.revision,
      contractTranscriptHash: contractState.transcriptHash,
      fundingPsbtDigest,
      ...window,
      chainTip: chainAfter.bestBlockHash,
      chainHeight: chainAfter.height,
      mempoolSequence: mempoolAfter,
      corePolicyAllowed: true,
      signingAllowed: false,
      sendRawTransactionAllowed: false
    });
    return Object.freeze({ record, receiptMetadata, policyDigest: sha256Hex(canonicalJson(record)) });
  }
  throw new Error('funding prebroadcast policy evaluation failed');
}

module.exports = {
  KIND,
  MAX_RAW_TRANSACTION_BYTES,
  MAX_ATTEMPTS,
  MAX_POLICY_TTL_SECONDS,
  RPC_METHODS,
  validateFundingPrebroadcastPolicy
};
