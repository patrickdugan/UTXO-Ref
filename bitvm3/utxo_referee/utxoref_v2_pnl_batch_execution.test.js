'use strict';

// Deterministic capability tests. The synthetic witnesses below exercise the
// guard's control flow; Core signature/consensus execution has its own regtest
// drill. Every RPC result here is explicitly supplied by this test double.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalJson } = require('./dlc_canonical_json');
const { outpoint, serializeWitnessTx } = require('./tradelayer_taproot');
const { ledgerFromSnapshot, hashLedgerState, PnlBatchStateStore } = require('./tradelayer_pnl_batch_state_store');
const { POLICY_KIND, hashPnlBatchTransactionPolicy, parsePnlBatchSignedEnvelope } = require('./tradelayer_pnl_batch_transaction');
const { TRUST_POLICY_KIND, buildSignedPnlBatchCheckpointV2 } = require('./utxoref_v2_pnl_batch_checkpoint');
const { KIND: SETTLEMENT_KIND, buildUtxoRefPnlBatchSettlementV2,
  verifyUtxoRefPnlBatchSettlementV2 } = require('./utxoref_v2_pnl_batch');
const { MAX_ATTEMPTS, btcToSats, signPnlBatchSettlementV2,
  broadcastPnlBatchSettlementV2, confirmPnlBatchSettlementV2 } = require('./utxoref_v2_pnl_batch_execution');

const SOURCE = require('./artifacts/fixtures/pnl_batch_settlement_v1.snapshot.json');
const BOOK = 'bb'.repeat(32);
const copy = (value) => JSON.parse(JSON.stringify(value));
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const blockHash = (height) => sha(`pnl-guard-test-block-${height}`);
const DEFAULT_TAPROOT_SIGNATURE = '22'.repeat(64);
const STRICT_DER_SIGNATURE = '3006020101020101';
const COMPRESSED_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const hash160 = (hex) => crypto.createHash('ripemd160')
  .update(crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest()).digest('hex');
const p2wpkhScript = (pubkey = COMPRESSED_PUBKEY) => `0014${hash160(pubkey)}`;
const KEYS = Array.from({ length: 2 }, () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const der = pair.publicKey.export({ type: 'spki', format: 'der' });
  return { privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    trusted: { keyId: sha(der), publicKeySpki: der.toString('base64') } };
});
const posixTest = (name, fn) => test(name, {
  skip: process.platform === 'win32' ? 'PnL authorization requires POSIX directory fsync; Windows fails closed' : false
}, fn);

function policy() {
  return { kind: TRUST_POLICY_KIND, version: 1, policyId: 'pnl-guard-test-policy',
    network: 'bitcoin-regtest', chainGenesisHash: blockHash(0), contractId: BOOK,
    threshold: 2, maxAgeBlocks: 6, trustedSigners: KEYS.map((key) => ({ ...key.trusted })) };
}

function seal(snapshot, trustPolicy = policy(), metadata = {}) {
  const transactionPolicy = { kind: POLICY_KIND, network: snapshot.network, version: 2, locktime: 0,
    inputSequences: snapshot.vaults.flatMap((vault) => vault.utxos.map(({ txid, vout }) => ({ txid, vout, sequence: 6 }))) };
  const expectedTransactionPolicyHash = hashPnlBatchTransactionPolicy(transactionPolicy);
  const stateEnvelope = buildSignedPnlBatchCheckpointV2({ policyId: trustPolicy.policyId,
    chainGenesisHash: trustPolicy.chainGenesisHash, contractId: trustPolicy.contractId,
    snapshotHeight: 100, snapshotBlockHash: blockHash(100),
    transactionPolicyHash: expectedTransactionPolicyHash, snapshot, ...metadata
  }, { privateKeys: KEYS.map((key) => key.privateKeyPem) });
  const settlement = buildUtxoRefPnlBatchSettlementV2({ stateEnvelope,
    stateVerification: { trustPolicy, expectedPreviousStateRoot: snapshot.previousStateRoot,
      expectedEpochId: snapshot.epochId, currentHeight: stateEnvelope.body.snapshotHeight,
      expectedSnapshotBlockHash: stateEnvelope.body.snapshotBlockHash },
    transactionPolicy, expectedTransactionPolicyHash });
  return { settlement, transactionPolicy, expectedTransactionPolicyHash };
}

function witnessTransaction(proposal, mutate = (value) => value, witnessStacks = null) {
  const transaction = mutate(copy(proposal));
  return serializeWitnessTx(transaction.version,
    transaction.prevouts.map((input, index) => ({ outpoint: outpoint(input.txid, input.vout),
      sequence: input.sequence, witness: witnessStacks === null ? [DEFAULT_TAPROOT_SIGNATURE] : witnessStacks[index] })),
    transaction.outputs.map(({ sats, scriptPubKey }) => ({ valueSats: BigInt(sats), script: scriptPubKey })),
    transaction.locktime);
}

function btc(sats) {
  const value = BigInt(sats);
  return `${value / 100000000n}.${(value % 100000000n).toString().padStart(8, '0')}`;
}

function offlineFixture() {
  const snapshot = copy(SOURCE);
  const ledger = ledgerFromSnapshot(snapshot, { previousEpochId: '0' });
  snapshot.previousStateRoot = hashLedgerState(ledger);
  const trustPolicy = policy();
  const sealed = seal(snapshot, trustPolicy);
  return { ...sealed, context: {
    stateVerification: { trustPolicy, expectedPreviousStateRoot: snapshot.previousStateRoot,
      expectedEpochId: '1', currentHeight: 102, expectedSnapshotBlockHash: blockHash(100) },
    transactionPolicy: sealed.transactionPolicy,
    expectedTransactionPolicyHash: sealed.expectedTransactionPolicyHash
  } };
}

