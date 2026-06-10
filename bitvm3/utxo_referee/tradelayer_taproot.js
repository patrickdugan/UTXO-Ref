/**
 * TradeLayer Taproot (BIP341) helpers
 *
 * Just enough taproot to settle an adaptor-signature DLC on-chain via a P2TR
 * keypath spend whose witness is an adaptor-completed BIP340 signature:
 *  - taproot output-key tweak (BIP341), no script tree (merkle root null)
 *  - P2TR scriptPubKey (witness v1) so a funding tx can pay it directly
 *  - SIGHASH_DEFAULT keypath sighash
 *  - minimal tx parse + (witness) serialization for broadcast
 *
 * Validated against the published BIP341 wallet test vectors
 * (tradelayer_taproot.test.js) so a hand-built P2TR output is safe to fund even
 * on a Core build with no taproot address tooling.
 */

const crypto = require('crypto');
const {
  N, G, mod, pointMul, pointAdd, liftX, taggedHash, bytes32, bufToBig
} = require('./tradelayer_dlc_adaptor_sig');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function hasEvenYPoint(point) {
  return mod(point.y, 2n) === 0n;
}

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function u64le(value) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value), 0);
  return b;
}

function varint(n) {
  const v = Number(n);
  if (v < 0xfd) return Buffer.from([v]);
  if (v <= 0xffff) return Buffer.concat([Buffer.from([0xfd]), (() => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; })()]);
  if (v <= 0xffffffff) return Buffer.concat([Buffer.from([0xfe]), u32le(v)]);
  return Buffer.concat([Buffer.from([0xff]), u64le(v)]);
}

function pushScript(scriptBuf) {
  return Buffer.concat([varint(scriptBuf.length), scriptBuf]);
}

