'use strict';

/**
 * Exact Bitcoin serialization adapter for a verified PnL batch.
 *
 * The caller independently pins both the economic snapshot and transaction
 * policy. Declared prevout values/scripts are bound to that snapshot; a live
 * chain observer must still authenticate them and execute the final witness.
 * A successful result verifies proposal bytes only. This module neither signs
 * nor broadcasts, and it never sets executionVerified or zkProofVerified true.
 *
 * The bounded profile reuses the DLC unsigned parser: Bitcoin version 2/3,
 * 1..16 inputs, 1..1000 outputs, empty scriptSigs, output scripts >=2 bytes,
 * native BTC MAX_MONEY. Signed verification supports generic SegWit witness
 * stacks and compares the complete stripped serialization byte for byte.
 * Shared plain-data limits apply to combined API arguments and receipts.
 */

const crypto = require('crypto');
const { snapshotPlainData, canonicalJson } = require('./dlc_canonical_json');
const { verifyPnlSettlementBatch } = require('./tradelayer_pnl_batch_settlement');
const { MAX_MONEY, parseCanonicalUnsignedTransaction } = require('./dlc_transaction_validator');
const { outpoint, serializeUnsignedTx } = require('./tradelayer_taproot');

const POLICY_KIND = 'tradelayer_pnl_batch_transaction_policy_v1';
const TRANSACTION_KIND = 'tradelayer_pnl_batch_transaction_v1';
const STATEMENT_KIND = 'tradelayer_pnl_batch_transaction_statement_v1';
const SIGNED_RECEIPT_KIND = 'tradelayer_pnl_batch_signed_bytes_receipt_v1';
const TRANSACTION_PROFILE = Object.freeze({ maxInputs: 16, maxOutputs: 1000,
  maxUnsignedBytes: 100000, maxSignedBytes: 400000,
  maxWitnessItemsPerInput: 128, maxWitnessItemBytes: 10000 });
const NETWORKS = new Set(['bitcoin', 'bitcoin-testnet', 'bitcoin-testnet4', 'bitcoin-regtest']);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function fail(message, code = 'INVALID_TRANSACTION') {
  const error = new Error(message);
  Object.defineProperty(error, 'code', { value: code });
  throw error;
}

function fields(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label} has unexpected field ${key}`);
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${label}.${key} is required`);
}

function hash(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(`${label} must be lowercase 32-byte hex`);
  return value;
}

function uint32(value, label) {
  let integer;
  if (typeof value === 'bigint') integer = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) integer = BigInt(value);
  else if (typeof value === 'string' && /^(0|[1-9][0-9]{0,9})$/.test(value)) integer = BigInt(value);
  else fail(`${label} must be an exact uint32`);
  if (integer < 0n || integer > 0xffffffffn) fail(`${label} must be an exact uint32`);
  return Number(integer);
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest(); }
function digest(domain, value) { return sha256(Buffer.from(`${domain}\0${canonicalJson(value)}`, 'utf8')).toString('hex'); }
function outpointKey(row) { return `${row.txid}:${String(row.vout).padStart(10, '0')}`; }

function normalizePolicy(plain) {
  fields(plain, 'transactionPolicy', ['kind', 'network', 'version', 'locktime', 'inputSequences']);
  if (plain.kind !== POLICY_KIND) fail('wrong transaction policy kind');
  if (typeof plain.network !== 'string' || !NETWORKS.has(plain.network)) fail('transaction adapter supports explicit Bitcoin networks only');
  const version = uint32(plain.version, 'transactionPolicy.version');
  if (version !== 2 && version !== 3) fail('transaction policy version must be 2 or 3');
  const locktime = uint32(plain.locktime, 'transactionPolicy.locktime');
  if (!Array.isArray(plain.inputSequences) || plain.inputSequences.length < 1 || plain.inputSequences.length > TRANSACTION_PROFILE.maxInputs) {
    fail(`transaction policy requires 1..${TRANSACTION_PROFILE.maxInputs} input sequences`);
  }
  const inputSequences = plain.inputSequences.map((row, index) => {
    const label = `inputSequences[${index}]`;
    fields(row, label, ['txid', 'vout', 'sequence']);
    return { txid: hash(row.txid, `${label}.txid`), vout: uint32(row.vout, `${label}.vout`),
      sequence: uint32(row.sequence, `${label}.sequence`) };
  }).sort((a, b) => cmp(outpointKey(a), outpointKey(b)));
  for (let index = 1; index < inputSequences.length; index++) {
    if (outpointKey(inputSequences[index - 1]) === outpointKey(inputSequences[index])) fail('duplicate transaction policy outpoint');
  }
  if (locktime !== 0 && inputSequences.every((row) => row.sequence === 0xffffffff)) fail('transaction policy locktime is disabled by final sequences');
  return { kind: POLICY_KIND, network: plain.network, version, locktime, inputSequences };
}