function fixture(t, mutateSnapshot = () => {}) {
  const snapshot = copy(SOURCE);
  mutateSnapshot(snapshot);
  const ledger = ledgerFromSnapshot(snapshot, { previousEpochId: '0' });
  snapshot.previousStateRoot = hashLedgerState(ledger);
  const trustPolicy = policy();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-execution-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new PnlBatchStateStore(path.join(directory, 'books'), BOOK);
  const initial = store.initialize(ledger, { expectedHeadHash: null });
  const result = { snapshot, ledger, trustPolicy, store, initial, directory,
    ...seal(snapshot, trustPolicy), signerCalls: 0,
    executionPolicy: { minFundingConfirmations: 2, minSettlementConfirmations: 2,
      maxFeeSats: '5000', maxFeeRateSatsPerVbyte: 100 } };
  const node = { height: 102, network: 'regtest', sequence: 1, known: null,
    confirmationHeight: null, blocks: new Map(), coins: new Map(), calls: [],
    afterResponse: null, acceptanceChanges: {}, sends: 0 };
  node.hashAt = (height) => node.blocks.has(height) ? node.blocks.get(height) : blockHash(height);
  result.settlement.transaction.prevouts.forEach((prevout) => node.coins.set(`${prevout.txid}:${prevout.vout}`, {
    value: btc(prevout.sats), scriptPubKey: { hex: prevout.scriptPubKey }, confirmations: 10, coinbase: false
  }));
  node.rpc = async (method, params = []) => {
    node.calls.push({ method, params });
    let response;
    if (method === 'getblockchaininfo') response = { chain: node.network, blocks: node.height, bestblockhash: node.hashAt(node.height) };
    else if (method === 'getrawmempool') response = { txids: node.known ? [node.known.txid] : [], mempool_sequence: node.sequence };
    else if (method === 'getblockhash') response = node.hashAt(params[0]);
    else if (method === 'gettxout') {
      const coin = node.coins.get(`${params[0]}:${params[1]}`);
      response = coin ? { bestblock: node.hashAt(node.height), ...copy(coin) } : null;
    } else if (method === 'testmempoolaccept') {
      const signed = parsePnlBatchSignedEnvelope(params[0][0], result.settlement.transaction.unsignedTxHex);
      response = [{ txid: signed.txid, wtxid: signed.wtxid, allowed: true, vsize: signed.vsize,
        fees: { base: btc(result.settlement.transaction.feeSats) }, ...node.acceptanceChanges }];
    } else if (method === 'getrawtransaction') {
      if (!node.known) {
        const error = new Error('No such mempool or blockchain transaction');
        Object.defineProperty(error, 'code', { value: -5 });
        throw error;
      }
      response = { ...node.known };
      if (node.confirmationHeight !== null) {
        response.blockhash = node.hashAt(node.confirmationHeight);
        response.confirmations = node.height - node.confirmationHeight + 1;
      }
    } else if (method === 'getblockheader') {
      response = { height: node.confirmationHeight,
        confirmations: node.height - node.confirmationHeight + 1 };
    } else if (method === 'sendrawtransaction') {
      node.sends++;
      const parsed = parsePnlBatchSignedEnvelope(params[0], result.settlement.transaction.unsignedTxHex);
      node.known = { hex: params[0], txid: parsed.txid, hash: parsed.wtxid };
      node.coins.clear();
      node.sequence++;
      response = parsed.txid;
    } else throw new Error(`unexpected mock RPC: ${method}`);
    return node.afterResponse ? await node.afterResponse(method, params, response) : response;
  };
  result.node = node;
  result.signer = async (request) => {
    result.signerCalls++;
    assert.equal(request.unsignedTxHex, result.settlement.transaction.unsignedTxHex);
    return witnessTransaction(result.settlement.transaction);
  };
  result.args = (expectedHeadHash = initial.headHash, signing = true) => ({
    settlement: result.settlement, trustPolicy: result.trustPolicy,
    transactionPolicy: result.transactionPolicy, expectedTransactionPolicyHash: result.expectedTransactionPolicyHash,
    executionPolicy: result.executionPolicy, store, expectedHeadHash, rpc: node.rpc,
    ...(signing ? { signer: result.signer } : {})
  });
  return result;
}

async function signedFixture(t) {
  const data = fixture(t);
  data.signed = await signPnlBatchSettlementV2(data.args());
  return data;
}

async function broadcastFixture(t) {
  const data = await signedFixture(t);
  await broadcastPnlBatchSettlementV2(data.args(data.signed.headHash, false));
  return data;
}

function mine(data, tipHeight = 104, transactionHeight = 103) {
  data.node.height = tipHeight;
  data.node.confirmationHeight = transactionHeight;
  data.node.sequence++;
}

function p2wpkhFixture(t, pubkey = COMPRESSED_PUBKEY) {
  return fixture(t, (snapshot) => { snapshot.vaults[0].utxos[0].scriptPubKey = p2wpkhScript(pubkey); });
}

function withWitnesses(data, stacks) {
  return witnessTransaction(data.settlement.transaction, (transaction) => transaction, stacks);
}

async function assertRejectedSignerResult(data, result, pattern) {
  data.signer = async () => { data.signerCalls++; return result; };
  let reservedHead;
  await assert.rejects(signPnlBatchSettlementV2(data.args()), (error) => {
    assert.match(error.message, pattern);
    assert.match(error.headHash, /^[0-9a-f]{64}$/);
    reservedHead = error.headHash;
    return true;
  });
  const state = data.store.read({ expectedHeadHash: reservedHead });
  assert.equal(data.signerCalls, 1);
  assert.equal(state.pending.status, 'RESERVED_BEFORE_SIGN');
  assert.equal(state.pending.txid, data.settlement.transaction.txid);
  assert.equal(state.pending.signedTxHex, null);
  assert.equal(state.signingTombstones.length, 1);
  assert.equal(state.ledgerHash, data.initial.ledgerHash);
  assert.equal(data.node.calls.filter((call) => call.method === 'testmempoolaccept').length, 0);
  await assert.rejects(broadcastPnlBatchSettlementV2(data.args(state.headHash, false)), /durably stored signed bytes/);
  assert.equal(data.node.sends, 0);
}

test('converts bounded Core decimal values to exact satoshis and rejects sub-satoshi input', () => {
  assert.equal(btcToSats('0.00000001', 'amount'), 1n);
  assert.equal(btcToSats(0.00000001, 'amount'), 1n);
  assert.equal(btcToSats('21000000.00000000', 'amount'), 2100000000000000n);
  for (const value of [-0, -1, Infinity, NaN, 0.000000001, '1.000000001', '01', '1e-8', '21000000.00000001']) {
    assert.throws(() => btcToSats(value, 'amount'));
  }
});

