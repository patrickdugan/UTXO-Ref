/**
 * Memory Opcode Constraints with Merkle Verification
 *
 * Covers: LW, SW, LB, SB, LH, SH, LBU, LHU
 *
 * Memory verification in BitVM3:
 *   1. Address computation: addr = rs1 + imm
 *   2. Merkle proof verification against memory root
 *   3. Value extraction (for sub-word loads)
 *   4. Sign extension (for LB, LH)
 *   5. Memory root update (for stores)
 */

const { OpcodeConstraint } = require('./base');
const { XLEN, decodeInstruction, MEM_FUNC, OPCODE } = require('../riscv');

/**
 * Base class for memory operations with Merkle proofs
 */
class MemoryConstraint extends OpcodeConstraint {
  constructor(name) {
    super(name);
  }

  /**
   * Compute address from rs1 + immediate
   */
  computeAddress(circuit, rs1, imm) {
    const { sum: addr } = circuit.addN(rs1, imm);
    return addr;
  }

  /**
   * Extract word index (addr >> 2) for Merkle tree
   */
  extractWordIndex(circuit, addr) {
    // Word index is bits [31:2] of address
    return addr.slice(2);
  }

  /**
   * Extract byte offset within word (addr & 3)
   */
  extractByteOffset(circuit, addr) {
    return addr.slice(0, 2);
  }

  /**
   * Verify Merkle inclusion proof
   * This is a simplified check - full implementation uses MerkleCircuitBuilder
   */
  verifyMerkleInclusion(circuit, wordIndex, leafValue, siblings, expectedRoot) {
    // For now, just verify the leaf matches expected
    // Full implementation walks up the tree with hash computations
    // See MerkleCircuitBuilder.verifyInclusionCircuit for full version
    return circuit.one(); // Placeholder - integrate with MerkleCircuitBuilder
  }

  /**
   * Select byte from word based on offset
   */
  selectByte(circuit, word, offset) {
    // offset is 2 bits: 00=byte0, 01=byte1, 10=byte2, 11=byte3
    const bytes = [
      word.slice(0, 8),
      word.slice(8, 16),
      word.slice(16, 24),
      word.slice(24, 32)
    ];

    // 4-to-1 MUX using offset bits
    const sel0 = offset[0];
    const sel1 = offset[1];

    // First level: select between pairs
    const pair0 = circuit.muxN(sel0, bytes[0], bytes[1]);
    const pair1 = circuit.muxN(sel0, bytes[2], bytes[3]);

    // Second level: select between pairs
    return circuit.muxN(sel1, pair0, pair1);
  }

  /**
   * Select halfword from word based on offset
   */
  selectHalf(circuit, word, offset) {
    // offset bit 1 selects upper/lower half
    const halves = [
      word.slice(0, 16),
      word.slice(16, 32)
    ];
    return circuit.muxN(offset[1], halves[0], halves[1]);
  }

  /**
   * Sign extend byte to word
   */
  signExtendByte(circuit, byte) {
    const signBit = byte[7];
    const result = [...byte];
    for (let i = 8; i < XLEN; i++) {
      result.push(signBit);
    }
    return result;
  }

  /**
   * Zero extend byte to word
   */
  zeroExtendByte(circuit, byte) {
    const result = [...byte];
    for (let i = 8; i < XLEN; i++) {
      result.push(circuit.zero());
    }
    return result;
  }

  /**
   * Sign extend halfword to word
   */
  signExtendHalf(circuit, half) {
    const signBit = half[15];
    const result = [...half];
    for (let i = 16; i < XLEN; i++) {
      result.push(signBit);
    }
    return result;
  }

  /**
   * Zero extend halfword to word
   */
  zeroExtendHalf(circuit, half) {
    const result = [...half];
    for (let i = 16; i < XLEN; i++) {
      result.push(circuit.zero());
    }
    return result;
  }

