/**
 * TradeLayer BitVM SHA256 circuit (Blocks 9-10)
 *
 * SHA256 of a single 512-bit block expressed as a boolean circuit over the
 * AND/OR/XOR/NOT gate primitives, so the final-output-equality referee predicate
 * ("the swept outputs hash to the committed root") is enforceable by the same
 * disprove machinery as the solvency comparator.
 *
 * A "bit" is either a constant (0/1) or a wire label; constants are propagated
 * (XOR/AND/NOT with a constant emit no gate), which keeps the gate count to the
 * real logic. Rotations/shifts are free (wire relabeling). The evaluator is
 * validated against the NIST SHA256 vectors in tradelayer_bitvm_sha256.test.js.
 */

const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function wordToBits(value) { // MSB-first (index 0 = bit 31)
  const bits = [];
  for (let i = 31; i >= 0; i--) bits.push((value >>> i) & 1);
  return bits;
}

class Sha256Circuit {
  constructor() { this.gates = []; this.n = 0; this.inputLabels = []; }
  fresh() { return `s${this.n++}`; }
  emit(type, inputs) { const out = this.fresh(); this.gates.push({ type, inputs, output: out }); return out; }

  xor(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a ^ b;
    if (a === 0) return b;
    if (b === 0) return a;
    if (a === 1) return this.not(b);
    if (b === 1) return this.not(a);
    return this.emit('xor', [a, b]);
  }
  and(a, b) {
    if (a === 0 || b === 0) return 0;
    if (typeof a === 'number' && typeof b === 'number') return a & b;
    if (a === 1) return b;
    if (b === 1) return a;
    return this.emit('and', [a, b]);
  }
  or(a, b) {
    if (a === 1 || b === 1) return 1;
    if (typeof a === 'number' && typeof b === 'number') return a | b;
    if (a === 0) return b;
    if (b === 0) return a;
    return this.emit('or', [a, b]);
  }
  not(a) { return typeof a === 'number' ? (1 - a) : this.emit('not', [a]); }

  xorW(a, b) { return a.map((_, i) => this.xor(a[i], b[i])); }
  andW(a, b) { return a.map((_, i) => this.and(a[i], b[i])); }
  notW(a) { return a.map((x) => this.not(x)); }
  rotr(a, k) { return a.map((_, i) => a[(i - k + 32) % 32]); }
  shr(a, k) { return a.map((_, i) => (i < k ? 0 : a[i - k])); }

  addW(a, b) { // 32-bit add mod 2^32, MSB-first words; ripple carry from LSB
    const out = new Array(32);
    let carry = 0;
    for (let i = 31; i >= 0; i--) {
      const axb = this.xor(a[i], b[i]);
      out[i] = this.xor(axb, carry);
      carry = this.or(this.and(a[i], b[i]), this.and(carry, axb));
    }
    return out;
  }

  Ch(e, f, g) { return this.xorW(this.andW(e, f), this.andW(this.notW(e), g)); }
  Maj(a, b, c) { return this.xorW(this.xorW(this.andW(a, b), this.andW(a, c)), this.andW(b, c)); }
  S0(a) { return this.xorW(this.xorW(this.rotr(a, 2), this.rotr(a, 13)), this.rotr(a, 22)); }
  S1(e) { return this.xorW(this.xorW(this.rotr(e, 6), this.rotr(e, 11)), this.rotr(e, 25)); }
  s0(x) { return this.xorW(this.xorW(this.rotr(x, 7), this.rotr(x, 18)), this.shr(x, 3)); }
  s1(x) { return this.xorW(this.xorW(this.rotr(x, 17), this.rotr(x, 19)), this.shr(x, 10)); }
}

// Build a single-block SHA256 circuit for an L-byte message (L <= 55).
// Returns { circuit, inputLabels, digestBits } where digestBits is 256 bits
// (each a wire label or constant) and inputLabels are the 8*L message bit wires.
function buildSha256Circuit(byteLen) {
  if (!Number.isInteger(byteLen) || byteLen < 0 || byteLen > 55) throw new Error('byteLen must be 0..55 (single block)');
  const c = new Sha256Circuit();

  // 512-bit message block: input bits as wires, padding + length as constants.
  const block = new Array(512).fill(0);
  for (let i = 0; i < byteLen * 8; i++) { const lbl = `m${i}`; block[i] = lbl; c.inputLabels.push(lbl); }
  block[byteLen * 8] = 1; // the 0x80 padding bit
  const bitLen = BigInt(byteLen * 8);
  for (let i = 0; i < 64; i++) block[448 + i] = Number((bitLen >> BigInt(63 - i)) & 1n); // 64-bit big-endian length

  // 16 message words
  const W = [];
  for (let t = 0; t < 16; t++) W.push(block.slice(t * 32, t * 32 + 32));
  for (let t = 16; t < 64; t++) {
    W.push(c.addW(c.addW(c.addW(c.s1(W[t - 2]), W[t - 7]), c.s0(W[t - 15])), W[t - 16]));
  }

  let [a, b, cc, d, e, f, g, h] = H0.map(wordToBits);
  for (let t = 0; t < 64; t++) {
    const T1 = c.addW(c.addW(c.addW(c.addW(h, c.S1(e)), c.Ch(e, f, g)), wordToBits(K[t])), W[t]);
    const T2 = c.addW(c.S0(a), c.Maj(a, b, cc));
    h = g; g = f; f = e; e = c.addW(d, T1); d = cc; cc = b; b = a; a = c.addW(T2, T1);
  }
  const Hout = [a, b, cc, d, e, f, g, h].map((w, i) => c.addW(wordToBits(H0[i]), w));
  const digestBits = [].concat(...Hout);

  const labels = new Set(c.inputLabels);
  for (const gate of c.gates) { gate.inputs.forEach((l) => { if (typeof l === 'string') labels.add(l); }); labels.add(gate.output); }
  return { circuit: c, gates: c.gates, inputLabels: c.inputLabels, digestBits, labels: [...labels] };
}

// Evaluate the circuit on a message buffer; returns { trace, digestHex }.
function evaluateSha256(built, messageBuf) {
  const trace = {};
  built.inputLabels.forEach((lbl, i) => {
    const byte = messageBuf[Math.floor(i / 8)];
    trace[lbl] = (byte >>> (7 - (i % 8))) & 1; // MSB-first within each byte
  });
  const resolve = (bit) => (typeof bit === 'number' ? bit : trace[bit]);
  const { GATES } = require('./tradelayer_bitvm_circuit');
  for (const g of built.gates) trace[g.output] = GATES[g.type].f(...g.inputs.map(resolve));

  // assemble digest (256 bits, MSB-first) into hex
  let hex = '';
  for (let i = 0; i < 256; i += 4) {
    let nib = 0;
    for (let j = 0; j < 4; j++) nib = (nib << 1) | resolve(built.digestBits[i + j]);
    hex += nib.toString(16);
  }
  return { trace, digestHex: hex };
}

module.exports = { buildSha256Circuit, evaluateSha256, wordToBits };
