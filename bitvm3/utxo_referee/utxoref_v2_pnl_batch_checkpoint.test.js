'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { canonicalJson } = require('./dlc_canonical_json');
const { hashPnlSettlementSnapshot, buildPnlSettlementBatch } = require('./tradelayer_pnl_batch_settlement');
const {
  CHECKPOINT_KIND, SIGNED_CHECKPOINT_KIND, TRUST_POLICY_KIND, MAX_SIGNERS,
  pnlBatchCheckpointSigningBytesV2, hashPnlBatchCheckpointBodyV2,
  buildSignedPnlBatchCheckpointV2, verifySignedPnlBatchCheckpointV2,
  verifyAuthenticatedPnlBatchV2
} = require('./utxoref_v2_pnl_batch_checkpoint');

const copy = (value) => JSON.parse(JSON.stringify(value));
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const FIXTURE = require('./artifacts/fixtures/pnl_batch_settlement_v1.snapshot.json');
const KEYS = Array.from({ length: 4 }, () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const der = pair.publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey: pair.privateKey,
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    trusted: { keyId: sha256(der), publicKeySpki: der.toString('base64') } };
});

function input() {
  return { policyId: 'pnl-signers-v1', chainGenesisHash: 'aa'.repeat(32),
    contractId: 'bb'.repeat(32), snapshotHeight: 100, snapshotBlockHash: 'cc'.repeat(32),
    transactionPolicyHash: 'dd'.repeat(32), snapshot: copy(FIXTURE) };
}

function policy() {
  return { kind: TRUST_POLICY_KIND, version: 1, policyId: 'pnl-signers-v1',
    network: 'bitcoin-regtest', chainGenesisHash: 'aa'.repeat(32), contractId: 'bb'.repeat(32),
    threshold: 2, maxAgeBlocks: 6, trustedSigners: KEYS.slice(0, 3).map(({ trusted }) => ({ ...trusted })) };
}

function context() {
  return { trustPolicy: policy(), expectedPreviousStateRoot: FIXTURE.previousStateRoot,
    expectedEpochId: '1', currentHeight: 102, expectedSnapshotBlockHash: 'cc'.repeat(32) };
}

function sign(value = input(), indexes = [0, 1]) {
  return buildSignedPnlBatchCheckpointV2(value, { privateKeys: indexes.map((index) => KEYS[index].privateKeyPem) });
}

function verify(envelope = sign(), verificationContext = context()) {
  return verifySignedPnlBatchCheckpointV2(envelope, verificationContext);
}

function rehash(envelope) {
  envelope.body.snapshotHash = hashPnlSettlementSnapshot(envelope.body.snapshot);
  envelope.bodyHash = hashPnlBatchCheckpointBodyV2(envelope.body);
  return envelope;
}

function assertRejected(result, reason) {
  assert.equal(result.ok, false);
  if (reason) assert.match(result.reason, reason);
}

test('authenticates a distinct 2-of-3 Ed25519 quorum under independent chain and state pins', () => {
  const signed = sign();
  const checked = verify(signed);
  assert.equal(checked.ok, true, checked.reason);
  assert.equal(signed.kind, SIGNED_CHECKPOINT_KIND);
  assert.equal(signed.body.kind, CHECKPOINT_KIND);
  assert.equal(checked.threshold, 2);
  assert.equal(checked.ageBlocks, 2);
  assert.deepEqual(checked.signerKeyIds, KEYS.slice(0, 2).map(({ trusted }) => trusted.keyId).sort());
  assert.equal(checked.authenticationVerified, true);
  assert.equal(checked.priorStateRootMatched, true);
  assert.equal(checked.priorStateOpeningVerified, false);
  assert.equal(checked.executionVerified, false);
  assert.equal(checked.zkProofVerified, false);
});

test('preserves the full typed snapshot and its existing canonical fixture commitment', () => {
  const signed = sign();
  assert.deepEqual(signed.body.snapshot, FIXTURE);
  assert.equal(signed.body.snapshotHash, 'bc71ce13544ae91521c3cc1b4672bac699f025f73eaf219a34ad6220a19d73f2');
  assert.equal(signed.bodyHash, sha256(pnlBatchCheckpointSigningBytesV2(signed.body)));
  assert.equal(signed.bodyHash, hashPnlBatchCheckpointBodyV2(signed.body));
  assert.equal(verify(copy(signed)).ok, true);
});

