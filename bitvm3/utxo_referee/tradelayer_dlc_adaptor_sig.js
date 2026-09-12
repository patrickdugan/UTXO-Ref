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
const { snapshotOwnDataArguments } = require('./dlc_canonical_json');

// secp256k1 domain parameters
const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;
const G = { x: GX, y: GY };
const MAX_256 = 1n << 256n;
const oracleStates = new WeakMap();

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

function requireBuffer(value, length, fieldName) {
  if (!Buffer.isBuffer(value) || value.length !== length) {
    throw new Error(`${fieldName} must be exactly ${length} bytes`);
  }
  return value;
}

function requireScalar(value, fieldName) {
  let scalar;
  if (typeof value === 'bigint') scalar = value;
  else if (Buffer.isBuffer(value) && value.length === 32) scalar = bufToBig(value);
  else throw new Error(`${fieldName} must be a bigint or 32-byte buffer`);
  if (scalar <= 0n || scalar >= N) throw new Error(`${fieldName} must be in 1..n-1`);
  return scalar;
}

function requirePoint(point, fieldName) {
  point = snapshotOwnDataArguments(point, ['x', 'y'], fieldName);
  if (!point || typeof point.x !== 'bigint' || typeof point.y !== 'bigint' ||
      point.x < 0n || point.x >= P || point.y < 0n || point.y >= P ||
      !onCurve(point)) {
    throw new Error(`${fieldName} must be a canonical non-infinity secp256k1 point`);
  }
  return point;
}

function pointBytes(point) {
  point = requirePoint(point, 'point');
  return Buffer.concat([Buffer.from([hasEvenY(point) ? 0x02 : 0x03]), bytes32(point.x)]);
}

