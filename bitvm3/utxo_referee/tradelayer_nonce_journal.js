/**
 * MuSig2/adaptor nonce-session journal (SECURITY_BLOCKERS.md #2).
 *
 * MuSig2 partial signing (tradelayer_musig2.js `partialSign`) takes an
 * externally-generated secret nonce per session - unlike single-party BIP340
 * signing in tradelayer_dlc_adaptor_sig.js, which derives its nonce
 * deterministically from (secret, message) and so can never reuse a nonce
 * across two different messages. A MuSig2 secnonce carries no such
 * protection: if the same secnonce is ever used to produce partial
 * signatures over two DIFFERENT messages (e.g. because a caller retried
 * after a crash and re-derived/reused nonce material), the private key is
 * recoverable by simple linear algebra from the two partial signatures.
 *
 * This journal makes that impossible by construction: before a partial
 * signature is released for a given secnonce, the (nonce, message) pair is
 * durably persisted to disk *first*. A later call with the SAME secnonce
 * and the SAME message is a safe, idempotent replay (returns without
 * re-signing anything new). A later call with the SAME secnonce and a
 * DIFFERENT message is refused outright, before any signature is computed.
 *
 * Only fingerprints (SHA256 hashes) of the nonce and message are persisted,
 * never the raw secret nonce material, so the journal file itself is safe
 * to keep around as an audit trail.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_JOURNAL_PATH = path.join(__dirname, 'artifacts', 'live', 'nonce_journal.json');

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).digest('hex');
}

function loadJournal(journalPath) {
  if (!fs.existsSync(journalPath)) return {};
  return JSON.parse(fs.readFileSync(journalPath, 'utf8'));
}

// Write-then-rename so a crash mid-write can never leave a half-written,
// unparseable journal file behind.
function saveJournalAtomic(journalPath, journal) {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const tmp = `${journalPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(journal, null, 2) + '\n');
  fs.renameSync(tmp, journalPath);
}

class NonceReuseError extends Error {
  constructor(nonceKey, message32Key, existing) {
    super(
      `NONCE_REUSE_DETECTED: this secnonce (fingerprint ${nonceKey.slice(0, 16)}...) was already ` +
      `committed to a different message (fingerprint ${existing.messageKey.slice(0, 16)}... ` +
      `at ${existing.firstUsedAt}); refusing to sign message ${message32Key.slice(0, 16)}... ` +
      `with the same nonce - completing this would leak the private key.`
    );
    this.name = 'NonceReuseError';
    this.nonceKey = nonceKey;
    this.attemptedMessageKey = message32Key;
    this.existing = existing;
  }
}

/**
 * Reserve a (secnonce, msg32) pair BEFORE signing.
 * Returns { reused: false } on first use (journal updated on disk before
 * returning), or { reused: true } on an idempotent replay of the exact same
 * pair. Throws NonceReuseError if the nonce was already committed to a
 * different message - callers MUST NOT sign in that case.
 */
function reserveNonceUsage(secnonce, msg32, options = {}) {
  const journalPath = options.journalPath || DEFAULT_JOURNAL_PATH;
  const nonceKey = sha256Hex(secnonce);
  const messageKey = sha256Hex(msg32);

  const journal = loadJournal(journalPath);
  const existing = journal[nonceKey];

  if (existing === undefined) {
    journal[nonceKey] = { messageKey, firstUsedAt: new Date().toISOString() };
    saveJournalAtomic(journalPath, journal);
    return { reused: false, nonceKey, messageKey };
  }

  if (existing.messageKey === messageKey) {
    return { reused: true, nonceKey, messageKey };
  }

  throw new NonceReuseError(nonceKey, messageKey, existing);
}

module.exports = {
  reserveNonceUsage,
  NonceReuseError,
  DEFAULT_JOURNAL_PATH,
  sha256Hex,
  // exposed for tests only - not part of the intended external API
  _loadJournal: loadJournal
};
