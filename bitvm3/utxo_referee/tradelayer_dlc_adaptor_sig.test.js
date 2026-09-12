/**
 * Run: node bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig.test.js
 */

const crypto = require('crypto');
const {
  N, G, pointMul, pointAdd,
  xOnlyPubkey, schnorrSign, schnorrVerify,
  adaptorSign, adaptorVerify, adaptorComplete, adaptorExtract,
  buildDlcOracle, dlcOutcomePoint, dlcAttest,
  bytes32, bufToBig
} = require('./tradelayer_dlc_adaptor_sig');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEq(a, e, m) { if (a !== e) throw new Error(m || `expected ${e}, got ${a}`); }

function randScalar() {
  return mod1(bufToBig(crypto.randomBytes(32)));
}
function mod1(x) { const r = x % N; return r > 0n ? r : r + 1n; }

// Node libsecp256k1 public key (uncompressed) for cross-checking our point math.
function nodePub(d) {
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(bytes32(d));
  const pub = ecdh.getPublicKey(); // 04 || X(32) || Y(32)
  return { x: bufToBig(pub.slice(1, 33)), y: bufToBig(pub.slice(33, 65)) };
}

console.log('\n=== TradeLayer DLC Adaptor Signature Tests ===\n');

test('scalar multiplication matches Node libsecp256k1 (ECDH) for random keys', () => {
  for (let i = 0; i < 12; i++) {
    const d = randScalar();
    const mine = pointMul(G, d);
    const theirs = nodePub(d);
    assert(mine.x === theirs.x && mine.y === theirs.y, `point mismatch at i=${i}`);
  }
});

test('group order and homomorphism hold', () => {
  assert(pointMul(G, N) === null, 'N*G must be the point at infinity');
  const a = randScalar();
  const b = randScalar();
  const lhs = pointMul(G, (a + b) % N);
  const rhs = pointAdd(pointMul(G, a), pointMul(G, b));
  assert(lhs.x === rhs.x && lhs.y === rhs.y, '(a+b)G must equal aG+bG');
});

test('BIP340 public key for secret=3 matches the published vector', () => {
  const px = xOnlyPubkey(3n).toString('hex').toUpperCase();
  assertEq(px, 'F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9');
});

test('schnorr sign/verify round-trips and rejects tampering', () => {
  const d = randScalar();
  const px = xOnlyPubkey(d);
  const msg = crypto.randomBytes(32);
  const sig = schnorrSign(d, msg);
  assert(schnorrVerify(px, msg, sig), 'valid signature must verify');

  const badMsg = crypto.randomBytes(32);
  assert(!schnorrVerify(px, badMsg, sig), 'wrong message must fail');
  const badSig = Buffer.from(sig); badSig[40] ^= 0x01;
  assert(!schnorrVerify(px, msg, badSig), 'tampered signature must fail');
});

test('adaptor pre-signature is not a valid signature on its own', () => {
  const d = randScalar();
  const px = xOnlyPubkey(d);
  const msg = crypto.randomBytes(32);
  const t = randScalar();
  const T = pointMul(G, t);
  const presig = adaptorSign(d, msg, T);
  assert(adaptorVerify(px, msg, presig), 'adaptor pre-sig must verify as a pre-sig');
  // the pre-sig scalar used directly as a BIP340 signature must NOT verify
  const fakeSig = Buffer.concat([Buffer.from(presig.rx, 'hex'), Buffer.from(presig.s0, 'hex')]);
  assert(!schnorrVerify(px, msg, fakeSig), 'pre-sig must not be a valid signature without the attestation');
});

test('only the oracle attestation completes the adaptor into a valid signature', () => {
  const d = randScalar();
  const px = xOnlyPubkey(d);
  const msg = crypto.randomBytes(32);
  const t = randScalar();          // oracle outcome secret
  const T = pointMul(G, t);        // announced outcome point
  const presig = adaptorSign(d, msg, T);

  const sig = adaptorComplete(presig, t);
  assert(schnorrVerify(px, msg, sig), 'completed signature must be a valid BIP340 signature');

  // a wrong attestation scalar must not even be accepted for completion
  let threw = false;
  try { adaptorComplete(presig, (t + 1n) % N); } catch (e) { threw = /does not match/.test(e.message); }
  assert(threw, 'wrong attestation scalar must be rejected');
});

test('completing the adaptor reveals the oracle scalar (extractable)', () => {
  const d = randScalar();
  const msg = crypto.randomBytes(32);
  const t = randScalar();
  const T = pointMul(G, t);
  const presig = adaptorSign(d, msg, T);
  const sig = adaptorComplete(presig, t);
  const extracted = adaptorExtract(presig, sig);
  assertEq(extracted, t, 'extracted oracle scalar must equal t');
});

test('oracle attestation scalar matches the announced outcome point', () => {
  const oracle = buildDlcOracle(randScalar(), randScalar());
  const msg = crypto.createHash('sha256').update('settle-loss').digest();
  const T = dlcOutcomePoint(oracle, msg);
  const t = dlcAttest(oracle, msg);
  const tG = pointMul(G, t);
  assert(tG.x === T.x && tG.y === T.y, 't*G must equal the announced outcome point T');
});

test('end-to-end DLC: only the attested outcome CET signature completes', () => {
  // party that co-signs each outcome CET
  const partySecret = randScalar();
  const partyPx = xOnlyPubkey(partySecret);
  // oracle announcement (px, rx) published up front
  const oracle = buildDlcOracle(randScalar(), randScalar());

  const outcomes = ['settle-gain', 'settle-loss', 'roll'];
  // each outcome has a distinct CET sighash message and outcome point
  const perOutcome = outcomes.map((id) => {
    const cetMsg = crypto.createHash('sha256').update(`cet:${id}`).digest();
    const outcomeMsg = crypto.createHash('sha256').update(id).digest();
    const T = dlcOutcomePoint(oracle, outcomeMsg);
    const presig = adaptorSign(partySecret, cetMsg, T);
    assert(adaptorVerify(partyPx, cetMsg, presig), `${id} pre-sig must verify`);
    return { id, cetMsg, outcomeMsg, presig };
  });

  // oracle attests the realized outcome
  const realized = 'settle-loss';
  const attested = perOutcome.find((o) => o.id === realized);
  const t = dlcAttest(oracle, attested.outcomeMsg);

  // the attested CET completes into a valid BIP340 signature
  const sig = adaptorComplete(attested.presig, t);
  assert(schnorrVerify(partyPx, attested.cetMsg, sig), 'attested CET signature must be valid');

  // the oracle scalar for the wrong outcomes does not match their adaptor points,
  // so their CETs cannot be completed with this attestation
  for (const o of perOutcome.filter((x) => x.id !== realized)) {
    let threw = false;
    try { adaptorComplete(o.presig, t); } catch (e) { threw = /does not match/.test(e.message); }
    assert(threw, `${o.id} CET must not complete with the settle-loss attestation`);
  }
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}
console.log(`\nPASS: ${passed} tests\n`);
