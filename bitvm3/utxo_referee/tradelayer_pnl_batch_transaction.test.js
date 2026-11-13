'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { hashPnlSettlementSnapshot, buildPnlSettlementBatch } = require('./tradelayer_pnl_batch_settlement');
const { parseCanonicalUnsignedTransaction, MAX_MONEY } = require('./dlc_transaction_validator');
const { outpoint, serializeUnsignedTx, serializeWitnessTx } = require('./tradelayer_taproot');
const {
  POLICY_KIND, TRANSACTION_PROFILE, hashPnlBatchTransactionPolicy, buildPnlBatchTransaction,
  verifyPnlBatchTransaction, parsePnlBatchSignedEnvelope, verifyPnlBatchSignedTransaction
} = require('./tradelayer_pnl_batch_transaction');

const fixture = require('./artifacts/fixtures/pnl_batch_settlement_v1.snapshot.json');
const copy = (value) => JSON.parse(JSON.stringify(value));

function contextFor(snapshot = copy(fixture), policyOverrides = {}) {
  const batch = buildPnlSettlementBatch(snapshot);
  const transactionPolicy = { kind: POLICY_KIND, network: snapshot.network, version: 2, locktime: 0,
    inputSequences: batch.transaction.inputs.map((input, index) => ({ txid: input.txid, vout: input.vout, sequence: 6 + index })),
    ...policyOverrides };
  return { batch, settlementContext: { snapshot, expectedSnapshotHash: hashPnlSettlementSnapshot(snapshot) }, transactionPolicy };
}

function pinned(context) {
  return { ...context, expectedTransactionPolicyHash: hashPnlBatchTransactionPolicy(context.transactionPolicy) };
}

function unsignedFrom(proposal, mutate = (value) => value) {
  const data = mutate(copy(proposal));
  return serializeUnsignedTx(data.version,
    data.prevouts.map((input) => ({ outpoint: outpoint(input.txid, input.vout), sequence: input.sequence })),
    data.outputs.map((output) => ({ valueSats: BigInt(output.sats), script: output.scriptPubKey })), data.locktime);
}

function signedFrom(proposal, witnesses = proposal.prevouts.map(() => ['11'.repeat(64)]), mutate = (value) => value) {
  const data = mutate(copy(proposal));
  return serializeWitnessTx(data.version,
    data.prevouts.map((input, index) => ({ outpoint: outpoint(input.txid, input.vout), sequence: input.sequence, witness: witnesses[index] })),
    data.outputs.map((output) => ({ valueSats: BigInt(output.sats), script: output.scriptPubKey })), data.locktime);
}

test('serializes the exact ordered inputs, outputs, policy and 1000-sat fee', () => {
  const context = contextFor();
  const proposal = buildPnlBatchTransaction(context);
  const check = verifyPnlBatchTransaction(proposal, pinned(context));
  assert.equal(check.ok, true, check.reason);
  assert.equal(check.transaction.unsignedTxHex, proposal.unsignedTxHex);
  assert.equal(check.transaction.transactionHash, proposal.transactionHash);
  const parsed = parseCanonicalUnsignedTransaction(proposal.unsignedTxHex);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.locktime, 0);
  assert.deepEqual(parsed.inputs.map((input) => input.sequence), [6, 7]);
  assert.deepEqual(parsed.inputs.map(({ txid, vout }) => ({ txid, vout })),
    proposal.prevouts.map(({ txid, vout }) => ({ txid, vout })));
  assert.deepEqual(parsed.outputs.map((output) => output.valueSats.toString()), ['4000', '99500', '110500']);
  assert.equal(proposal.feeSats, '1000');
  assert.equal(proposal.transactionBytesVerified, true);
  assert.equal(proposal.executionVerified, false);
  assert.equal(proposal.zkProofVerified, false);
  assert(Object.isFrozen(proposal.prevouts[0]));
});

