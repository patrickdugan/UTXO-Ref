/**
 * Branch Opcode Constraints
 *
 * Covers: BEQ, BNE, BLT, BGE, BLTU, BGEU, JAL, JALR
 *
 * Branch verification ensures:
 *   1. Condition evaluation is correct
 *   2. PC update follows branch semantics
 *   3. Link register (rd) is set for JAL/JALR
 */

const { OpcodeConstraint } = require('./base');
const { XLEN, decodeInstruction, BRANCH_FUNC, OPCODE } = require('../riscv');

/**
 * BEQ (Branch if Equal) constraint
 * Verifies: if (rs1 == rs2) pc := pc + imm else pc := pc + 4
 */
class BeqConstraint extends OpcodeConstraint {
  constructor() {
    super('BEQ');
  }

  constrain(circuit, inputs) {
    const { rs1, rs2, pc, imm, postPC } = inputs;

    // Condition: rs1 == rs2
    const taken = circuit.eqN(rs1, rs2);

    // Branch target
    const { sum: branchTarget } = circuit.addN(pc, imm);

    // Sequential target (pc + 4)
    const four = circuit.constantBits(4, XLEN);
    const { sum: seqTarget } = circuit.addN(pc, four);

    // Expected PC = taken ? branchTarget : seqTarget
    const expectedPC = circuit.muxN(taken, seqTarget, branchTarget);

    const valid = circuit.eqN(expectedPC, postPC);

    return { taken, expectedPC, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    return {
      rs1: step.preState.getReg(d.rs1),
      rs2: step.preState.getReg(d.rs2),
      pc: step.preState.pc,
      imm: d.immB >>> 0,
      postPC: step.postState.pc
    };
  }
}

/**
 * BNE (Branch if Not Equal) constraint
 * Verifies: if (rs1 != rs2) pc := pc + imm else pc := pc + 4
 */
class BneConstraint extends OpcodeConstraint {
  constructor() {
    super('BNE');
  }

  constrain(circuit, inputs) {
    const { rs1, rs2, pc, imm, postPC } = inputs;

    // Condition: rs1 != rs2
    const taken = circuit.neqN(rs1, rs2);

    const { sum: branchTarget } = circuit.addN(pc, imm);
    const four = circuit.constantBits(4, XLEN);
    const { sum: seqTarget } = circuit.addN(pc, four);

    const expectedPC = circuit.muxN(taken, seqTarget, branchTarget);
    const valid = circuit.eqN(expectedPC, postPC);

    return { taken, expectedPC, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    return {
      rs1: step.preState.getReg(d.rs1),
      rs2: step.preState.getReg(d.rs2),
      pc: step.preState.pc,
      imm: d.immB >>> 0,
      postPC: step.postState.pc
    };
  }
}

/**
 * BLT (Branch if Less Than, signed) constraint
 * Verifies: if (rs1 < rs2) pc := pc + imm else pc := pc + 4
 */
class BltConstraint extends OpcodeConstraint {
  constructor() {
    super('BLT');
  }

  constrain(circuit, inputs) {
    const { rs1, rs2, pc, imm, postPC } = inputs;

    // Condition: rs1 < rs2 (signed)
    const taken = circuit.sltN(rs1, rs2);

    const { sum: branchTarget } = circuit.addN(pc, imm);
    const four = circuit.constantBits(4, XLEN);
    const { sum: seqTarget } = circuit.addN(pc, four);

    const expectedPC = circuit.muxN(taken, seqTarget, branchTarget);
    const valid = circuit.eqN(expectedPC, postPC);

    return { taken, expectedPC, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    return {
      rs1: step.preState.getReg(d.rs1),
      rs2: step.preState.getReg(d.rs2),
      pc: step.preState.pc,
      imm: d.immB >>> 0,
      postPC: step.postState.pc
    };
  }
}

/**
 * BGE (Branch if Greater or Equal, signed) constraint
 * Verifies: if (rs1 >= rs2) pc := pc + imm else pc := pc + 4
 */
class BgeConstraint extends OpcodeConstraint {
  constructor() {
    super('BGE');
  }

  constrain(circuit, inputs) {
    const { rs1, rs2, pc, imm, postPC } = inputs;

    // Condition: rs1 >= rs2 (signed) = NOT(rs1 < rs2)
    const lt = circuit.sltN(rs1, rs2);
    const taken = circuit.inv(lt);

    const { sum: branchTarget } = circuit.addN(pc, imm);
    const four = circuit.constantBits(4, XLEN);
    const { sum: seqTarget } = circuit.addN(pc, four);

    const expectedPC = circuit.muxN(taken, seqTarget, branchTarget);
    const valid = circuit.eqN(expectedPC, postPC);

    return { taken, expectedPC, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    return {
      rs1: step.preState.getReg(d.rs1),
      rs2: step.preState.getReg(d.rs2),
      pc: step.preState.pc,
      imm: d.immB >>> 0,
      postPC: step.postState.pc
    };
  }
}

/**
 * BLTU (Branch if Less Than, unsigned) constraint
 * Verifies: if (rs1 < rs2) pc := pc + imm else pc := pc + 4
 */
class BltuConstraint extends OpcodeConstraint {
  constructor() {
    super('BLTU');
  }

