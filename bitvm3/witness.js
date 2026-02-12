/**
 * Witness Computation for BitVM3
 *
 * Computes circuit witness values from RISC-V execution traces.
 * The witness is the assignment of values to all circuit wires
 * that satisfies the constraints.
 */

const { XLEN, decodeInstruction, OPCODE, ALU_FUNC, BRANCH_FUNC, MEM_FUNC } = require('./riscv');
const { registry } = require('./opcodes');

/**
 * Convert integer to bit array (LSB first)
 */
function toBits(value, bitWidth = XLEN) {
  const bits = [];
  for (let i = 0; i < bitWidth; i++) {
    bits.push((value >> i) & 1);
  }
  return bits;
}

/**
 * Convert bit array to integer
 */
function fromBits(bits) {
  let value = 0;
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) value |= (1 << i);
  }
  return value >>> 0;
}

/**
 * Determine opcode name from instruction
 */
function getOpcodeName(instruction) {
  const d = decodeInstruction(instruction);

  switch (d.opcode) {
    case OPCODE.LUI:
      return 'LUI';

    case OPCODE.AUIPC:
      return 'AUIPC';

    case OPCODE.JAL:
      return 'JAL';

    case OPCODE.JALR:
      return 'JALR';

    case OPCODE.BRANCH:
      switch (d.funct3) {
        case BRANCH_FUNC.BEQ:  return 'BEQ';
        case BRANCH_FUNC.BNE:  return 'BNE';
        case BRANCH_FUNC.BLT:  return 'BLT';
        case BRANCH_FUNC.BGE:  return 'BGE';
        case BRANCH_FUNC.BLTU: return 'BLTU';
        case BRANCH_FUNC.BGEU: return 'BGEU';
      }
      break;

    case OPCODE.LOAD:
      switch (d.funct3) {
        case MEM_FUNC.BYTE:  return 'LB';
        case MEM_FUNC.HALF:  return 'LH';
        case MEM_FUNC.WORD:  return 'LW';
        case MEM_FUNC.BYTEU: return 'LBU';
        case MEM_FUNC.HALFU: return 'LHU';
      }
      break;

    case OPCODE.STORE:
      switch (d.funct3) {
        case MEM_FUNC.BYTE: return 'SB';
        case MEM_FUNC.HALF: return 'SH';
        case MEM_FUNC.WORD: return 'SW';
      }
      break;

    case OPCODE.OP_IMM:
      switch (d.funct3) {
        case ALU_FUNC.ADD:  return 'ADDI';
        case ALU_FUNC.SLT:  return 'SLTI';
        case ALU_FUNC.SLTU: return 'SLTIU';
        case ALU_FUNC.XOR:  return 'XORI';
        case ALU_FUNC.OR:   return 'ORI';
        case ALU_FUNC.AND:  return 'ANDI';
        case ALU_FUNC.SLL:  return 'SLLI';
        case ALU_FUNC.SRL:
          return (d.funct7 & 0x20) ? 'SRAI' : 'SRLI';
      }
      break;

    case OPCODE.OP:
      switch (d.funct3) {
        case ALU_FUNC.ADD:
          return (d.funct7 & 0x20) ? 'SUB' : 'ADD';
        case ALU_FUNC.SLL:  return 'SLL';
        case ALU_FUNC.SLT:  return 'SLT';
        case ALU_FUNC.SLTU: return 'SLTU';
        case ALU_FUNC.XOR:  return 'XOR';
        case ALU_FUNC.SRL:
          return (d.funct7 & 0x20) ? 'SRA' : 'SRL';
        case ALU_FUNC.OR:   return 'OR';
        case ALU_FUNC.AND:  return 'AND';
      }
      // Check for M extension (MUL/DIV)
      if (d.funct7 === 0x01) {
        switch (d.funct3) {
          case 0b000: return 'MUL';
          case 0b001: return 'MULH';
          case 0b010: return 'MULHSU';
          case 0b011: return 'MULHU';
          case 0b100: return 'DIV';
          case 0b101: return 'DIVU';
          case 0b110: return 'REM';
          case 0b111: return 'REMU';
        }
      }
      break;
  }

  return 'UNKNOWN';
}

