'use strict';
// Offline checks for the distributed coordinator: request binding, the key-material scanner,
// and the committed receipts. No Core, VPS or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const L = require('./lib.cjs');

const RECEIPTS = path.join(__dirname, '..', 'receipts');

test('a request binds network, vault descriptors, exact outputs, fee ceiling, expiry and a unique id', () => {
  const decoded = { tx: { vout: [{ value: 0.4, scriptPubKey: { address: 'bcrt1qpayee' } }, { value: 0.599996, scriptPubKey: { address: 'bcrt1qchange' } }] } };
  const vault = { id: 'kan-vault-1', checksums: ['aaaaaaaa', 'bbbbbbbb'] };
  const a = L.buildRequest({ psbt: 'cHNidP8=', decoded, vault, feeCeiling: 10000, expiry: 123 });
  const b = L.buildRequest({ psbt: 'cHNidP8=', decoded, vault, feeCeiling: 10000, expiry: 123 });
  assert.deepEqual(Object.keys(a).sort(), ['expiry', 'fee_ceiling_sats', 'intended_outputs', 'network', 'psbt', 'request_id',
    'vault_descriptor_checksums', 'vault_id', 'version']);
  assert.deepEqual(a.intended_outputs, [{ address: 'bcrt1qpayee', sats: 40000000 }, { address: 'bcrt1qchange', sats: 59999600 }]);
  assert.equal(a.network, 'regtest');
  assert.notEqual(a.request_id, b.request_id);
});

test('the receipt writer refuses extended private keys, WIF and PEM private keys', () => {
  const tprv = 'tprv' + '8'.repeat(107);
  const wif = 'cT' + 'V'.repeat(50);
  assert.ok(L.findSecrets(`{"k":"${tprv}"}`).length);
  assert.ok(L.findSecrets(`{"k":"${wif}"}`).length);
  assert.ok(L.findSecrets('-----BEGIN PRIVATE KEY-----').length);
  assert.deepEqual(L.findSecrets('{"xpub":"[5d398d61/84h/1h/0h]tpubDDN3zqJ5vZkwnNQwTDiLpToox"}'), []);
  assert.throws(() => L.writeReceipt(path.join(__dirname, 'never-written'), 'x', { k: tprv }), /key material/);
  assert.equal(fs.existsSync(path.join(__dirname, 'never-written')), false);
});

test('committed receipts pass, carry no key material and cover every fault scenario', () => {
  const files = fs.readdirSync(RECEIPTS).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const text = fs.readFileSync(path.join(RECEIPTS, f), 'utf8');
    assert.deepEqual(L.findSecrets(text), [], f);
    assert.ok(!/"(signed_)?psbt"\s*:\s*"cHNidP/.test(text), `${f} carries a full PSBT`);
    const receipt = JSON.parse(text);
    if (f !== 'summary.json') assert.equal(receipt.pass, true, f);
  }
  const names = files.map((f) => f.replace(/\.json$/, ''));
  for (const required of ['gate1-distributed-signing', 'gate2-vps-unavailable', 'gate2-process-restart', 'gate2-duplicate-request',
    'gate2-modified-output-address', 'gate2-modified-amount-or-fee', 'gate2-stale-request', 'gate2-conflicting-psbts',
    'gate2-coordinator-credentials', 'gate2-collusion-a-operator-b', 'gate3-conflicting-quorum-race', 'gate3-custodian-a-disappears']) {
    assert.ok(names.includes(required), `missing receipt ${required}`);
  }
});
