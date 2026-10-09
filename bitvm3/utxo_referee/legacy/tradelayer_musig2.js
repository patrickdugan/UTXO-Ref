/**
 * LEGACY - NOT PART OF THE PILOT SURFACE.
 *
 * The pilot DLC funding output is the two-leaf script-path output in
 * ../dlc_funding_output.js (2-of-2 CHECKSIGVERIFY/CHECKSIG, no key path), which
 * needs no interactive nonce exchange and therefore no nonce journal. This
 * module is kept for the BIP327 vector tests and the historical demo only.
 * Do not build new signing paths on it.
 *
 * TradeLayer MuSig2 (BIP327) with an adaptor offset
 *
 * Two-party (n-party) key aggregation + 2-round signing producing a single
 * BIP340 Schnorr signature, so a taproot keypath output can be a 2-of-2 that
 * neither party can spend alone. With an adaptor point T added to the aggregate
 * nonce, the aggregated pre-signature is completed only by the oracle scalar t
 * (t*G == T) - so settlement needs BOTH partial signatures AND the oracle
 * attestation. That is the DLC enforcement the single-key keypath spend lacked.
 *
 * KeyAgg, the session nonce coefficient, and PartialSign are validated against
 * the published BIP327 test vectors (tradelayer_musig2.test.js). Implemented on
 * Node built-ins via the secp256k1 primitives in tradelayer_dlc_adaptor_sig.js.
 */

const {
  N, G, mod, pointMul, pointAdd, pointNegate, liftX, taggedHash, bytes32, bufToBig, schnorrVerify
} = require('../tradelayer_dlc_adaptor_sig');
const { reserveNonceUsage } = require('./tradelayer_nonce_journal');

const FIELD_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;

function hasEvenY(point) { return mod(point.y, 2n) === 0n; }
function xbytes(point) { return bytes32(point.x); }

function cbytes(point) {
  if (point === null) return Buffer.alloc(33);
  return Buffer.concat([Buffer.from([hasEvenY(point) ? 0x02 : 0x03]), xbytes(point)]);
}

function cpoint(buf) {
  if (buf.length !== 33) throw new Error('cpoint: bad length');
  if (buf.equals(Buffer.alloc(33))) return null; // infinity
  const prefix = buf[0];
  const x = bufToBig(buf.slice(1, 33));
  const even = liftX(x); // even-y lift
  if (prefix === 0x02) return even;
  if (prefix === 0x03) return { x: even.x, y: mod(FIELD_P - even.y, FIELD_P) };
  throw new Error('cpoint: bad prefix');
}

// ---- key aggregation ----
function getSecondKey(pubkeys) {
  for (let i = 1; i < pubkeys.length; i++) {
    if (!pubkeys[i].equals(pubkeys[0])) return pubkeys[i];
  }
  return Buffer.alloc(33);
}

function keyAggCoeff(pubkeys, pk, secondKey) {
  if (pk.equals(secondKey)) return 1n;
  const L = taggedHash('KeyAgg list', Buffer.concat(pubkeys));
  return mod(bufToBig(taggedHash('KeyAgg coefficient', Buffer.concat([L, pk]))), N);
}

function keyAgg(pubkeys) {
  const secondKey = getSecondKey(pubkeys);
  let Q = null;
  for (const pk of pubkeys) {
    const a = keyAggCoeff(pubkeys, pk, secondKey);
    Q = pointAdd(Q, pointMul(cpoint(pk), a));
  }
  if (Q === null) throw new Error('keyAgg: infinite aggregate');
  return { Q, gacc: 1n, tacc: 0n, pubkeys, secondKey };
}

// Apply a tweak to the aggregate key (BIP327). For a taproot keypath output the
// tweak is TapTweak(x(Q)) with isXonly=true, yielding the taproot output key.
function applyTweak(ctx, tweak, isXonly) {
  const t = mod(bufToBig(tweak), N);
  if (bufToBig(tweak) >= N) throw new Error('tweak out of range');
  const g = (isXonly && !hasEvenY(ctx.Q)) ? N - 1n : 1n;
  const Q = pointAdd(pointMul(ctx.Q, g), pointMul(G, t));
  if (Q === null) throw new Error('applyTweak: infinite result');
  return {
    Q,
    gacc: mod(g * ctx.gacc, N),
    tacc: mod(t + g * ctx.tacc, N),
    pubkeys: ctx.pubkeys,
    secondKey: ctx.secondKey
  };
}

