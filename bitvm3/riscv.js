/**
 * RISC-V State Model for BitVM3
 *
 * Defines the RISC-V machine state and execution trace format
 * that circuits will verify.
 *
 * RV32I base instruction set coverage:
 *   - ALU: ADD, SUB, AND, OR, XOR, SLT, SLTU, SLL, SRL, SRA
 *   - Immediate: ADDI, ANDI, ORI, XORI, SLTI, SLTIU, SLLI, SRLI, SRAI
 *   - Memory: LW, SW, LB, SB, LH, SH, LBU, LHU
 *   - Branch: BEQ, BNE, BLT, BGE, BLTU, BGEU
 *   - Jump: JAL, JALR
 *   - Upper: LUI, AUIPC
 */

const XLEN = 32; // RV32

// RISC-V opcodes (bits 6:0)
const OPCODE = {
  LUI:    0b0110111,
  AUIPC:  0b0010111,
  JAL:    0b1101111,
  JALR:   0b1100111,
  BRANCH: 0b1100011,
  LOAD:   0b0000011,
  STORE:  0b0100011,
  OP_IMM: 0b0010011,
  OP:     0b0110011,
  SYSTEM: 0b1110011
};

// ALU function codes (funct3 for OP/OP_IMM)
const ALU_FUNC = {
  ADD:  0b000, // SUB when funct7[5]=1
  SLL:  0b001,
  SLT:  0b010,
  SLTU: 0b011,
  XOR:  0b100,
  SRL:  0b101, // SRA when funct7[5]=1
  OR:   0b110,
  AND:  0b111
};

// Branch function codes (funct3)
const BRANCH_FUNC = {
  BEQ:  0b000,
  BNE:  0b001,
  BLT:  0b100,
  BGE:  0b101,
  BLTU: 0b110,
  BGEU: 0b111
};

// Load/Store function codes (funct3)
const MEM_FUNC = {
  BYTE:  0b000, // LB/SB
  HALF:  0b001, // LH/SH
  WORD:  0b010, // LW/SW
  BYTEU: 0b100, // LBU
  HALFU: 0b101  // LHU
};

/**
 * RISC-V CPU State
 */
class RiscVState {
  constructor() {
    this.pc = 0;
    this.regs = new Uint32Array(32);
    this.regs[0] = 0; // x0 is always 0
    this.memory = new Map(); // sparse memory: addr -> byte
  }

  clone() {
    const s = new RiscVState();
    s.pc = this.pc;
    s.regs = new Uint32Array(this.regs);
    s.memory = new Map(this.memory);
    return s;
  }

  getReg(idx) {
    return idx === 0 ? 0 : this.regs[idx];
  }

  setReg(idx, value) {
    if (idx !== 0) {
      this.regs[idx] = value >>> 0;
    }
  }

  loadByte(addr) {
    return this.memory.get(addr) ?? 0;
  }

  storeByte(addr, value) {
    this.memory.set(addr, value & 0xFF);
  }

  loadWord(addr) {
    return (
      this.loadByte(addr) |
      (this.loadByte(addr + 1) << 8) |
      (this.loadByte(addr + 2) << 16) |
      (this.loadByte(addr + 3) << 24)
    ) >>> 0;
  }

  storeWord(addr, value) {
    this.storeByte(addr, value & 0xFF);
    this.storeByte(addr + 1, (value >> 8) & 0xFF);
    this.storeByte(addr + 2, (value >> 16) & 0xFF);
    this.storeByte(addr + 3, (value >> 24) & 0xFF);
  }

  loadHalf(addr) {
    return (this.loadByte(addr) | (this.loadByte(addr + 1) << 8)) & 0xFFFF;
  }

  storeHalf(addr, value) {
    this.storeByte(addr, value & 0xFF);
    this.storeByte(addr + 1, (value >> 8) & 0xFF);
  }