test('requires the independent economic and transaction-policy pins', () => {
  const context = contextFor();
  const proposal = buildPnlBatchTransaction(context);
  assert.equal(verifyPnlBatchTransaction(proposal, context).ok, false);
  assert.equal(verifyPnlBatchTransaction(proposal, { ...pinned(context), expectedTransactionPolicyHash: '00'.repeat(32) }).ok, false);
  const badEconomic = copy(pinned(context));
  badEconomic.settlementContext.expectedSnapshotHash = '00'.repeat(32);
  assert.equal(verifyPnlBatchTransaction(proposal, badEconomic).ok, false);
  const flagsOnly = { transactionBytesVerified: true, executionVerified: true };
  assert.equal(verifyPnlBatchTransaction(proposal, flagsOnly).ok, false);
});

test('policy hash commits network, version, locktime and each input sequence', () => {
  const policy = contextFor().transactionPolicy;
  const hash = hashPnlBatchTransactionPolicy(policy);
  for (const modify of [
    (p) => { p.network = 'bitcoin-testnet4'; },
    (p) => { p.version = 3; },
    (p) => { p.locktime = 100; },
    (p) => { p.inputSequences[0].sequence++; },
    (p) => { p.inputSequences[0].vout++; },
    (p) => { p.inputSequences[0].txid = 'cc'.repeat(32); }
  ]) {
    const changed = copy(policy); modify(changed);
    assert.notEqual(hashPnlBatchTransactionPolicy(changed), hash);
  }
  const reordered = copy(policy); reordered.inputSequences.reverse();
  assert.equal(hashPnlBatchTransactionPolicy(reordered), hash);
});

test('supports explicitly pinned version 3 and enabled nonzero locktime as proposal bytes', () => {
  const context = contextFor(copy(fixture), { version: 3, locktime: 100 });
  const proposal = buildPnlBatchTransaction(context);
  assert.equal(verifyPnlBatchTransaction(proposal, pinned(context)).ok, true);
  assert.equal(parseCanonicalUnsignedTransaction(proposal.unsignedTxHex).locktime, 100);
  assert.equal(proposal.executionVerified, false);
});

test('rejects unsupported versions, disabled locktime and invalid integer encodings', () => {
  for (const version of [1, 4, -1, 4294967296, '02']) {
    assert.throws(() => buildPnlBatchTransaction(contextFor(copy(fixture), { version })), /version|uint32/);
  }
  const context = contextFor(copy(fixture), { locktime: 1 });
  context.transactionPolicy.inputSequences.forEach((row) => { row.sequence = 0xffffffff; });
  assert.throws(() => buildPnlBatchTransaction(context), /locktime is disabled/);
});

test('rejects policy outpoint duplication, missing sequences and unrelated inputs', () => {
  for (const modify of [
    (p) => { p.inputSequences[1] = copy(p.inputSequences[0]); },
    (p) => { p.inputSequences.pop(); },
    (p) => { p.inputSequences[1].txid = 'cc'.repeat(32); }
  ]) {
    const context = contextFor(); modify(context.transactionPolicy);
    assert.throws(() => buildPnlBatchTransaction(context), /duplicate|mismatch/);
  }
});

test('rejects changes to complete outpoints, ordering, sequences, version and locktime', () => {
  const context = contextFor();
  const proposal = buildPnlBatchTransaction(context);
  for (const modify of [
    (p) => { p.prevouts[0].txid = 'cc'.repeat(32); return p; },
    (p) => { p.prevouts[0].vout++; return p; },
    (p) => { p.prevouts.reverse(); return p; },
    (p) => { p.prevouts[1] = copy(p.prevouts[0]); return p; },
    (p) => { p.prevouts[0].sequence++; return p; },
    (p) => { p.version = 3; return p; },
    (p) => { p.locktime = 100; return p; }
  ]) {
    const candidate = { ...proposal, unsignedTxHex: unsignedFrom(proposal, modify) };
    assert.equal(verifyPnlBatchTransaction(candidate, pinned(context)).ok, false);
  }
});