test('offline V2 composition verifies authentication and exact bytes while leaving execution open', () => {
  const data = offlineFixture();
  const result = verifyUtxoRefPnlBatchSettlementV2(data.settlement, data.context);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.stateAuthenticated, true);
  assert.equal(result.transactionBytesVerified, true);
  assert.equal(result.priorStateOpeningVerified, false);
  assert.equal(result.executionVerified, false);
  assert.equal(result.zkProofVerified, false);
  assert.equal(result.settlement.stateEnvelope.body.snapshot.accounts[1].payoutSats, '4000');
});

test('offline V2 verification rejects rehashed accounting or prevout substitutions and missing policy pins', () => {
  const data = offlineFixture();
  for (const mutate of [
    (settlement) => { settlement.batch.accountStates[0].afterEquitySats = '999999'; },
    (settlement) => { settlement.transaction.prevouts[0].sats = '110001'; },
    (settlement) => { settlement.transaction.executionVerified = true; }
  ]) {
    const candidate = copy(data.settlement);
    mutate(candidate);
    const { settlementHash: _oldHash, ...core } = candidate;
    candidate.settlementHash = sha(`${SETTLEMENT_KIND}\0${canonicalJson(core)}`);
    assert.equal(verifyUtxoRefPnlBatchSettlementV2(candidate, data.context).ok, false);
  }
  const missing = copy(data.context);
  delete missing.expectedTransactionPolicyHash;
  assert.equal(verifyUtxoRefPnlBatchSettlementV2(data.settlement, missing).ok, false);
});

test('execution entrypoints reject Proxy and getter arguments before any capability is available', async () => {
  let sideEffects = 0;
  const traps = { get() { sideEffects++; }, ownKeys() { sideEffects++; },
    getOwnPropertyDescriptor() { sideEffects++; }, getPrototypeOf() { sideEffects++; } };
  for (const run of [signPnlBatchSettlementV2, broadcastPnlBatchSettlementV2, confirmPnlBatchSettlementV2]) {
    await assert.rejects(run(new Proxy({}, traps)), /Proxy/);
    const argument = {};
    Object.defineProperty(argument, 'rpc', { enumerable: true,
      get() { sideEffects++; throw new Error('unexpected capability getter'); } });
    await assert.rejects(run(argument), /data property/);
  }
  assert.equal(sideEffects, 0);
});

posixTest('reserves before signer invocation, persists exact signed bytes, and keeps equity pending', async (t) => {
  const data = fixture(t);
  const baseSigner = data.signer;
  data.signer = async (request) => {
    const beforeSignature = data.store.read();
    assert.equal(beforeSignature.pending.status, 'RESERVED_BEFORE_SIGN');
    assert.equal(beforeSignature.pending.unsignedTxHex, request.unsignedTxHex);
    assert.equal(beforeSignature.signingTombstones.length, 1);
    assert.equal(beforeSignature.ledgerHash, data.initial.ledgerHash);
    assert(Object.isFrozen(request) && Object.isFrozen(request.prevouts[0]));
    await Promise.resolve();
    return baseSigner(request);
  };
  const signed = await signPnlBatchSettlementV2(data.args());
  const current = data.store.read({ expectedHeadHash: signed.headHash });
  assert.equal(data.signerCalls, 1);
  assert.equal(current.pending.status, 'SIGNED');
  assert.equal(current.pending.signedTxHex, signed.signedTxHex);
  assert.equal(current.ledger.epochId, '0');
  assert.equal(signed.pendingLedgerHash, current.pending.nextLedgerHash);
  assert.equal(signed.priorStateOpeningVerified, true);
  assert.equal(signed.corePolicyVerified, true);
  assert.equal(signed.executionVerified, false);
  assert.equal(signed.zkProofVerified, false);
  assert.equal(data.node.sends, 0);
});

posixTest('accepts Taproot DEFAULT and explicit SIGHASH_ALL within one signed batch', async (t) => {
  const data = fixture(t);
  data.signer = async () => {
    data.signerCalls++;
    return withWitnesses(data, [[DEFAULT_TAPROOT_SIGNATURE], [`${DEFAULT_TAPROOT_SIGNATURE}01`]]);
  };
  const signed = await signPnlBatchSettlementV2(data.args());
  assert.equal(signed.corePolicyVerified, true);
  assert.equal(data.store.read({ expectedHeadHash: signed.headHash }).pending.status, 'SIGNED');
  assert.equal(data.signerCalls, 1);
  assert.equal(data.node.sends, 0);
});

posixTest('accepts a matching compressed P2WPKH SIGHASH_ALL witness beside a Taproot input', async (t) => {
  const data = p2wpkhFixture(t);
  data.signer = async () => {
    data.signerCalls++;
    return withWitnesses(data, [[`${STRICT_DER_SIGNATURE}01`, COMPRESSED_PUBKEY], [DEFAULT_TAPROOT_SIGNATURE]]);
  };
  const signed = await signPnlBatchSettlementV2(data.args());
  const args = data.args(signed.headHash, false);
  assert.equal((await broadcastPnlBatchSettlementV2(args)).ok, true);
  mine(data);
  const confirmed = await confirmPnlBatchSettlementV2(args);
  assert.equal(confirmed.executionVerified, true);
  assert.equal(data.store.read({ expectedHeadHash: confirmed.headHash }).ledger.epochId, '1');
  assert.equal(data.signerCalls, 1);
  assert.equal(data.node.sends, 1);
});