function hashPnlBatchTransactionPolicy(policy) {
  return digest(POLICY_KIND, normalizePolicy(snapshotPlainData(policy, '$.transactionPolicy', true)));
}

function rawHex(value, maxBytes, label) {
  if (typeof value !== 'string' || value.length < 20 || value.length > maxBytes * 2 || !/^(?:[0-9a-f]{2})+$/.test(value)) {
    fail(`${label} must be bounded canonical lowercase hex`);
  }
  return value;
}

function prepare(plain, requirePolicyPin) {
  const keys = ['batch', 'settlementContext', 'transactionPolicy'];
  if (requirePolicyPin) keys.push('expectedTransactionPolicyHash');
  fields(plain, 'transaction context', keys);
  const batchCheck = verifyPnlSettlementBatch(plain.batch, plain.settlementContext);
  if (!batchCheck.ok) fail(`economic batch verification failed: ${batchCheck.reason}`, 'INVALID_SETTLEMENT');
  const batch = plain.batch;
  const policy = normalizePolicy(plain.transactionPolicy);
  const transactionPolicyHash = digest(POLICY_KIND, policy);
  if (requirePolicyPin && hash(plain.expectedTransactionPolicyHash, 'expectedTransactionPolicyHash') !== transactionPolicyHash) {
    fail('independent transaction policy hash mismatch', 'POLICY_MISMATCH');
  }
  if (policy.network !== batch.transaction.network || policy.network !== batch.statement.network) fail('transaction policy network differs from economic batch');
  if (batch.transaction.kind !== 'atomic-spend-proposal') fail('accounting-only batches do not have a Bitcoin spend transaction');
  const inputs = batch.transaction.inputs;
  const outputs = batch.transaction.outputs;
  if (inputs.length < 1 || inputs.length > TRANSACTION_PROFILE.maxInputs) fail(`transaction profile allows 1..${TRANSACTION_PROFILE.maxInputs} inputs`);
  if (outputs.length < 1 || outputs.length > TRANSACTION_PROFILE.maxOutputs) fail(`transaction profile allows 1..${TRANSACTION_PROFILE.maxOutputs} outputs`);
  if (policy.inputSequences.length !== inputs.length) fail('transaction policy input sequence count mismatch');
  const seen = new Set();
  const sequences = new Map(policy.inputSequences.map((row) => [outpointKey(row), row.sequence]));
  let inputTotal = 0n;
  const prevouts = inputs.map((input) => {
    const key = outpointKey(input);
    if (seen.has(key)) fail('duplicate transaction input outpoint');
    seen.add(key);
    if (input.txid === '00'.repeat(32) && input.vout === 0xffffffff) fail('coinbase input is outside the settlement profile');
    if (!sequences.has(key)) fail('transaction policy input sequence outpoint mismatch');
    const sats = BigInt(input.sats);
    if (sats < 1n || sats > MAX_MONEY) fail('declared prevout exceeds Bitcoin money bounds');
    inputTotal += sats;
    if (inputTotal > MAX_MONEY) fail('total declared input value exceeds Bitcoin MAX_MONEY');
    return { vaultId: input.vaultId, txid: input.txid, vout: input.vout,
      sats: input.sats, scriptPubKey: input.scriptPubKey, sequence: sequences.get(key) };
  });
  let outputTotal = 0n;
  const orderedOutputs = outputs.map((output) => {
    const sats = BigInt(output.sats);
    if (sats < 1n || sats > MAX_MONEY) fail('output exceeds Bitcoin money bounds');
    outputTotal += sats;
    if (outputTotal > MAX_MONEY) fail('total output value exceeds Bitcoin MAX_MONEY');
    if (output.scriptPubKey.length < 4) fail('transaction profile requires output scripts of at least two bytes');
    return { outputId: output.id, sats: output.sats, scriptPubKey: output.scriptPubKey };
  });
  const feeSats = BigInt(batch.transaction.feeSats);
  if (inputTotal - outputTotal !== feeSats || feeSats < 0n) fail('declared prevout/output fee mismatch');
  const unsignedTxHex = serializeUnsignedTx(policy.version,
    prevouts.map((input) => ({ outpoint: outpoint(input.txid, input.vout), sequence: input.sequence })),
    orderedOutputs.map((output) => ({ valueSats: BigInt(output.sats), script: output.scriptPubKey })), policy.locktime);
  rawHex(unsignedTxHex, TRANSACTION_PROFILE.maxUnsignedBytes, 'unsignedTxHex');
  const parsed = parseCanonicalUnsignedTransaction(unsignedTxHex);
  const statement = { kind: STATEMENT_KIND, network: policy.network, epochId: batch.statement.epochId,
    snapshotHash: batch.snapshotHash, batchHash: batch.batchHash, batchStatementHash: batch.statementHash,
    transactionTemplateHash: batch.statement.transactionTemplateHash, transactionPolicyHash,
    version: policy.version, locktime: policy.locktime, inputCount: inputs.length, outputCount: outputs.length,
    prevoutRoot: digest('utxoref-pnl-transaction-prevouts-v1', prevouts),
    outputRoot: digest('utxoref-pnl-transaction-outputs-v1', orderedOutputs),
    feeSats: feeSats.toString(), unsignedTransactionSha256: sha256(Buffer.from(unsignedTxHex, 'hex')).toString('hex'),
    txid: parsed.txid };
  const core = { kind: TRANSACTION_KIND, network: policy.network, batchHash: batch.batchHash,
    transactionPolicyHash, version: policy.version, locktime: policy.locktime, prevouts, outputs: orderedOutputs,
    feeSats: feeSats.toString(), unsignedTxHex, txid: parsed.txid, size: unsignedTxHex.length / 2,
    statement, statementHash: digest(STATEMENT_KIND, statement),
    transactionBytesVerified: true, executionVerified: false, zkProofVerified: false };
  return snapshotPlainData({ ...core, transactionHash: digest(TRANSACTION_KIND, core) }, '$.transaction', false);
}

