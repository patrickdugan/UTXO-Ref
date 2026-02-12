/**
 * Base Opcode Constraint Generator
 *
 * All opcode generators extend this class and implement:
 *   - constrain(circuit, inputs): Add constraints to circuit
 *   - computeWitness(step): Compute witness values from trace step
 */

const { XLEN } = require('../riscv');

class OpcodeConstraint {
  constructor(name) {
    this.name = name;
    this.bitWidth = XLEN;
  }

  /**
   * Add constraints to verify this opcode's execution
   * @param {Circuit} circuit - The circuit to add constraints to
   * @param {Object} inputs - Wire arrays for inputs
   * @returns {Object} Output wire arrays
   */
  constrain(circuit, inputs) {
    throw new Error(`${this.name}: constrain() not implemented`);
  }

  /**
   * Compute witness values for this opcode
   * @param {TraceStep} step - Execution trace step
   * @returns {Object} Witness values keyed by input name
   */
  computeWitness(step) {
    throw new Error(`${this.name}: computeWitness() not implemented`);
  }

  /**
   * Helper: Convert integer to bit array (LSB first)
   */
  toBits(value, bitWidth = this.bitWidth) {
    const bits = [];
    for (let i = 0; i < bitWidth; i++) {
      bits.push((value >> i) & 1);
    }
    return bits;
  }

  /**
   * Helper: Convert bit array to integer
   */
  fromBits(bits) {
    let value = 0;
    for (let i = 0; i < bits.length; i++) {
      if (bits[i]) value |= (1 << i);
    }
    return value >>> 0;
  }
}

/**
 * Standard inputs for most opcodes
 */
function standardInputs(circuit) {
  return {
    rs1: circuit.addInput(XLEN, 'rs1'),      // Source register 1
    rs2: circuit.addInput(XLEN, 'rs2'),      // Source register 2
    imm: circuit.addInput(XLEN, 'imm'),      // Immediate value (sign-extended)
    pc:  circuit.addInput(XLEN, 'pc'),       // Program counter
    rd:  circuit.addInput(XLEN, 'rd'),       // Destination register (claimed)
  };
}

/**
 * Inputs for transition verification (pre-state -> post-state)
 */
function transitionInputs(circuit, numRegs = 32) {
  const inputs = {
    prePC: circuit.addInput(XLEN, 'prePC'),
    postPC: circuit.addInput(XLEN, 'postPC'),
    instruction: circuit.addInput(XLEN, 'instruction'),
    preRegs: [],
    postRegs: [],
  };

  // For full verification, include all registers
  // For optimization, only include rs1, rs2, rd
  for (let i = 0; i < numRegs; i++) {
    inputs.preRegs.push(circuit.addInput(XLEN, `preR${i}`));
    inputs.postRegs.push(circuit.addInput(XLEN, `postR${i}`));
  }

  return inputs;
}

module.exports = {
  OpcodeConstraint,
  standardInputs,
  transitionInputs
};
