/**
 * Opcode Constraint Registry
 *
 * Maps RISC-V opcodes to their constraint generators.
 */

const { OpcodeConstraint, standardInputs, transitionInputs } = require('./base');
const alu = require('./alu');
const memory = require('./memory');
const branch = require('./branch');

// Re-export all constraint classes
module.exports = {
  // Base
  OpcodeConstraint,
  standardInputs,
  transitionInputs,

  // ALU
  ...alu,

  // Memory
  ...memory,

  // Branch/Jump
  ...branch,

  // Registry for looking up constraints by opcode name
  registry: {
    // ALU register-register
    ADD:  new alu.AddConstraint(),
    SUB:  new alu.SubConstraint(),
    AND:  new alu.AndConstraint(),
    OR:   new alu.OrConstraint(),
    XOR:  new alu.XorConstraint(),
    SLT:  new alu.SltConstraint(),
    SLTU: new alu.SltuConstraint(),
    SLL:  new alu.SllConstraint(),
    SRL:  new alu.SrlConstraint(),
    SRA:  new alu.SraConstraint(),
    MUL:  new alu.MulConstraint(),

    // ALU immediate
    ADDI:  new alu.AddConstraint(),
    ANDI:  new alu.AndConstraint(),
    ORI:   new alu.OrConstraint(),
    XORI:  new alu.XorConstraint(),
    SLTI:  new alu.SltConstraint(),
    SLTIU: new alu.SltuConstraint(),
    SLLI:  new alu.SllConstraint(),
    SRLI:  new alu.SrlConstraint(),
    SRAI:  new alu.SraConstraint(),

    // Memory
    LW:  new memory.LoadWordConstraint(),
    LB:  new memory.LoadByteConstraint(),
    LBU: new memory.LoadByteUnsignedConstraint(),
    LH:  new memory.LoadHalfConstraint(),
    LHU: new memory.LoadHalfUnsignedConstraint(),
    SW:  new memory.StoreWordConstraint(),
    SB:  new memory.StoreByteConstraint(),
    SH:  new memory.StoreHalfConstraint(),

    // Branches
    BEQ:  new branch.BeqConstraint(),
    BNE:  new branch.BneConstraint(),
    BLT:  new branch.BltConstraint(),
    BGE:  new branch.BgeConstraint(),
    BLTU: new branch.BltuConstraint(),
    BGEU: new branch.BgeuConstraint(),

    // Jumps
    JAL:  new branch.JalConstraint(),
    JALR: new branch.JalrConstraint(),

    // Upper immediate
    LUI:   new branch.LuiConstraint(),
    AUIPC: new branch.AuipcConstraint(),
  }
};
