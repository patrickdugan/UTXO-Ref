/**
 * Run: node bitvm3/utxo_referee/legacy/tradelayer_musig2.test.js
 *
 * Validates MuSig2 key aggregation + partial signing against the published
 * BIP327 test vectors (vendored), then checks the 2-party adaptor variant:
 * the aggregated pre-signature is not valid until the oracle scalar completes
 * it, and a single party cannot produce the settling signature alone.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const m = require('./tradelayer_musig2');
const a = require('../tradelayer_dlc_adaptor_sig');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
function assertEq(x, e, msg) { if (x !== e) throw new Error(msg || `expected ${e}, got ${x}`); }
function hexBuf(h) { return Buffer.from(h, 'hex'); }

const ka = JSON.parse(fs.readFileSync(path.join(__dirname, 'bip327-key-agg-vectors.json'), 'utf8'));
const sv = JSON.parse(fs.readFileSync(path.join(__dirname, 'bip327-sign-verify-vectors.json'), 'utf8'));

console.log('\n=== TradeLayer MuSig2 (BIP327) Vector Tests ===\n');

test('key aggregation matches BIP327 vectors', () => {
  for (const tc of ka.valid_test_cases) {
    const pubkeys = tc.key_indices.map((i) => hexBuf(ka.pubkeys[i]));
    const ctx = m.keyAgg(pubkeys);
    assertEq(m.aggregateXonly(ctx).toString('hex').toUpperCase(), tc.expected.toUpperCase());
  }
});

test('partial signing matches BIP327 vectors', () => {
  for (const tc of sv.valid_test_cases) {
    const pubkeys = tc.key_indices.map((i) => hexBuf(sv.pubkeys[i]));
    const ctx = m.keyAgg(pubkeys);
    const aggnonce = hexBuf(sv.aggnonces[tc.aggnonce_index]);
    const msg = hexBuf(sv.msgs[tc.msg_index]);
    const session = m.sessionValues(aggnonce, ctx, msg, null);
    const secnonce = hexBuf(sv.secnonces[0]); // signer's secret nonce
    const psig = m.partialSign(secnonce, hexBuf(sv.sk), ctx, session);
    assertEq(psig.toString('hex').toUpperCase(), tc.expected.toUpperCase(), `case key_indices=${tc.key_indices}`);
  }
});

test('x-only tweak (taproot) partial signing matches BIP327 vectors', () => {
  const tv = JSON.parse(fs.readFileSync(path.join(__dirname, 'bip327-tweak-vectors.json'), 'utf8'));
  const tc = tv.valid_test_cases[0]; // single x-only tweak
  const pubkeys = tc.key_indices.map((i) => hexBuf(tv.pubkeys[i]));
  let ctx = m.keyAgg(pubkeys);
  tc.tweak_indices.forEach((ti, j) => { ctx = m.applyTweak(ctx, hexBuf(tv.tweaks[ti]), tc.is_xonly[j]); });
  const aggnonce = hexBuf(tv.aggnonce);
  const msg = hexBuf(tv.msg);
  const session = m.sessionValues(aggnonce, ctx, msg, null);
  const psig = m.partialSign(hexBuf(tv.secnonce), hexBuf(tv.sk), ctx, session);
  assertEq(psig.toString('hex').toUpperCase(), tc.expected.toUpperCase());
});

test('2-party MuSig2 aggregates to a valid BIP340 signature (no adaptor)', () => {
  const skA = a.mod(a.bufToBig(crypto.randomBytes(32)), a.N);
  const skB = a.mod(a.bufToBig(crypto.randomBytes(32)), a.N);
  const pkA = m.cbytes(a.pointMul(a.G, skA));
  const pkB = m.cbytes(a.pointMul(a.G, skB));
  const ctx = m.keyAgg([pkA, pkB]);
  const msg = crypto.randomBytes(32);

  // deterministic-but-unique nonces for the test
  const mk = () => { const k1 = a.mod(a.bufToBig(crypto.randomBytes(32)), a.N); const k2 = a.mod(a.bufToBig(crypto.randomBytes(32)), a.N);
    return { sec: Buffer.concat([a.bytes32(k1), a.bytes32(k2)]), pub: Buffer.concat([m.cbytes(a.pointMul(a.G, k1)), m.cbytes(a.pointMul(a.G, k2))]) }; };
  const nA = mk(); const nB = mk();
  const aggnonce = m.nonceAgg([nA.pub, nB.pub]);
  const session = m.sessionValues(aggnonce, ctx, msg, null);
  const psA = m.partialSign(nA.sec, a.bytes32(skA), ctx, session);
  const psB = m.partialSign(nB.sec, a.bytes32(skB), ctx, session);
  const sig = m.partialSigAgg([psA, psB], ctx, session);
  assert(a.schnorrVerify(m.aggregateXonly(ctx), msg, sig), 'aggregate signature must verify against the aggregate key');
});

test('2-party adaptor: needs both partials AND the oracle scalar to settle', () => {
  const skA = a.mod(a.bufToBig(crypto.randomBytes(32)), a.N);
  const skB = a.mod(a.bufToBig(crypto.randomBytes(32)), a.N);
  const pkA = m.cbytes(a.pointMul(a.G, skA));
  const pkB = m.cbytes(a.pointMul(a.G, skB));
  const ctx = m.keyAgg([pkA, pkB]);
  const msg = crypto.randomBytes(32);

  const outcomeMsg = crypto.createHash('sha256').update('settle-loss').digest();
  const oracle = a.buildDlcOracle(
    a.mod(a.bufToBig(crypto.randomBytes(32)), a.N),
    a.mod(a.bufToBig(crypto.randomBytes(32)), a.N),
    { eventId: 'musig2-adaptor-test', outcomeMessages: [outcomeMsg] }
  );
  const T = a.dlcOutcomePoint(oracle, outcomeMsg);

  const mk = () => { const k1 = a.mod(a.bufToBig(crypto.randomBytes(32)), a.N); const k2 = a.mod(a.bufToBig(crypto.randomBytes(32)), a.N);
    return { sec: Buffer.concat([a.bytes32(k1), a.bytes32(k2)]), pub: Buffer.concat([m.cbytes(a.pointMul(a.G, k1)), m.cbytes(a.pointMul(a.G, k2))]) }; };
  const nA = mk(); const nB = mk();
  const aggnonce = m.nonceAgg([nA.pub, nB.pub]);
  const session = m.sessionValues(aggnonce, ctx, msg, T);
  const psA = m.partialSign(nA.sec, a.bytes32(skA), ctx, session);
  const psB = m.partialSign(nB.sec, a.bytes32(skB), ctx, session);

  // pre-signature (both partials) is NOT a valid signature on its own
  const preAgg = m.partialSigAggAdaptor([psA, psB], ctx, session);
  const preAsSig = Buffer.concat([hexBuf(preAgg.rx), hexBuf(preAgg.sPrime)]);
  assert(!a.schnorrVerify(m.aggregateXonly(ctx), msg, preAsSig), 'pre-signature must not verify without the oracle');

  // oracle attestation completes it into a valid signature
  const t = a.dlcAttest(oracle, outcomeMsg);
  const sig = m.adaptorCompleteMuSig(preAgg, t);
  assert(a.schnorrVerify(m.aggregateXonly(ctx), msg, sig), 'completed 2-party signature must verify');

  // one party alone (missing the other partial) cannot reach a valid signature
  const soloPre = m.partialSigAggAdaptor([psA], ctx, session);
  const soloSig = m.adaptorCompleteMuSig(soloPre, t);
  assert(!a.schnorrVerify(m.aggregateXonly(ctx), msg, soloSig), 'a single party must not be able to settle alone');
});

// DLC-8: malformed or hostile inputs are refused with an explicit error,
// never a TypeError from deep inside the arithmetic.
function expectRefusal(run, expected, label) {
  let error = null;
  try { run(); } catch (err) { error = err; }
  assert(error, `${label} was accepted`);
  assert(!(error instanceof TypeError), `${label} crashed: ${error.message}`);
  if (expected) assert(error.message.includes(expected), `${label}: unexpected error ${error.message}`);
}

test('DLC-8: BIP327 sign error vectors are refused', () => {
  assert(sv.sign_error_test_cases.length >= 6, 'sign error vectors are missing');
  for (const tc of sv.sign_error_test_cases) {
    expectRefusal(() => {
      const ctx = m.keyAgg(tc.key_indices.map((i) => hexBuf(sv.pubkeys[i])));
      const session = m.sessionValues(hexBuf(sv.aggnonces[tc.aggnonce_index]), ctx, hexBuf(sv.msgs[tc.msg_index]), null);
      m.partialSign(hexBuf(sv.secnonces[tc.secnonce_index]), hexBuf(sv.sk), ctx, session);
    }, tc.error.message || null, tc.comment);
  }
});

test('DLC-8: an adaptor nonce at infinity and out-of-range secrets are refused', () => {
  const skA = 0x1234n;
  const skB = 0x5678n;
  const ctx = m.keyAgg([m.cbytes(a.pointMul(a.G, skA)), m.cbytes(a.pointMul(a.G, skB))]);
  const msg = crypto.createHash('sha256').update('dlc-8').digest();
  const nonce = (k1, k2) => ({
    sec: Buffer.concat([a.bytes32(k1), a.bytes32(k2)]),
    pub: Buffer.concat([m.cbytes(a.pointMul(a.G, k1)), m.cbytes(a.pointMul(a.G, k2))])
  });
  const nA = nonce(11n, 13n);
  const nB = nonce(17n, 19n);
  const aggnonce = m.nonceAgg([nA.pub, nB.pub]);
  // A co-signer that knows the adaptor point can aim R + T at infinity.
  const plain = m.sessionValues(aggnonce, ctx, msg, null);
  expectRefusal(() => m.sessionValues(aggnonce, ctx, msg, a.pointNegate(plain.Reff)), 'point at infinity', 'R + T at infinity');
  const session = m.sessionValues(aggnonce, ctx, msg, a.pointMul(a.G, 23n));
  expectRefusal(() => m.partialSign(Buffer.concat([a.bytes32(0n), a.bytes32(13n)]), a.bytes32(skA), ctx, session),
    'first secnonce value is out of range', 'zero first nonce');
  expectRefusal(() => m.partialSign(Buffer.concat([a.bytes32(11n), a.bytes32(a.N)]), a.bytes32(skA), ctx, session),
    'second secnonce value is out of range', 'second nonce equal to n');
  expectRefusal(() => m.partialSign(nA.sec, a.bytes32(0n), ctx, session), 'secret key value is out of range', 'zero secret key');
  expectRefusal(() => m.partialSign(nA.sec, a.bytes32(0x9abcn), ctx, session),
    'must be included in the list of pubkeys', 'signer outside the key set');
  expectRefusal(() => m.partialSign(Buffer.concat([nA.sec, m.cbytes(a.pointMul(a.G, skB))]), a.bytes32(skA), ctx, session),
    'does not match', 'secnonce for another key');
  expectRefusal(() => m.partialSign(nA.sec.slice(0, 63), a.bytes32(skA), ctx, session), 'secnonce must be', 'short secnonce');
  // The honest signer still signs.
  assert(m.partialSign(nA.sec, a.bytes32(skA), ctx, session).length === 32);
});

if (failed > 0) { console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`); process.exit(1); }
console.log(`\nPASS: ${passed} tests\n`);
