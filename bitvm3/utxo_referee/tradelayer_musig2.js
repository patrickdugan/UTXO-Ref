/**
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
} = require('./tradelayer_dlc_adaptor_sig');

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
  const bNeg = !hasEvenY(Radapt);
  const Rfinal = bNeg ? pointNegate(Radapt) : Radapt; // even-y, same x as Radapt
  const e = mod(bufToBig(taggedHash('BIP0340/challenge', Buffer.concat([xbytes(Rfinal), Qx, msg32]))), N);
  return { b, Reff, Radapt, Rfinal, e, bNeg };
}

// ---- partial signing ----
function partialSign(secnonce, sk, ctx, session) {
  const k1p = bufToBig(secnonce.slice(0, 32));
  const k2p = bufToBig(secnonce.slice(32, 64));
  const k1 = session.bNeg ? mod(N - k1p, N) : k1p;
  const k2 = session.bNeg ? mod(N - k2p, N) : k2p;
  const dp = mod(bufToBig(sk), N);
  const Ppoint = pointMul(G, dp);
  const a = keyAggCoeff(ctx.pubkeys, cbytes(Ppoint), ctx.secondKey);
  const g = hasEvenY(ctx.Q) ? 1n : N - 1n;
  const d = mod(g * ctx.gacc % N * dp, N);
  const s = mod(k1 + session.b * k2 % N + session.e * a % N * d, N);
  return bytes32(s);
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
  partialSigAgg,
  partialSigAggAdaptor,
  adaptorCompleteMuSig,
  xbytes,
  aggregateXonly: (ctx) => xbytes(ctx.Q),
  schnorrVerify
};
