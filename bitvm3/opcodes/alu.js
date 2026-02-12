/**
 * ALU Opcode Constraints
 *
 * Covers: ADD, SUB, AND, OR, XOR, SLT, SLTU, SLL, SRL, SRA
 * Plus immediate variants: ADDI, ANDI, ORI, XORI, SLTI, SLTIU, SLLI, SRLI, SRAI
 */

const { OpcodeConstraint, standardInputs } = require('./base');
const { XLEN, decodeInstruction, ALU_FUNC, OPCODE } = require('../riscv');

/**
 * ADD / ADDI constraint
 * Verifies: rd = rs1 + operand2
 */
class AddConstraint extends OpcodeConstraint {
  constructor() {
    super('ADD');
  }

  constrain(circuit, inputs) {
    const { rs1, operand2, rdClaimed } = inputs;

    // Compute expected rd = rs1 + operand2
    const { sum: rdExpected } = circuit.addN(rs1, operand2);

    // Constraint: rdExpected == rdClaimed
    const valid = circuit.eqN(rdExpected, rdClaimed);

    return { rdExpected, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    const isImm = (d.opcode === OPCODE.OP_IMM);

    return {
      rs1: step.preState.getReg(d.rs1),
      operand2: isImm ? (d.immI >>> 0) : step.preState.getReg(d.rs2),
      rdClaimed: step.postState.getReg(d.rd)
    };
  }
}

/**
 * SUB constraint
 * Verifies: rd = rs1 - rs2
 */
class SubConstraint extends OpcodeConstraint {
  constructor() {
    super('SUB');
  }

  constrain(circuit, inputs) {
    const { rs1, rs2, rdClaimed } = inputs;

    // Compute expected rd = rs1 - rs2
    const rdExpected = circuit.subN(rs1, rs2);

    // Constraint: rdExpected == rdClaimed
    const valid = circuit.eqN(rdExpected, rdClaimed);

    return { rdExpected, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    return {
      rs1: step.preState.getReg(d.rs1),
      rs2: step.preState.getReg(d.rs2),
      rdClaimed: step.postState.getReg(d.rd)
    };
  }
}

/**
 * AND / ANDI constraint
 * Verifies: rd = rs1 & operand2
 */
class AndConstraint extends OpcodeConstraint {
  constructor() {
    super('AND');
  }

  constrain(circuit, inputs) {
    const { rs1, operand2, rdClaimed } = inputs;

    const rdExpected = circuit.andN(rs1, operand2);
    const valid = circuit.eqN(rdExpected, rdClaimed);

    return { rdExpected, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    const isImm = (d.opcode === OPCODE.OP_IMM);

    return {
      rs1: step.preState.getReg(d.rs1),
      operand2: isImm ? (d.immI >>> 0) : step.preState.getReg(d.rs2),
      rdClaimed: step.postState.getReg(d.rd)
    };
  }
}

/**
 * OR / ORI constraint
 * Verifies: rd = rs1 | operand2
 */
class OrConstraint extends OpcodeConstraint {
  constructor() {
    super('OR');
  }

  constrain(circuit, inputs) {
    const { rs1, operand2, rdClaimed } = inputs;

    const rdExpected = circuit.orN(rs1, operand2);
    const valid = circuit.eqN(rdExpected, rdClaimed);

    return { rdExpected, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    const isImm = (d.opcode === OPCODE.OP_IMM);

    return {
      rs1: step.preState.getReg(d.rs1),
      operand2: isImm ? (d.immI >>> 0) : step.preState.getReg(d.rs2),
      rdClaimed: step.postState.getReg(d.rd)
    };
  }
}

/**
 * XOR / XORI constraint
 * Verifies: rd = rs1 ^ operand2
 */
class XorConstraint extends OpcodeConstraint {
  constructor() {
    super('XOR');
  }