test('rejects extra, omitted, reordered and redirected outputs', () => {
  const context = contextFor();
  const proposal = buildPnlBatchTransaction(context);
  for (const modify of [
    (p) => { p.outputs.push(copy(p.outputs[0])); return p; },
    (p) => { p.outputs.pop(); return p; },
    (p) => { p.outputs.reverse(); return p; },
    (p) => { p.outputs[0].scriptPubKey = `0014${'44'.repeat(20)}`; return p; },
    (p) => { p.outputs[0].sats = '4001'; return p; }
  ]) {
    assert.equal(verifyPnlBatchTransaction({ ...proposal, unsignedTxHex: unsignedFrom(proposal, modify) }, pinned(context)).ok, false);
  }
});

test('rejects wrong declared prevout values/scripts and fee even with correct transaction bytes', () => {
  const context = contextFor();
  const proposal = buildPnlBatchTransaction(context);
  for (const modify of [
    (p) => { p.prevouts[0].sats = '110001'; },
    (p) => { p.prevouts[0].scriptPubKey = `5120${'44'.repeat(32)}`; },
    (p) => { p.feeSats = '0'; },
    (p) => { p.txid = '00'.repeat(32); },
    (p) => { p.transactionBytesVerified = false; },
    (p) => { p.executionVerified = true; }
  ]) {
    const candidate = copy(proposal); modify(candidate);
    assert.equal(verifyPnlBatchTransaction(candidate, pinned(context)).ok, false);
  }
});

test('network binds the receipt context even though raw transaction bytes omit it', () => {
  const context = contextFor();
  const proposal = buildPnlBatchTransaction(context);
  assert.equal(verifyPnlBatchTransaction({ ...proposal, network: 'bitcoin-testnet4' }, pinned(context)).ok, false);
  context.transactionPolicy.network = 'bitcoin-testnet4';
  assert.throws(() => buildPnlBatchTransaction(context), /network differs/);
  assert.throws(() => hashPnlBatchTransactionPolicy({ ...context.transactionPolicy, network: 'litecoin-testnet' }), /Bitcoin networks only/);
});

test('rejects noncanonical CompactSize, malformed lowercase hex and trailing bytes', () => {
  const context = contextFor();
  const proposal = buildPnlBatchTransaction(context);
  const tx = proposal.unsignedTxHex;
  for (const malformed of [
    `${tx.slice(0, 8)}fd0200${tx.slice(10)}`, tx.toUpperCase(), `${tx}00`, tx.slice(0, -2),
    `${tx}z0`, '0', '00'.repeat(TRANSACTION_PROFILE.maxUnsignedBytes + 1)
  ]) assert.equal(verifyPnlBatchTransaction({ ...proposal, unsignedTxHex: malformed }, pinned(context)).ok, false);
});

test('enforces total Bitcoin money bounds even when each declared input is in range', () => {
  const snapshot = copy(fixture);
  snapshot.vaults[0].utxos[0].sats = MAX_MONEY.toString();
  snapshot.vaults[1].utxos[0].sats = MAX_MONEY.toString();
  const context = contextFor(snapshot);
  assert.throws(() => buildPnlBatchTransaction(context), /total declared input value exceeds/);
});

