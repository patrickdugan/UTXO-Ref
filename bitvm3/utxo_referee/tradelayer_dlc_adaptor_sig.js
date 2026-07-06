/**
 * TradeLayer DLC Adaptor Signatures (secp256k1 / BIP340 Schnorr)
 *
 * The cryptographic core of a real DLC: an oracle pre-commits an outcome point
 * T = t*G for each outcome; a party publishes an *adaptor signature* (a
 * pre-signature) that is NOT a valid signature on its own. Only the oracle's
 * attestation scalar t (the discrete log of T) can complete it into a valid
 * BIP340 Schnorr signature. Completing it also lets anyone extract t.
 *
 * This replaces "the oracle selects a pre-built CET" with "the oracle's
 * attestation is mathematically required to produce the settling signature".
 *
 * Implemented from scratch on Node built-ins (the repo is zero-dependency).
 * The secp256k1 scalar multiplication is cross-checked against Node's ECDH
 * (libsecp256k1) in the test suite, and BIP340 sign/verify round-trips guard
 * the rest.
 *
 * SECURITY_BLOCKERS.md #1 (partial fix): every point multiplication in this
 * codebase where the *scalar is secret* (private key, nonce, oracle secret,
 * adaptor secret) is always a multiplication by the fixed generator G - see
 * `pointMul()` below. That specific operation is now routed through Node's
 * built-in `crypto.createECDH('secp256k1')`, which uses OpenSSL's
 * constant-time-ish scalar multiplication for named curves - a real security
 * improvement with zero new dependencies (still Node built-ins only).
 *
 * Arbitrary-point multiplication (scalar * P for P != G) remains pure JS and
 * variable-time. This is safe *in this codebase's actual usage* because every
 * such call multiplies a PUBLIC point by a PUBLIC scalar (verification math:
 * checking `sG - eP =? R` needs a public signature component `s` or `e`
 * against a public key `P` - nothing secret to leak via timing). It would NOT
 * be safe to reuse `pointMul` with a secret scalar against a non-generator
 * point without revisiting this - if a future change introduces that pattern,
 * route it through an audited library first (see SIGNER_MIGRATION_PLAN.md;
 * Node has no built-in for arbitrary-point constant-time multiplication with
 * a usable full-point output, only generator multiplication via ECDH.getPublicKey
 * and X-coordinate-only Diffie-Hellman via ECDH.computeSecret).
 */

const crypto = require('crypto');

// secp256k1 domain parameters
const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;
const G = { x: GX, y: GY };