  constrain(circuit, inputs) {
    const { rs1, operand2, rdClaimed } = inputs;

    const rdExpected = circuit.xorN(rs1, operand2);
    const valid = circuit.eqN(rdExpected, rdClaimed);

    return { rdExpected, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    const isImm = (d.opcode === OPCODE.OP_IMM);

    return {
      rs1: step.preState.getReg(d.rs1),
      operand2: isImm ? (d.immI >>> 0) : step.preState.getReg(d.rs2),
      rdClaimed: step.postState.getReg(d.rd)
    };
  }
}

/**
 * SLT / SLTI constraint (signed less-than)
 * Verifies: rd = (rs1 < operand2) ? 1 : 0  (signed comparison)
 */
class SltConstraint extends OpcodeConstraint {
  constructor() {
    super('SLT');
  }

  constrain(circuit, inputs) {
    const { rs1, operand2, rdClaimed } = inputs;

    // Compute signed less-than
    const lt = circuit.sltN(rs1, operand2);

    // Expected rd is 1-bit result zero-extended
    const rdExpected = [lt];
    for (let i = 1; i < XLEN; i++) {
      rdExpected.push(circuit.zero());
    }

    const valid = circuit.eqN(rdExpected, rdClaimed);

    return { rdExpected, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    const isImm = (d.opcode === OPCODE.OP_IMM);

    return {
      rs1: step.preState.getReg(d.rs1),
      operand2: isImm ? (d.immI >>> 0) : step.preState.getReg(d.rs2),
      rdClaimed: step.postState.getReg(d.rd)
    };
  }
}

/**
 * SLTU / SLTIU constraint (unsigned less-than)
 * Verifies: rd = (rs1 < operand2) ? 1 : 0  (unsigned comparison)
 */
class SltuConstraint extends OpcodeConstraint {
  constructor() {
    super('SLTU');
  }

  constrain(circuit, inputs) {
    const { rs1, operand2, rdClaimed } = inputs;

    // Compute unsigned less-than
    const lt = circuit.ltN(rs1, operand2);

    const rdExpected = [lt];
    for (let i = 1; i < XLEN; i++) {
      rdExpected.push(circuit.zero());
    }

    const valid = circuit.eqN(rdExpected, rdClaimed);

    return { rdExpected, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    const isImm = (d.opcode === OPCODE.OP_IMM);

    return {
      rs1: step.preState.getReg(d.rs1),
      operand2: isImm ? (d.immI >>> 0) : step.preState.getReg(d.rs2),
      rdClaimed: step.postState.getReg(d.rd)
    };
  }
}

/**
 * MUL constraint (lower 32 bits of multiplication)
 * Verifies: rd = (rs1 * rs2)[31:0]
 */
class MulConstraint extends OpcodeConstraint {
  constructor() {
    super('MUL');
  }

  constrain(circuit, inputs) {
    const { rs1, rs2, rdClaimed } = inputs;

    // Full multiplication gives 64 bits
    const product = circuit.mulN(rs1, rs2);

    // Take lower 32 bits
    const rdExpected = product.slice(0, XLEN);

    const valid = circuit.eqN(rdExpected, rdClaimed);

    return { rdExpected, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    return {
      rs1: step.preState.getReg(d.rs1),
      rs2: step.preState.getReg(d.rs2),
      rdClaimed: step.postState.getReg(d.rd)
    };
  }
}

/**
 * SLL / SLLI constraint (shift left logical)
 * Verifies: rd = rs1 << shamt
 *
 * Note: Dynamic shifts are expensive in circuits.
 * This uses a barrel shifter approach.
 */
class SllConstraint extends OpcodeConstraint {
  constructor() {
    super('SLL');
  }

