/**
 * UTXO Referee Merkle Tree
 *
 * Binary Merkle tree for payout leaves. Reuses hash primitives
 * from ../merkle.js but implements a simpler fixed-leaf tree
 * suitable for withdrawal sets.
 */

const crypto = require('crypto');
const { PayoutLeaf, LEAF_TAG } = require('./types');

/**
 * SHA256 hash
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * Hash two 32-byte nodes together (parent hash)
 * Uses sorted ordering for consistency
 */
function hashPair(left, right) {
  return sha256(Buffer.concat([left, right]));
}

/**
 * Precomputed zero hash for empty leaves
 */
const ZERO_HASH = sha256(Buffer.alloc(32));

/**
 * PayoutMerkleTree - Binary Merkle tree for payout leaves
 *
 * Builds a complete binary tree, padding with zero hashes if needed.
 */
class PayoutMerkleTree {
  constructor(leaves) {
    if (!Array.isArray(leaves)) {
      throw new Error('leaves must be an array');
    }

    this.leafCount = leaves.length;
    this.leaves = leaves.map(l =>
      l instanceof PayoutLeaf ? l : new PayoutLeaf(l)
    );

    // Compute leaf hashes
    this.leafHashes = this.leaves.map(l => l.hash());

    // Pad to power of 2
    this.depth = Math.max(1, Math.ceil(Math.log2(this.leafCount || 1)));
    const treeSize = 1 << this.depth;

    // Precompute zero hashes for each level
    this.zeroHashes = this._computeZeroHashes(this.depth);

    // Pad leaf hashes with zero hash
    while (this.leafHashes.length < treeSize) {
      this.leafHashes.push(this.zeroHashes[0]);
    }

    // Build tree bottom-up
    this.tree = this._buildTree();
  }

  _computeZeroHashes(depth) {
    const zeros = [ZERO_HASH];
    for (let i = 1; i <= depth; i++) {
      zeros.push(hashPair(zeros[i - 1], zeros[i - 1]));
    }
    return zeros;
  }

  _buildTree() {
    // tree[0] = leaves, tree[depth] = [root]
    const tree = [this.leafHashes.slice()];

    for (let level = 0; level < this.depth; level++) {
      const currentLevel = tree[level];
      const nextLevel = [];

      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = currentLevel[i + 1] || this.zeroHashes[level];
        nextLevel.push(hashPair(left, right));
      }

      tree.push(nextLevel);
    }

    return tree;
  }

  /**
   * Get the Merkle root
   */
  getRoot() {
    return this.tree[this.depth][0];
  }

  /**
   * Get Merkle proof for leaf at index
   * Returns { siblings: Buffer[], index: number }
   */
  getProof(leafIndex) {
    if (leafIndex < 0 || leafIndex >= this.leafCount) {
      throw new Error(`Invalid leaf index: ${leafIndex}`);
    }

    const siblings = [];
    let idx = leafIndex;

    for (let level = 0; level < this.depth; level++) {
      const siblingIdx = idx ^ 1; // Flip last bit
      const sibling = this.tree[level][siblingIdx] || this.zeroHashes[level];
      siblings.push(sibling);
      idx = idx >> 1;
    }

    return { siblings, index: leafIndex };
  }

  /**
   * Get leaf at index
   */
  getLeaf(index) {
    return this.leaves[index];
  }

  /**
   * Verify a Merkle proof
   */
  static verifyProof(leafHash, proof, expectedRoot) {
    let current = leafHash;
    let idx = proof.index;

    for (const sibling of proof.siblings) {
      const isRight = idx & 1;
      if (isRight) {
        current = hashPair(sibling, current);
      } else {
        current = hashPair(current, sibling);
      }
      idx = idx >> 1;
    }

    return current.equals(expectedRoot);
  }
}

/**
 * Compute withdrawal root from array of payout leaves
 */
function computeWithdrawalRoot(leaves) {
  if (leaves.length === 0) {
    return ZERO_HASH;
  }
  const tree = new PayoutMerkleTree(leaves);
  return tree.getRoot();
}

/**
 * Build tree and get all proofs
 */
function buildTreeWithProofs(leaves) {
  const tree = new PayoutMerkleTree(leaves);
  const proofs = [];

  for (let i = 0; i < leaves.length; i++) {
    proofs.push(tree.getProof(i));
  }

  return {
    root: tree.getRoot(),
    proofs,
    tree
  };
}

module.exports = {
  sha256,
  hashPair,
  ZERO_HASH,
  PayoutMerkleTree,
  computeWithdrawalRoot,
  buildTreeWithProofs
};
