/**
 * Merkle Tree for BitVM3 Memory Verification
 *
 * Implements a sparse Merkle tree for memory commitment.
 * - 32-bit addresses (word-aligned) = 30-bit word index = 30 levels
 * - Each leaf is a 32-bit memory word
 * - Hash function is configurable (SHA256, Poseidon, etc.)
 *
 * For circuit verification:
 * - Prove inclusion: value at address with siblings -> root
 * - Prove update: old_root + old_value + new_value + siblings -> new_root
 */

const crypto = require('crypto');

const TREE_DEPTH = 30; // 2^30 words = 4GB addressable (word-aligned)
const HASH_BITS = 256; // SHA256 output

/**
 * Default hash function (SHA256)
 * In production, consider circuit-friendly hashes like Poseidon
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * Hash two 256-bit values together
 */
function hashPair(left, right) {
  const combined = Buffer.concat([left, right]);
  return sha256(combined);
}

/**
 * Convert 32-bit word to 256-bit buffer (zero-padded)
 */
function wordToBuffer(word) {
  const buf = Buffer.alloc(32);
  buf.writeUInt32LE(word >>> 0, 0);
  return buf;
}

/**
 * Convert buffer to hex string
 */
function bufToHex(buf) {
  return buf.toString('hex');
}

/**
 * Sparse Merkle Tree for memory
 */
class SparseMerkleTree {
  constructor(depth = TREE_DEPTH) {
    this.depth = depth;
    this.leaves = new Map(); // wordIndex -> value
    this.cache = new Map();  // nodeKey -> hash

    // Precompute zero hashes for each level
    // zeroHashes[0] = hash(0), zeroHashes[i] = hash(zeroHashes[i-1], zeroHashes[i-1])
    this.zeroHashes = this._computeZeroHashes();
  }

  _computeZeroHashes() {
    const zeros = [wordToBuffer(0)];
    for (let i = 1; i <= this.depth; i++) {
      zeros.push(hashPair(zeros[i - 1], zeros[i - 1]));
    }
    return zeros;
  }

  _nodeKey(level, index) {
    return `${level}:${index}`;
  }

  /**
   * Get hash at a specific node
   */
  _getNode(level, index) {
    const key = this._nodeKey(level, index);
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }

    if (level === 0) {
      // Leaf level
      const value = this.leaves.get(index) ?? 0;
      return wordToBuffer(value);
    }

    // Internal node: hash of children
    const leftChild = this._getNode(level - 1, index * 2);
    const rightChild = this._getNode(level - 1, index * 2 + 1);

    // Optimization: if both children are zero, use precomputed zero hash
    if (leftChild.equals(this.zeroHashes[level - 1]) &&
        rightChild.equals(this.zeroHashes[level - 1])) {
      return this.zeroHashes[level];
    }

    const hash = hashPair(leftChild, rightChild);
    this.cache.set(key, hash);
    return hash;
  }

  /**
   * Get the Merkle root
   */
  getRoot() {
    return this._getNode(this.depth, 0);
  }

  /**
   * Get value at word index
   */
  get(wordIndex) {
    return this.leaves.get(wordIndex) ?? 0;
  }

  /**
   * Set value at word index
   */
  set(wordIndex, value) {
    // Invalidate cache along the path
    let idx = wordIndex;
    for (let level = 0; level <= this.depth; level++) {
      this.cache.delete(this._nodeKey(level, idx));
      idx = Math.floor(idx / 2);
    }

    this.leaves.set(wordIndex, value >>> 0);
  }

  /**
   * Get Merkle proof for a word index
   * Returns array of sibling hashes from leaf to root
   */
  getProof(wordIndex) {
    const siblings = [];
    let idx = wordIndex;

    for (let level = 0; level < this.depth; level++) {
      const siblingIdx = idx ^ 1; // Flip last bit to get sibling
      siblings.push(this._getNode(level, siblingIdx));
      idx = Math.floor(idx / 2);
    }

    return {
      wordIndex,
      value: this.get(wordIndex),
      siblings,
      root: this.getRoot()
    };
  }

  /**
   * Verify a Merkle proof
   */
  static verifyProof(proof) {
    let current = wordToBuffer(proof.value);
    let idx = proof.wordIndex;

    for (let i = 0; i < proof.siblings.length; i++) {
      const sibling = proof.siblings[i];
      const isRight = idx & 1;

      if (isRight) {
        current = hashPair(sibling, current);
      } else {
        current = hashPair(current, sibling);
      }

      idx = Math.floor(idx / 2);
    }

    return current.equals(proof.root);
  }

  /**
   * Generate update proof: proves transition from old to new value
   */
  getUpdateProof(wordIndex, newValue) {
    const oldProof = this.getProof(wordIndex);
    const oldRoot = this.getRoot();
    const oldValue = this.get(wordIndex);

    this.set(wordIndex, newValue);

    const newRoot = this.getRoot();

    return {
      wordIndex,
      oldValue,
      newValue,
      siblings: oldProof.siblings,
      oldRoot,
      newRoot
    };
  }
}