// ---- minimal tx reader ----
class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  read(n) { const r = this.buf.slice(this.pos, this.pos + n); this.pos += n; return r; }
  u32() { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  u64() { const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return v; }
  varint() {
    const b = this.buf[this.pos++];
    if (b < 0xfd) return b;
    if (b === 0xfd) { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
    if (b === 0xfe) { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
    const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return Number(v);
  }
}

// Parses a non-witness (unsigned) transaction; keeps raw outpoint bytes.
function parseTx(hex) {
  const r = new Reader(Buffer.from(hex, 'hex'));
  const version = r.u32();
  const vinCount = r.varint();
  const vin = [];
  for (let i = 0; i < vinCount; i++) {
    const outpoint = r.read(36); // txid(32 LE) + vout(4 LE)
    const scriptLen = r.varint();
    const scriptSig = r.read(scriptLen);
    const sequence = r.u32();
    vin.push({ outpoint, scriptSig, sequence });
  }
  const voutCount = r.varint();
  const vout = [];
  for (let i = 0; i < voutCount; i++) {
    const value = r.u64();
    const scriptLen = r.varint();
    const script = r.read(scriptLen);
    vout.push({ value, script });
  }
  const locktime = r.u32();
  return { version, vin, vout, locktime };
}

// ---- BIP341 keypath sighash (SIGHASH_DEFAULT = 0x00) ----
function bip341SighashDefault(txParsed, utxosSpent, inputIndex) {
  const shaPrevouts = sha256(Buffer.concat(txParsed.vin.map((i) => i.outpoint)));
  const shaAmounts = sha256(Buffer.concat(utxosSpent.map((u) => u64le(u.amountSats))));
  const shaScriptPubkeys = sha256(Buffer.concat(utxosSpent.map((u) => pushScript(Buffer.from(u.scriptPubKey, 'hex')))));
  const shaSequences = sha256(Buffer.concat(txParsed.vin.map((i) => u32le(i.sequence))));
  const shaOutputs = sha256(Buffer.concat(txParsed.vout.map((o) => Buffer.concat([u64le(o.value), pushScript(o.script)]))));

  const preimage = Buffer.concat([
    Buffer.from([0x00]),            // epoch
    Buffer.from([0x00]),            // hash_type SIGHASH_DEFAULT
    u32le(txParsed.version),
    u32le(txParsed.locktime),
    shaPrevouts,
    shaAmounts,
    shaScriptPubkeys,
    shaSequences,
    shaOutputs,
    Buffer.from([0x00]),            // spend_type (no annex, key path)
    u32le(inputIndex)
  ]);
  return taggedHash('TapSighash', preimage);
}

// ---- taproot key tweak (BIP341) ----
function tapTweakScalar(internalXonly, merkleRoot = null) {
  const data = merkleRoot ? Buffer.concat([internalXonly, merkleRoot]) : internalXonly;
  return mod(bufToBig(taggedHash('TapTweak', data)), N);
}

function taprootOutputKey(internalXonly, merkleRoot = null) {
  const t = tapTweakScalar(internalXonly, merkleRoot);
  const Pint = liftX(bufToBig(internalXonly)); // BIP341 uses even-y internal point
  const Q = pointAdd(Pint, pointMul(G, t));
  return { tweak: t, Q, xonly: bytes32(Q.x), parityEven: hasEvenYPoint(Q) };
}

function taprootScriptPubKey(internalXonly, merkleRoot = null) {
  return Buffer.concat([Buffer.from([0x51, 0x20]), taprootOutputKey(internalXonly, merkleRoot).xonly]);
}

// Tweaked private key for a keypath spend (BIP341): normalize internal key to
// even-y, add the tweak. The BIP340 signer normalizes again to the output key.
function taprootTweakSecret(internalSecret, merkleRoot = null) {
  const d0 = mod(internalSecret, N);
  const Pint = pointMul(G, d0);
  const d = hasEvenYPoint(Pint) ? d0 : N - d0;
  const xonly = bytes32(Pint.x);
  const t = tapTweakScalar(xonly, merkleRoot);
  return mod(d + t, N);
}

// ---- serialization for broadcast ----
function serializeUnsignedTx(version, vins, vouts, locktime) {
  // legacy (non-witness) form; scriptSigs empty so a wallet can sign inputs
  const parts = [u32le(version), varint(vins.length)];
  for (const vin of vins) {
    parts.push(Buffer.from(vin.outpoint, 'hex')); // 36-byte outpoint hex
    parts.push(varint(0));                          // empty scriptSig
    parts.push(u32le(vin.sequence ?? 0xfffffffd));
  }
  parts.push(varint(vouts.length));
  for (const vout of vouts) {
    parts.push(u64le(vout.valueSats));
    parts.push(pushScript(Buffer.from(vout.script, 'hex')));
  }
  parts.push(u32le(locktime || 0));
  return Buffer.concat(parts).toString('hex');
}

function serializeWitnessTx(version, vins, vouts, locktime) {
  const parts = [u32le(version), Buffer.from([0x00, 0x01]), varint(vins.length)];
  for (const vin of vins) {
    parts.push(Buffer.from(vin.outpoint, 'hex'));
    parts.push(pushScript(Buffer.from(vin.scriptSig || '', 'hex')));
    parts.push(u32le(vin.sequence ?? 0xfffffffd));
  }
  parts.push(varint(vouts.length));
  for (const vout of vouts) {
    parts.push(u64le(vout.valueSats));
    parts.push(pushScript(Buffer.from(vout.script, 'hex')));
  }
  for (const vin of vins) {
    const items = vin.witness || [];
    parts.push(varint(items.length));
    for (const item of items) parts.push(pushScript(Buffer.from(item, 'hex')));
  }
  parts.push(u32le(locktime || 0));
  return Buffer.concat(parts).toString('hex');
}

// Build the 36-byte outpoint (display-txid -> internal LE) + vout
function outpoint(txidDisplay, vout) {
  const txidLe = Buffer.from(txidDisplay, 'hex').reverse();
  return Buffer.concat([txidLe, u32le(vout)]).toString('hex');
}

module.exports = {
  sha256,
  varint,
  parseTx,
  bip341SighashDefault,
  tapTweakScalar,
  taprootOutputKey,
  taprootScriptPubKey,
  taprootTweakSecret,
  serializeUnsignedTx,
  serializeWitnessTx,
  outpoint
};