posixTest('rejects unsupported authenticated funding programs before reserving or calling the signer', async (t) => {
  for (const script of [
    `0020${'44'.repeat(32)}`,
    `a914${'44'.repeat(20)}87`,
    `76a914${'44'.repeat(20)}88ac`,
    `5220${'44'.repeat(32)}`,
    `511f${'44'.repeat(31)}`,
    `0014${'44'.repeat(19)}`
  ]) {
    const data = fixture(t, (snapshot) => { snapshot.vaults[1].utxos[0].scriptPubKey = script; });
    await assert.rejects(signPnlBatchSettlementV2(data.args()), /execution funding profile requires native P2WPKH or P2TR/);
    const state = data.store.read({ expectedHeadHash: data.initial.headHash });
    assert.equal(state.pending, null);
    assert.equal(state.signingTombstones.length, 0);
    assert.equal(data.signerCalls, 0);
    assert.equal(data.node.sends, 0);
    assert.equal(data.node.calls.filter((call) => call.method === 'testmempoolaccept').length, 0);
  }
});

posixTest('rejects Taproot NONE, SINGLE and ANYONECANPAY on a later input while retaining its reservation', async (t) => {
  for (const flag of ['02', '03', '81', '82', '83']) {
    const data = fixture(t);
    await assertRejectedSignerResult(data,
      withWitnesses(data, [[DEFAULT_TAPROOT_SIGNATURE], [`${DEFAULT_TAPROOT_SIGNATURE}${flag}`]]),
      /P2TR signing profile/);
  }
});

posixTest('rejects an explicitly encoded Taproot DEFAULT sighash byte', async (t) => {
  const data = fixture(t);
  await assertRejectedSignerResult(data,
    withWitnesses(data, [[DEFAULT_TAPROOT_SIGNATURE], [`${DEFAULT_TAPROOT_SIGNATURE}00`]]),
    /P2TR signing profile/);
});

posixTest('rejects Taproot signatures with lengths outside its DEFAULT and ALL encodings', async (t) => {
  for (const signature of ['22'.repeat(63), `${'22'.repeat(65)}01`]) {
    const data = fixture(t);
    await assertRejectedSignerResult(data,
      withWitnesses(data, [[DEFAULT_TAPROOT_SIGNATURE], [signature]]), /P2TR signing profile/);
  }
});

posixTest('rejects empty Taproot witnesses, annexes and script-path stacks in the execution profile', async (t) => {
  for (const stack of [
    [],
    [DEFAULT_TAPROOT_SIGNATURE, '50'],
    [DEFAULT_TAPROOT_SIGNATURE, '51', `c0${'11'.repeat(32)}`]
  ]) {
    const data = fixture(t);
    await assertRejectedSignerResult(data,
      withWitnesses(data, [[DEFAULT_TAPROOT_SIGNATURE], stack]), /P2TR signing profile/);
  }
});

posixTest('rejects P2WPKH NONE, SINGLE, ANYONECANPAY and undefined DEFAULT sighashes', async (t) => {
  for (const flag of ['02', '03', '81', '82', '83', '00']) {
    const data = p2wpkhFixture(t);
    await assertRejectedSignerResult(data,
      withWitnesses(data, [[`${STRICT_DER_SIGNATURE}${flag}`, COMPRESSED_PUBKEY], [DEFAULT_TAPROOT_SIGNATURE]]),
      /P2WPKH signing profile/);
  }
});

posixTest('rejects malformed DER and nonminimal or negative ECDSA integers despite an ALL suffix', async (t) => {
  for (const signature of [
    '310602010102010101',
    '300702010102010101',
    '300602018002010101',
    '30070202000102010101',
    '30070201010202000101'
  ]) {
    const data = p2wpkhFixture(t);
    await assertRejectedSignerResult(data,
      withWitnesses(data, [[signature, COMPRESSED_PUBKEY], [DEFAULT_TAPROOT_SIGNATURE]]),
      /P2WPKH signing profile/);
  }
});

posixTest('rejects a compressed P2WPKH pubkey whose HASH160 differs from the authenticated program', async (t) => {
  const data = p2wpkhFixture(t);
  const differentPubkey = `03${COMPRESSED_PUBKEY.slice(2)}`;
  await assertRejectedSignerResult(data,
    withWitnesses(data, [[`${STRICT_DER_SIGNATURE}01`, differentPubkey], [DEFAULT_TAPROOT_SIGNATURE]]),
    /P2WPKH signing pubkey differs/);
});

posixTest('requires compressed 33-byte P2WPKH pubkeys even when another encoding matches the program hash', async (t) => {
  for (const pubkey of [
    `04${COMPRESSED_PUBKEY.slice(2)}${'11'.repeat(32)}`,
    `04${COMPRESSED_PUBKEY.slice(2)}`,
    COMPRESSED_PUBKEY.slice(0, -2)
  ]) {
    const data = p2wpkhFixture(t, pubkey);
    await assertRejectedSignerResult(data,
      withWitnesses(data, [[`${STRICT_DER_SIGNATURE}01`, pubkey], [DEFAULT_TAPROOT_SIGNATURE]]),
      /P2WPKH signing profile/);
  }
});

posixTest('requires exactly two P2WPKH witness items before releasing a signed result', async (t) => {
  for (const stack of [[], [`${STRICT_DER_SIGNATURE}01`], [`${STRICT_DER_SIGNATURE}01`, COMPRESSED_PUBKEY, '00']]) {
    const data = p2wpkhFixture(t);
    await assertRejectedSignerResult(data,
      withWitnesses(data, [stack, [DEFAULT_TAPROOT_SIGNATURE]]), /P2WPKH signing profile/);
  }
});

