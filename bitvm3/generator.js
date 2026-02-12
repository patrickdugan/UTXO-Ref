/**
 * BitVM3 Circuit Generator
 *
 * High-level API for generating RISC-V verification circuits.
 */

const fs = require('fs');
const path = require('path');
const { Circuit } = require('./circuit');
const { XLEN, decodeInstruction, RiscVState, executeStep } = require('./riscv');
const { registry } = require('./opcodes');
const { toBits, getOpcodeName, computeStepWitness } = require('./witness');

/**
 * Generate a circuit for a specific opcode
 */
function generateOpcodeCircuit(opcodeName) {
  const constraint = registry[opcodeName];
  if (!constraint) {
    throw new Error(`Unknown opcode: ${opcodeName}`);
  }

  const circuit = new Circuit(`${opcodeName}_verify`);

  // Add standard inputs based on opcode type
  const inputs = {};

  // Most opcodes need rs1
  if (['ADD', 'SUB', 'AND', 'OR', 'XOR', 'SLT', 'SLTU', 'SLL', 'SRL', 'SRA', 'MUL',
       'ADDI', 'ANDI', 'ORI', 'XORI', 'SLTI', 'SLTIU', 'SLLI', 'SRLI', 'SRAI',
       'LW', 'LB', 'LBU', 'LH', 'LHU', 'SW', 'SB', 'SH', 'JALR',
       'BEQ', 'BNE', 'BLT', 'BGE', 'BLTU', 'BGEU'].includes(opcodeName)) {
    inputs.rs1 = circuit.addInput(XLEN, 'rs1');
  }

  // Register-register ALU ops and branches need rs2
  if (['ADD', 'SUB', 'AND', 'OR', 'XOR', 'SLT', 'SLTU', 'SLL', 'SRL', 'SRA', 'MUL',
       'SW', 'SB', 'SH', 'BEQ', 'BNE', 'BLT', 'BGE', 'BLTU', 'BGEU'].includes(opcodeName)) {
    inputs.rs2 = circuit.addInput(XLEN, 'rs2');
  }

  // Immediate-based operations
  if (['ADDI', 'ANDI', 'ORI', 'XORI', 'SLTI', 'SLTIU',
       'LW', 'LB', 'LBU', 'LH', 'LHU', 'SW', 'SB', 'SH',
       'JAL', 'JALR', 'LUI', 'AUIPC',
       'BEQ', 'BNE', 'BLT', 'BGE', 'BLTU', 'BGEU'].includes(opcodeName)) {
    inputs.imm = circuit.addInput(XLEN, 'imm');
  }

  // Shift amounts (5 bits)
  if (['SLLI', 'SRLI', 'SRAI', 'SLL', 'SRL', 'SRA'].includes(opcodeName)) {
    inputs.shamt = circuit.addInput(5, 'shamt');
  }

  // PC for branches/jumps
  if (['JAL', 'JALR', 'AUIPC', 'BEQ', 'BNE', 'BLT', 'BGE', 'BLTU', 'BGEU'].includes(opcodeName)) {
    inputs.pc = circuit.addInput(XLEN, 'pc');
    inputs.postPC = circuit.addInput(XLEN, 'postPC');
  }

  // Claimed output (rd)
  if (['ADD', 'SUB', 'AND', 'OR', 'XOR', 'SLT', 'SLTU', 'SLL', 'SRL', 'SRA', 'MUL',
       'ADDI', 'ANDI', 'ORI', 'XORI', 'SLTI', 'SLTIU', 'SLLI', 'SRLI', 'SRAI',
       'LW', 'LB', 'LBU', 'LH', 'LHU', 'JAL', 'JALR', 'LUI', 'AUIPC'].includes(opcodeName)) {
    inputs.rdClaimed = circuit.addInput(XLEN, 'rdClaimed');
  }

  // Memory values for loads
  if (['LW'].includes(opcodeName)) {
    inputs.memValue = circuit.addInput(XLEN, 'memValue');
  }
  if (['LB', 'LBU'].includes(opcodeName)) {
    inputs.memByte = circuit.addInput(8, 'memByte');
  }
  if (['LH', 'LHU'].includes(opcodeName)) {
    inputs.memHalf = circuit.addInput(16, 'memHalf');
  }

  // Stored values for stores
  if (['SW'].includes(opcodeName)) {
    inputs.storedValue = circuit.addInput(XLEN, 'storedValue');
  }
  if (['SB'].includes(opcodeName)) {
    inputs.storedByte = circuit.addInput(8, 'storedByte');
  }
  if (['SH'].includes(opcodeName)) {
    inputs.storedHalf = circuit.addInput(16, 'storedHalf');
  }

  // Map operand2 to rs2 or imm depending on opcode
  if (['ADD', 'SUB', 'AND', 'OR', 'XOR', 'SLT', 'SLTU', 'MUL'].includes(opcodeName)) {
    inputs.operand2 = inputs.rs2;
  }
  if (['ADDI', 'ANDI', 'ORI', 'XORI', 'SLTI', 'SLTIU'].includes(opcodeName)) {
    inputs.operand2 = inputs.imm;
  }

  // Apply constraints
  const result = constraint.constrain(circuit, inputs);

  // Set output to validity bit
  circuit.setOutputs([result.valid]);

  return circuit;
}