test('rebuilds funded accounting from the authenticated snapshot with execution claims scoped', () => {
  const signed = sign();
  const batch = buildPnlSettlementBatch(signed.body.snapshot);
  const checked = verifyAuthenticatedPnlBatchV2(batch, signed, context());
  assert.equal(checked.ok, true, checked.reason);
  assert.equal(checked.authenticationVerified, true);
  assert.equal(checked.accountingVerified, true);
  assert.equal(checked.batchHash, batch.batchHash);
  assert.equal(checked.statementHash, batch.statementHash);
  assert.equal(checked.transactionPolicyHash, signed.body.transactionPolicyHash);
  assert.equal(checked.priorStateOpeningVerified, false);
  assert.equal(checked.executionVerified, false);
  assert.equal(checked.zkProofVerified, false);
});

test('rejects every unsigned economic snapshot substitution after hashes are recomputed', () => {
  const mutations = [
    (snapshot) => { snapshot.obligations[0].sats = '10001'; },
    (snapshot) => { snapshot.accounts[1].payoutSats = '3000'; },
    (snapshot) => { snapshot.accounts[0].equitySats = '99999'; },
    (snapshot) => { snapshot.accounts[0].lockedSats = '1000'; },
    (snapshot) => { snapshot.accounts[1].payoutScriptPubKey = '51'; },
    (snapshot) => { snapshot.vaults[0].feeSats = '501'; },
    (snapshot) => { snapshot.vaults[0].protectedSats = '1'; },
    (snapshot) => { snapshot.vaults[0].changeScriptPubKey = '51'; },
    (snapshot) => { snapshot.vaults[0].utxos[0].sats = '110001'; },
    (snapshot) => { snapshot.vaults[0].utxos[0].scriptPubKey = '51'; },
    (snapshot) => { snapshot.routes[0].capacitySats = '5000'; },
    (snapshot) => { snapshot.consumedObligationIds.push('prior-obligation'); },
    (snapshot) => { snapshot.spentOutpoints.push(`${'ee'.repeat(32)}:0`); }
  ];
  for (const mutate of mutations) {
    const signed = copy(sign());
    mutate(signed.body.snapshot);
    assertRejected(verify(rehash(signed)), /signature/);
  }
});

test('authenticates the transaction policy hash against unsigned policy substitution', () => {
  const signed = copy(sign());
  signed.body.transactionPolicyHash = 'ee'.repeat(32);
  assertRejected(verify(rehash(signed)), /signature/);
  const missing = input();
  delete missing.transactionPolicyHash;
  assert.throws(() => sign(missing), /transactionPolicyHash is required/);
});

test('requires every independent verification context field', () => {
  const signed = sign();
  for (const field of Object.keys(context())) {
    const incomplete = context();
    delete incomplete[field];
    assertRejected(verify(signed, incomplete), /required/);
  }
  assertRejected(verifySignedPnlBatchCheckpointV2(signed));
  assertRejected(verifySignedPnlBatchCheckpointV2(signed, {}));
});

test('requires explicit allowlist, quorum and freshness policy fields', () => {
  const signed = sign();
  for (const field of Object.keys(policy())) {
    const incomplete = context();
    delete incomplete.trustPolicy[field];
    assertRejected(verify(signed, incomplete), /required/);
  }
  for (const threshold of [0, -1, 4, '2']) {
    const invalid = context();
    invalid.trustPolicy.threshold = threshold;
    assertRejected(verify(signed, invalid), /threshold/);
  }
});

test('rejects signatures from self-declared and unallowlisted keys', () => {
  assertRejected(verify(sign(input(), [0, 3])), /not allowlisted/);
  const embeddedTrust = { ...copy(sign()), trustPolicy: policy() };
  assertRejected(verify(embeddedTrust), /unexpected field trustPolicy/);
});