posixTest('rechecks restrictive sighashes for persisted recovery records before broadcast or confirmation', async (t) => {
  for (const profile of ['P2TR', 'P2WPKH']) {
    const data = profile === 'P2TR' ? fixture(t) : p2wpkhFixture(t);
    data.signer = async () => { data.signerCalls++; throw new Error('fixture interrupted before returning bytes'); };
    await assert.rejects(signPnlBatchSettlementV2(data.args()), /fixture interrupted/);
    const reserved = data.store.read();
    const stacks = profile === 'P2TR'
      ? [[DEFAULT_TAPROOT_SIGNATURE], [`${DEFAULT_TAPROOT_SIGNATURE}83`]]
      : [[`${STRICT_DER_SIGNATURE}02`, COMPRESSED_PUBKEY], [DEFAULT_TAPROOT_SIGNATURE]];
    const signedTxHex = withWitnesses(data, stacks);
    // This generic store operation binds bytes to the reservation. Execution
    // must apply its signature policy again when an older record is recovered.
    const stored = data.store.recordSigned(reserved.headHash, { signedTxHex });
    const parsed = parsePnlBatchSignedEnvelope(signedTxHex, data.settlement.transaction.unsignedTxHex);
    data.node.known = { hex: signedTxHex, txid: parsed.txid, hash: parsed.wtxid };
    mine(data);
    const args = data.args(stored.headHash, false);
    await assert.rejects(broadcastPnlBatchSettlementV2(args), /signing profile/);
    await assert.rejects(confirmPnlBatchSettlementV2(args), /signing profile/);
    const state = data.store.read({ expectedHeadHash: stored.headHash });
    assert.equal(state.pending.status, 'SIGNED');
    assert.equal(state.pending.signedTxHex, signedTxHex);
    assert.equal(state.ledger.epochId, '0');
    assert.equal(state.signingTombstones.length, 1);
    assert.equal(data.node.sends, 0);
    assert.equal(data.node.calls.filter((call) => call.method === 'getrawtransaction').length, 0);
  }
});

posixTest('reads witness stacks from the parsed receipt without consulting inherited getters', async (t) => {
  const data = fixture(t);
  let getterCalls = 0;
  const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'witnessStacks');
  try {
    Object.defineProperty(Object.prototype, 'witnessStacks', { configurable: true,
      get() { getterCalls++; throw new Error('inherited witness stacks'); } });
    const signed = await signPnlBatchSettlementV2(data.args());
    assert.equal(signed.corePolicyVerified, true);
    assert.equal(getterCalls, 0);
  } finally {
    if (prior) Object.defineProperty(Object.prototype, 'witnessStacks', prior);
    else delete Object.prototype.witnessStacks;
  }
});

posixTest('rejects counterfeit signer objects before invoking own or inherited witness getters', async (t) => {
  let getterCalls = 0;
  for (const inherited of [false, true]) {
    const source = {};
    Object.defineProperty(source, 'witnessStacks', { enumerable: true,
      get() { getterCalls++; throw new Error('counterfeit witness stacks'); } });
    const result = inherited ? Object.create(source) : source;
    const data = fixture(t);
    await assertRejectedSignerResult(data, result, /signed batch rejected/);
    assert.equal(getterCalls, 0);
  }
});

posixTest('broadcasts only persisted bytes, handles an already-known transaction and commits exact residuals', async (t) => {
  const data = await signedFixture(t);
  const args = data.args(data.signed.headHash, false);
  const broadcast = await broadcastPnlBatchSettlementV2(args);
  assert.equal(broadcast.alreadyKnown, false);
  const sent = data.node.calls.find((call) => call.method === 'sendrawtransaction');
  assert.equal(sent.params[0], data.store.read().pending.signedTxHex);
  assert.equal((await broadcastPnlBatchSettlementV2(args)).alreadyKnown, true);
  assert.equal(data.node.sends, 1);
  mine(data);
  const committed = await confirmPnlBatchSettlementV2(args);
  const state = data.store.read({ expectedHeadHash: committed.headHash });
  assert.equal(committed.executionVerified, true);
  assert.equal(committed.productionReady, false);
  assert.equal(committed.zkProofVerified, false);
  assert.equal(state.pending, null);
  assert.equal(state.ledger.epochId, '1');
  assert.equal(state.ledgerHash, data.signed.pendingLedgerHash);
  assert.deepEqual(state.ledger.accounts.map((account) => account.equitySats), ['90000', '106000']);
  assert.deepEqual(state.ledger.vaults.map((vault) => vault.utxos[0].vout), [1, 2]);
  assert(state.ledger.vaults.every((vault) => vault.utxos[0].txid === data.signed.txid));
  assert.equal(state.signingTombstones.length, 1);
});

posixTest('a signer failure leaves a restart-visible reservation and blocks another signing attempt', async (t) => {
  const data = fixture(t);
  data.signer = async () => { data.signerCalls++; await Promise.resolve(); throw new Error('signer disconnected'); };
  await assert.rejects(signPnlBatchSettlementV2(data.args()), (error) => {
    assert.match(error.message, /signer disconnected/);
    assert.match(error.headHash, /^[0-9a-f]{64}$/);
    return true;
  });
  const restarted = new PnlBatchStateStore(data.store.baseDirectory, BOOK);
  const state = restarted.read();
  assert.equal(state.pending.status, 'RESERVED_BEFORE_SIGN');
  assert.equal(state.signingTombstones.length, 1);
  await assert.rejects(signPnlBatchSettlementV2(data.args(state.headHash)), /unresolved signing reservation/);
  assert.equal(data.signerCalls, 1);
  assert.equal(data.node.sends, 0);
});

posixTest('rejects signing replay and stale external heads before another signer can run', async (t) => {
  const data = await signedFixture(t);
  await assert.rejects(signPnlBatchSettlementV2(data.args()), /independent expected head/);
  await assert.rejects(signPnlBatchSettlementV2(data.args(data.signed.headHash)), /unresolved signing reservation/);
  await assert.rejects(broadcastPnlBatchSettlementV2(data.args(data.initial.headHash, false)), /independent expected head/);
  assert.equal(data.signerCalls, 1);
  assert.equal(data.node.sends, 0);
});

posixTest('requires a branded store for the independently selected contract book', async (t) => {
  const data = fixture(t);
  const fake = Object.create(PnlBatchStateStore.prototype);
  await assert.rejects(signPnlBatchSettlementV2({ ...data.args(), store: fake }), /live branded/);
  const different = new PnlBatchStateStore(data.store.baseDirectory, 'cc'.repeat(32));
  const otherHead = different.initialize(data.ledger, { expectedHeadHash: null });
  await assert.rejects(signPnlBatchSettlementV2({ ...data.args(otherHead.headHash), store: different }), /book differs/);
  assert.equal(data.signerCalls, 0);
  assert.equal(data.node.calls.length, 0);
});

posixTest('rejects altered prior balances even under a valid quorum and matching root label', async (t) => {
  const data = fixture(t);
  const changed = copy(data.snapshot);
  changed.accounts[0].equitySats = '100001';
  Object.assign(data, seal(changed, data.trustPolicy));
  await assert.rejects(signPnlBatchSettlementV2(data.args()), /changes prior balances/);
  assert.equal(data.store.read().headHash, data.initial.headHash);
  assert.equal(data.signerCalls, 0);
});