// ---- nonce aggregation ----
function nonceAgg(pubnonces) {
  const parts = [];
  for (let j = 0; j < 2; j++) {
    let R = null;
    for (const pn of pubnonces) {
      R = pointAdd(R, cpoint(pn.slice(33 * j, 33 * j + 33)));
    }
    parts.push(cbytes(R));
  }
  return Buffer.concat(parts);
}

// ---- session values (with optional adaptor point T) ----
function sessionValues(aggnonce, ctx, msg32, T = null) {
  const Qx = xbytes(ctx.Q);
  const b = mod(bufToBig(taggedHash('MuSig/noncecoef', Buffer.concat([aggnonce, Qx, msg32]))), N);
  const R1 = cpoint(aggnonce.slice(0, 33));
  const R2 = cpoint(aggnonce.slice(33, 66));
  let Reff = pointAdd(R1, R2 ? pointMul(R2, b) : null);
  if (Reff === null) Reff = G; // BIP327
  const Radapt = T ? pointAdd(Reff, T) : Reff;
  // DLC-8: a co-signer can choose its nonce so that R + T is infinity.
  if (Radapt === null) throw new Error('MuSig2 adaptor nonce R + T is the point at infinity');
  const bNeg = !hasEvenY(Radapt);
  const Rfinal = bNeg ? pointNegate(Radapt) : Radapt; // even-y, same x as Radapt
  const e = mod(bufToBig(taggedHash('BIP0340/challenge', Buffer.concat([xbytes(Rfinal), Qx, msg32]))), N);
  return { b, Reff, Radapt, Rfinal, e, bNeg };
}

// ---- partial signing ----
// Unguarded primitive, validated directly against BIP327 test vectors. Do
// NOT call this directly for real signing - a secnonce is caller-generated
// (unlike BIP340's deterministic per-message nonce), so nothing here stops
// the same secnonce being reused across two different messages, which
// leaks the private key. Use partialSignGuarded() below for anything that
// isn't a fixed-vector conformance test.
function partialSign(secnonce, sk, ctx, session) {
  // DLC-8: the BIP327 Sign input checks. A 97-byte secnonce carries the
  // signer's public key, which must match sk.
  if (!Buffer.isBuffer(secnonce) || (secnonce.length !== 64 && secnonce.length !== 97)) {
    throw new Error('secnonce must be a 64- or 97-byte Buffer');
  }
  if (!Buffer.isBuffer(sk) || sk.length !== 32) throw new Error('sk must be a 32-byte Buffer');
  const k1p = bufToBig(secnonce.slice(0, 32));
  const k2p = bufToBig(secnonce.slice(32, 64));
  if (k1p === 0n || k1p >= N) throw new Error('first secnonce value is out of range.');
  if (k2p === 0n || k2p >= N) throw new Error('second secnonce value is out of range.');
  const k1 = session.bNeg ? mod(N - k1p, N) : k1p;
  const k2 = session.bNeg ? mod(N - k2p, N) : k2p;
  const dp = bufToBig(sk);
  if (dp === 0n || dp >= N) throw new Error('secret key value is out of range.');
  const Ppoint = pointMul(G, dp);
  const pk = cbytes(Ppoint);
  if (secnonce.length === 97 && !secnonce.slice(64, 97).equals(pk)) {
    throw new Error('Public key does not match nonce_gen argument');
  }
  if (!ctx.pubkeys.some((key) => key.equals(pk))) {
    throw new Error("The signer's pubkey must be included in the list of pubkeys.");
  }
  const a = keyAggCoeff(ctx.pubkeys, pk, ctx.secondKey);
  const g = hasEvenY(ctx.Q) ? 1n : N - 1n;
  const d = mod(g * ctx.gacc % N * dp, N);
  const s = mod(k1 + session.b * k2 % N + session.e * a % N * d, N);
  return bytes32(s);
}