  constrain(circuit, inputs) {
    const { rs1, shamt, rdClaimed } = inputs;

    // Barrel shifter: cascade 5 stages for 32-bit shift
    let current = rs1;

    // Stage 0: shift by 1 if shamt[0]
    const shifted1 = circuit.shlConst(current, 1);
    current = circuit.muxN(shamt[0], current, shifted1);

    // Stage 1: shift by 2 if shamt[1]
    const shifted2 = circuit.shlConst(current, 2);
    current = circuit.muxN(shamt[1], current, shifted2);

    // Stage 2: shift by 4 if shamt[2]
    const shifted4 = circuit.shlConst(current, 4);
    current = circuit.muxN(shamt[2], current, shifted4);

    // Stage 3: shift by 8 if shamt[3]
    const shifted8 = circuit.shlConst(current, 8);
    current = circuit.muxN(shamt[3], current, shifted8);

    // Stage 4: shift by 16 if shamt[4]
    const shifted16 = circuit.shlConst(current, 16);
    current = circuit.muxN(shamt[4], current, shifted16);

    const rdExpected = current;
    const valid = circuit.eqN(rdExpected, rdClaimed);

    return { rdExpected, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    const isImm = (d.opcode === OPCODE.OP_IMM);

    return {
      rs1: step.preState.getReg(d.rs1),
      shamt: isImm ? d.rs2 : (step.preState.getReg(d.rs2) & 0x1F),
      rdClaimed: step.postState.getReg(d.rd)
    };
  }
}

/**
 * SRL / SRLI constraint (shift right logical)
 * Verifies: rd = rs1 >> shamt (zero-fill)
 */
class SrlConstraint extends OpcodeConstraint {
  constructor() {
    super('SRL');
  }

  constrain(circuit, inputs) {
    const { rs1, shamt, rdClaimed } = inputs;

    let current = rs1;

    const shifted1 = circuit.shrConst(current, 1);
    current = circuit.muxN(shamt[0], current, shifted1);

    const shifted2 = circuit.shrConst(current, 2);
    current = circuit.muxN(shamt[1], current, shifted2);

    const shifted4 = circuit.shrConst(current, 4);
    current = circuit.muxN(shamt[2], current, shifted4);

    const shifted8 = circuit.shrConst(current, 8);
    current = circuit.muxN(shamt[3], current, shifted8);

    const shifted16 = circuit.shrConst(current, 16);
    current = circuit.muxN(shamt[4], current, shifted16);

    const rdExpected = current;
    const valid = circuit.eqN(rdExpected, rdClaimed);

    return { rdExpected, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    const isImm = (d.opcode === OPCODE.OP_IMM);

    return {
      rs1: step.preState.getReg(d.rs1),
      shamt: isImm ? d.rs2 : (step.preState.getReg(d.rs2) & 0x1F),
      rdClaimed: step.postState.getReg(d.rd)
    };
  }
}

/**
 * SRA / SRAI constraint (shift right arithmetic)
 * Verifies: rd = rs1 >> shamt (sign-fill)
 */
class SraConstraint extends OpcodeConstraint {
  constructor() {
    super('SRA');
  }

  constrain(circuit, inputs) {
    const { rs1, shamt, rdClaimed } = inputs;

    let current = rs1;

    const shifted1 = circuit.sraConst(current, 1);
    current = circuit.muxN(shamt[0], current, shifted1);

    const shifted2 = circuit.sraConst(current, 2);
    current = circuit.muxN(shamt[1], current, shifted2);

    const shifted4 = circuit.sraConst(current, 4);
    current = circuit.muxN(shamt[2], current, shifted4);

    const shifted8 = circuit.sraConst(current, 8);
    current = circuit.muxN(shamt[3], current, shifted8);

    const shifted16 = circuit.sraConst(current, 16);
    current = circuit.muxN(shamt[4], current, shifted16);

    const rdExpected = current;
    const valid = circuit.eqN(rdExpected, rdClaimed);

    return { rdExpected, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    const isImm = (d.opcode === OPCODE.OP_IMM);

    return {
      rs1: step.preState.getReg(d.rs1),
      shamt: isImm ? d.rs2 : (step.preState.getReg(d.rs2) & 0x1F),
      rdClaimed: step.postState.getReg(d.rd)
    };
  }
}

module.exports = {
  AddConstraint,
  SubConstraint,
  AndConstraint,
  OrConstraint,
  XorConstraint,
  SltConstraint,
  SltuConstraint,
  MulConstraint,
  SllConstraint,
  SrlConstraint,
  SraConstraint
};