posixTest('requires independently trusted checkpoint signatures and the signed transaction policy', async (t) => {
  const data = fixture(t);
  const unauthorized = data.args();
  unauthorized.trustPolicy = { ...data.trustPolicy, trustedSigners: [] };
  await assert.rejects(signPnlBatchSettlementV2(unauthorized), /trustedSigners/);
  await assert.rejects(signPnlBatchSettlementV2({ ...data.args(), expectedTransactionPolicyHash: 'ff'.repeat(32) }), /policy/);
  assert.equal(data.signerCalls, 0);
  assert.equal(data.store.read().headHash, data.initial.headHash);
});

posixTest('checks Core network, trusted genesis and active snapshot block before reserving', async (t) => {
  for (const mutate of [
    (data) => { data.node.network = 'main'; },
    (data) => { data.node.blocks.set(0, 'ff'.repeat(32)); },
    (data) => { data.node.blocks.set(100, 'ff'.repeat(32)); }
  ]) {
    const data = fixture(t); mutate(data);
    await assert.rejects(signPnlBatchSettlementV2(data.args()), /chain differs|genesis differs|active block/);
    assert.equal(data.signerCalls, 0);
    assert.equal(data.store.read().headHash, data.initial.headHash);
  }
});

posixTest('rejects missing, underconfirmed, wrong-amount, wrong-script and immature funding', async (t) => {
  const mutations = [
    (data, key) => { data.node.coins.delete(key); },
    (data, key) => { data.node.coins.get(key).confirmations = 1; },
    (data, key) => { data.node.coins.get(key).value = '0.00110001'; },
    (data, key) => { data.node.coins.get(key).scriptPubKey.hex = `0014${'44'.repeat(20)}`; },
    (data, key) => { data.node.coins.get(key).coinbase = true; data.node.coins.get(key).confirmations = 99; }
  ];
  for (const mutate of mutations) {
    const data = fixture(t);
    const key = data.node.coins.keys().next().value;
    mutate(data, key);
    await assert.rejects(signPnlBatchSettlementV2(data.args()), /unavailable|confirmations|funding amount|funding script|immature/);
    assert.equal(data.signerCalls, 0);
    assert.equal(data.store.read().headHash, data.initial.headHash);
  }
});

posixTest('rejects funding observations from a different best block', async (t) => {
  const data = fixture(t);
  data.node.afterResponse = async (method, _params, response) => method === 'gettxout'
    ? { ...response, bestblock: 'ff'.repeat(32) } : response;
  await assert.rejects(signPnlBatchSettlementV2(data.args()), /crossed chain tips/);
  assert.equal(data.signerCalls, 0);
});

posixTest('checks checkpoint age before issuing new signing authority', async (t) => {
  const data = fixture(t);
  data.node.height = 107;
  await assert.rejects(signPnlBatchSettlementV2(data.args()), /freshness limit/);
  assert.equal(data.signerCalls, 0);
  assert.equal(data.store.read().pending, null);
});

posixTest('retries a changing tip and fails closed when every funding view crosses mempool sequences', async (t) => {
  const transient = fixture(t);
  let tipReads = 0;
  transient.node.afterResponse = async (method, _params, response) => {
    if (method === 'getblockchaininfo' && ++tipReads === 2) {
      transient.node.height++;
      return { ...response, blocks: transient.node.height, bestblockhash: transient.node.hashAt(transient.node.height) };
    }
    return response;
  };
  assert.equal((await signPnlBatchSettlementV2(transient.args())).ok, true);
  assert.equal(transient.signerCalls, 1);
  assert(tipReads >= 6);
  const unstable = fixture(t);
  unstable.node.afterResponse = async (method, _params, response) => method === 'getrawmempool'
    ? { ...response, mempool_sequence: unstable.node.sequence++ } : response;
  await assert.rejects(signPnlBatchSettlementV2(unstable.args()), /changed throughout funding validation/);
  assert.equal(unstable.signerCalls, 0);
  assert.equal(unstable.node.calls.filter((call) => call.method === 'getrawmempool').length, MAX_ATTEMPTS * 2);
});

posixTest('enforces total fee before signing and fee rate before releasing the result', async (t) => {
  const excessiveFee = fixture(t);
  excessiveFee.executionPolicy.maxFeeSats = '999';
  await assert.rejects(signPnlBatchSettlementV2(excessiveFee.args()), /batch fee exceeds/);
  assert.equal(excessiveFee.signerCalls, 0);
  const excessiveRate = fixture(t);
  excessiveRate.executionPolicy.maxFeeRateSatsPerVbyte = 1;
  await assert.rejects(signPnlBatchSettlementV2(excessiveRate.args()), /fee rate exceeds/);
  assert.equal(excessiveRate.signerCalls, 1);
  assert.equal(excessiveRate.store.read().pending.status, 'RESERVED_BEFORE_SIGN');
});

posixTest('rejects changed signer output while retaining the original signing tombstone', async (t) => {
  const data = fixture(t);
  data.signer = async () => {
    data.signerCalls++;
    return witnessTransaction(data.settlement.transaction, (transaction) => {
      transaction.outputs[0].scriptPubKey = `0014${'44'.repeat(20)}`;
      return transaction;
    });
  };
  await assert.rejects(signPnlBatchSettlementV2(data.args()), /signed batch rejected/);
  const state = data.store.read();
  assert.equal(state.pending.status, 'RESERVED_BEFORE_SIGN');
  assert.equal(state.signingTombstones.length, 1);
  assert.equal(data.node.sends, 0);
});

posixTest('requires Core approval bound to exact txid, wtxid, vsize and actual fee', async (t) => {
  const changes = [
    { allowed: false }, { txid: 'ff'.repeat(32) }, { wtxid: 'ff'.repeat(32) },
    { vsize: 1 }, { fees: { base: '0.00001001' } }
  ];
  for (const change of changes) {
    const data = fixture(t);
    data.node.acceptanceChanges = change;
    await assert.rejects(signPnlBatchSettlementV2(data.args()), /Core/);
    assert.equal(data.signerCalls, 1);
    assert.equal(data.store.read().pending.status, 'SIGNED');
    assert.equal(data.node.sends, 0);
  }
});

