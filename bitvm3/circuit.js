/**
 * BitVM3 Circuit Builder
 *
 * Core arithmetic circuit primitives for R1CS-style constraints.
 * Generates Bristol-format circuits optimized for BitVM3 verification.
 *
 * Gate costs (garbled circuits):
 *   - XOR, INV: Free (no ciphertext)
 *   - AND, OR: 1 ciphertext each
 */

class Circuit {
  constructor(name = 'circuit') {
    this.name = name;
    this.gates = [];
    this.wireCount = 0;
    this.inputWires = [];
    this.outputWires = [];
    this.labels = new Map(); // wire -> label for debugging
    this.constants = { zero: null, one: null };
  }

  // Wire allocation
  allocWire(label = null) {
    const wire = this.wireCount++;
    if (label) this.labels.set(wire, label);
    return wire;
  }

  allocWires(n, labelPrefix = null) {
    const wires = [];
    for (let i = 0; i < n; i++) {
      const label = labelPrefix ? `${labelPrefix}[${i}]` : null;
      wires.push(this.allocWire(label));
    }
    return wires;
  }

  // Input declaration
  addInput(bitWidth, label) {
    const wires = this.allocWires(bitWidth, label);
    this.inputWires.push(...wires);
    return wires;
  }

  addInputScalar(label) {
    const wire = this.allocWire(label);
    this.inputWires.push(wire);
    return wire;
  }

  // === Primitive Gates ===

  and(a, b) {
    const out = this.wireCount++;
    this.gates.push({ type: 'AND', inputs: [a, b], outputs: [out] });
    return out;
  }

  xor(a, b) {
    const out = this.wireCount++;
    this.gates.push({ type: 'XOR', inputs: [a, b], outputs: [out] });
    return out;
  }

  inv(a) {
    const out = this.wireCount++;
    this.gates.push({ type: 'INV', inputs: [a], outputs: [out] });
    return out;
  }

  or(a, b) {
    // OR(a,b) = XOR(XOR(a,b), AND(a,b)) - 1 AND + 2 XOR (1 non-free)
    const xorAB = this.xor(a, b);
    const andAB = this.and(a, b);
    return this.xor(xorAB, andAB);
  }

  // === Constants ===

  zero() {
    if (this.constants.zero !== null) return this.constants.zero;
    if (this.inputWires.length === 0) {
      throw new Error('Need at least one input wire before creating constants');
    }
    this.constants.zero = this.xor(this.inputWires[0], this.inputWires[0]);
    return this.constants.zero;
  }

  one() {
    if (this.constants.one !== null) return this.constants.one;
    this.constants.one = this.inv(this.zero());
    return this.constants.one;
  }

  constantBits(value, bitWidth) {
    const bits = [];
    for (let i = 0; i < bitWidth; i++) {
      bits.push((value >> i) & 1 ? this.one() : this.zero());
    }
    return bits;
  }

  // === Composite Gates ===

  // 2-to-1 MUX: out = sel ? b : a
  mux(sel, a, b) {
    const xorAB = this.xor(a, b);
    const andSel = this.and(sel, xorAB);
    return this.xor(a, andSel);
  }

  // N-bit MUX
  muxN(sel, aBits, bBits) {
    if (aBits.length !== bBits.length) {
      throw new Error('MUX operands must have same bit width');
    }
    return aBits.map((a, i) => this.mux(sel, a, bBits[i]));
  }

  // Full adder: [sum, carry]
  fullAdder(a, b, cin) {
    const axorb = this.xor(a, b);
    const sum = this.xor(axorb, cin);
    const aAndb = this.and(a, b);
    const axorbAndCin = this.and(axorb, cin);
    // OR via XOR works here because aAndb and axorbAndCin are mutually exclusive
    const cout = this.xor(aAndb, axorbAndCin);
    return [sum, cout];
  }

  // N-bit ripple-carry adder
  addN(aBits, bBits, carryIn = null) {
    const n = aBits.length;
    if (bBits.length !== n) {
      throw new Error('Adder operands must have same bit width');
    }

    const sumBits = [];
    let carry = carryIn ?? this.zero();

    for (let i = 0; i < n; i++) {
      const [sum, cout] = this.fullAdder(aBits[i], bBits[i], carry);
      sumBits.push(sum);
      carry = cout;
    }

    return { sum: sumBits, carry };
  }

  // N-bit subtractor: a - b (two's complement)
  subN(aBits, bBits) {
    const n = aBits.length;
    const bInv = bBits.map(b => this.inv(b));
    const { sum } = this.addN(aBits, bInv, this.one());
    return sum;
  }