  constrain(circuit, inputs) {
    const { rs1, rs2, pc, imm, postPC } = inputs;

    // Condition: rs1 < rs2 (unsigned)
    const taken = circuit.ltN(rs1, rs2);

    const { sum: branchTarget } = circuit.addN(pc, imm);
    const four = circuit.constantBits(4, XLEN);
    const { sum: seqTarget } = circuit.addN(pc, four);

    const expectedPC = circuit.muxN(taken, seqTarget, branchTarget);
    const valid = circuit.eqN(expectedPC, postPC);

    return { taken, expectedPC, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    return {
      rs1: step.preState.getReg(d.rs1),
      rs2: step.preState.getReg(d.rs2),
      pc: step.preState.pc,
      imm: d.immB >>> 0,
      postPC: step.postState.pc
    };
  }
}

/**
 * BGEU (Branch if Greater or Equal, unsigned) constraint
 * Verifies: if (rs1 >= rs2) pc := pc + imm else pc := pc + 4
 */
class BgeuConstraint extends OpcodeConstraint {
  constructor() {
    super('BGEU');
  }

  constrain(circuit, inputs) {
    const { rs1, rs2, pc, imm, postPC } = inputs;

    // Condition: rs1 >= rs2 (unsigned) = NOT(rs1 < rs2)
    const lt = circuit.ltN(rs1, rs2);
    const taken = circuit.inv(lt);

    const { sum: branchTarget } = circuit.addN(pc, imm);
    const four = circuit.constantBits(4, XLEN);
    const { sum: seqTarget } = circuit.addN(pc, four);

    const expectedPC = circuit.muxN(taken, seqTarget, branchTarget);
    const valid = circuit.eqN(expectedPC, postPC);

    return { taken, expectedPC, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    return {
      rs1: step.preState.getReg(d.rs1),
      rs2: step.preState.getReg(d.rs2),
      pc: step.preState.pc,
      imm: d.immB >>> 0,
      postPC: step.postState.pc
    };
  }
}

/**
 * JAL (Jump and Link) constraint
 * Verifies: rd := pc + 4; pc := pc + imm
 */
class JalConstraint extends OpcodeConstraint {
  constructor() {
    super('JAL');
  }

  constrain(circuit, inputs) {
    const { pc, imm, rdClaimed, postPC } = inputs;

    // rd = pc + 4 (return address)
    const four = circuit.constantBits(4, XLEN);
    const { sum: rdExpected } = circuit.addN(pc, four);

    // pc = pc + imm
    const { sum: expectedPC } = circuit.addN(pc, imm);

    const rdValid = circuit.eqN(rdExpected, rdClaimed);
    const pcValid = circuit.eqN(expectedPC, postPC);

    const valid = circuit.and(rdValid, pcValid);

    return { rdExpected, expectedPC, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    return {
      pc: step.preState.pc,
      imm: d.immJ >>> 0,
      rdClaimed: step.postState.getReg(d.rd),
      postPC: step.postState.pc
    };
  }
}

/**
 * JALR (Jump and Link Register) constraint
 * Verifies: rd := pc + 4; pc := (rs1 + imm) & ~1
 */
class JalrConstraint extends OpcodeConstraint {
  constructor() {
    super('JALR');
  }

  constrain(circuit, inputs) {
    const { rs1, imm, pc, rdClaimed, postPC } = inputs;

    // rd = pc + 4
    const four = circuit.constantBits(4, XLEN);
    const { sum: rdExpected } = circuit.addN(pc, four);

    // pc = (rs1 + imm) & ~1
    const { sum: target } = circuit.addN(rs1, imm);

    // Clear LSB (align to 2-byte boundary)
    const expectedPC = [...target];
    expectedPC[0] = circuit.zero();

    const rdValid = circuit.eqN(rdExpected, rdClaimed);
    const pcValid = circuit.eqN(expectedPC, postPC);

    const valid = circuit.and(rdValid, pcValid);

    return { rdExpected, expectedPC, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    return {
      rs1: step.preState.getReg(d.rs1),
      imm: d.immI >>> 0,
      pc: step.preState.pc,
      rdClaimed: step.postState.getReg(d.rd),
      postPC: step.postState.pc
    };
  }
}

/**
 * LUI (Load Upper Immediate) constraint
 * Verifies: rd := imm << 12 (already in upper 20 bits of immU)
 */
class LuiConstraint extends OpcodeConstraint {
  constructor() {
    super('LUI');
  }

  constrain(circuit, inputs) {
    const { imm, rdClaimed } = inputs;

    // imm is already the upper immediate (bits 31:12, lower 12 are 0)
    const valid = circuit.eqN(imm, rdClaimed);

    return { rdExpected: imm, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    return {
      imm: d.immU >>> 0,
      rdClaimed: step.postState.getReg(d.rd)
    };
  }
}

/**
 * AUIPC (Add Upper Immediate to PC) constraint
 * Verifies: rd := pc + (imm << 12)
 */
class AuipcConstraint extends OpcodeConstraint {
  constructor() {
    super('AUIPC');
  }

  constrain(circuit, inputs) {
    const { pc, imm, rdClaimed } = inputs;

    const { sum: rdExpected } = circuit.addN(pc, imm);
    const valid = circuit.eqN(rdExpected, rdClaimed);

    return { rdExpected, valid };
  }

  computeWitness(step) {
    const d = decodeInstruction(step.instruction);
    return {
      pc: step.preState.pc,
      imm: d.immU >>> 0,
      rdClaimed: step.postState.getReg(d.rd)
    };
  }
}

module.exports = {
  BeqConstraint,
  BneConstraint,
  BltConstraint,
  BgeConstraint,
  BltuConstraint,
  BgeuConstraint,
  JalConstraint,
  JalrConstraint,
  LuiConstraint,
  AuipcConstraint
};