test('rejects batches beyond the input and serialized-byte profile', () => {
  const snapshot = copy(fixture);
  const original = snapshot.vaults[0].utxos[0];
  snapshot.vaults[0].utxos = Array.from({ length: 16 }, (_, index) => ({ ...original, vout: index, sats: index === 0 ? '109985' : '1' }));
  const context = contextFor(snapshot);
  assert.throws(() => buildPnlBatchTransaction(context), /1\.\.16/);
  const small = contextFor();
  const proposal = buildPnlBatchTransaction(small);
  assert.equal(verifyPnlBatchSignedTransaction('00'.repeat(TRANSACTION_PROFILE.maxSignedBytes + 1), pinned(small)).ok, false);
  const oversize = copy(fixture);
  oversize.accounts[1].payoutScriptPubKey = '51'.repeat(10000);
  // Ten extra zero-equity accounts withdrawing tiny credited profits create
  // more than 100 kB of exact output scripts while still fitting the relation.
  for (let index = 0; index < 11; index++) {
    oversize.accounts.push({ ...copy(oversize.accounts[1]), id: `extra-${index}`, equitySats: '0', payoutSats: '1' });
    oversize.obligations.push({ ...copy(oversize.obligations[0]), id: `extra-close-${index}`, toAccountId: `extra-${index}`, sats: '1' });
    oversize.routes.push({ fromVaultId: 'A', toOutputId: `payout:extra-${index}`, capacitySats: '1' });
  }
  assert.throws(() => buildPnlBatchTransaction(contextFor(oversize)), /bounded canonical lowercase hex/);
  assert.equal(proposal.executionVerified, false);
});

test('rejects accounting-only cycles and scripts outside the unsigned parser profile', () => {
  const context = contextFor();
  const smallScript = copy(fixture);
  smallScript.accounts[1].payoutScriptPubKey = '51';
  assert.throws(() => buildPnlBatchTransaction(contextFor(smallScript)), /at least two bytes/);
  const empty = copy(fixture);
  empty.accounts = []; empty.obligations = []; empty.routes = [];
  empty.vaults.forEach((vault) => { vault.utxos = []; vault.feeSats = '0'; });
  const accounting = contextFor(empty, { inputSequences: context.transactionPolicy.inputSequences });
  assert.throws(() => buildPnlBatchTransaction(accounting), /accounting-only/);
});

test('verifies opaque generic SegWit bytes while leaving witness execution unverified', () => {
  const context = contextFor();
  const proposal = buildPnlBatchTransaction(context);
  const signedTxHex = signedFrom(proposal);
  const receipt = verifyPnlBatchSignedTransaction(signedTxHex, pinned(context));
  assert.equal(receipt.ok, true, receipt.reason);
  assert.equal(receipt.strippedRawTxHex, proposal.unsignedTxHex);
  assert.equal(receipt.txid, proposal.txid);
  const bytes = Buffer.from(signedTxHex, 'hex');
  const sha = (value) => crypto.createHash('sha256').update(value).digest();
  assert.equal(receipt.wtxid, Buffer.from(sha(sha(bytes))).reverse().toString('hex'));
  assert.equal(receipt.rawTransactionSha256, sha(bytes).toString('hex'));
  assert.equal(receipt.weight, proposal.size * 4 + bytes.length - proposal.size);
  assert.equal(receipt.vsize, Math.ceil(receipt.weight / 4));
  assert.equal(receipt.transactionBytesVerified, true);
  assert.equal(receipt.executionVerified, false);
  assert.equal(receipt.zkProofVerified, false);
  assert.deepEqual(receipt.witnessItemCounts, [1, 1]);
});

test('supports arbitrary bounded witness stack shapes and empty items without validating signatures', () => {
  const context = contextFor();
  const proposal = buildPnlBatchTransaction(context);
  for (const stacks of [[[''], []], [['11'.repeat(64), '51', '22'.repeat(33)], ['33', '44']]]) {
    const result = verifyPnlBatchSignedTransaction(signedFrom(proposal, stacks), pinned(context));
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.executionVerified, false);
  }
});