posixTest('blocks stale signed-byte release when a freeze happens during awaited post-sign RPC', async (t) => {
  const data = fixture(t);
  let froze = false;
  data.node.afterResponse = async (method, _params, response) => {
    if (!froze && method === 'testmempoolaccept') {
      await Promise.resolve();
      const state = data.store.read();
      data.store.freeze(state.headHash, { reason: 'concurrent recovery stop' });
      froze = true;
    }
    return response;
  };
  await assert.rejects(signPnlBatchSettlementV2(data.args()), /expected head|frozen/);
  assert.equal(froze, true);
  assert.equal(data.store.read().pending.status, 'SIGNED');
  assert.equal(data.store.read().frozen.reason, 'concurrent recovery stop');
  assert.equal(data.node.sends, 0);
});

posixTest('blocks broadcast when a freeze happens during awaited funding validation', async (t) => {
  const data = await signedFixture(t);
  let froze = false;
  data.node.afterResponse = async (method, _params, response) => {
    if (!froze && method === 'testmempoolaccept') {
      await Promise.resolve();
      data.store.freeze(data.signed.headHash, { reason: 'freeze before broadcast dispatch' });
      froze = true;
    }
    return response;
  };
  await assert.rejects(broadcastPnlBatchSettlementV2(data.args(data.signed.headHash, false)), /expected head|frozen/);
  assert.equal(froze, true);
  assert.equal(data.node.sends, 0);
});

posixTest('checks the journal again after an awaited already-known lookup', async (t) => {
  const data = await broadcastFixture(t);
  let froze = false;
  data.node.afterResponse = async (method, _params, response) => {
    if (!froze && method === 'getrawtransaction') {
      await Promise.resolve();
      data.store.freeze(data.signed.headHash, { reason: 'freeze during known lookup' });
      froze = true;
    }
    return response;
  };
  await assert.rejects(broadcastPnlBatchSettlementV2(data.args(data.signed.headHash, false)), /expected head|frozen/);
  assert.equal(data.node.sends, 1);
});

posixTest('keeps exact pending bytes recoverable after a lost broadcast acknowledgement', async (t) => {
  const data = await signedFixture(t);
  let dropped = false;
  data.node.afterResponse = async (method, _params, response) => {
    if (method === 'sendrawtransaction' && !dropped) { dropped = true; throw new Error('connection lost after send'); }
    return response;
  };
  await assert.rejects(broadcastPnlBatchSettlementV2(data.args(data.signed.headHash, false)), /connection lost/);
  assert.equal(data.store.read().pending.signedTxHex, data.signed.signedTxHex);
  assert.equal((await broadcastPnlBatchSettlementV2(data.args(data.signed.headHash, false))).alreadyKnown, true);
  assert.equal(data.node.sends, 1);
});

posixTest('rejects a stale acknowledgement if the book freezes after broadcast dispatch', async (t) => {
  const data = await signedFixture(t);
  data.node.afterResponse = async (method, _params, response) => {
    if (method === 'sendrawtransaction') {
      await Promise.resolve();
      data.store.freeze(data.signed.headHash, { reason: 'freeze while broadcast is in flight' });
    }
    return response;
  };
  await assert.rejects(broadcastPnlBatchSettlementV2(data.args(data.signed.headHash, false)), /expected head|frozen/);
  assert.equal(data.node.sends, 1);
  const state = data.store.read();
  assert.equal(state.pending.status, 'SIGNED');
  assert.equal(state.ledger.epochId, '0');
  assert.match(state.frozen.reason, /in flight/);
});

posixTest('rejects Core acknowledgements and known transactions naming different bytes', async (t) => {
  const acknowledgement = await signedFixture(t);
  acknowledgement.node.afterResponse = async (method, _params, response) => method === 'sendrawtransaction' ? 'ff'.repeat(32) : response;
  await assert.rejects(broadcastPnlBatchSettlementV2(acknowledgement.args(acknowledgement.signed.headHash, false)), /acknowledgement differs/);
  const known = await broadcastFixture(t);
  known.node.known.hash = 'ff'.repeat(32);
  await assert.rejects(broadcastPnlBatchSettlementV2(known.args(known.signed.headHash, false)), /known transaction differs/);
  assert.equal(known.node.sends, 1);
});

posixTest('permits historical recovery only for the original persisted checkpoint and bytes', async (t) => {
  const data = await signedFixture(t);
  data.node.height = 110;
  assert.equal((await broadcastPnlBatchSettlementV2(data.args(data.signed.headHash, false))).ok, true);
  const replacement = seal(data.snapshot, data.trustPolicy,
    { snapshotHeight: 101, snapshotBlockHash: blockHash(101) });
  await assert.rejects(broadcastPnlBatchSettlementV2({ ...data.args(data.signed.headHash, false),
    settlement: replacement.settlement }), /original persisted reservation/);
  assert.equal(data.node.sends, 1);
});

posixTest('requires signed state before broadcast and confirmation', async (t) => {
  const data = fixture(t);
  await assert.rejects(broadcastPnlBatchSettlementV2(data.args(data.initial.headHash, false)), /durably stored signed bytes/);
  await assert.rejects(confirmPnlBatchSettlementV2(data.args(data.initial.headHash, false)), /pending signed batch/);
  assert.equal(data.node.sends, 0);
});

posixTest('requires exact witnessed bytes and sufficient active-chain confirmations before committing equity', async (t) => {
  const data = await broadcastFixture(t);
  mine(data, 103, 103);
  const args = data.args(data.signed.headHash, false);
  await assert.rejects(confirmPnlBatchSettlementV2(args), /required active-chain confirmations/);
  assert.equal(data.store.read().ledger.epochId, '0');
  data.node.height = 104;
  data.node.known.hex = `${data.node.known.hex.slice(0, -2)}01`;
  await assert.rejects(confirmPnlBatchSettlementV2(args), /confirmed transaction differs/);
  assert.equal(data.store.read().ledger.epochId, '0');
});