function parseHexInteger(value, bytes, upperExclusive, fieldName) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${fieldName} must be canonical ${bytes}-byte hex`);
  }
  const integer = bufToBig(Buffer.from(value, 'hex'));
  if (integer >= upperExclusive) throw new Error(`${fieldName} is out of range`);
  return integer;
}

function lengthPrefixed(value, fieldName) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  if (bytes.length > 0xffff) throw new Error(`${fieldName} exceeds 65535 bytes`);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

// ---- byte helpers ----
function bytes32(value) {
  const integer = BigInt(value);
  if (integer < 0n || integer >= MAX_256) throw new Error('value must fit 32 bytes');
  return Buffer.from(integer.toString(16).padStart(64, '0'), 'hex');
}

function bufToBig(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('buffer must be non-empty');
  return BigInt('0x' + buf.toString('hex'));
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
  const d0 = requireScalar(secret, 'secret');
  const Ppoint = pointMul(G, d0);
  return bytes32(Ppoint.x);
}

function schnorrSign(secret, msg32, aux32 = crypto.randomBytes(32)) {
  const d0 = requireScalar(secret, 'secret');
  requireBuffer(msg32, 32, 'msg32');
  requireBuffer(aux32, 32, 'aux32');
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
  try {
    requireBuffer(msg32, 32, 'msg32');
    requireBuffer(sig64, 64, 'sig64');
    const px = typeof pubkeyX === 'bigint'
      ? pubkeyX
      : bufToBig(requireBuffer(pubkeyX, 32, 'pubkeyX'));
    const Ppoint = liftX(px);
    const rx = bufToBig(sig64.subarray(0, 32));
    const s = bufToBig(sig64.subarray(32, 64));
    if (rx >= P || s >= N) return false;
    const e = challenge(rx, px, msg32);
    const R = pointAdd(pointMul(G, s), pointNegate(pointMul(Ppoint, e)));
    return !isInf(R) && hasEvenY(R) && R.x === rx;
  } catch (_error) {
    return false;
  }
}

// ---- Schnorr adaptor signatures ----
// Pre-signature under adaptor point T. The nonce is rejection-sampled so the
// effective nonce point (R0 + T) has even y, which makes the completed
// signature a valid BIP340 signature without extra parity juggling.
function adaptorSign(secret, msg32, T, aux32 = crypto.randomBytes(32)) {
  T = requirePoint(T, 'adaptor point T');
  requireBuffer(msg32, 32, 'msg32');
  requireBuffer(aux32, 32, 'aux32');
  const d0 = requireScalar(secret, 'secret');
  const Ppoint = pointMul(G, d0);
  const d = hasEvenY(Ppoint) ? d0 : N - d0;
  const px = Ppoint.x;
  const tbase = bufToBig(bytes32(d)) ^ bufToBig(taggedHash('BIP0340/aux', aux32));

  for (let counter = 0; counter < 64; counter++) {
    const rand = taggedHash(
      'TradeLayer/dlc/adaptor/nonce',
      bytes32(tbase), bytes32(px), msg32, pointBytes(T), Buffer.from([counter])
    );
    const k0 = mod(bufToBig(rand), N);
    if (k0 === 0n) continue;
    const R0 = pointMul(G, k0);
    const Rp = pointAdd(R0, T); // effective nonce point of the final signature
    if (isInf(Rp) || !hasEvenY(Rp)) continue; // need even y for BIP340 completion
    const e = challenge(Rp.x, px, msg32);
    const s0 = mod(k0 + e * d, N);
    return Object.freeze({
      kind: 'tradelayer_dlc_adaptor_presig_v1',
      rx: bytes32(Rp.x).toString('hex'),       // r of the eventual signature
      s0: bytes32(s0).toString('hex'),          // pre-signature scalar
      R0x: bytes32(R0.x).toString('hex'),
      R0y: bytes32(R0.y).toString('hex'),
      Tx: bytes32(T.x).toString('hex'),
      Ty: bytes32(T.y).toString('hex')
    });
  }
  throw new Error('adaptorSign: failed to find even-y nonce');
}

function presigPoints(presig) {
  presig = snapshotOwnDataArguments(presig, [
    'kind', 'rx', 's0', 'R0x', 'R0y', 'Tx', 'Ty'
  ], 'DLC adaptor pre-signature');
  if (!presig || presig.kind !== 'tradelayer_dlc_adaptor_presig_v1') {
    throw new Error('wrong adaptor pre-signature kind');
  }
  const R0 = {
    x: parseHexInteger(presig.R0x, 32, P, 'R0x'),
    y: parseHexInteger(presig.R0y, 32, P, 'R0y')
  };
  const T = {
    x: parseHexInteger(presig.Tx, 32, P, 'Tx'),
    y: parseHexInteger(presig.Ty, 32, P, 'Ty')
  };
  requirePoint(R0, 'R0');
  requirePoint(T, 'T');
  const rx = parseHexInteger(presig.rx, 32, P, 'rx');
  const s0 = parseHexInteger(presig.s0, 32, N, 's0');
  return { R0, T, rx, s0 };
}

function adaptorVerify(pubkeyX, msg32, presig) {
  try {
    requireBuffer(msg32, 32, 'msg32');
    const px = typeof pubkeyX === 'bigint'
      ? pubkeyX
      : bufToBig(requireBuffer(pubkeyX, 32, 'pubkeyX'));
    const Ppoint = liftX(px);
    const { R0, T, rx, s0 } = presigPoints(presig);
    const Rp = pointAdd(R0, T);
    if (isInf(Rp) || !hasEvenY(Rp) || Rp.x !== rx) return false;
    const e = challenge(Rp.x, px, msg32);
    const lhs = pointMul(G, s0);
    const rhs = pointAdd(R0, pointMul(Ppoint, e));
    return !isInf(lhs) && !isInf(rhs) && lhs.x === rhs.x && lhs.y === rhs.y;
  } catch (_error) {
    return false;
  }
}

// Complete the pre-signature with the oracle attestation scalar t (t*G == T).
function adaptorComplete(presig, attestationScalar) {
  const t = requireScalar(attestationScalar, 'attestationScalar');
  const { T, rx, s0 } = presigPoints(presig);
  const Tcheck = pointMul(G, t);
  if (isInf(Tcheck) || Tcheck.x !== T.x || Tcheck.y !== T.y) {
    throw new Error('attestation scalar does not match adaptor point T');
  }
  const s = mod(s0 + t, N);
  return Buffer.concat([bytes32(rx), bytes32(s)]);
}

// Recover the oracle scalar from a pre-signature and its completed signature.
function adaptorExtract(presig, sig64, pubkeyX, msg32) {
  requireBuffer(sig64, 64, 'sig64');
  requireBuffer(msg32, 32, 'msg32');
  if (!adaptorVerify(pubkeyX, msg32, presig)) throw new Error('invalid adaptor pre-signature');
  if (!schnorrVerify(pubkeyX, msg32, sig64)) throw new Error('invalid completed signature');
  const { T, s0 } = presigPoints(presig);
  const s = bufToBig(sig64.subarray(32, 64));
  const extracted = mod(s - s0, N);
  const extractedPoint = pointMul(G, extracted);
  if (isInf(extractedPoint) || extractedPoint.x !== T.x || extractedPoint.y !== T.y) {
    throw new Error('extracted scalar does not match adaptor point T');
  }
  return extracted;
}

// ---- DLC oracle (BIP340 attestation model) ----
// The oracle commits an x-only pubkey px and an x-only nonce rx. For each
// outcome message the outcome point T = lift_x(rx) + e*lift_x(px) is computable
// by anyone in advance; the oracle's attestation for the realized outcome is a
// scalar s with s*G == T (a BIP340 signature value), which completes any adaptor
// pre-signature made under T.
function normalizeOutcomeMessages(outcomeMessages) {
  if (!Array.isArray(outcomeMessages) || outcomeMessages.length < 1) {
    throw new Error('outcomeMessages must be a non-empty array');
  }
  const values = outcomeMessages.map((message, index) =>
    Buffer.from(requireBuffer(message, 32, `outcomeMessages[${index}]`)));
  const hex = values.map((message) => message.toString('hex'));
  if (new Set(hex).size !== hex.length) throw new Error('outcomeMessages must be unique');
  return { values, hex };
}

function deriveOracleNonce(oracleSecret, nonceSecret, eventId, outcomeHex) {
  const eventBytes = lengthPrefixed(eventId, 'eventId');
  const outcomeBytes = Buffer.concat(outcomeHex.map((outcome, index) =>
    lengthPrefixed(Buffer.from(outcome, 'hex'), `outcomeMessages[${index}]`)));
  for (let counter = 0; counter < 256; counter++) {
    const freshRandom = requireBuffer(crypto.randomBytes(32), 32, 'oracle nonce randomness');
    const candidate = mod(bufToBig(taggedHash(
      'TradeLayer/dlc/oracle/nonce/v2',
      bytes32(oracleSecret),
      bytes32(nonceSecret),
      eventBytes,
      outcomeBytes,
      freshRandom,
      Buffer.from([counter])
    )), N);
    if (candidate !== 0n) return candidate;
  }
  throw new Error('failed to derive a non-zero oracle nonce');
}

function oracleAnnouncementDigest(announcement) {
  if (!announcement || announcement.kind !== 'tradelayer_dlc_oracle_announcement_v1') {
    throw new Error('invalid DLC oracle announcement');
  }
  const eventId = String(announcement.eventId || '');
  if (!eventId || Buffer.byteLength(eventId, 'utf8') > 256) {
    throw new Error('announcement eventId must be 1..256 UTF-8 bytes');
  }
  parseHexInteger(announcement.px, 32, P, 'announcement.px');
  parseHexInteger(announcement.rx, 32, P, 'announcement.rx');
  if (!Array.isArray(announcement.outcomeMessages) || announcement.outcomeMessages.length < 1) {
    throw new Error('announcement outcomeMessages must be non-empty');
  }
  const outcomes = announcement.outcomeMessages.map((outcome, index) => {
    parseHexInteger(outcome, 32, MAX_256, `announcement.outcomeMessages[${index}]`);
    return outcome.toLowerCase();
  });
  if (new Set(outcomes).size !== outcomes.length) throw new Error('announcement outcomes must be unique');
  return taggedHash(
    'TradeLayer/dlc/oracle/announcement/v1',
    lengthPrefixed(eventId, 'eventId'),
    Buffer.from(announcement.px, 'hex'),
    Buffer.from(announcement.rx, 'hex'),
    ...outcomes.map((outcome, index) =>
      lengthPrefixed(Buffer.from(outcome, 'hex'), `outcomeMessages[${index}]`))
  );
}

function verifyDlcOracleAnnouncement(announcement) {
  try {
    const digest = oracleAnnouncementDigest(announcement);
    if (typeof announcement.signature !== 'string' || !/^[0-9a-fA-F]{128}$/.test(announcement.signature)) {
      return false;
    }
    return schnorrVerify(
      Buffer.from(announcement.px, 'hex'),
      digest,
      Buffer.from(announcement.signature, 'hex')
    );
  } catch (_error) {
    return false;
  }
}

function buildDlcOracle(oracleSecret, nonceSecret, options = {}) {
  const x0 = requireScalar(oracleSecret, 'oracleSecret');
  const nonceSeed = requireScalar(nonceSecret, 'nonceSecret');
  const eventId = String(options.eventId || '');
  if (!eventId || Buffer.byteLength(eventId, 'utf8') > 256) {
    throw new Error('eventId must be 1..256 UTF-8 bytes');
  }
  const outcomes = normalizeOutcomeMessages(options.outcomeMessages);
  const k0 = deriveOracleNonce(x0, nonceSeed, eventId, outcomes.hex);
  const Ppoint = pointMul(G, x0);
  const Rpoint = pointMul(G, k0);
  // BIP340 even-y adjusted secrets so the attestation scalar matches the point.
  const x = hasEvenY(Ppoint) ? x0 : N - x0;
  const k = hasEvenY(Rpoint) ? k0 : N - k0;
  const unsignedAnnouncement = {
    kind: 'tradelayer_dlc_oracle_announcement_v1',
    eventId,
    px: bytes32(Ppoint.x).toString('hex'),
    rx: bytes32(Rpoint.x).toString('hex'),
    outcomeMessages: Object.freeze(outcomes.hex)
  };
  const signature = schnorrSign(x0, oracleAnnouncementDigest(unsignedAnnouncement));
  const announcement = Object.freeze({
    ...unsignedAnnouncement,
    signature: signature.toString('hex')
  });
  oracleStates.set(announcement, {
    x,
    k,
    allowed: new Set(outcomes.hex),
    attestedMessage: null,
    attestation: null
  });
  return announcement;
}

function dlcOutcomePoint(announcement, outcomeMsg32) {
  requireBuffer(outcomeMsg32, 32, 'outcomeMsg32');
  if (!verifyDlcOracleAnnouncement(announcement)) throw new Error('invalid DLC oracle announcement signature');
  const outcomeHex = outcomeMsg32.toString('hex');
  if (!Array.isArray(announcement.outcomeMessages) || !announcement.outcomeMessages.includes(outcomeHex)) {
    throw new Error('outcome message is not committed by the oracle announcement');
  }
  const px = parseHexInteger(announcement.px, 32, P, 'announcement.px');
  const rx = parseHexInteger(announcement.rx, 32, P, 'announcement.rx');
  const e = challenge(rx, px, outcomeMsg32);
  return pointAdd(liftX(rx), pointMul(liftX(px), e));
}

function dlcAttest(oracle, outcomeMsg32) {
  requireBuffer(outcomeMsg32, 32, 'outcomeMsg32');
  const state = oracleStates.get(oracle);
  if (!state) throw new Error('oracle signer state is unavailable');
  const outcomeHex = outcomeMsg32.toString('hex');
  if (!state.allowed.has(outcomeHex)) throw new Error('outcome message is not committed by the oracle announcement');
  if (state.attestedMessage && state.attestedMessage !== outcomeHex) {
    throw new Error('oracle event already attested to a conflicting outcome');
  }
  if (state.attestation !== null) return state.attestation;
  const px = parseHexInteger(oracle.px, 32, P, 'oracle.px');
  const rx = parseHexInteger(oracle.rx, 32, P, 'oracle.rx');
  const e = challenge(rx, px, outcomeMsg32);
  const attestation = mod(state.k + e * state.x, N);
  const signature = Buffer.concat([Buffer.from(oracle.rx, 'hex'), bytes32(attestation)]);
  if (!schnorrVerify(Buffer.from(oracle.px, 'hex'), outcomeMsg32, signature)) {
    throw new Error('oracle produced an invalid attestation');
  }
  state.attestedMessage = outcomeHex;
  state.attestation = attestation;
  return attestation; // scalar t with t*G == dlcOutcomePoint
}

function verifyDlcAttestation(announcement, outcomeMsg32, attestationScalar) {
  try {
    requireBuffer(outcomeMsg32, 32, 'outcomeMsg32');
    if (!verifyDlcOracleAnnouncement(announcement)) return false;
    if (!announcement.outcomeMessages.includes(outcomeMsg32.toString('hex'))) return false;
    const scalar = requireScalar(attestationScalar, 'attestationScalar');
    return schnorrVerify(
      Buffer.from(announcement.px, 'hex'),
      outcomeMsg32,
      Buffer.concat([Buffer.from(announcement.rx, 'hex'), bytes32(scalar)])
    );
  } catch (_error) {
    return false;
  }
}

function requireWrappingKey(wrappingKey) {
  return requireBuffer(wrappingKey, 32, 'wrappingKey');
}

function signerStateAad(announcement) {
  return Buffer.concat([
    oracleAnnouncementDigest(announcement),
    Buffer.from(announcement.signature, 'hex')
  ]);
}

function sealDlcOracleSignerState(announcement, wrappingKey) {
  requireWrappingKey(wrappingKey);
  if (!verifyDlcOracleAnnouncement(announcement)) throw new Error('cannot seal an invalid oracle announcement');
  const state = oracleStates.get(announcement);
  if (!state) throw new Error('oracle signer state is unavailable');
  const payload = {
    kind: 'tradelayer_dlc_oracle_signer_state_v1',
    announcementDigest: oracleAnnouncementDigest(announcement).toString('hex'),
    x: bytes32(state.x).toString('hex'),
    k: bytes32(state.k).toString('hex'),
    attestedMessage: state.attestedMessage,
    attestation: state.attestation === null ? null : bytes32(state.attestation).toString('hex')
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv, { authTagLength: 16 });
  cipher.setAAD(signerStateAad(announcement));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Object.freeze({
    kind: 'tradelayer_dlc_oracle_signer_sealed_v1',
    cipher: 'aes-256-gcm',
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex')
  });
}

function restoreDlcOracleSignerState(announcementInput, sealedState, wrappingKey) {
  requireWrappingKey(wrappingKey);
  if (!announcementInput || typeof announcementInput !== 'object') throw new Error('oracle announcement is required');
  const announcement = Object.freeze({
    ...announcementInput,
    outcomeMessages: Object.freeze([...(announcementInput.outcomeMessages || [])])
  });
  if (!verifyDlcOracleAnnouncement(announcement)) throw new Error('cannot restore an invalid oracle announcement');
  if (!sealedState || sealedState.kind !== 'tradelayer_dlc_oracle_signer_sealed_v1' ||
      sealedState.cipher !== 'aes-256-gcm' ||
      typeof sealedState.iv !== 'string' || !/^[0-9a-f]{24}$/.test(sealedState.iv) ||
      typeof sealedState.authTag !== 'string' || !/^[0-9a-f]{32}$/.test(sealedState.authTag) ||
      typeof sealedState.ciphertext !== 'string' || !/^[0-9a-f]+$/.test(sealedState.ciphertext)) {
    throw new Error('invalid sealed oracle signer state');
  }
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      wrappingKey,
      Buffer.from(sealedState.iv, 'hex'),
      { authTagLength: 16 }
    );
    decipher.setAAD(signerStateAad(announcement));
    decipher.setAuthTag(Buffer.from(sealedState.authTag, 'hex'));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealedState.ciphertext, 'hex')),
      decipher.final()
    ]);
  } catch (_error) {
    throw new Error('sealed oracle signer state authentication failed');
  }
  let payload;
  try {
    payload = JSON.parse(plaintext.toString('utf8'));
  } finally {
    plaintext.fill(0);
  }
  if (!payload || payload.kind !== 'tradelayer_dlc_oracle_signer_state_v1' ||
      payload.announcementDigest !== oracleAnnouncementDigest(announcement).toString('hex')) {
    throw new Error('sealed signer state does not match the announcement');
  }
  const x = parseHexInteger(payload.x, 32, N, 'sealed.x');
  const k = parseHexInteger(payload.k, 32, N, 'sealed.k');
  if (x === 0n || k === 0n) throw new Error('sealed signer scalars must be non-zero');
  const publicPoint = pointMul(G, x);
  const noncePoint = pointMul(G, k);
  if (!publicPoint || !noncePoint || !hasEvenY(publicPoint) || !hasEvenY(noncePoint) ||
      bytes32(publicPoint.x).toString('hex') !== announcement.px ||
      bytes32(noncePoint.x).toString('hex') !== announcement.rx) {
    throw new Error('sealed signer scalars do not match the announcement');
  }
  let attestedMessage = null;
  let attestation = null;
  if (payload.attestedMessage !== null || payload.attestation !== null) {
    if (typeof payload.attestedMessage !== 'string' ||
        !announcement.outcomeMessages.includes(payload.attestedMessage)) {
      throw new Error('sealed attested outcome is not committed');
    }
    attestation = parseHexInteger(payload.attestation, 32, N, 'sealed.attestation');
    if (attestation === 0n || !verifyDlcAttestation(
      announcement,
      Buffer.from(payload.attestedMessage, 'hex'),
      attestation
    )) {
      throw new Error('sealed oracle attestation is invalid');
    }
    const challengeScalar = challenge(
      parseHexInteger(announcement.rx, 32, P, 'announcement.rx'),
      parseHexInteger(announcement.px, 32, P, 'announcement.px'),
      Buffer.from(payload.attestedMessage, 'hex')
    );
    if (mod(k + challengeScalar * x, N) !== attestation) {
      throw new Error('sealed attestation does not match signer scalars');
    }
    attestedMessage = payload.attestedMessage;
  }
  oracleStates.set(announcement, {
    x,
    k,
    allowed: new Set(announcement.outcomeMessages),
    attestedMessage,
    attestation
  });
  return announcement;
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
  verifyDlcOracleAnnouncement,
  dlcOutcomePoint,
  dlcAttest,
  verifyDlcAttestation,
  sealDlcOracleSignerState,
  restoreDlcOracleSignerState,
  bytes32,
  bufToBig
};