test('signed verification independently rebuilds the source instead of trusting a verified flag', () => {
  const context = contextFor();
  const proposal = buildPnlBatchTransaction(context);
  const signed = signedFrom(proposal);
  assert.equal(verifyPnlBatchSignedTransaction(signed, proposal).ok, false);
  assert.equal(verifyPnlBatchSignedTransaction(signed, { transactionBytesVerified: true }).ok, false);
  const forged = copy(pinned(context));
  forged.batch.transaction.outputs[0].sats = '4001';
  assert.equal(verifyPnlBatchSignedTransaction(signed, forged).ok, false);
  assert.equal(verifyPnlBatchSignedTransaction(signed, { ...pinned(context), expectedTransactionPolicyHash: '00'.repeat(32) }).ok, false);
});

test('rejects signed transaction mutation of every bound financial field', () => {
  const context = contextFor();
  const proposal = buildPnlBatchTransaction(context);
  for (const modify of [
    (p) => { p.version = 3; return p; },
    (p) => { p.locktime = 1; return p; },
    (p) => { p.prevouts.reverse(); return p; },
    (p) => { p.prevouts[0].vout++; return p; },
    (p) => { p.prevouts[0].sequence++; return p; },
    (p) => { p.outputs.reverse(); return p; },
    (p) => { p.outputs[0].sats = '4001'; return p; },
    (p) => { p.outputs[0].scriptPubKey = '0014' + '44'.repeat(20); return p; }
  ]) assert.equal(verifyPnlBatchSignedTransaction(signedFrom(proposal, undefined, modify), pinned(context)).ok, false);
});

test('rejects malformed or superfluous SegWit envelopes and witness encodings', () => {
  const context = contextFor();
  const proposal = buildPnlBatchTransaction(context);
  const signed = signedFrom(proposal);
  const witnessOffset = 12 + proposal.unsignedTxHex.length - 16;
  const malformed = [
    proposal.unsignedTxHex, `${signed.slice(0, 10)}02${signed.slice(12)}`,
    signedFrom(proposal, [[], []]), `${signed}00`, signed.slice(0, -2),
    `${signed.slice(0, witnessOffset)}fd0100${signed.slice(witnessOffset + 2)}`,
    `${signed.slice(0, witnessOffset + 2)}fd4000${signed.slice(witnessOffset + 4)}`,
    `${signed.slice(0, witnessOffset)}81${signed.slice(witnessOffset + 2)}`,
    `${signed.slice(0, witnessOffset + 2)}fd1127${signed.slice(witnessOffset + 4)}`
  ];
  for (const value of malformed) assert.equal(verifyPnlBatchSignedTransaction(value, pinned(context)).ok, false);
});

test('rejects getter, Proxy, toJSON and inherited-hook execution at all public boundaries', () => {
  let sideEffects = 0;
  const context = contextFor();
  const proposal = buildPnlBatchTransaction(context);
  const candidate = copy(proposal);
  Object.defineProperty(candidate, 'unsignedTxHex', { enumerable: true, get() { sideEffects++; return proposal.unsignedTxHex; } });
  assert.equal(verifyPnlBatchTransaction(candidate, pinned(context)).ok, false);
  const policy = copy(context.transactionPolicy);
  Object.defineProperty(policy, 'version', { enumerable: true, get() { sideEffects++; return 2; } });
  assert.throws(() => hashPnlBatchTransactionPolicy(policy), /data property/);
  const traps = { get() { sideEffects++; throw new Error('proxy get'); }, ownKeys() { sideEffects++; throw new Error('proxy keys'); } };
  assert.throws(() => buildPnlBatchTransaction(new Proxy(context, traps)), /Proxy/);
  assert.equal(verifyPnlBatchSignedTransaction(signedFrom(proposal), new Proxy(pinned(context), traps)).ok, false);
  assert.equal(verifyPnlBatchTransaction({ ...proposal, toJSON() { sideEffects++; return proposal; } }, pinned(context)).ok, false);
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'unsignedTxHex');
  try {
    Object.defineProperty(Object.prototype, 'unsignedTxHex', { configurable: true, get() { sideEffects++; return proposal.unsignedTxHex; } });
    assert.equal(verifyPnlBatchTransaction({}, pinned(context)).ok, false);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'unsignedTxHex', previous);
    else delete Object.prototype.unsignedTxHex;
  }
  assert.equal(sideEffects, 0);
});