  // Merkle root of memory (placeholder - implement proper merkleization)
  memoryRoot() {
    // For now, just hash all memory contents
    // In production, use sparse Merkle tree
    const entries = [...this.memory.entries()].sort((a, b) => a[0] - b[0]);
    return JSON.stringify(entries);
  }
}

/**
 * Execution trace step - what circuits verify
 */
class TraceStep {
  constructor() {
    this.preState = null;   // RiscVState before
    this.postState = null;  // RiscVState after
    this.instruction = 0;   // 32-bit instruction
    this.memReadAddr = 0;   // Memory read address (if any)
    this.memReadValue = 0;  // Memory read value
    this.memWriteAddr = 0;  // Memory write address (if any)
    this.memWriteValue = 0; // Memory write value
  }
}

/**
 * Decode instruction fields
 */
function decodeInstruction(instr) {
  return {
    opcode: instr & 0x7F,
    rd:     (instr >> 7) & 0x1F,
    funct3: (instr >> 12) & 0x7,
    rs1:    (instr >> 15) & 0x1F,
    rs2:    (instr >> 20) & 0x1F,
    funct7: (instr >> 25) & 0x7F,

    // Immediate formats
    immI: signExtend((instr >> 20), 12),
    immS: signExtend(((instr >> 25) << 5) | ((instr >> 7) & 0x1F), 12),
    immB: signExtend(
      (((instr >> 31) & 1) << 12) |
      (((instr >> 7) & 1) << 11) |
      (((instr >> 25) & 0x3F) << 5) |
      (((instr >> 8) & 0xF) << 1),
      13
    ),
    immU: instr & 0xFFFFF000,
    immJ: signExtend(
      (((instr >> 31) & 1) << 20) |
      (((instr >> 12) & 0xFF) << 12) |
      (((instr >> 20) & 1) << 11) |
      (((instr >> 21) & 0x3FF) << 1),
      21
    )
  };
}

function signExtend(value, bits) {
  const mask = 1 << (bits - 1);
  return ((value ^ mask) - mask) | 0;
}

/**
 * Execute single instruction and return trace step
 */
