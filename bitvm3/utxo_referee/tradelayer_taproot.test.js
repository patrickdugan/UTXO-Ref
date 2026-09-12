/**
 * Run: node bitvm3/utxo_referee/tradelayer_taproot.test.js
 *
 * Validates the taproot tweak + BIP341 SIGHASH_DEFAULT sighash against the
 * published BIP341 wallet test vectors. The vectors are vendored as
 * bip341-wallet-test-vectors.json next to this test (fetched from
 * bitcoin/bips bip-0341/wallet-test-vectors.json).
 */

const fs = require('fs');
const path = require('path');
const {
  parseTx, bip341SighashDefault, tapTweakScalar, taprootOutputKey, taprootTweakSecret, sha256, varint
} = require('./tradelayer_taproot');
const { bytes32, bufToBig } = require('./tradelayer_dlc_adaptor_sig');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEq(a, e, m) { if (a !== e) throw new Error(m || `expected ${e}, got ${a}`); }

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'bip341-wallet-test-vectors.json'), 'utf8'));
const kp = vectors.keyPathSpending[0];

console.log('\n=== TradeLayer Taproot (BIP341) Vector Tests ===\n');

test('keypath taproot tweak matches the vector (merkle root null)', () => {
  const i0 = kp.inputSpending.find((s) => s.given.txinIndex === 0);
  const internalXonly = Buffer.from(i0.intermediary.internalPubkey, 'hex');
  const tweak = tapTweakScalar(internalXonly, null);
  assertEq(bytes32(tweak).toString('hex'), i0.intermediary.tweak);
  // tweaked private key
  const tweaked = taprootTweakSecret(BigInt('0x' + i0.given.internalPrivkey), null);
  assertEq(bytes32(tweaked).toString('hex'), i0.intermediary.tweakedPrivkey);
});

test('taproot output key matches the spent scriptPubKey program', () => {
  const i0 = kp.inputSpending.find((s) => s.given.txinIndex === 0);
  const internalXonly = Buffer.from(i0.intermediary.internalPubkey, 'hex');
  const out = taprootOutputKey(internalXonly, null);
  const expectedProgram = kp.given.utxosSpent[0].scriptPubKey.slice(4); // strip 5120
  assertEq(out.xonly.toString('hex'), expectedProgram);
});

test('precomputed sub-hashes match the vector intermediary', () => {
  const tx = parseTx(kp.given.rawUnsignedTx);
  const u = kp.given.utxosSpent;
  const shaPrevouts = sha256(Buffer.concat(tx.vin.map((i) => i.outpoint))).toString('hex');
  const shaSequences = sha256(Buffer.concat(tx.vin.map((i) => {
    const b = Buffer.alloc(4); b.writeUInt32LE(i.sequence); return b;
  }))).toString('hex');
  const shaOutputs = sha256(Buffer.concat(tx.vout.map((o) => {
    const val = Buffer.alloc(8); val.writeBigUInt64LE(o.value);
    return Buffer.concat([val, varint(o.script.length), o.script]);
  }))).toString('hex');
  assertEq(shaPrevouts, kp.intermediary.hashPrevouts, 'hashPrevouts');
  assertEq(shaSequences, kp.intermediary.hashSequences, 'hashSequences');
  assertEq(shaOutputs, kp.intermediary.hashOutputs, 'hashOutputs');
});

test('SIGHASH_DEFAULT keypath sighash matches the vector (input 4)', () => {
  const i4 = kp.inputSpending.find((s) => s.given.txinIndex === 4);
  const tx = parseTx(kp.given.rawUnsignedTx);
  const utxos = kp.given.utxosSpent;
  const sighash = bip341SighashDefault(tx, utxos, 4).toString('hex');
  assertEq(sighash, i4.intermediary.sigHash);
});

if (failed > 0) { console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`); process.exit(1); }
console.log(`\nPASS: ${passed} tests\n`);
