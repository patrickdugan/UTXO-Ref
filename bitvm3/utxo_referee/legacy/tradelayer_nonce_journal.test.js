/**
 * Run: node bitvm3/utxo_referee/legacy/tradelayer_nonce_journal.test.js
 *
 * Validates SECURITY_BLOCKERS.md #2's fix: a MuSig2 secnonce can safely be
 * reused for the exact same message (idempotent retry), but reusing it for
 * a different message must be refused outright, before any signature is
 * computed - because that's exactly the pattern that leaks a private key.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { reserveNonceUsage, NonceReuseError, _loadJournal } = require('./tradelayer_nonce_journal');
const m = require('./tradelayer_musig2');
const a = require('../tradelayer_dlc_adaptor_sig');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }

const TMP_DIR = path.join(__dirname, '..', 'artifacts', 'live', 'test-tmp');
function freshJournalPath(name) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const p = path.join(TMP_DIR, `nonce_journal_test_${name}_${process.pid}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return p;
}

console.log('\n=== TradeLayer Nonce Journal Tests (SECURITY_BLOCKERS.md #2) ===\n');

test('first use of a nonce is recorded and reported as not-reused', () => {
  const journalPath = freshJournalPath('first-use');
  const nonce = crypto.randomBytes(64);
  const msg = crypto.randomBytes(32);
  const result = reserveNonceUsage(nonce, msg, { journalPath });
  assert(result.reused === false, 'first use should not be flagged as reused');
  const onDisk = _loadJournal(journalPath);
  assert(Object.keys(onDisk).length === 1, 'journal should have exactly one entry after first use');
});

test('same nonce + same message is a safe idempotent replay', () => {
  const journalPath = freshJournalPath('idempotent');
  const nonce = crypto.randomBytes(64);
  const msg = crypto.randomBytes(32);
  const first = reserveNonceUsage(nonce, msg, { journalPath });
  const second = reserveNonceUsage(nonce, msg, { journalPath });
  assert(first.reused === false, 'first call should not be reused');
  assert(second.reused === true, 'second call with identical (nonce, message) should be an idempotent replay');
});

test('same nonce + different message throws NonceReuseError', () => {
  const journalPath = freshJournalPath('reuse-detected');
  const nonce = crypto.randomBytes(64);
  const msgA = crypto.randomBytes(32);
  const msgB = crypto.randomBytes(32);
  reserveNonceUsage(nonce, msgA, { journalPath });
  let threw = null;
  try {
    reserveNonceUsage(nonce, msgB, { journalPath });
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof NonceReuseError, 'expected a NonceReuseError to be thrown');
  assert(/NONCE_REUSE_DETECTED/.test(threw.message), 'error message should flag nonce reuse clearly');
});

test('different nonces for different messages never collide', () => {
  const journalPath = freshJournalPath('no-false-positive');
  for (let i = 0; i < 5; i++) {
    const nonce = crypto.randomBytes(64);
    const msg = crypto.randomBytes(32);
    const result = reserveNonceUsage(nonce, msg, { journalPath });
    assert(result.reused === false, `iteration ${i}: fresh nonce+message should never be flagged as reused`);
  }
});

test('journal persists raw fingerprints only, never the raw nonce bytes', () => {
  const journalPath = freshJournalPath('no-secret-leak');
  const nonce = crypto.randomBytes(64);
  const msg = crypto.randomBytes(32);
  reserveNonceUsage(nonce, msg, { journalPath });
  const raw = fs.readFileSync(journalPath, 'utf8');
  assert(!raw.includes(nonce.toString('hex')), 'journal file must not contain the raw secnonce hex');
});

test('partialSignGuarded refuses to sign a second, different message under the same secnonce', () => {
  const journalPath = freshJournalPath('musig2-guarded');
  // Minimal 1-of-1 MuSig2 session (aggregation with one key is still valid MuSig2).
  const sk = a.mod(a.bufToBig(crypto.randomBytes(32)), a.N);
  const pk = m.cbytes(a.pointMul(a.G, sk));
  const ctx = m.keyAgg([pk]);

  function makeNonce() {
    const k1 = a.mod(a.bufToBig(crypto.randomBytes(32)), a.N);
    const k2 = a.mod(a.bufToBig(crypto.randomBytes(32)), a.N);
    return {
      sec: Buffer.concat([a.bytes32(k1), a.bytes32(k2)]),
      pub: Buffer.concat([m.cbytes(a.pointMul(a.G, k1)), m.cbytes(a.pointMul(a.G, k2))])
    };
  }

  const nonce = makeNonce();
  const aggnonce = m.nonceAgg([nonce.pub]);
  const msgA = crypto.randomBytes(32);
  const msgB = crypto.randomBytes(32);
  const sessionA = m.sessionValues(aggnonce, ctx, msgA);
  const sessionB = m.sessionValues(aggnonce, ctx, msgB);

  // First message: signs fine.
  m.partialSignGuarded(nonce.sec, a.bytes32(sk), ctx, sessionA, msgA, { journalPath });

  // Same nonce, same message again: safe idempotent replay, does not throw.
  m.partialSignGuarded(nonce.sec, a.bytes32(sk), ctx, sessionA, msgA, { journalPath });

  // Same nonce, DIFFERENT message: must throw before producing a signature.
  let threw = null;
  try {
    m.partialSignGuarded(nonce.sec, a.bytes32(sk), ctx, sessionB, msgB, { journalPath });
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof NonceReuseError, 'partialSignGuarded must refuse nonce reuse across different messages');
});

// DLC-2 regression (port of the readiness-assessment poc2). The co-signer
// replays the SAME message with a different public nonce. Under a
// message-keyed journal this looked like an idempotent retry and the two
// partial signatures solved for the victim's key.
test('partialSignGuarded refuses the same message in a different session (co-signer nonce replay)', () => {
  const journalPath = freshJournalPath('musig2-session-replay');
  const scalar = () => a.mod(a.bufToBig(crypto.randomBytes(32)), a.N - 1n) + 1n;
  const victimSk = scalar();
  const attackerSk = scalar();
  const victimPk = m.cbytes(a.pointMul(a.G, victimSk));
  const attackerPk = m.cbytes(a.pointMul(a.G, attackerSk));
  const ctx = m.keyAgg([victimPk, attackerPk]);
  const makeNonce = () => {
    const k1 = scalar();
    const k2 = scalar();
    return {
      sec: Buffer.concat([a.bytes32(k1), a.bytes32(k2)]),
      pub: Buffer.concat([m.cbytes(a.pointMul(a.G, k1)), m.cbytes(a.pointMul(a.G, k2))])
    };
  };
  const victimNonce = makeNonce();
  const msg = crypto.randomBytes(32);
  const sessionOne = m.sessionValues(m.nonceAgg([victimNonce.pub, makeNonce().pub]), ctx, msg);
  const sessionTwo = m.sessionValues(m.nonceAgg([victimNonce.pub, makeNonce().pub]), ctx, msg);
  assert(sessionOne.b !== sessionTwo.b || sessionOne.e !== sessionTwo.e, 'fixture sessions must differ');

  const first = m.partialSignGuarded(victimNonce.sec, a.bytes32(victimSk), ctx, sessionOne, msg, { journalPath });
  // An identical retry of the first session is still idempotent.
  const retry = m.partialSignGuarded(victimNonce.sec, a.bytes32(victimSk), ctx, sessionOne, msg, { journalPath });
  assert(first.equals(retry), 'identical session retry should return the same partial signature');

  let threw = null;
  let second = null;
  try {
    second = m.partialSignGuarded(victimNonce.sec, a.bytes32(victimSk), ctx, sessionTwo, msg, { journalPath });
  } catch (err) {
    threw = err;
  }
  assert(second === null, 'a second partial signature was released under the same secnonce');
  assert(threw instanceof NonceReuseError, 'same message in a different session must be refused as nonce reuse');
});

test('partialSignGuarded refuses a session whose challenge does not commit to the named message', () => {
  const journalPath = freshJournalPath('musig2-message-binding');
  const sk = a.mod(a.bufToBig(crypto.randomBytes(32)), a.N - 1n) + 1n;
  const ctx = m.keyAgg([m.cbytes(a.pointMul(a.G, sk))]);
  const k1 = a.mod(a.bufToBig(crypto.randomBytes(32)), a.N - 1n) + 1n;
  const k2 = a.mod(a.bufToBig(crypto.randomBytes(32)), a.N - 1n) + 1n;
  const sec = Buffer.concat([a.bytes32(k1), a.bytes32(k2)]);
  const pub = Buffer.concat([m.cbytes(a.pointMul(a.G, k1)), m.cbytes(a.pointMul(a.G, k2))]);
  const signedMessage = crypto.randomBytes(32);
  const journalledMessage = crypto.randomBytes(32);
  const session = m.sessionValues(m.nonceAgg([pub]), ctx, signedMessage);
  let threw = null;
  try {
    m.partialSignGuarded(sec, a.bytes32(sk), ctx, session, journalledMessage, { journalPath });
  } catch (err) {
    threw = err;
  }
  assert(threw && /does not commit to msg32/.test(threw.message), 'mismatched session/message was signed');
  assert(!fs.existsSync(journalPath), 'journal was written for a refused session');
});

console.log(`\nPASS: ${passed} tests${failed ? `, FAIL: ${failed}` : ''}`);
if (failed > 0) process.exit(1);
