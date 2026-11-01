'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const v2 = require('../bitvm3/utxo_referee/utxoref_v2.js');
const tr = require('../bitvm3/utxo_referee/tradelayer_taproot.js');
const codec = require('./statement.cjs');
const { inspectV2Settlement } = require('./v2_adapter.cjs');

// Fixed dev-only Ed25519 seed: deterministic test fixture, never a custody key.
const seed = Buffer.from('80'.repeat(32), 'hex');
const privateKey = crypto.createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  format: 'der', type: 'pkcs8'
});
const publicKey = crypto.createPublicKey(privateKey);
const keyId = v2.publicKeyId(publicKey);
const TRUSTED = { [keyId]: publicKey };
const G = '11'.repeat(32);
const CONTRACT = '42'.repeat(32);
const ASSERTION = 'aa'.repeat(32);
const SCRIPT = '5120' + '33'.repeat(32);
const A = '0014' + '01'.repeat(20);
const C = '0014' + '03'.repeat(20);

function checkpointBody() {
  return {
    network: 'bitcoin-testnet4',
    chainGenesisHash: G,
    contractId: CONTRACT,
    epochId: '91',
    snapshotHeight: 1000,
    snapshotBlockHash: '22'.repeat(32),
    settlementAddressMap: {
      A: { address: 'winner-a', scriptPubKeyHex: A },
      C: { address: 'winner-c', scriptPubKeyHex: C }
    },
    pnlRows: [
      { id: 'a-wins-from-b', contractId: CONTRACT, side: 'long',
        entryPrice: 2100, closePrice: 2200, quantityUnits: 30, collateralSats: 50000,
        traderAddress: 'A', counterpartyAddress: 'B' },
      { id: 'c-wins-from-b', contractId: CONTRACT, side: 'long',
        entryPrice: 2100, closePrice: 2200, quantityUnits: 20, collateralSats: 50000,
        traderAddress: 'C', counterpartyAddress: 'B' }
    ]
  };
}
function fixture(fundingOverride) {
  const verifyOptions = {
    trustedSigners: TRUSTED,
    expectedNetwork: 'bitcoin-testnet4',
    expectedGenesisHash: G,
    currentHeight: 1002
  };
  const fundingOutpoints = fundingOverride || [
    { txid: ASSERTION, vout: 0, amountSats: '6000', scriptPubKeyHex: SCRIPT }
  ];
  const stateEnvelope = v2.buildSignedStateCheckpointV2(checkpointBody(), {
    privateKey, publicKey
  });
  const settlement = v2.buildUtxoRefPnlSettlementV2({
    stateEnvelope, stateVerification: verifyOptions,
    fundingOutpoints, feeSats: '1000',
    operatorXonly: '44'.repeat(32), challengerXonly: '55'.repeat(32),
    challengeCsvBlocks: 6, recoveryCsvBlocks: 144
  });
  settlement.unsignedTxHex = tr.serializeUnsignedTx(
    2,
    fundingOutpoints.map(f => ({ outpoint: tr.outpoint(f.txid, f.vout), sequence: 6 })),
    settlement.outputs.map(o => ({ valueSats: o.valueSats, script: o.scriptPubKeyHex })),
    0
  );
  const policy = {
    programHash: '66'.repeat(32),
    verifyingKeyHash: '77'.repeat(32),
    policyHash: '88'.repeat(32),
    assertionTxid: ASSERTION,
    assertionVout: 0,
    assertionAmountSats: '6000',
    assertionScriptPubKeyHex: SCRIPT,
    stateVerification: verifyOptions
  };
  return { settlement, policy, verifyOptions };
}
function independentTxid(raw) {
  const hash = crypto.createHash('sha256').update(Buffer.from(raw, 'hex')).digest();
  return Buffer.from(crypto.createHash('sha256').update(hash).digest()).reverse().toString('hex');
}
function mutateTx(settlement, inputs, outputs, version = 2, locktime = 0) {
  settlement.unsignedTxHex = tr.serializeUnsignedTx(version, inputs, outputs, locktime);
}
function input(txid = ASSERTION, vout = 0, sequence = 6) {
  return { outpoint: tr.outpoint(txid, vout), sequence };
}
function outputs(s) {
  return s.outputs.map(o => ({ valueSats: o.valueSats, script: o.scriptPubKeyHex }));
}

test('positive V2 checkpoint, exact spend and Groth16 V0 statement are deterministic', () => {
  const { settlement, policy, verifyOptions } = fixture();
  const reference = v2.verifyUtxoRefSettlementV2(settlement, verifyOptions);
  assert.equal(reference.ok, true, reference.reason);
  const result = inspectV2Settlement(settlement, policy);
  assert.equal(result.status, 'V2_OFFCHAIN_CHECKED_ONLY');
  assert.equal(result.v2RefereeChecked, true);
  assert.equal(result.proofVerified, false);
  assert.equal(result.settlementAuthorized, false);
  assert.equal(result.statement.commitmentHash, reference.commitmentHash);
  assert.equal(result.statement.assertionTxid, ASSERTION);
  assert.equal(result.statement.settlementTxid, independentTxid(settlement.unsignedTxHex));
  assert.equal(result.digest, codec.statementDigestV0(result.statement));
  assert.deepEqual(result.publicInputs, codec.publicInputsV0(result.statement));
  assert.equal(codec.encodeStatementV0(result.statement).length, 304);
  assert.equal(result.digest, inspectV2Settlement(fixture().settlement, fixture().policy).digest);
});

