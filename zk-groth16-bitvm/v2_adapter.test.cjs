'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectV2Settlement } = require('./v2_adapter.cjs');
const H = '11'.repeat(32);
const basePolicy = () => ({
  programHash: H, verifyingKeyHash: H, policyHash: H,
  assertionTxid: H, assertionVout: 0,
  assertionAmountSats: '6000',
  assertionScriptPubKeyHex: '5120' + '33'.repeat(32),
  stateVerification: {
    trustedSigners: { id: 'not-a-real-key' },
    expectedGenesisHash: H,
    expectedNetwork: 'bitcoin-regtest',
    currentHeight: 100
  }
});
test('trust pins are mandatory', () => {
  assert.throws(() => inspectV2Settlement({}, null), /policy/);
  for (const field of ['programHash', 'verifyingKeyHash', 'policyHash', 'assertionTxid']) {
    const p = basePolicy();
    delete p[field];
    assert.throws(() => inspectV2Settlement({}, p), /32-byte hex/);
  }
});
test('assertion index is strictly bounded', () => {
  for (const v of [-1, -0, 1.5, '0', 2 ** 32]) {
    const p = basePolicy(); p.assertionVout = v;
    assert.throws(() => inspectV2Settlement({}, p), /assertionVout/);
  }
});
test('assertion amount and script have exact canonical encodings', () => {
  for (const v of [0, '0', '-1', '00006000', '18446744073709551616', 6000]) {
    const p = basePolicy(); p.assertionAmountSats = v;
    assert.throws(() => inspectV2Settlement({}, p), /assertionAmountSats/);
  }
  for (const v of ['', '0014' + '33'.repeat(20), '5120' + 'GG'.repeat(32), '5120' + '33'.repeat(31)]) {
    const p = basePolicy(); p.assertionScriptPubKeyHex = v;
    assert.throws(() => inspectV2Settlement({}, p), /assertionScriptPubKeyHex/);
  }
});
test('chain and state trust configuration are mandatory', () => {
  for (const field of ['trustedSigners', 'expectedGenesisHash', 'expectedNetwork', 'currentHeight']) {
    const p = basePolicy(); delete p.stateVerification[field];
    assert.throws(() => inspectV2Settlement({}, p), /trust pins/);
  }
  for (const height of [-1, 0.5, '100', 2 ** 32]) {
    const p = basePolicy(); p.stateVerification.currentHeight = height;
    assert.throws(() => inspectV2Settlement({}, p), /currentHeight/);
  }
});
test('invalid settlement cannot yield a statement', () => {
  assert.throws(() => inspectV2Settlement({}, basePolicy()), /V2 referee rejected settlement/);
  assert.throws(() => inspectV2Settlement({ kind: 'utxoref_pnl_settlement_v2', version: 2 }, basePolicy()), /V2 referee rejected settlement/);
});