// SECURITY_BLOCKERS.md #2: same as partialSign(), but durably records the
// (secnonce, msg32) pair to the nonce journal BEFORE computing/releasing
// anything. Reusing secnonce over a different msg32 throws NonceReuseError
// instead of silently signing - this is the entry point real signing code
// (demos, any future production path) should use.
//
// The journal is keyed on the whole signing session, not on msg32 alone. A
// partial signature is s = k1 + b*k2 + e*a*d, and b and e depend on the
// aggregate nonce and key as well as the message. Journalling only msg32 let
// a co-signer replay the same message with a different public nonce: the
// journal reported an idempotent retry, the signer released a second partial
// signature with different (b, e), and the two equations gave up the key.
// A retry is now idempotent only when the session is identical.
function sessionBinding(ctx, session, msg32) {
  return taggedHash('UTXORef/musig2-session-binding', Buffer.concat([
    msg32,
    xbytes(ctx.Q),
    bytes32(session.b),
    bytes32(session.e),
    xbytes(session.Rfinal),
    Buffer.from([session.bNeg ? 1 : 0])
  ]));
}

function partialSignGuarded(secnonce, sk, ctx, session, msg32, journalOptions = {}) {
  if (!Buffer.isBuffer(msg32) || msg32.length !== 32) throw new Error('msg32 must be a 32-byte Buffer');
  // The caller-named message must be the one this session actually signs.
  const expectedE = mod(bufToBig(taggedHash('BIP0340/challenge',
    Buffer.concat([xbytes(session.Rfinal), xbytes(ctx.Q), msg32]))), N);
  if (session.e !== expectedE) throw new Error('MuSig2 session challenge does not commit to msg32');
  reserveNonceUsage(secnonce, sessionBinding(ctx, session, msg32), journalOptions);
  return partialSign(secnonce, sk, ctx, session);
}

// ---- aggregation ----
// Base BIP327 aggregation -> 64-byte BIP340 signature.
function partialSigAgg(psigs, ctx, session) {
  let s = 0n;
  for (const ps of psigs) s = mod(s + bufToBig(ps), N);
  s = mod(s + session.e * (hasEvenY(ctx.Q) ? 1n : N - 1n) % N * ctx.tacc, N);
  return Buffer.concat([xbytes(session.Rfinal), bytes32(s)]);
}

// Adaptor aggregation -> a pre-signature scalar s' (not yet a valid signature).
function partialSigAggAdaptor(psigs, ctx, session) {
  let s = 0n;
  for (const ps of psigs) s = mod(s + bufToBig(ps), N);
  s = mod(s + session.e * (hasEvenY(ctx.Q) ? 1n : N - 1n) % N * ctx.tacc, N);
  return { rx: xbytes(session.Rfinal).toString('hex'), sPrime: bytes32(s).toString('hex'), bNeg: session.bNeg };
}

// Complete the adaptor pre-signature with the oracle scalar t (t*G == T).
function adaptorCompleteMuSig(preAgg, attestationScalar) {
  const t = mod(typeof attestationScalar === 'bigint' ? attestationScalar : bufToBig(attestationScalar), N);
  const sPrime = bufToBig(Buffer.from(preAgg.sPrime, 'hex'));
  const s = preAgg.bNeg ? mod(sPrime - t, N) : mod(sPrime + t, N);
  return Buffer.concat([Buffer.from(preAgg.rx, 'hex'), bytes32(s)]);
}

module.exports = {
  cpoint,
  cbytes,
  keyAgg,
  keyAggCoeff,
  applyTweak,
  nonceAgg,
  sessionValues,
  partialSign,
  partialSignGuarded,
  partialSigAgg,
  partialSigAggAdaptor,
  adaptorCompleteMuSig,
  xbytes,
  aggregateXonly: (ctx) => xbytes(ctx.Q),
  schnorrVerify
};