test('preserves exact BigInt source amounts while rejecting extra receipt/context fields', () => {
  const snapshot = copy(fixture);
  snapshot.epochId = 1n;
  snapshot.vaults[0].utxos[0].sats = 110000n;
  const context = contextFor(snapshot);
  const proposal = buildPnlBatchTransaction(context);
  assert.equal(verifyPnlBatchTransaction(proposal, pinned(context)).ok, true);
  assert.equal(verifyPnlBatchTransaction({ ...proposal, executionProof: 'claimed' }, pinned(context)).ok, false);
  assert.equal(verifyPnlBatchTransaction(proposal, { ...pinned(context), allowWrongOutputs: true }).ok, false);
});

test('low-level signed parser binds persisted expected bytes without returning authority flags', () => {
  const context = contextFor();
  const proposal = buildPnlBatchTransaction(context);
  const signed = signedFrom(proposal);
  const parsed = parsePnlBatchSignedEnvelope(signed, proposal.unsignedTxHex);
  assert.equal(parsed.txid, proposal.txid);
  assert.equal(parsed.strippedRawTxHex, proposal.unsignedTxHex);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'ok'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'executionVerified'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'transactionBytesVerified'), false);
  assert.throws(() => parsePnlBatchSignedEnvelope(signed, unsignedFrom(proposal, (p) => {
    p.prevouts[0].sequence++; return p;
  })), /expected unsigned bytes/);
  const duplicate = copy(proposal);
  duplicate.prevouts[1] = copy(duplicate.prevouts[0]);
  assert.throws(() => parsePnlBatchSignedEnvelope(signedFrom(duplicate), unsignedFrom(duplicate)), /duplicate expected input/);
});

test('rejects an economic batch with more than 1000 ordered outputs', () => {
  const snapshot = copy(fixture);
  for (let index = 0; index < 1000; index++) {
    snapshot.accounts.push({ ...copy(snapshot.accounts[1]), id: `extra-${index}`, equitySats: '0', payoutSats: '1' });
    snapshot.obligations.push({ ...copy(snapshot.obligations[0]), id: `extra-close-${index}`, toAccountId: `extra-${index}`, sats: '1' });
    snapshot.routes.push({ fromVaultId: 'A', toOutputId: `payout:extra-${index}`, capacitySats: '1' });
  }
  assert.throws(() => buildPnlBatchTransaction(contextFor(snapshot)), /1\.\.1000 outputs/);
});

test('reports malformed and semantic failures without invoking inherited error code accessors', () => {
  const context = contextFor();
  const proposal = buildPnlBatchTransaction(context);
  const verificationContext = pinned(context);
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'code');
  let sideEffects = 0;
  try {
    Object.defineProperty(Object.prototype, 'code', { configurable: true,
      get() { sideEffects++; throw new Error('inherited error getter executed'); },
      set() { sideEffects++; throw new Error('inherited error setter executed'); } });
    const malformed = verifyPnlBatchTransaction(null, {});
    assert.equal(malformed.ok, false);
    assert.equal(malformed.code, 'INVALID_TRANSACTION');
    const semantic = verifyPnlBatchTransaction({ ...proposal, feeSats: '0' }, verificationContext);
    assert.equal(semantic.ok, false);
    assert.equal(semantic.code, 'TRANSACTION_MISMATCH');
    const signed = verifyPnlBatchSignedTransaction('00', verificationContext);
    assert.equal(signed.ok, false);
    assert.equal(signed.code, 'INVALID_TRANSACTION');
    assert.equal(sideEffects, 0);
  } finally {
    if (original) Object.defineProperty(Object.prototype, 'code', original);
    else delete Object.prototype.code;
  }
});