  /**
   * Update byte in word
   */
  updateByte(circuit, word, byte, offset) {
    const result = [];

    for (let i = 0; i < 32; i++) {
      const byteIdx = Math.floor(i / 8);
      const bitInByte = i % 8;

      // Check if this byte position matches offset
      // offset[0] selects odd/even byte, offset[1] selects upper/lower pair
      const isTargetByte = circuit.and(
        byteIdx & 1 ? offset[0] : circuit.inv(offset[0]),
        byteIdx & 2 ? offset[1] : circuit.inv(offset[1])
      );

      // MUX: if target byte, use new value; else keep old
      result.push(circuit.mux(isTargetByte, word[i], byte[bitInByte]));
    }

    return result;
  }

  /**
   * Update halfword in word
   */
  updateHalf(circuit, word, half, offset) {
    const result = [];

    for (let i = 0; i < 32; i++) {
      const isUpperHalf = i >= 16;
      const bitInHalf = i % 16;

      // offset[1] selects upper/lower half
      const isTargetHalf = isUpperHalf ? offset[1] : circuit.inv(offset[1]);

      result.push(circuit.mux(isTargetHalf, word[i], half[bitInHalf]));
    }

    return result;
  }
}

/**
 * LW (Load Word) constraint with Merkle proof
 */
class LoadWordConstraint extends MemoryConstraint {
  constructor() {
    super('LW');
  }

  constrain(circuit, inputs) {
    const { rs1, imm, memValue, rdClaimed, merkleProof } = inputs;

    // Compute address
    const addr = this.computeAddress(circuit, rs1, imm);

    // For LW, rd should equal the memory value directly
    const rdExpected = memValue;

    // Basic value check
    const valueValid = circuit.eqN(rdExpected, rdClaimed);

    // Merkle proof verification (if provided)
    let merkleValid = circuit.one();
    if (merkleProof) {
      const wordIndex = this.extractWordIndex(circuit, addr);
      merkleValid = this.verifyMerkleInclusion(
        circuit,
        wordIndex,
        memValue,
        merkleProof.siblings,
        merkleProof.root
      );
    }

    const valid = circuit.and(valueValid, merkleValid);

    return { addr, rdExpected, valid };
  }

  computeWitness(step, merkleMemory = null) {
    const d = decodeInstruction(step.instruction);
    const addr = (step.preState.getReg(d.rs1) + d.immI) >>> 0;

    const witness = {
      rs1: step.preState.getReg(d.rs1),
      imm: d.immI >>> 0,
      memValue: step.memReadValue,
      rdClaimed: step.postState.getReg(d.rd)
    };

    // Add Merkle proof if memory provided
    if (merkleMemory) {
      const { proof } = merkleMemory.loadWord(addr);
      witness.merkleProof = proof;
    }

    return witness;
  }
}

/**
 * LB (Load Byte, sign-extended) constraint with Merkle proof
 */
class LoadByteConstraint extends MemoryConstraint {
  constructor() {
    super('LB');
  }

  constrain(circuit, inputs) {
    const { rs1, imm, memWord, rdClaimed, merkleProof } = inputs;

    const addr = this.computeAddress(circuit, rs1, imm);
    const offset = this.extractByteOffset(circuit, addr);

    // Select byte from word
    const byte = this.selectByte(circuit, memWord, offset);

    // Sign extend
    const rdExpected = this.signExtendByte(circuit, byte);

    const valueValid = circuit.eqN(rdExpected, rdClaimed);

    let merkleValid = circuit.one();
    if (merkleProof) {
      const wordIndex = this.extractWordIndex(circuit, addr);
      merkleValid = this.verifyMerkleInclusion(
        circuit, wordIndex, memWord,
        merkleProof.siblings, merkleProof.root
      );
    }

    const valid = circuit.and(valueValid, merkleValid);

    return { addr, rdExpected, valid };
  }

  computeWitness(step, merkleMemory = null) {
    const d = decodeInstruction(step.instruction);
    const addr = (step.preState.getReg(d.rs1) + d.immI) >>> 0;
    const wordAddr = addr & ~3;

    const witness = {
      rs1: step.preState.getReg(d.rs1),
      imm: d.immI >>> 0,
      memWord: step.preState.loadWord ? step.preState.loadWord(wordAddr) : (step.memReadValue & 0xFF),
      rdClaimed: step.postState.getReg(d.rd)
    };

    if (merkleMemory) {
      const { proof } = merkleMemory.loadWord(wordAddr);
      witness.merkleProof = proof;
    }

    return witness;
  }
}