test('binds policy key IDs to exact canonical Ed25519 SPKI bytes', () => {
  const wrongId = context();
  wrongId.trustPolicy.trustedSigners[0].keyId = 'ff'.repeat(32);
  assertRejected(verify(sign(), wrongId), /identity mismatch/);
  const trailing = context();
  const bytes = Buffer.from(trailing.trustPolicy.trustedSigners[0].publicKeySpki, 'base64');
  trailing.trustPolicy.trustedSigners[0].publicKeySpki = Buffer.concat([bytes, Buffer.from([0])]).toString('base64');
  assertRejected(verify(sign(), trailing));
  const whitespace = context();
  whitespace.trustPolicy.trustedSigners[0].publicKeySpki += '\n';
  assertRejected(verify(sign(), whitespace), /not canonical/);
});

test('rejects non-Ed25519 policy keys and private signing keys', () => {
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = ec.publicKey.export({ type: 'spki', format: 'der' });
  const invalid = context();
  invalid.trustPolicy.trustedSigners[0] = { keyId: sha256(der), publicKeySpki: der.toString('base64') };
  assertRejected(verify(sign(), invalid), /Ed25519/);
  assert.throws(() => buildSignedPnlBatchCheckpointV2(input(), {
    privateKeys: [ec.privateKey.export({ type: 'pkcs8', format: 'pem' })]
  }), /Ed25519/);
});

test('duplicate signatures cannot satisfy a quorum', () => {
  const signed = copy(sign(input(), [0]));
  signed.signatures.push(copy(signed.signatures[0]));
  assertRejected(verify(signed), /duplicate checkpoint signature/);
});

test('rejects duplicate policy keys and repeated builder signing keys', () => {
  const invalid = context();
  invalid.trustPolicy.trustedSigners[1] = { ...invalid.trustPolicy.trustedSigners[0] };
  assertRejected(verify(sign(), invalid), /reuses a signing key/);
  assert.throws(() => sign(input(), [0, 0]), /duplicate checkpoint signing key/);
});

test('enforces quorum and validates every extra signature', () => {
  assertRejected(verify(sign(input(), [0])), /below the pinned threshold/);
  assertRejected(verify(sign(input(), [0, 1, 3])), /not allowlisted/);
  const invalidExtra = copy(sign(input(), [0, 1, 2]));
  invalidExtra.signatures[2].signatureHex = '00'.repeat(64);
  assertRejected(verify(invalidExtra), /invalid checkpoint signature/);
});

test('signatures on different checkpoint bodies cannot be combined', () => {
  const signed = copy(sign(input(), [0]));
  const otherInput = input();
  otherInput.transactionPolicyHash = 'ee'.repeat(32);
  signed.signatures.push(copy(sign(otherInput, [1]).signatures[0]));
  assertRejected(verify(signed), /invalid checkpoint signature/);
});

test('rejects unknown fields throughout the signed and independent policy schemas', () => {
  const locations = [
    (signed, _context) => signed,
    (signed, _context) => signed.body,
    (signed, _context) => signed.signatures[0],
    (_signed, verificationContext) => verificationContext,
    (_signed, verificationContext) => verificationContext.trustPolicy,
    (_signed, verificationContext) => verificationContext.trustPolicy.trustedSigners[0]
  ];
  for (const location of locations) {
    const signed = copy(sign());
    const verificationContext = context();
    location(signed, verificationContext).skipVerification = true;
    assertRejected(verify(signed, verificationContext), /unexpected field/);
  }
  assert.throws(() => sign({ ...input(), snapshotHash: 'ff'.repeat(32) }), /unexpected field/);
  assert.throws(() => buildSignedPnlBatchCheckpointV2(input(), {
    privateKeys: [KEYS[0].privateKeyPem], skipVerification: true
  }), /unexpected field/);
});

test('rejects unknown typed snapshot fields rather than discarding their semantics', () => {
  const unsupported = input();
  unsupported.snapshot.priceScale = '100000000';
  assert.throws(() => sign(unsupported), /unexpected field priceScale/);
  const signed = copy(sign());
  signed.body.snapshot.accounts[0].withdrawalPriority = 'fifo';
  assertRejected(verify(signed), /unexpected field withdrawalPriority/);
});