/**
 * Circuit constraints for Merkle proof verification
 */
class MerkleCircuitBuilder {
  constructor(circuit, hashBits = HASH_BITS, depth = TREE_DEPTH) {
    this.circuit = circuit;
    this.hashBits = hashBits;
    this.depth = depth;
  }

  /**
   * Add inputs for a Merkle proof
   */
  addProofInputs(prefix = 'merkle') {
    const c = this.circuit;

    return {
      // The word index (determines left/right at each level)
      wordIndex: c.addInput(this.depth, `${prefix}_wordIndex`),

      // The leaf value (32-bit word)
      leafValue: c.addInput(32, `${prefix}_leafValue`),

      // Sibling hashes along the path
      siblings: Array.from({ length: this.depth }, (_, i) =>
        c.addInput(this.hashBits, `${prefix}_sibling_${i}`)
      ),

      // Expected root
      expectedRoot: c.addInput(this.hashBits, `${prefix}_root`)
    };
  }

  /**
   * SHA256 compression in circuit (simplified - uses AND/XOR gates)
   *
   * NOTE: Full SHA256 is ~22k gates per compression. For production,
   * consider circuit-friendly hashes like Poseidon (~300 constraints).
   *
   * This implements a simplified hash for demonstration.
   * Replace with actual SHA256 or Poseidon for production.
   */
  hashPairCircuit(leftBits, rightBits) {
    const c = this.circuit;
    const n = this.hashBits;

    // Simplified hash: XOR with rotation and mixing
    // NOT cryptographically secure - replace with real hash!
    const result = [];

    for (let i = 0; i < n; i++) {
      // Mix bits from both inputs with rotation
      const li = leftBits[i];
      const ri = rightBits[(i + 128) % n]; // Rotate right input
      const li2 = leftBits[(i + 64) % n];
      const ri2 = rightBits[(i + 192) % n];

      // XOR chain with AND for non-linearity
      const x1 = c.xor(li, ri);
      const x2 = c.xor(li2, ri2);
      const a1 = c.and(x1, x2);
      result.push(c.xor(x1, a1));
    }

    return result;
  }

  /**
   * Compute Merkle root from leaf and siblings in circuit
   */
  computeRootCircuit(inputs) {
    const c = this.circuit;
    const { wordIndex, leafValue, siblings } = inputs;

    // Extend leaf value to hash size (zero-padded)
    let current = [...leafValue];
    while (current.length < this.hashBits) {
      current.push(c.zero());
    }

    // Walk up the tree
    for (let level = 0; level < this.depth; level++) {
      const sibling = siblings[level];
      const isRight = wordIndex[level]; // Bit determines position

      // Select order: if isRight, sibling is left child
      const left = c.muxN(isRight, current, sibling);
      const right = c.muxN(isRight, sibling, current);

      // Hash the pair
      current = this.hashPairCircuit(left, right);
    }

    return current;
  }

  /**
   * Verify Merkle inclusion proof in circuit
   * Returns wire that is 1 if proof is valid
   */
  verifyInclusionCircuit(inputs) {
    const c = this.circuit;

    const computedRoot = this.computeRootCircuit(inputs);
    return c.eqN(computedRoot, inputs.expectedRoot);
  }

  /**
   * Add inputs for Merkle update proof
   */
  addUpdateProofInputs(prefix = 'merkle') {
    const c = this.circuit;

    return {
      wordIndex: c.addInput(this.depth, `${prefix}_wordIndex`),
      oldValue: c.addInput(32, `${prefix}_oldValue`),
      newValue: c.addInput(32, `${prefix}_newValue`),
      siblings: Array.from({ length: this.depth }, (_, i) =>
        c.addInput(this.hashBits, `${prefix}_sibling_${i}`)
      ),
      oldRoot: c.addInput(this.hashBits, `${prefix}_oldRoot`),
      newRoot: c.addInput(this.hashBits, `${prefix}_newRoot`)
    };
  }

  /**
   * Verify Merkle update in circuit
   * Checks: oldRoot valid for oldValue AND newRoot valid for newValue
   */
  verifyUpdateCircuit(inputs) {
    const c = this.circuit;
    const { wordIndex, oldValue, newValue, siblings, oldRoot, newRoot } = inputs;

    // Verify old value produces old root
    const oldValid = this.verifyInclusionCircuit({
      wordIndex,
      leafValue: oldValue,
      siblings,
      expectedRoot: oldRoot
    });

    // Verify new value produces new root
    const newValid = this.verifyInclusionCircuit({
      wordIndex,
      leafValue: newValue,
      siblings,
      expectedRoot: newRoot
    });

    // Both must be valid
    return c.and(oldValid, newValid);
  }
}

