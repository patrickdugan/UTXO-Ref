/**
 * Run: node bitvm3/utxo_referee/tradelayer_nonce_journal.test.js
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
const a = require('./tradelayer_dlc_adaptor_sig');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }

const TMP_DIR = path.join(__dirname, 'artifacts', 'live', 'test-tmp');
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

console.log(`\nPASS: ${passed} tests${failed ? `, FAIL: ${failed}` : ''}`);
if (failed > 0) process.exit(1);