test('enforces the inclusive freshness boundary with no age-check bypass', () => {
  const current = context();
  current.currentHeight = 106;
  assert.equal(verify(sign(), current).ok, true);
  current.currentHeight = 107;
  assertRejected(verify(sign(), current), /freshness limit/);
  current.enforceStateAge = false;
  assertRejected(verify(sign(), current), /unexpected field/);
});

test('a zero-block freshness budget requires the exact current height and rejects future state', () => {
  const exact = context();
  exact.trustPolicy.maxAgeBlocks = 0;
  exact.currentHeight = 100;
  assert.equal(verify(sign(), exact).ok, true);
  exact.currentHeight = 101;
  assertRejected(verify(sign(), exact), /freshness limit/);
  exact.currentHeight = 99;
  assertRejected(verify(sign(), exact), /ahead of the current chain view/);
});

test('pins the active checkpoint block, network, genesis and contract independently', () => {
  const changed = [
    (verificationContext) => { verificationContext.expectedSnapshotBlockHash = 'ee'.repeat(32); },
    (verificationContext) => { verificationContext.trustPolicy.network = 'bitcoin-testnet4'; },
    (verificationContext) => { verificationContext.trustPolicy.chainGenesisHash = 'ee'.repeat(32); },
    (verificationContext) => { verificationContext.trustPolicy.contractId = 'ee'.repeat(32); }
  ];
  for (const mutate of changed) {
    const verificationContext = context();
    mutate(verificationContext);
    const checked = verify(sign(), verificationContext);
    assertRejected(checked);
    assert.equal(checked.code, 'CHAIN_MISMATCH');
  }
});

test('pins the expected epoch and prior root even for a valid trusted quorum', () => {
  const differentEpoch = input();
  differentEpoch.snapshot.epochId = '2';
  assertRejected(verify(sign(differentEpoch)), /epoch differs/);
  const differentRoot = input();
  differentRoot.snapshot.previousStateRoot = 'ee'.repeat(32);
  assertRejected(verify(sign(differentRoot)), /previous state root differs/);
  const differentPolicy = input();
  differentPolicy.policyId = 'other-policy';
  assertRejected(verify(sign(differentPolicy)), /signer policy mismatch/);
});

test('rejects malformed and noncanonical metadata, heights and epoch pins', () => {
  for (const value of [-1, 1.5, '102', 0x100000000]) {
    const invalid = context();
    invalid.currentHeight = value;
    assertRejected(verify(sign(), invalid));
  }
  for (const value of ['01', '-1', '9223372036854775808', 1.5]) {
    const invalid = context();
    invalid.expectedEpochId = value;
    assertRejected(verify(sign(), invalid));
  }
  const invalidInput = input();
  invalidInput.snapshotBlockHash = 'CC'.repeat(32);
  assert.throws(() => sign(invalidInput), /lowercase/);
});

test('legacy V2 signed row checkpoints cannot enter the typed batch path', () => {
  const signed = copy(sign());
  signed.kind = 'utxoref_signed_state_checkpoint_v2';
  assertRejected(verify(signed), /wrong signed PnL batch checkpoint/);
  signed.kind = SIGNED_CHECKPOINT_KIND;
  signed.body.kind = 'utxoref_state_checkpoint_v2';
  assertRejected(verify(signed), /wrong PnL batch checkpoint/);
});

test('uses a distinct signing domain and rejects signatures over bare JSON', () => {
  const signed = copy(sign());
  const unsignedBytes = Buffer.from(canonicalJson(signed.body), 'utf8');
  signed.signatures = KEYS.slice(0, 2).map((key) => ({ algorithm: 'ed25519', keyId: key.trusted.keyId,
    signatureHex: crypto.sign(null, unsignedBytes, key.privateKey).toString('hex') }));
  assertRejected(verify(signed), /invalid checkpoint signature/);
  const domain = 'UTXOREF_PNL_BATCH_CHECKPOINT_V2\0';
  assert.equal(pnlBatchCheckpointSigningBytesV2(signed.body)
    .subarray(0, domain.length).toString('ascii'), domain);
});

test('validates the body snapshot commitment before exposing signing bytes or hashes', () => {
  const body = copy(sign().body);
  body.snapshotHash = 'ee'.repeat(32);
  assert.throws(() => pnlBatchCheckpointSigningBytesV2(body), /snapshot hash mismatch/);
  assert.throws(() => hashPnlBatchCheckpointBodyV2(body), /snapshot hash mismatch/);
});