function buildPnlBatchTransaction(input) {
  return prepare(snapshotPlainData(input, '$.transactionContext', true), false);
}

function errorResult(error) {
  const message = error && typeof error === 'object'
    ? Object.getOwnPropertyDescriptor(error, 'message') : null;
  const code = error && typeof error === 'object'
    ? Object.getOwnPropertyDescriptor(error, 'code') : null;
  return { ok: false,
    reason: message && Object.prototype.hasOwnProperty.call(message, 'value') && typeof message.value === 'string'
      ? message.value : 'invalid PnL batch transaction',
    code: code && Object.prototype.hasOwnProperty.call(code, 'value') && typeof code.value === 'string'
      ? code.value : 'INVALID_TRANSACTION' };
}

function verifyPnlBatchTransaction(candidate, context) {
  try {
    const plainCandidate = snapshotPlainData(candidate, '$.candidate', false);
    const rebuilt = prepare(snapshotPlainData(context, '$.transactionContext', true), true);
    fields(plainCandidate, 'candidate', Object.keys(rebuilt));
    rawHex(plainCandidate.unsignedTxHex, TRANSACTION_PROFILE.maxUnsignedBytes, 'candidate.unsignedTxHex');
    // Parse supplied bytes even when their claimed txid/hash look plausible.
    parseCanonicalUnsignedTransaction(plainCandidate.unsignedTxHex);
    if (canonicalJson(plainCandidate) !== canonicalJson(rebuilt)) fail('transaction differs from independently rebuilt bytes and prevouts', 'TRANSACTION_MISMATCH');
    return snapshotPlainData({ ok: true, transaction: rebuilt, transactionBytesVerified: true,
      executionVerified: false, zkProofVerified: false }, '$.verification', false);
  } catch (error) { return errorResult(error); }
}

class WitnessReader {
  constructor(bytes, offset) { this.bytes = bytes; this.offset = offset; }
  take(length, label) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) fail(`signed transaction is truncated at ${label}`);
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  compactSize(label, maximum) {
    const prefix = this.take(1, label)[0];
    let value;
    if (prefix < 0xfd) value = BigInt(prefix);
    else if (prefix === 0xfd) {
      value = BigInt(this.take(2, label).readUInt16LE(0));
      if (value < 0xfdn) fail(`${label} uses non-canonical CompactSize`);
    } else if (prefix === 0xfe) {
      value = BigInt(this.take(4, label).readUInt32LE(0));
      if (value <= 0xffffn) fail(`${label} uses non-canonical CompactSize`);
    } else {
      value = this.take(8, label).readBigUInt64LE(0);
      if (value <= 0xffffffffn) fail(`${label} uses non-canonical CompactSize`);
    }
    if (value > BigInt(maximum)) fail(`${label} exceeds ${maximum}`);
    return Number(value);
  }
}

/**
 * Low-level envelope parser for a store's already-reserved unsigned bytes.
 * It throws on malformed/mismatched bytes and returns no authority status.
 * Call verifyPnlBatchSignedTransaction for independent policy/state checks.
 */