function mod(a, m) {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function powMod(base, exp, m) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function invMod(a, m) {
  return powMod(mod(a, m), m - 2n, m); // m is prime (P or N)
}

// Affine point ops; null === point at infinity.
function isInf(point) {
  return point === null;
}

function pointAdd(p1, p2) {
  if (isInf(p1)) return p2;
  if (isInf(p2)) return p1;
  if (p1.x === p2.x) {
    if (mod(p1.y + p2.y, P) === 0n) return null; // p + (-p) = inf
    return pointDouble(p1);
  }
  const lambda = mod((p2.y - p1.y) * invMod(p2.x - p1.x, P), P);
  const x3 = mod(lambda * lambda - p1.x - p2.x, P);
  const y3 = mod(lambda * (p1.x - x3) - p1.y, P);
  return { x: x3, y: y3 };
}

function pointDouble(p1) {
  if (isInf(p1)) return null;
  if (p1.y === 0n) return null;
  const lambda = mod((3n * p1.x * p1.x) * invMod(2n * p1.y, P), P);
  const x3 = mod(lambda * lambda - 2n * p1.x, P);
  const y3 = mod(lambda * (p1.x - x3) - p1.y, P);
  return { x: x3, y: y3 };
}

// scalar * G via Node's built-in OpenSSL binding (crypto.createECDH), which
// uses a constant-time-ish implementation for named curves - unlike the pure
// JS double-and-add loop below, this does not leak scalar bits through
// data-dependent branching/timing. Node built-in only, no new dependency.
function pointMulGeneratorHardened(scalar) {
  const k = mod(scalar, N);
  if (k === 0n) return null; // 0*G = point at infinity
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(bytes32(k));
  const uncompressed = ecdh.getPublicKey(null, 'uncompressed'); // 0x04 || x(32) || y(32)
  return {
    x: bufToBig(uncompressed.subarray(1, 33)),
    y: bufToBig(uncompressed.subarray(33, 65))
  };
}

function isGenerator(point) {
  return point != null && point.x === GX && point.y === GY;
}

function pointMul(point, scalar) {
  if (isGenerator(point)) return pointMulGeneratorHardened(scalar);
  // Arbitrary-point multiplication: variable-time, but every call site in
  // this codebase multiplies a PUBLIC point by a PUBLIC scalar (signature
  // verification math) - see the file header note on this trade-off.
  let result = null;
  let addend = point;
  let k = mod(scalar, N);
  while (k > 0n) {
    if (k & 1n) result = pointAdd(result, addend);
    addend = pointDouble(addend);
    k >>= 1n;
  }
  return result;
}

function pointNegate(point) {
  if (isInf(point)) return null;
  return { x: point.x, y: mod(-point.y, P) };
}

function hasEvenY(point) {
  return mod(point.y, 2n) === 0n;
}

function onCurve(point) {
  if (isInf(point)) return true;
  return mod(point.y * point.y - point.x * point.x * point.x - 7n, P) === 0n;
}

// ---- byte helpers ----
function bytes32(value) {
  return Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
}

function bufToBig(buf) {
  return BigInt('0x' + Buffer.from(buf).toString('hex'));
}

function liftX(x) {
  if (x <= 0n || x >= P) throw new Error('liftX: x out of range');
  const c = mod(x * x * x + 7n, P);
  const y = powMod(c, (P + 1n) / 4n, P);
  if (mod(y * y, P) !== c) throw new Error('liftX: x is not on the curve');
  return { x, y: mod(y, 2n) === 0n ? y : P - y };
}

function taggedHash(tag, ...buffers) {
  const tagHash = crypto.createHash('sha256').update(tag).digest();
  const h = crypto.createHash('sha256').update(tagHash).update(tagHash);
  for (const b of buffers) h.update(b);
  return h.digest();
}

function challenge(rx, px, msg32) {
  return mod(bufToBig(taggedHash('BIP0340/challenge', bytes32(rx), bytes32(px), msg32)), N);
}

// ---- BIP340 Schnorr ----
function xOnlyPubkey(secret) {
  const d0 = mod(secret, N);
  if (d0 === 0n) throw new Error('invalid secret');
  const Ppoint = pointMul(G, d0);
  return bytes32(Ppoint.x);
}

function schnorrSign(secret, msg32, aux32 = Buffer.alloc(32)) {
  const d0 = mod(secret, N);
  if (d0 === 0n) throw new Error('invalid secret');
  const Ppoint = pointMul(G, d0);
  const d = hasEvenY(Ppoint) ? d0 : N - d0;
  const px = Ppoint.x;

  const t = bufToBig(bytes32(d)) ^ bufToBig(taggedHash('BIP0340/aux', aux32));
  const rand = taggedHash('BIP0340/nonce', bytes32(t), bytes32(px), msg32);
  let k0 = mod(bufToBig(rand), N);
  if (k0 === 0n) throw new Error('nonce is zero');
  const Rpoint = pointMul(G, k0);
  const k = hasEvenY(Rpoint) ? k0 : N - k0;
  const e = challenge(Rpoint.x, px, msg32);
  const s = mod(k + e * d, N);
  return Buffer.concat([bytes32(Rpoint.x), bytes32(s)]);
}

function schnorrVerify(pubkeyX, msg32, sig64) {
  const px = typeof pubkeyX === 'bigint' ? pubkeyX : bufToBig(pubkeyX);
  let Ppoint;
  try { Ppoint = liftX(px); } catch (e) { return false; }
  const rx = bufToBig(sig64.slice(0, 32));
  const s = bufToBig(sig64.slice(32, 64));
  if (rx >= P || s >= N) return false;
  const e = challenge(rx, px, msg32);
  const R = pointAdd(pointMul(G, s), pointNegate(pointMul(Ppoint, e)));
  if (isInf(R) || !hasEvenY(R) || R.x !== rx) return false;
  return true;
}

// ---- Schnorr adaptor signatures ----
// Pre-signature under adaptor point T. The nonce is rejection-sampled so the
// effective nonce point (R0 + T) has even y, which makes the completed
// signature a valid BIP340 signature without extra parity juggling.
function adaptorSign(secret, msg32, T, aux32 = Buffer.alloc(32)) {
  if (!onCurve(T) || isInf(T)) throw new Error('adaptor point T invalid');
  const d0 = mod(secret, N);
  if (d0 === 0n) throw new Error('invalid secret');
  const Ppoint = pointMul(G, d0);
  const d = hasEvenY(Ppoint) ? d0 : N - d0;
  const px = Ppoint.x;
  const tbase = bufToBig(bytes32(d)) ^ bufToBig(taggedHash('BIP0340/aux', aux32));

  for (let counter = 0; counter < 64; counter++) {
    const rand = taggedHash(
      'TradeLayer/dlc/adaptor/nonce',
      bytes32(tbase), bytes32(px), msg32, bytes32(T.x), Buffer.from([counter])
    );
    const k0 = mod(bufToBig(rand), N);
    if (k0 === 0n) continue;
    const R0 = pointMul(G, k0);
    const Rp = pointAdd(R0, T); // effective nonce point of the final signature
    if (isInf(Rp) || !hasEvenY(Rp)) continue; // need even y for BIP340 completion
    const e = challenge(Rp.x, px, msg32);
    const s0 = mod(k0 + e * d, N);
    return {
      kind: 'tradelayer_dlc_adaptor_presig_v1',
      rx: bytes32(Rp.x).toString('hex'),       // r of the eventual signature
      s0: bytes32(s0).toString('hex'),          // pre-signature scalar
      R0x: bytes32(R0.x).toString('hex'),
      R0y: bytes32(R0.y).toString('hex'),
      Tx: bytes32(T.x).toString('hex'),
      Ty: bytes32(T.y).toString('hex')
    };
  }
  throw new Error('adaptorSign: failed to find even-y nonce');
}

function presigPoints(presig) {
  const R0 = { x: bufToBig(Buffer.from(presig.R0x, 'hex')), y: bufToBig(Buffer.from(presig.R0y, 'hex')) };
  const T = { x: bufToBig(Buffer.from(presig.Tx, 'hex')), y: bufToBig(Buffer.from(presig.Ty, 'hex')) };
  return { R0, T };
}

function adaptorVerify(pubkeyX, msg32, presig) {
  if (!presig || presig.kind !== 'tradelayer_dlc_adaptor_presig_v1') return false;
  const px = typeof pubkeyX === 'bigint' ? pubkeyX : bufToBig(pubkeyX);
  let Ppoint;
  try { Ppoint = liftX(px); } catch (e) { return false; }
  const { R0, T } = presigPoints(presig);
  if (!onCurve(R0) || !onCurve(T)) return false;
  const Rp = pointAdd(R0, T);
  if (isInf(Rp) || !hasEvenY(Rp)) return false;
  if (Rp.x !== bufToBig(Buffer.from(presig.rx, 'hex'))) return false;
  const s0 = bufToBig(Buffer.from(presig.s0, 'hex'));
  if (s0 >= N) return false;
  const e = challenge(Rp.x, px, msg32);
  // s0*G == R0 + e*P
  const lhs = pointMul(G, s0);
  const rhs = pointAdd(R0, pointMul(Ppoint, e));
  return !isInf(lhs) && !isInf(rhs) && lhs.x === rhs.x && lhs.y === rhs.y;
}

// Complete the pre-signature with the oracle attestation scalar t (t*G == T).
function adaptorComplete(presig, attestationScalar) {
  const t = mod(typeof attestationScalar === 'bigint' ? attestationScalar : bufToBig(attestationScalar), N);
  const { T } = presigPoints(presig);
  const Tcheck = pointMul(G, t);
  if (isInf(Tcheck) || Tcheck.x !== T.x || Tcheck.y !== T.y) {
    throw new Error('attestation scalar does not match adaptor point T');
  }
  const s0 = bufToBig(Buffer.from(presig.s0, 'hex'));
  const s = mod(s0 + t, N);
  return Buffer.concat([Buffer.from(presig.rx, 'hex'), bytes32(s)]);
}

// Recover the oracle scalar from a pre-signature and its completed signature.
function adaptorExtract(presig, sig64) {
  const s = bufToBig(sig64.slice(32, 64));
  const s0 = bufToBig(Buffer.from(presig.s0, 'hex'));
  return mod(s - s0, N);
}

// ---- DLC oracle (BIP340 attestation model) ----
// The oracle commits an x-only pubkey px and an x-only nonce rx. For each
// outcome message the outcome point T = lift_x(rx) + e*lift_x(px) is computable
// by anyone in advance; the oracle's attestation for the realized outcome is a
// scalar s with s*G == T (a BIP340 signature value), which completes any adaptor
// pre-signature made under T.
function buildDlcOracle(oracleSecret, nonceSecret) {
  const x0 = mod(oracleSecret, N);
  const k0 = mod(nonceSecret, N);
  if (x0 === 0n || k0 === 0n) throw new Error('oracle/nonce secret invalid');
  const Ppoint = pointMul(G, x0);
  const Rpoint = pointMul(G, k0);
  // BIP340 even-y adjusted secrets so the attestation scalar matches the point.
  const x = hasEvenY(Ppoint) ? x0 : N - x0;
  const k = hasEvenY(Rpoint) ? k0 : N - k0;
  return {
    px: bytes32(Ppoint.x).toString('hex'),
    rx: bytes32(Rpoint.x).toString('hex'),
    _x: x,
    _k: k
  };
}

function dlcOutcomePoint(announcement, outcomeMsg32) {
  const px = bufToBig(Buffer.from(announcement.px, 'hex'));
  const rx = bufToBig(Buffer.from(announcement.rx, 'hex'));
  const e = challenge(rx, px, outcomeMsg32);
  return pointAdd(liftX(rx), pointMul(liftX(px), e));
}

function dlcAttest(oracle, outcomeMsg32) {
  const px = bufToBig(Buffer.from(oracle.px, 'hex'));
  const rx = bufToBig(Buffer.from(oracle.rx, 'hex'));
  const e = challenge(rx, px, outcomeMsg32);
  return mod(oracle._k + e * oracle._x, N); // scalar t with t*G == dlcOutcomePoint
}

module.exports = {
  N,
  G,
  mod,
  pointMul,
  pointAdd,
  pointNegate,
  liftX,
  taggedHash,
  xOnlyPubkey,
  schnorrSign,
  schnorrVerify,
  adaptorSign,
  adaptorVerify,
  adaptorComplete,
  adaptorExtract,
  buildDlcOracle,
  dlcOutcomePoint,
  dlcAttest,
  bytes32,
  bufToBig
};