/**
 * LBU (Load Byte Unsigned) constraint with Merkle proof
 */
class LoadByteUnsignedConstraint extends MemoryConstraint {
  constructor() {
    super('LBU');
  }

  constrain(circuit, inputs) {
    const { rs1, imm, memWord, rdClaimed, merkleProof } = inputs;

    const addr = this.computeAddress(circuit, rs1, imm);
    const offset = this.extractByteOffset(circuit, addr);

    const byte = this.selectByte(circuit, memWord, offset);
    const rdExpected = this.zeroExtendByte(circuit, byte);

    const valueValid = circuit.eqN(rdExpected, rdClaimed);

    let merkleValid = circuit.one();
    if (merkleProof) {
      const wordIndex = this.extractWordIndex(circuit, addr);
      merkleValid = this.verifyMerkleInclusion(
        circuit, wordIndex, memWord,
        merkleProof.siblings, merkleProof.root
      );
    }

    const valid = circuit.and(valueValid, merkleValid);

    return { addr, rdExpected, valid };
  }

  computeWitness(step, merkleMemory = null) {
    const d = decodeInstruction(step.instruction);
    const addr = (step.preState.getReg(d.rs1) + d.immI) >>> 0;
    const wordAddr = addr & ~3;

    const witness = {
      rs1: step.preState.getReg(d.rs1),
      imm: d.immI >>> 0,
      memWord: step.preState.loadWord ? step.preState.loadWord(wordAddr) : (step.memReadValue & 0xFF),
      rdClaimed: step.postState.getReg(d.rd)
    };

    if (merkleMemory) {
      const { proof } = merkleMemory.loadWord(wordAddr);
      witness.merkleProof = proof;
    }

    return witness;
  }
}

/**
 * LH (Load Halfword, sign-extended) constraint with Merkle proof
 */
class LoadHalfConstraint extends MemoryConstraint {
  constructor() {
    super('LH');
  }

  constrain(circuit, inputs) {
    const { rs1, imm, memWord, rdClaimed, merkleProof } = inputs;

    const addr = this.computeAddress(circuit, rs1, imm);
    const offset = this.extractByteOffset(circuit, addr);

    const half = this.selectHalf(circuit, memWord, offset);
    const rdExpected = this.signExtendHalf(circuit, half);

    const valueValid = circuit.eqN(rdExpected, rdClaimed);

    let merkleValid = circuit.one();
    if (merkleProof) {
      const wordIndex = this.extractWordIndex(circuit, addr);
      merkleValid = this.verifyMerkleInclusion(
        circuit, wordIndex, memWord,
        merkleProof.siblings, merkleProof.root
      );
    }

    const valid = circuit.and(valueValid, merkleValid);

    return { addr, rdExpected, valid };
  }

  computeWitness(step, merkleMemory = null) {
    const d = decodeInstruction(step.instruction);
    const addr = (step.preState.getReg(d.rs1) + d.immI) >>> 0;
    const wordAddr = addr & ~3;

    const witness = {
      rs1: step.preState.getReg(d.rs1),
      imm: d.immI >>> 0,
      memWord: step.preState.loadWord ? step.preState.loadWord(wordAddr) : (step.memReadValue & 0xFFFF),
      rdClaimed: step.postState.getReg(d.rd)
    };

    if (merkleMemory) {
      const { proof } = merkleMemory.loadWord(wordAddr);
      witness.merkleProof = proof;
    }

    return witness;
  }
}

/**
 * LHU (Load Halfword Unsigned) constraint with Merkle proof
 */
class LoadHalfUnsignedConstraint extends MemoryConstraint {
  constructor() {
    super('LHU');
  }