posixTest('rejects confirmation observations that disagree on header or active block identity', async (t) => {
  for (const mutation of [
    (method, _params, response) => method === 'getblockheader' ? { ...response, confirmations: 999 } : response,
    (method, params, response) => method === 'getblockhash' && params[0] === 103 ? 'ff'.repeat(32) : response
  ]) {
    const data = await broadcastFixture(t);
    mine(data);
    data.node.afterResponse = async (method, params, response) => mutation(method, params, response);
    await assert.rejects(confirmPnlBatchSettlementV2(data.args(data.signed.headHash, false)), /required active-chain confirmations/);
    assert.equal(data.store.read().ledger.epochId, '0');
  }
});

posixTest('a freeze during confirmation prevents CAS from committing the pending ledger', async (t) => {
  const data = await broadcastFixture(t);
  mine(data);
  let froze = false;
  data.node.afterResponse = async (method, _params, response) => {
    if (!froze && method === 'getblockheader') {
      await Promise.resolve();
      data.store.freeze(data.signed.headHash, { reason: 'concurrent confirmation recovery' });
      froze = true;
    }
    return response;
  };
  await assert.rejects(confirmPnlBatchSettlementV2(data.args(data.signed.headHash, false)), /stale|rolled-back|frozen/);
  assert.equal(data.store.read().ledger.epochId, '0');
  assert.equal(data.store.read().pending.status, 'SIGNED');
});

posixTest('rejects a consumed epoch and freezes a committed book when its chain anchor is reorganized', async (t) => {
  const data = await broadcastFixture(t);
  mine(data);
  const committed = await confirmPnlBatchSettlementV2(data.args(data.signed.headHash, false));
  await assert.rejects(signPnlBatchSettlementV2(data.args(committed.headHash)), /previous state root|epoch differs/);
  data.node.blocks.set(103, 'ff'.repeat(32));
  await assert.rejects(signPnlBatchSettlementV2(data.args(committed.headHash)), /reorganized; book frozen/);
  const state = data.store.read();
  assert.equal(state.ledgerHash, committed.ledgerHash);
  assert.equal(state.signingTombstones.length, 1);
  assert.match(state.frozen.reason, /left the active chain/);
  assert.equal(data.signerCalls, 1);
});

posixTest('rejects a pending checkpoint whose block has left the active chain', async (t) => {
  const data = await signedFixture(t);
  data.node.blocks.set(100, 'ff'.repeat(32));
  await assert.rejects(broadcastPnlBatchSettlementV2(data.args(data.signed.headHash, false)), /active block/);
  assert.equal(data.node.sends, 0);
  assert.equal(data.store.read().pending.status, 'SIGNED');
});

posixTest('checks own data fields and rejects counterfeit RPC values without invoking getters', async (t) => {
  const data = fixture(t);
  let sideEffects = 0;
  const argumentsWithGetter = data.args();
  Object.defineProperty(argumentsWithGetter, 'rpc', { enumerable: true,
    get() { sideEffects++; throw new Error('argument getter'); } });
  await assert.rejects(signPnlBatchSettlementV2(argumentsWithGetter), /data property/);
  const proxyArguments = new Proxy(data.args(), { get() { sideEffects++; }, ownKeys() { sideEffects++; } });
  await assert.rejects(signPnlBatchSettlementV2(proxyArguments), /Proxy/);
  data.node.afterResponse = async (method, _params, response) => {
    if (method !== 'getblockchaininfo') return response;
    Object.defineProperty(response, 'chain', { enumerable: true,
      get() { sideEffects++; throw new Error('RPC getter'); } });
    return response;
  };
  await assert.rejects(signPnlBatchSettlementV2(data.args()), /own data field/);
  assert.equal(sideEffects, 0);
  assert.equal(data.signerCalls, 0);
});

posixTest('rejects unknown execution fields and inherited replacements for missing policy data', async (t) => {
  const data = fixture(t);
  await assert.rejects(signPnlBatchSettlementV2({ ...data.args(), skipFunding: true }), /unsupported property/);
  const missing = data.args();
  missing.trustPolicy = copy(data.trustPolicy);
  delete missing.trustPolicy.network;
  let sideEffects = 0;
  const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'network');
  try {
    Object.defineProperty(Object.prototype, 'network', { configurable: true,
      get() { sideEffects++; throw new Error('inherited network getter'); } });
    await assert.rejects(signPnlBatchSettlementV2(missing), /own data field/);
    assert.equal(sideEffects, 0);
  } finally {
    if (prior) Object.defineProperty(Object.prototype, 'network', prior);
    else delete Object.prototype.network;
  }
});

posixTest('handles a Proxy signer error without invoking traps and retains its reservation', async (t) => {
  const data = fixture(t);
  let sideEffects = 0;
  const error = new Proxy({}, { get() { sideEffects++; throw new Error('error get trap'); },
    getOwnPropertyDescriptor() { sideEffects++; throw new Error('error descriptor trap'); } });
  data.signer = async () => { data.signerCalls++; throw error; };
  await assert.rejects(signPnlBatchSettlementV2(data.args()), /signing failed with a retained reservation/);
  assert.equal(sideEffects, 0);
  assert.equal(data.store.read().pending.status, 'RESERVED_BEFORE_SIGN');
});

posixTest('propagates an uninspectable RPC error without treating it as transaction absence', async (t) => {
  const data = await signedFixture(t);
  let sideEffects = 0;
  const error = new Proxy({}, { get() { sideEffects++; throw new Error('error get trap'); },
    getOwnPropertyDescriptor() { sideEffects++; throw new Error('error descriptor trap'); } });
  const args = data.args(data.signed.headHash, false);
  args.rpc = async (method, params) => {
    if (method === 'getrawtransaction') throw error;
    return data.node.rpc(method, params);
  };
  let caught;
  try { await broadcastPnlBatchSettlementV2(args); } catch (failure) { caught = failure; }
  assert.equal(caught, error);
  assert.equal(sideEffects, 0);
  assert.equal(data.node.sends, 0);
  assert.equal(data.store.read().pending.status, 'SIGNED');
});
