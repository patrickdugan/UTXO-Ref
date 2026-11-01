/**
 * Recompute-and-compare for challenge envelopes.
 *
 * A challenge is { kind, challengeHash, challengeable, core }. The hash commits to
 * the core, and `challengeable` is a function of the core (plus any state the
 * verifier holds). Verifiers recompute both and reject a mismatch. A label kept
 * beside the core, such as a top-level challengeType, must equal the hashed copy.
 */

const { sha256Hex } = require('./tradelayer_pnl_route_adapter');

function verifyChallengeVerdict(challenge, { kind, coreKind, hashField = 'challengeHash', labelField = null, verdict }) {
  if (!challenge || challenge.kind !== kind) return { ok: false, reason: 'wrong challenge kind' };
  if (!challenge.core || typeof challenge.core !== 'object') return { ok: false, reason: 'challenge core missing' };
  if (challenge.core.kind !== coreKind) return { ok: false, reason: 'challenge core kind mismatch' };
  if (labelField && challenge[labelField] !== challenge.core[labelField]) {
    return { ok: false, reason: `challenge ${labelField} does not match its core` };
  }
  const challengeHash = sha256Hex(challenge.core);
  if (challenge[hashField] !== challengeHash) return { ok: false, reason: 'challenge hash mismatch', challengeHash };
  const challengeable = verdict(challenge.core) === true;
  if (challenge.challengeable !== challengeable) {
    return { ok: false, reason: 'challenge verdict does not follow from its core', challengeHash };
  }
  return { ok: true, challengeHash, challengeable };
}

module.exports = { verifyChallengeVerdict };