test('requires exact signature encodings and the fixed algorithm', () => {
  for (const mutation of [
    (signature) => { signature.algorithm = 'ecdsa'; },
    (signature) => { signature.signatureHex = 'ab'.repeat(63); },
    (signature) => { signature.signatureHex = 'AB'.repeat(64); },
    (signature) => { signature.signatureHex += '\n'; }
  ]) {
    const signed = copy(sign());
    mutation(signed.signatures[0]);
    assertRejected(verify(signed));
  }
});

test('body key ordering is canonical while the exact signed array content remains bound', () => {
  const signed = copy(sign());
  signed.body = Object.fromEntries(Object.entries(signed.body).reverse());
  assert.equal(verify(signed).ok, true);
  signed.body.snapshot.vaults.reverse();
  assert.equal(hashPnlSettlementSnapshot(signed.body.snapshot), signed.body.snapshotHash);
  assertRejected(verify(rehash(signed)), /invalid checkpoint signature/);
});

test('rejects a different accounting result and forged execution flags under a valid checkpoint', () => {
  const signed = sign();
  const batch = copy(buildPnlSettlementBatch(signed.body.snapshot));
  batch.transaction.outputs[0].sats = '4001';
  assertRejected(verifyAuthenticatedPnlBatchV2(batch, signed, context()), /accounting failed/);
  for (const field of ['executionVerified', 'zkProofVerified']) {
    const forged = copy(buildPnlSettlementBatch(signed.body.snapshot));
    forged[field] = true;
    assertRejected(verifyAuthenticatedPnlBatchV2(forged, signed, context()), /accounting failed/);
  }
});

test('quorum authentication leaves margin and funded route feasibility to the batch verifier', () => {
  const insolventInput = input();
  insolventInput.snapshot.accounts[0].equitySats = '1';
  const signed = sign(insolventInput);
  assert.equal(verify(signed).ok, true);
  const otherBatch = buildPnlSettlementBatch(FIXTURE);
  assertRejected(verifyAuthenticatedPnlBatchV2(otherBatch, signed, context()), /accounting failed/);
});

test('copies and freezes signed snapshots before callers can mutate their sources', () => {
  const source = input();
  const signed = sign(source);
  source.snapshot.accounts[0].equitySats = '1';
  assert.equal(signed.body.snapshot.accounts[0].equitySats, '100000');
  assert.equal(Object.isFrozen(signed), true);
  assert.equal(Object.isFrozen(signed.body.snapshot.accounts[0]), true);
  assert.throws(() => { signed.body.snapshot.accounts[0].equitySats = '1'; }, TypeError);
  const checked = verify(signed);
  assert.equal(Object.isFrozen(checked), true);
  assert.equal(Object.isFrozen(checked.signerKeyIds), true);
});

test('uses decimal strings for large wire integers and rejects native BigInt or lossy numbers', () => {
  const large = input();
  large.snapshot.vaults[0].utxos[0].sats = '9007199254740993';
  assert.equal(verify(sign(large)).ok, true);
  large.snapshot.vaults[0].utxos[0].sats = 9007199254740993n;
  assert.throws(() => sign(large), /unsupported data/);
  large.snapshot.vaults[0].utxos[0].sats = 9007199254740992;
  assert.throws(() => sign(large), /safe integers/);
});

test('bounds signature and trust policy fanout before signature verification', () => {
  assert.equal(MAX_SIGNERS, 32);
  const signed = copy(sign());
  signed.signatures = Array.from({ length: 33 }, () => copy(signed.signatures[0]));
  assertRejected(verify(signed), /1\.\.32 signatures/);
  const invalidPolicy = context();
  invalidPolicy.trustPolicy.trustedSigners = Array.from({ length: 33 }, () => ({ ...KEYS[0].trusted }));
  assertRejected(verify(sign(), invalidPolicy), /1\.\.32 keys/);
  assert.throws(() => buildSignedPnlBatchCheckpointV2(input(), {
    privateKeys: Array.from({ length: 33 }, () => KEYS[0].privateKeyPem)
  }), /1\.\.32/);
});