function executeStep(state, instruction) {
  const step = new TraceStep();
  step.preState = state.clone();
  step.instruction = instruction;

  const d = decodeInstruction(instruction);
  const rs1Val = state.getReg(d.rs1);
  const rs2Val = state.getReg(d.rs2);

  let nextPC = state.pc + 4;

  switch (d.opcode) {
    case OPCODE.LUI:
      state.setReg(d.rd, d.immU);
      break;

    case OPCODE.AUIPC:
      state.setReg(d.rd, (state.pc + d.immU) >>> 0);
      break;

    case OPCODE.JAL:
      state.setReg(d.rd, nextPC);
      nextPC = (state.pc + d.immJ) >>> 0;
      break;

    case OPCODE.JALR:
      state.setReg(d.rd, nextPC);
      nextPC = ((rs1Val + d.immI) & ~1) >>> 0;
      break;

    case OPCODE.BRANCH: {
      let taken = false;
      switch (d.funct3) {
        case BRANCH_FUNC.BEQ:  taken = rs1Val === rs2Val; break;
        case BRANCH_FUNC.BNE:  taken = rs1Val !== rs2Val; break;
        case BRANCH_FUNC.BLT:  taken = (rs1Val | 0) < (rs2Val | 0); break;
        case BRANCH_FUNC.BGE:  taken = (rs1Val | 0) >= (rs2Val | 0); break;
        case BRANCH_FUNC.BLTU: taken = rs1Val < rs2Val; break;
        case BRANCH_FUNC.BGEU: taken = rs1Val >= rs2Val; break;
      }
      if (taken) nextPC = (state.pc + d.immB) >>> 0;
      break;
    }

    case OPCODE.LOAD: {
      const addr = (rs1Val + d.immI) >>> 0;
      step.memReadAddr = addr;
      let value;
      switch (d.funct3) {
        case MEM_FUNC.BYTE:
          value = signExtend(state.loadByte(addr), 8);
          break;
        case MEM_FUNC.HALF:
          value = signExtend(state.loadHalf(addr), 16);
          break;
        case MEM_FUNC.WORD:
          value = state.loadWord(addr);
          break;
        case MEM_FUNC.BYTEU:
          value = state.loadByte(addr);
          break;
        case MEM_FUNC.HALFU:
          value = state.loadHalf(addr);
          break;
      }
      step.memReadValue = value >>> 0;
      state.setReg(d.rd, value);
      break;
    }

    case OPCODE.STORE: {
      const addr = (rs1Val + d.immS) >>> 0;
      step.memWriteAddr = addr;
      step.memWriteValue = rs2Val;
      switch (d.funct3) {
        case MEM_FUNC.BYTE:
          state.storeByte(addr, rs2Val);
          break;
        case MEM_FUNC.HALF:
          state.storeHalf(addr, rs2Val);
          break;
        case MEM_FUNC.WORD:
          state.storeWord(addr, rs2Val);
          break;
      }
      break;
    }

    case OPCODE.OP_IMM: {
      let result;
      const imm = d.immI;
      const shamt = d.rs2; // Lower 5 bits of immediate for shifts
      switch (d.funct3) {
        case ALU_FUNC.ADD:  result = (rs1Val + imm) >>> 0; break;
        case ALU_FUNC.SLT:  result = ((rs1Val | 0) < (imm | 0)) ? 1 : 0; break;
        case ALU_FUNC.SLTU: result = (rs1Val >>> 0) < ((imm >>> 0) & 0xFFF) ? 1 : 0; break;
        case ALU_FUNC.XOR:  result = (rs1Val ^ imm) >>> 0; break;
        case ALU_FUNC.OR:   result = (rs1Val | imm) >>> 0; break;
        case ALU_FUNC.AND:  result = (rs1Val & imm) >>> 0; break;
        case ALU_FUNC.SLL:  result = (rs1Val << shamt) >>> 0; break;
        case ALU_FUNC.SRL:
          if (d.funct7 & 0x20) { // SRAI
            result = (rs1Val >> shamt) >>> 0;
          } else { // SRLI
            result = (rs1Val >>> shamt);
          }
          break;
      }
      state.setReg(d.rd, result);
      break;
    }

    case OPCODE.OP: {
      let result;
      const isSub = (d.funct7 & 0x20) !== 0;
      switch (d.funct3) {
        case ALU_FUNC.ADD:
          result = isSub ? (rs1Val - rs2Val) >>> 0 : (rs1Val + rs2Val) >>> 0;
          break;
        case ALU_FUNC.SLL:  result = (rs1Val << (rs2Val & 0x1F)) >>> 0; break;
        case ALU_FUNC.SLT:  result = ((rs1Val | 0) < (rs2Val | 0)) ? 1 : 0; break;
        case ALU_FUNC.SLTU: result = rs1Val < rs2Val ? 1 : 0; break;
        case ALU_FUNC.XOR:  result = (rs1Val ^ rs2Val) >>> 0; break;
        case ALU_FUNC.SRL:
          if (isSub) { // SRA
            result = (rs1Val >> (rs2Val & 0x1F)) >>> 0;
          } else { // SRL
            result = rs1Val >>> (rs2Val & 0x1F);
          }
          break;
        case ALU_FUNC.OR:   result = (rs1Val | rs2Val) >>> 0; break;
        case ALU_FUNC.AND:  result = (rs1Val & rs2Val) >>> 0; break;
      }
      state.setReg(d.rd, result);
      break;
    }
  }

  state.pc = nextPC;
  step.postState = state.clone();

  return step;
}

module.exports = {
  XLEN,
  OPCODE,
  ALU_FUNC,
  BRANCH_FUNC,
  MEM_FUNC,
  RiscVState,
  TraceStep,
  decodeInstruction,
  signExtend,
  executeStep
};