/**
 * Memory with Merkle tree backing
 */
class MerkleMemory {
  constructor() {
    this.tree = new SparseMerkleTree();
  }

  /**
   * Convert byte address to word index
   */
  addrToWordIndex(addr) {
    return (addr >>> 2); // Divide by 4 (word-aligned)
  }

  /**
   * Load word with Merkle proof
   */
  loadWord(addr) {
    const wordIndex = this.addrToWordIndex(addr);
    const value = this.tree.get(wordIndex);
    const proof = this.tree.getProof(wordIndex);

    return { value, proof };
  }

  /**
   * Store word with Merkle update proof
   */
  storeWord(addr, value) {
    const wordIndex = this.addrToWordIndex(addr);
    const updateProof = this.tree.getUpdateProof(wordIndex, value);

    return { updateProof };
  }

  /**
   * Load byte (from word, with offset)
   */
  loadByte(addr) {
    const wordAddr = addr & ~3;
    const offset = addr & 3;
    const { value, proof } = this.loadWord(wordAddr);
    const byte = (value >> (offset * 8)) & 0xFF;

    return { value: byte, wordValue: value, offset, proof };
  }

  /**
   * Store byte (read-modify-write)
   */
  storeByte(addr, byte) {
    const wordAddr = addr & ~3;
    const offset = addr & 3;
    const wordIndex = this.addrToWordIndex(wordAddr);

    const oldValue = this.tree.get(wordIndex);
    const mask = ~(0xFF << (offset * 8));
    const newValue = (oldValue & mask) | ((byte & 0xFF) << (offset * 8));

    const updateProof = this.tree.getUpdateProof(wordIndex, newValue);

    return { offset, oldValue, newValue, updateProof };
  }

  /**
   * Load halfword
   */
  loadHalf(addr) {
    const wordAddr = addr & ~3;
    const offset = (addr & 2) >> 1;
    const { value, proof } = this.loadWord(wordAddr);
    const half = (value >> (offset * 16)) & 0xFFFF;

    return { value: half, wordValue: value, offset, proof };
  }

  /**
   * Store halfword
   */
  storeHalf(addr, half) {
    const wordAddr = addr & ~3;
    const offset = (addr & 2) >> 1;
    const wordIndex = this.addrToWordIndex(wordAddr);

    const oldValue = this.tree.get(wordIndex);
    const mask = ~(0xFFFF << (offset * 16));
    const newValue = (oldValue & mask) | ((half & 0xFFFF) << (offset * 16));

    const updateProof = this.tree.getUpdateProof(wordIndex, newValue);

    return { offset, oldValue, newValue, updateProof };
  }

  /**
   * Get current root
   */
  getRoot() {
    return this.tree.getRoot();
  }
}

/**
 * Convert Merkle proof to witness format (bit arrays)
 */
function proofToWitness(proof, depth = TREE_DEPTH) {
  const toBits = (value, width) => {
    const bits = [];
    for (let i = 0; i < width; i++) {
      bits.push((value >> i) & 1);
    }
    return bits;
  };

  const bufferToBits = (buf) => {
    const bits = [];
    for (let i = 0; i < buf.length; i++) {
      for (let j = 0; j < 8; j++) {
        bits.push((buf[i] >> j) & 1);
      }
    }
    return bits;
  };

  return {
    wordIndex: toBits(proof.wordIndex, depth),
    leafValue: toBits(proof.value, 32),
    siblings: proof.siblings.map(bufferToBits),
    root: bufferToBits(proof.root)
  };
}

/**
 * Convert update proof to witness format
 */
function updateProofToWitness(proof, depth = TREE_DEPTH) {
  const toBits = (value, width) => {
    const bits = [];
    for (let i = 0; i < width; i++) {
      bits.push((value >> i) & 1);
    }
    return bits;
  };

  const bufferToBits = (buf) => {
    const bits = [];
    for (let i = 0; i < buf.length; i++) {
      for (let j = 0; j < 8; j++) {
        bits.push((buf[i] >> j) & 1);
      }
    }
    return bits;
  };

  return {
    wordIndex: toBits(proof.wordIndex, depth),
    oldValue: toBits(proof.oldValue, 32),
    newValue: toBits(proof.newValue, 32),
    siblings: proof.siblings.map(bufferToBits),
    oldRoot: bufferToBits(proof.oldRoot),
    newRoot: bufferToBits(proof.newRoot)
  };
}

module.exports = {
  TREE_DEPTH,
  HASH_BITS,
  sha256,
  hashPair,
  wordToBuffer,
  bufToHex,
  SparseMerkleTree,
  MerkleCircuitBuilder,
  MerkleMemory,
  proofToWitness,
  updateProofToWitness
};