test('wrong outpoint, index, amount or script fails after valid V2 reference check', () => {
  const { settlement, policy, verifyOptions } = fixture();
  assert.equal(v2.verifyUtxoRefSettlementV2(settlement, verifyOptions).ok, true);
  for (const patch of [
    { assertionTxid: 'bb'.repeat(32) }, { assertionVout: 1 },
    { assertionAmountSats: '5999' },
    { assertionScriptPubKeyHex: '5120' + 'ff'.repeat(32) }
  ]) {
    assert.throws(() => inspectV2Settlement(settlement, { ...policy, ...patch }),
      /assertion outpoint|assertion value or Taproot script/);
  }
});

test('valid V2 multi-input transaction is excluded from single-assertion Stage 1 profile', () => {
  const { settlement, policy, verifyOptions } = fixture([
    { txid: ASSERTION, vout: 0, amountSats: '3000', scriptPubKeyHex: SCRIPT },
    { txid: 'bb'.repeat(32), vout: 1, amountSats: '3000', scriptPubKeyHex: SCRIPT }
  ]);
  assert.equal(v2.verifyUtxoRefSettlementV2(settlement, verifyOptions).ok, true);
  assert.throws(() => inspectV2Settlement(settlement, policy), /single assertion funding input required/);
});

test('changed payout destinations, output order and appended outputs fail closed', () => {
  for (const mode of ['redirect', 'swap', 'extra']) {
    const { settlement, policy } = fixture();
    const o = outputs(settlement);
    if (mode === 'redirect') o[0].script = C;
    if (mode === 'swap') o.reverse();
    if (mode === 'extra') o.push({ valueSats: '1', script: A });
    mutateTx(settlement, [input()], o);
    assert.throws(() => inspectV2Settlement(settlement, policy), /V2 referee rejected settlement/);
  }
});

test('incorrect input, sequence, transaction version or locktime fail closed', () => {
  for (const mode of ['input', 'sequence', 'version', 'locktime']) {
    const { settlement, policy } = fixture();
    const inp = mode === 'input' ? input('bb'.repeat(32)) :
      mode === 'sequence' ? input(ASSERTION, 0, 5) : input();
    mutateTx(settlement, [inp], outputs(settlement),
      mode === 'version' ? 3 : 2, mode === 'locktime' ? 1 : 0);
    assert.throws(() => inspectV2Settlement(settlement, policy), /V2 referee rejected settlement/);
  }
});

test('mutated signed state, disallowed signer, stale state and wrong genesis fail closed', () => {
  for (const mode of ['state', 'signer', 'stale', 'genesis']) {
    const { settlement, policy } = fixture();
    if (mode === 'state') settlement.stateEnvelope.body.pnlRows[0].closePrice = 9999;
    if (mode === 'signer') policy.stateVerification = { ...policy.stateVerification, trustedSigners: {} };
    if (mode === 'stale') policy.stateVerification = { ...policy.stateVerification, currentHeight: 1010 };
    if (mode === 'genesis') policy.stateVerification = {
      ...policy.stateVerification, expectedGenesisHash: 'ff'.repeat(32)
    };
    assert.throws(() => inspectV2Settlement(settlement, policy), /V2 referee rejected settlement/);
  }
});

test('proof and policy identifiers remain visible to statement digest', () => {
  const { settlement, policy } = fixture();
  const original = inspectV2Settlement(settlement, policy);
  for (const field of ['programHash', 'verifyingKeyHash', 'policyHash']) {
    const changed = inspectV2Settlement(settlement, {
      ...policy, [field]: 'ef'.repeat(32)
    });
    assert.notEqual(changed.digest, original.digest);
    assert.equal(changed.proofVerified, false);
    assert.equal(changed.settlementAuthorized, false);
  }
});

test('funding conservation, duplicate inputs and forged commitment fail at V2 boundary', () => {
  const { settlement, policy } = fixture();
  settlement.commitment.core.fundingTotalSats = '999999';
  assert.throws(() => inspectV2Settlement(settlement, policy), /V2 referee rejected settlement/);
  const { settlement: second, policy: p2 } = fixture();
  second.commitment.core.payoutRoot = 'ff'.repeat(32);
  assert.throws(() => inspectV2Settlement(second, p2), /V2 referee rejected settlement/);
  const { settlement: third, policy: p3 } = fixture();
  mutateTx(third, [input(), input()], outputs(third));
  assert.throws(() => inspectV2Settlement(third, p3), /V2 referee rejected settlement/);
});