  constrain(circuit, inputs) {
    const { rs1, imm, memWord, rdClaimed, merkleProof } = inputs;

    const addr = this.computeAddress(circuit, rs1, imm);
    const offset = this.extractByteOffset(circuit, addr);

    const half = this.selectHalf(circuit, memWord, offset);
    const rdExpected = this.zeroExtendHalf(circuit, half);

    const valueValid = circuit.eqN(rdExpected, rdClaimed);

    let merkleValid = circuit.one();
    if (merkleProof) {
      const wordIndex = this.extractWordIndex(circuit, addr);
      merkleValid = this.verifyMerkleInclusion(
        circuit, wordIndex, memWord,
        merkleProof.siblings, merkleProof.root
      );
    }

    const valid = circuit.and(valueValid, merkleValid);

    return { addr, rdExpected, valid };
  }

  computeWitness(step, merkleMemory = null) {
    const d = decodeInstruction(step.instruction);
    const addr = (step.preState.getReg(d.rs1) + d.immI) >>> 0;
    const wordAddr = addr & ~3;

    const witness = {
      rs1: step.preState.getReg(d.rs1),
      imm: d.immI >>> 0,
      memWord: step.preState.loadWord ? step.preState.loadWord(wordAddr) : (step.memReadValue & 0xFFFF),
      rdClaimed: step.postState.getReg(d.rd)
    };

    if (merkleMemory) {
      const { proof } = merkleMemory.loadWord(wordAddr);
      witness.merkleProof = proof;
    }

    return witness;
  }
}

/**
 * SW (Store Word) constraint with Merkle update proof
 */
class StoreWordConstraint extends MemoryConstraint {
  constructor() {
    super('SW');
  }

  constrain(circuit, inputs) {
    const { rs1, imm, rs2, oldMemRoot, newMemRoot, merkleProof } = inputs;

    const addr = this.computeAddress(circuit, rs1, imm);

    // For stores, verify:
    // 1. Old root is valid with old value
    // 2. New root is valid with new value (rs2)

    let valid = circuit.one();

    if (merkleProof) {
      const wordIndex = this.extractWordIndex(circuit, addr);

      // Verify old root
      const oldValid = this.verifyMerkleInclusion(
        circuit, wordIndex, merkleProof.oldValue,
        merkleProof.siblings, oldMemRoot
      );

      // Verify new root
      const newValid = this.verifyMerkleInclusion(
        circuit, wordIndex, rs2,
        merkleProof.siblings, newMemRoot
      );

      valid = circuit.and(oldValid, newValid);
    } else {
      // Without Merkle proof, just check stored value matches rs2
      if (inputs.storedValue) {
        valid = circuit.eqN(rs2, inputs.storedValue);
      }
    }

    return { addr, valid };
  }

  computeWitness(step, merkleMemory = null) {
    const d = decodeInstruction(step.instruction);
    const addr = (step.preState.getReg(d.rs1) + d.immS) >>> 0;

    const witness = {
      rs1: step.preState.getReg(d.rs1),
      imm: d.immS >>> 0,
      rs2: step.preState.getReg(d.rs2),
      storedValue: step.memWriteValue
    };

    if (merkleMemory) {
      const { updateProof } = merkleMemory.storeWord(addr, step.preState.getReg(d.rs2));
      witness.merkleProof = updateProof;
      witness.oldMemRoot = updateProof.oldRoot;
      witness.newMemRoot = updateProof.newRoot;
    }

    return witness;
  }
}

/**
 * SB (Store Byte) constraint with Merkle update proof
 */
class StoreByteConstraint extends MemoryConstraint {
  constructor() {
    super('SB');
  }