/**
 * Compute witness for a single trace step
 */
function computeStepWitness(step) {
  const opcodeName = getOpcodeName(step.instruction);
  const constraint = registry[opcodeName];

  if (!constraint) {
    throw new Error(`Unknown opcode: ${opcodeName} (instruction: 0x${step.instruction.toString(16)})`);
  }

  // Get raw witness values from constraint
  const rawWitness = constraint.computeWitness(step);

  // Convert all values to bit arrays
  const witness = {};
  for (const [key, value] of Object.entries(rawWitness)) {
    if (typeof value === 'number') {
      witness[key] = toBits(value);
    } else if (Array.isArray(value)) {
      witness[key] = value;
    } else {
      witness[key] = value;
    }
  }

  witness._opcode = opcodeName;
  witness._instruction = step.instruction;

  return witness;
}

/**
 * Compute full witness for entire trace
 */
function computeTraceWitness(steps) {
  return steps.map((step, index) => {
    try {
      const witness = computeStepWitness(step);
      witness._stepIndex = index;
      return witness;
    } catch (e) {
      throw new Error(`Failed to compute witness for step ${index}: ${e.message}`);
    }
  });
}

/**
 * Evaluate circuit with witness to verify constraints
 */
function evaluateCircuit(circuit, inputValues) {
  const wireValues = new Map();

  // Set input wire values
  const inputs = circuit.inputWires;
  if (inputValues.length !== inputs.length) {
    throw new Error(`Expected ${inputs.length} input values, got ${inputValues.length}`);
  }

  for (let i = 0; i < inputs.length; i++) {
    wireValues.set(inputs[i], inputValues[i] ? 1 : 0);
  }

  // Evaluate gates in order
  for (const gate of circuit.gates) {
    const ins = gate.inputs.map(w => wireValues.get(w));

    if (ins.some(v => v === undefined)) {
      throw new Error(`Gate inputs not yet computed: ${gate.inputs}`);
    }

    let out;
    switch (gate.type) {
      case 'AND':
        out = ins[0] & ins[1];
        break;
      case 'XOR':
        out = ins[0] ^ ins[1];
        break;
      case 'INV':
        out = 1 - ins[0];
        break;
      case 'OR':
        out = ins[0] | ins[1];
        break;
      default:
        throw new Error(`Unknown gate type: ${gate.type}`);
    }

    wireValues.set(gate.outputs[0], out);
  }

  // Return output wire values
  return circuit.outputWires.map(w => wireValues.get(w));
}

/**
 * Verify a witness against a circuit
 * Returns true if all constraints are satisfied
 */
function verifyWitness(circuit, witness) {
  // Flatten witness to input array in circuit's expected order
  const inputValues = [];

  // This assumes witness keys match the order inputs were added
  // In practice, you'd need a more sophisticated mapping
  for (const wire of circuit.inputWires) {
    const label = circuit.labels.get(wire);
    if (label) {
      // Parse label like "rs1[0]" -> witness.rs1[0]
      const match = label.match(/^(\w+)\[(\d+)\]$/);
      if (match) {
        const [, name, idx] = match;
        if (witness[name]) {
          inputValues.push(witness[name][parseInt(idx)]);
          continue;
        }
      }
    }
    // Fallback: just use wire index
    inputValues.push(0);
  }

  const outputs = evaluateCircuit(circuit, inputValues);

  // For validity circuits, output should be 1 (valid)
  return outputs.every(v => v === 1);
}

module.exports = {
  toBits,
  fromBits,
  getOpcodeName,
  computeStepWitness,
  computeTraceWitness,
  evaluateCircuit,
  verifyWitness
};