  // N-bit equality: 1 if a == b
  eqN(aBits, bBits) {
    const n = aBits.length;
    let result = this.one();

    for (let i = 0; i < n; i++) {
      const diff = this.xor(aBits[i], bBits[i]);
      const same = this.inv(diff);
      result = this.and(result, same);
    }

    return result;
  }

  // N-bit not-equal
  neqN(aBits, bBits) {
    return this.inv(this.eqN(aBits, bBits));
  }

  // N-bit less-than (unsigned): 1 if a < b
  ltN(aBits, bBits) {
    // a < b iff (a - b) has borrow, i.e., ~carry from a + ~b + 1
    const bInv = bBits.map(b => this.inv(b));
    const { carry } = this.addN(aBits, bInv, this.one());
    return this.inv(carry); // borrow = ~carry
  }

  // N-bit signed less-than
  sltN(aBits, bBits) {
    const n = aBits.length;
    const signA = aBits[n - 1];
    const signB = bBits[n - 1];

    // If signs differ: a < b iff a is negative
    const signsDiffer = this.xor(signA, signB);

    // If signs same: use unsigned comparison
    const unsignedLt = this.ltN(aBits, bBits);

    return this.mux(signsDiffer, unsignedLt, signA);
  }

  // N-bit multiplier (array multiplier - O(n²) gates)
  mulN(aBits, bBits) {
    const n = aBits.length;
    const resultWidth = 2 * n;

    // Build partial products
    const partials = [];
    for (let i = 0; i < n; i++) {
      const partial = [];
      // Shift: i zeros at LSB
      for (let s = 0; s < i; s++) {
        partial.push(this.zero());
      }
      // AND a[j] with b[i]
      for (let j = 0; j < n; j++) {
        partial.push(this.and(aBits[j], bBits[i]));
      }
      // Pad to result width
      while (partial.length < resultWidth) {
        partial.push(this.zero());
      }
      partials.push(partial);
    }

    // Sum all partials
    let result = partials[0];
    for (let i = 1; i < partials.length; i++) {
      const { sum } = this.addN(result, partials[i]);
      result = sum;
    }

    return result;
  }

  // Bitwise AND
  andN(aBits, bBits) {
    return aBits.map((a, i) => this.and(a, bBits[i]));
  }

  // Bitwise OR
  orN(aBits, bBits) {
    return aBits.map((a, i) => this.or(a, bBits[i]));
  }

  // Bitwise XOR
  xorN(aBits, bBits) {
    return aBits.map((a, i) => this.xor(a, bBits[i]));
  }

  // Left shift by constant
  shlConst(bits, shift) {
    if (shift >= bits.length) {
      return bits.map(() => this.zero());
    }
    const result = [];
    for (let i = 0; i < bits.length; i++) {
      result.push(i < shift ? this.zero() : bits[i - shift]);
    }
    return result;
  }

  // Logical right shift by constant
  shrConst(bits, shift) {
    if (shift >= bits.length) {
      return bits.map(() => this.zero());
    }
    const result = [];
    for (let i = 0; i < bits.length; i++) {
      result.push(i + shift < bits.length ? bits[i + shift] : this.zero());
    }
    return result;
  }

  // Arithmetic right shift by constant
  sraConst(bits, shift) {
    if (shift >= bits.length) {
      return bits.map(() => bits[bits.length - 1]); // All sign bits
    }
    const result = [];
    const sign = bits[bits.length - 1];
    for (let i = 0; i < bits.length; i++) {
      result.push(i + shift < bits.length ? bits[i + shift] : sign);
    }
    return result;
  }

  // === Output ===

  setOutputs(wires) {
    this.outputWires = Array.isArray(wires) ? wires : [wires];
  }

  // === Export Formats ===

  toBristol() {
    const lines = [];
    lines.push(`${this.gates.length} ${this.wireCount}`);
    lines.push(`${this.inputWires.length} ${this.outputWires.length}`);

    for (const gate of this.gates) {
      const numIn = gate.inputs.length;
      const numOut = gate.outputs.length;
      lines.push(`${numIn} ${numOut} ${gate.inputs.join(' ')} ${gate.outputs.join(' ')} ${gate.type}`);
    }

    return lines.join('\n');
  }

  getStats() {
    const counts = { AND: 0, XOR: 0, INV: 0, OR: 0 };
    for (const gate of this.gates) {
      counts[gate.type] = (counts[gate.type] || 0) + 1;
    }

    return {
      name: this.name,
      totalGates: this.gates.length,
      wireCount: this.wireCount,
      inputBits: this.inputWires.length,
      outputBits: this.outputWires.length,
      gates: counts,
      freeGates: counts.XOR + counts.INV,
      nonFreeGates: counts.AND + counts.OR
    };
  }
}

module.exports = { Circuit };