  constrain(circuit, inputs) {
    const { rs1, imm, rs2, oldMemWord, oldMemRoot, newMemRoot, merkleProof } = inputs;

    const addr = this.computeAddress(circuit, rs1, imm);
    const offset = this.extractByteOffset(circuit, addr);

    // Extract byte to store
    const byteToStore = rs2.slice(0, 8);

    // Compute expected new word
    const newWord = this.updateByte(circuit, oldMemWord, byteToStore, offset);

    let valid = circuit.one();

    if (merkleProof) {
      const wordIndex = this.extractWordIndex(circuit, addr);

      // Verify old root
      const oldValid = this.verifyMerkleInclusion(
        circuit, wordIndex, oldMemWord,
        merkleProof.siblings, oldMemRoot
      );

      // Verify new root
      const newValid = this.verifyMerkleInclusion(
        circuit, wordIndex, newWord,
        merkleProof.siblings, newMemRoot
      );

      valid = circuit.and(oldValid, newValid);
    } else if (inputs.storedByte) {
      // Simple check without Merkle
      valid = circuit.eqN(byteToStore, inputs.storedByte);
    }

    return { addr, newWord, valid };
  }

  computeWitness(step, merkleMemory = null) {
    const d = decodeInstruction(step.instruction);
    const addr = (step.preState.getReg(d.rs1) + d.immS) >>> 0;
    const wordAddr = addr & ~3;

    const witness = {
      rs1: step.preState.getReg(d.rs1),
      imm: d.immS >>> 0,
      rs2: step.preState.getReg(d.rs2),
      storedByte: step.memWriteValue & 0xFF,
      oldMemWord: step.preState.loadWord ? step.preState.loadWord(wordAddr) : 0
    };

    if (merkleMemory) {
      const { updateProof } = merkleMemory.storeByte(addr, step.preState.getReg(d.rs2) & 0xFF);
      witness.merkleProof = updateProof;
      witness.oldMemRoot = updateProof.oldRoot;
      witness.newMemRoot = updateProof.newRoot;
    }

    return witness;
  }
}

/**
 * SH (Store Halfword) constraint with Merkle update proof
 */
class StoreHalfConstraint extends MemoryConstraint {
  constructor() {
    super('SH');
  }

  constrain(circuit, inputs) {
    const { rs1, imm, rs2, oldMemWord, oldMemRoot, newMemRoot, merkleProof } = inputs;

    const addr = this.computeAddress(circuit, rs1, imm);
    const offset = this.extractByteOffset(circuit, addr);

    // Extract halfword to store
    const halfToStore = rs2.slice(0, 16);

    // Compute expected new word
    const newWord = this.updateHalf(circuit, oldMemWord, halfToStore, offset);

    let valid = circuit.one();

    if (merkleProof) {
      const wordIndex = this.extractWordIndex(circuit, addr);

      const oldValid = this.verifyMerkleInclusion(
        circuit, wordIndex, oldMemWord,
        merkleProof.siblings, oldMemRoot
      );

      const newValid = this.verifyMerkleInclusion(
        circuit, wordIndex, newWord,
        merkleProof.siblings, newMemRoot
      );

      valid = circuit.and(oldValid, newValid);
    } else if (inputs.storedHalf) {
      valid = circuit.eqN(halfToStore, inputs.storedHalf);
    }

    return { addr, newWord, valid };
  }

  computeWitness(step, merkleMemory = null) {
    const d = decodeInstruction(step.instruction);
    const addr = (step.preState.getReg(d.rs1) + d.immS) >>> 0;
    const wordAddr = addr & ~3;

    const witness = {
      rs1: step.preState.getReg(d.rs1),
      imm: d.immS >>> 0,
      rs2: step.preState.getReg(d.rs2),
      storedHalf: step.memWriteValue & 0xFFFF,
      oldMemWord: step.preState.loadWord ? step.preState.loadWord(wordAddr) : 0
    };

    if (merkleMemory) {
      const { updateProof } = merkleMemory.storeHalf(addr, step.preState.getReg(d.rs2) & 0xFFFF);
      witness.merkleProof = updateProof;
      witness.oldMemRoot = updateProof.oldRoot;
      witness.newMemRoot = updateProof.newRoot;
    }

    return witness;
  }
}

module.exports = {
  MemoryConstraint,
  LoadWordConstraint,
  LoadByteConstraint,
  LoadByteUnsignedConstraint,
  LoadHalfConstraint,
  LoadHalfUnsignedConstraint,
  StoreWordConstraint,
  StoreByteConstraint,
  StoreHalfConstraint
};