function parsePnlBatchSignedEnvelope(signedTxHex, expectedUnsignedTxHex) {
  const plainHex = snapshotPlainData(signedTxHex, '$.signedTxHex', false);
  const plainUnsigned = snapshotPlainData(expectedUnsignedTxHex, '$.expectedUnsignedTxHex', false);
  rawHex(plainHex, TRANSACTION_PROFILE.maxSignedBytes, 'signedTxHex');
  rawHex(plainUnsigned, TRANSACTION_PROFILE.maxUnsignedBytes, 'expectedUnsignedTxHex');
  const parsed = parseCanonicalUnsignedTransaction(plainUnsigned);
  const outpoints = new Set(parsed.inputs.map(outpointKey));
  if (outpoints.size !== parsed.inputs.length) fail('duplicate expected input outpoint');
  if (parsed.inputs.some((input) => input.txid === '00'.repeat(32) && input.vout === 0xffffffff)) fail('coinbase input is outside the settlement profile');
  if (parsed.outputs.reduce((total, output) => total + output.valueSats, 0n) > MAX_MONEY) fail('total expected output value exceeds Bitcoin MAX_MONEY');
  const bytes = Buffer.from(plainHex, 'hex');
  const unsigned = Buffer.from(plainUnsigned, 'hex');
  if (!bytes.subarray(0, 4).equals(unsigned.subarray(0, 4))) fail('signed transaction version differs from policy');
  if (bytes[4] !== 0 || bytes[5] !== 1) fail('signed transaction must use canonical SegWit marker and flag');
  const expectedBody = unsigned.subarray(4, unsigned.length - 4);
  if (!bytes.subarray(6, 6 + expectedBody.length).equals(expectedBody)) {
    fail('signed transaction inputs or outputs differ from the complete expected unsigned bytes', 'SIGNED_TRANSACTION_MISMATCH');
  }
  // The exact body above already contains the canonical counts, outpoints,
  // empty scriptSigs, sequences, ordered output values and output scripts.
  const reader = new WitnessReader(bytes, 6 + expectedBody.length);
  const witnessItemCounts = [];
  let anyWitness = false;
  for (let input = 0; input < parsed.inputs.length; input++) {
    const itemCount = reader.compactSize(`input ${input} witness item count`, TRANSACTION_PROFILE.maxWitnessItemsPerInput);
    witnessItemCounts.push(itemCount);
    if (itemCount > 0) anyWitness = true;
    for (let item = 0; item < itemCount; item++) {
      const length = reader.compactSize(`input ${input} witness item ${item} length`, TRANSACTION_PROFILE.maxWitnessItemBytes);
      reader.take(length, `input ${input} witness item ${item}`);
    }
  }
  if (!anyWitness) fail('superfluous SegWit encoding has no witness stacks');
  if (!reader.take(4, 'locktime').equals(unsigned.subarray(unsigned.length - 4))) fail('signed transaction locktime differs from policy');
  if (reader.offset !== bytes.length) fail('signed transaction has trailing bytes');
  const rawTransactionSha256 = sha256(bytes).toString('hex');
  const wtxid = Buffer.from(sha256(sha256(bytes))).reverse().toString('hex');
  const weight = unsigned.length * 4 + bytes.length - unsigned.length;
  return snapshotPlainData({ txid: parsed.txid, wtxid, rawTransactionSha256,
    signedTxHex: plainHex, strippedRawTxHex: plainUnsigned,
    size: bytes.length, strippedSize: unsigned.length, weight, vsize: Math.ceil(weight / 4),
    witnessItemCounts }, '$.signedEnvelope', false);
}

function verifyPnlBatchSignedTransaction(signedTxHex, context) {
  try {
    const plainHex = snapshotPlainData(signedTxHex, '$.signedTxHex', false);
    const expected = prepare(snapshotPlainData(context, '$.transactionContext', true), true);
    const envelope = parsePnlBatchSignedEnvelope(plainHex, expected.unsignedTxHex);
    const core = { kind: SIGNED_RECEIPT_KIND, network: expected.network,
      batchHash: expected.batchHash, transactionHash: expected.transactionHash,
      transactionPolicyHash: expected.transactionPolicyHash, statementHash: expected.statementHash,
      ...envelope,
      feeSats: expected.feeSats, transactionBytesVerified: true,
      executionVerified: false, zkProofVerified: false };
    return snapshotPlainData({ ok: true, ...core, receiptHash: digest(SIGNED_RECEIPT_KIND, core) }, '$.signedBytesReceipt', false);
  } catch (error) { return errorResult(error); }
}

module.exports = { POLICY_KIND, TRANSACTION_KIND, STATEMENT_KIND, SIGNED_RECEIPT_KIND,
  TRANSACTION_PROFILE, hashPnlBatchTransactionPolicy, buildPnlBatchTransaction,
  verifyPnlBatchTransaction, parsePnlBatchSignedEnvelope, verifyPnlBatchSignedTransaction };