test('rejects Proxy inputs at every public boundary without invoking their traps', () => {
  let calls = 0;
  const wrapped = (value) => new Proxy(value, {
    get() { calls++; throw new Error('unexpected get trap'); },
    ownKeys() { calls++; throw new Error('unexpected ownKeys trap'); },
    getOwnPropertyDescriptor() { calls++; throw new Error('unexpected descriptor trap'); },
    getPrototypeOf() { calls++; throw new Error('unexpected prototype trap'); }
  });
  const signed = sign();
  assertRejected(verify(wrapped(signed)));
  assertRejected(verify(signed, wrapped(context())));
  assertRejected(verifyAuthenticatedPnlBatchV2(wrapped({}), signed, context()));
  assert.throws(() => sign(wrapped(input())), /Proxy/);
  assert.throws(() => buildSignedPnlBatchCheckpointV2(input(), wrapped({ privateKeys: [] })), /Proxy/);
  assert.throws(() => pnlBatchCheckpointSigningBytesV2(wrapped(signed.body)), /Proxy/);
  const nested = copy(signed);
  nested.body.snapshot = wrapped(nested.body.snapshot);
  assertRejected(verify(nested));
  assert.equal(calls, 0);
});

test('rejects own getters before traversing candidate, source or trust policy fields', () => {
  let calls = 0;
  const withGetter = (value, field) => {
    const changed = copy(value);
    Object.defineProperty(changed, field, { enumerable: true,
      get() { calls++; throw new Error('unexpected getter'); } });
    return changed;
  };
  const signed = sign();
  assertRejected(verify(withGetter(signed, 'kind')));
  assertRejected(verify(signed, withGetter(context(), 'trustPolicy')));
  const nested = copy(signed);
  nested.body.snapshot.accounts[0] = withGetter(nested.body.snapshot.accounts[0], 'equitySats');
  assertRejected(verify(nested));
  assert.throws(() => sign(withGetter(input(), 'snapshot')), /enumerable data property/);
  assert.equal(calls, 0);
});

test('ignores inherited toJSON and rejects inherited replacements for required pins', () => {
  const signed = sign();
  const missingPin = context();
  delete missingPin.expectedPreviousStateRoot;
  const missingKind = copy(signed);
  delete missingKind.kind;
  let calls = 0;
  const descriptors = Object.getOwnPropertyDescriptors(Object.prototype);
  try {
    for (const name of ['toJSON', 'expectedPreviousStateRoot', 'kind', 'payoutScriptPubKey']) {
      Object.defineProperty(Object.prototype, name, { configurable: true,
        get() { calls++; throw new Error(`unexpected inherited ${name}`); } });
    }
    assert.equal(verify(signed).ok, true);
    assertRejected(verify(signed, missingPin), /required/);
    assertRejected(verify(missingKind), /required/);
    assert.equal(verifyAuthenticatedPnlBatchV2(buildPnlSettlementBatch(FIXTURE), signed, context()).ok, true);
    assert.equal(calls, 0);
  } finally {
    for (const name of ['toJSON', 'expectedPreviousStateRoot', 'kind', 'payoutScriptPubKey']) {
      if (Object.prototype.hasOwnProperty.call(descriptors, name)) Object.defineProperty(Object.prototype, name, descriptors[name]);
      else delete Object.prototype[name];
    }
  }
});

test('rejects non-data candidates and malformed collections without throwing from verifiers', () => {
  const signed = sign();
  for (const malformed of [null, [], 0, 'signed', undefined]) {
    assertRejected(verifySignedPnlBatchCheckpointV2(malformed, context()));
    assertRejected(verifySignedPnlBatchCheckpointV2(signed, malformed));
  }
  for (const signatures of [[], null, {}, [null]]) {
    assertRejected(verify({ ...copy(signed), signatures }));
  }
  const sparse = copy(signed);
  delete sparse.signatures[0];
  assertRejected(verify(sparse), /dense array/);
  const cyclic = copy(signed);
  cyclic.body.snapshot.accounts[0].cycle = cyclic;
  assertRejected(verify(cyclic), /cycle/);
});
