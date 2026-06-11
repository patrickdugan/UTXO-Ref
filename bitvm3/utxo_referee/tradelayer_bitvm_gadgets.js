/**
 * TradeLayer BitVM gadgets (Bitcoin Script enforcement)
 *
 * Turns a referee challenge from an evidence object into a real Bitcoin Script
 * constraint. The foundational BitVM primitive is a *bit commitment*: a prover
 * commits to a bit b by publishing hash0 = SHA256(preimage0) and
 * hash1 = SHA256(preimage1); asserting b reveals the matching preimage.
 *
 * The equivocation-punishment leaf is a tapscript that is spendable only by
 * revealing BOTH preimages, i.e. only if the prover equivocated (asserted the
 * committed bit as both 0 and 1). A challenger who collects both preimages can
 * take the bonded output on-chain. This is the enforcement the JS referee
 * predicates previously only described.
 */

const crypto = require('crypto');

const OP_SHA256 = 0xa8;
const OP_EQUALVERIFY = 0x88;
const OP_CHECKSIG = 0xac;
const OP_PUSH32 = 0x20;

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest(); }

// A BitVM bit commitment: two preimages and their SHA256 digests.
function buildBitCommitment(seed) {
  const base = seed ? Buffer.from(seed) : crypto.randomBytes(32);
  const preimage0 = sha256(Buffer.concat([base, Buffer.from('bit:0')]));
  const preimage1 = sha256(Buffer.concat([base, Buffer.from('bit:1')]));
  return {
    preimage0: preimage0.toString('hex'),
    preimage1: preimage1.toString('hex'),
    hash0: sha256(preimage0).toString('hex'),
    hash1: sha256(preimage1).toString('hex')
  };
}

// Reveal a bit value as the preimage the verifier (or script) checks.
function revealBit(commitment, bit) {
  return bit ? commitment.preimage1 : commitment.preimage0;
}

/**
 * Tapscript that pays the challenger iff BOTH committed preimages are revealed
 * (equivocation) AND the challenger signs.
 *
 *   OP_SHA256 <hash1> OP_EQUALVERIFY   // top witness item is preimage1
 *   OP_SHA256 <hash0> OP_EQUALVERIFY   // next witness item is preimage0
 *   <challengerXonly> OP_CHECKSIG
 *
 * Witness (bottom -> top): [challengerSig, preimage0, preimage1, <script>, <control block>]
 */
function buildEquivocationPunishmentScript({ hash0, hash1, challengerXonly }) {
  const h0 = Buffer.from(hash0, 'hex');
  const h1 = Buffer.from(hash1, 'hex');
  const pk = Buffer.from(challengerXonly, 'hex');
  if (h0.length !== 32 || h1.length !== 32) throw new Error('hash0/hash1 must be 32 bytes');
  if (pk.length !== 32) throw new Error('challengerXonly must be 32 bytes (BIP340)');
  return Buffer.concat([
    Buffer.from([OP_SHA256, OP_PUSH32]), h1, Buffer.from([OP_EQUALVERIFY]),
    Buffer.from([OP_SHA256, OP_PUSH32]), h0, Buffer.from([OP_EQUALVERIFY]),
    Buffer.from([OP_PUSH32]), pk, Buffer.from([OP_CHECKSIG])
  ]).toString('hex');
}

// Witness stack for the equivocation spend (script + control block appended by caller).
function buildEquivocationWitness({ challengerSigHex, preimage0, preimage1 }) {
  return [challengerSigHex, preimage0, preimage1];
}

module.exports = {
  OP_SHA256,
  OP_EQUALVERIFY,
  OP_CHECKSIG,
  sha256,
  buildBitCommitment,
  revealBit,
  buildEquivocationPunishmentScript,
  buildEquivocationWitness
};