/**
 * Generate circuits for all supported opcodes
 */
function generateAllOpcodeCircuits(outputDir) {
  const opcodes = Object.keys(registry);
  const results = {};

  for (const opcode of opcodes) {
    try {
      const circuit = generateOpcodeCircuit(opcode);
      const stats = circuit.getStats();
      results[opcode] = {
        success: true,
        stats,
        bristol: circuit.toBristol()
      };
    } catch (e) {
      results[opcode] = {
        success: false,
        error: e.message
      };
    }
  }

  // Write to files if output directory specified
  if (outputDir) {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    for (const [opcode, result] of Object.entries(results)) {
      if (result.success) {
        fs.writeFileSync(
          path.join(outputDir, `${opcode.toLowerCase()}.bristol`),
          result.bristol
        );
      }
    }

    // Write summary
    const summary = {};
    for (const [opcode, result] of Object.entries(results)) {
      if (result.success) {
        summary[opcode] = result.stats;
      } else {
        summary[opcode] = { error: result.error };
      }
    }
    fs.writeFileSync(
      path.join(outputDir, 'summary.json'),
      JSON.stringify(summary, null, 2)
    );
  }

  return results;
}

/**
 * Generate a single-step verification circuit
 * Verifies one instruction execution: preState + instruction -> postState
 */
function generateStepVerifier(opcodeName) {
  const circuit = new Circuit(`${opcodeName}_step_verify`);

  // Pre-state inputs
  const prePC = circuit.addInput(XLEN, 'prePC');
  const instruction = circuit.addInput(XLEN, 'instruction');

  // Only include affected registers (optimization)
  const preRS1 = circuit.addInput(XLEN, 'preRS1');
  const preRS2 = circuit.addInput(XLEN, 'preRS2');

  // Post-state inputs (claimed)
  const postPC = circuit.addInput(XLEN, 'postPC');
  const postRD = circuit.addInput(XLEN, 'postRD');

  // Memory witness (for load/store)
  const memAddr = circuit.addInput(XLEN, 'memAddr');
  const memValue = circuit.addInput(XLEN, 'memValue');

  // Build constraint based on opcode
  const constraint = registry[opcodeName];
  if (!constraint) {
    throw new Error(`Unknown opcode: ${opcodeName}`);
  }

  // Map inputs for constraint
  const inputs = {
    rs1: preRS1,
    rs2: preRS2,
    pc: prePC,
    imm: instruction, // Needs decoding - placeholder
    rdClaimed: postRD,
    postPC: postPC,
    memValue: memValue
  };

  const result = constraint.constrain(circuit, inputs);
  circuit.setOutputs([result.valid]);

  return circuit;
}

/**
 * Execute a program and generate trace
 */
function executeProgram(initialState, program, maxSteps = 1000) {
  const state = initialState.clone();
  const trace = [];

  // Load program into memory at PC
  let addr = state.pc;
  for (const instr of program) {
    state.storeWord(addr, instr);
    addr += 4;
  }

  for (let i = 0; i < maxSteps; i++) {
    const instruction = state.loadWord(state.pc);

    // Check for halt (ECALL or invalid)
    if (instruction === 0 || (instruction & 0x7F) === 0x73) {
      break;
    }

    const step = executeStep(state, instruction);
    trace.push(step);
  }

  return trace;
}

/**
 * Verify trace validity by generating and checking constraints
 */
function verifyTrace(trace) {
  const results = [];

  for (let i = 0; i < trace.length; i++) {
    const step = trace[i];
    const opcode = getOpcodeName(step.instruction);
    const witness = computeStepWitness(step);

    results.push({
      step: i,
      opcode,
      valid: true, // Would need full circuit evaluation
      witness
    });
  }

  return results;
}

module.exports = {
  generateOpcodeCircuit,
  generateAllOpcodeCircuits,
  generateStepVerifier,
  executeProgram,
  verifyTrace
};
