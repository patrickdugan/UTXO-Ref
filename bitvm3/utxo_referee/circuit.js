/**
 * UTXO Referee Circuit
 *
 * BitVM/Bristol-format circuit scaffolding for referee verification.
 * Expresses the verification rules as boolean circuit constraints.
 *
 * This is a minimal implementation focusing on:
 * - Equality checks (epoch, amounts, destinations)
 * - Merkle proof verification (hash chains)
 * - Sum accumulation with cap comparison
 */

const { Circuit } = require('../circuit');

// Circuit parameters
const EPOCH_BITS = 64;
const AMOUNT_BITS = 64;
const HASH_BITS = 256;
const MAX_PAYOUTS = 8; // Configurable max payouts per sweep
const MAX_MERKLE_DEPTH = 16; // Max tree depth (64k leaves)
const SPK_HASH_BITS = 256; // Hash of scriptPubKey for comparison

/**
 * RefereeCircuit - Generates boolean circuit for sweep verification
 */
class RefereeCircuit {
  constructor(options = {}) {
    this.maxPayouts = options.maxPayouts || MAX_PAYOUTS;
    this.merkleDepth = options.merkleDepth || MAX_MERKLE_DEPTH;
    this.circuit = new Circuit('utxo_referee_verify');
  }

  /**
   * Build the complete verification circuit
   */
  build() {
    const c = this.circuit;

    // === Commitment Package Inputs ===
    const commitEpochId = c.addInput(EPOCH_BITS, 'commit_epochId');
    const commitWithdrawalRoot = c.addInput(HASH_BITS, 'commit_withdrawalRoot');
    const commitCapSats = c.addInput(AMOUNT_BITS, 'commit_capSats');
    const commitResidualDest = c.addInput(SPK_HASH_BITS, 'commit_residualDest');

    // === Sweep Object Inputs ===
    const sweepEpochId = c.addInput(EPOCH_BITS, 'sweep_epochId');
    const sweepResidualAmount = c.addInput(AMOUNT_BITS, 'sweep_residualAmount');
    const sweepResidualDest = c.addInput(SPK_HASH_BITS, 'sweep_residualDest');

    // === Payout Inputs (fixed number, unused ones set to zero) ===
    const payouts = [];
    for (let i = 0; i < this.maxPayouts; i++) {
      payouts.push({
        amount: c.addInput(AMOUNT_BITS, `payout_${i}_amount`),
        leafHash: c.addInput(HASH_BITS, `payout_${i}_leafHash`),
        // Merkle proof siblings
        siblings: Array.from({ length: this.merkleDepth }, (_, j) =>
          c.addInput(HASH_BITS, `payout_${i}_sibling_${j}`)
        ),
        // Path index bits
        pathBits: c.addInput(this.merkleDepth, `payout_${i}_pathBits`),
        // Enable bit (1 if this payout is used, 0 if padding)
        enabled: c.addInputScalar(`payout_${i}_enabled`)
      });
    }

    // === Rule 1: Epoch Binding ===
    const epochMatch = c.eqN(commitEpochId, sweepEpochId);

    // === Rule 2: Merkle Membership (for each payout) ===
    const membershipValid = [];
    for (let i = 0; i < this.maxPayouts; i++) {
      const payout = payouts[i];
      const proofValid = this._verifyMerkleProof(
        c,
        payout.leafHash,
        payout.siblings,
        payout.pathBits,
        commitWithdrawalRoot
      );
      // If enabled, proof must be valid; if disabled, always valid
      const checkValid = c.mux(payout.enabled, c.one(), proofValid);
      membershipValid.push(checkValid);
    }
    // AND all membership checks
    let allMembershipValid = membershipValid[0];
    for (let i = 1; i < membershipValid.length; i++) {
      allMembershipValid = c.and(allMembershipValid, membershipValid[i]);
    }

    // === Rule 3: Cap Check ===
    // Sum all enabled payout amounts
    const payoutSum = this._sumPayouts(c, payouts);

    // payoutSum <= capSats  =>  NOT(payoutSum > capSats)  =>  NOT(capSats < payoutSum)
    const capExceeded = c.ltN(commitCapSats, payoutSum);
    const capValid = c.inv(capExceeded);

    // === Rule 4a: Residual Amount ===
    // residual = cap - sum
    const expectedResidual = c.subN(commitCapSats, payoutSum);
    const residualAmountValid = c.eqN(expectedResidual, sweepResidualAmount);

    // === Rule 4b: Residual Destination ===
    const residualDestValid = c.eqN(commitResidualDest, sweepResidualDest);

    // === Final: All rules must pass ===
    let valid = epochMatch;
    valid = c.and(valid, allMembershipValid);
    valid = c.and(valid, capValid);
    valid = c.and(valid, residualAmountValid);
    valid = c.and(valid, residualDestValid);

    c.setOutputs([valid]);

    return {
      circuit: c,
      inputs: {
        commitEpochId,
        commitWithdrawalRoot,
        commitCapSats,
        commitResidualDest,
        sweepEpochId,
        sweepResidualAmount,
        sweepResidualDest,
        payouts
      }
    };
  }

  /**
   * Verify Merkle proof in circuit
   */
  _verifyMerkleProof(c, leafHash, siblings, pathBits, expectedRoot) {
    let current = leafHash;

    for (let level = 0; level < this.merkleDepth; level++) {
      const sibling = siblings[level];
      const isRight = pathBits[level];

      // If isRight, hash(sibling, current); else hash(current, sibling)
      const left = c.muxN(isRight, current, sibling);
      const right = c.muxN(isRight, sibling, current);

      // TODO: Replace with actual SHA256 circuit
      // For now, use simplified XOR-based hash placeholder
      current = this._hashPairCircuit(c, left, right);
    }

    return c.eqN(current, expectedRoot);
  }

  /**
   * Hash two 256-bit values (placeholder - needs real SHA256)
   * TODO: Implement actual SHA256 compression function (~22k gates)
   */
  _hashPairCircuit(c, left, right) {
    const n = HASH_BITS;
    const result = [];

    // Simplified mixing - NOT CRYPTOGRAPHICALLY SECURE
    // Replace with actual SHA256 for production
    for (let i = 0; i < n; i++) {
      const li = left[i];
      const ri = right[(i + 128) % n];
      const x1 = c.xor(li, ri);
      const x2 = c.xor(left[(i + 64) % n], right[(i + 192) % n]);
      const a = c.and(x1, x2);
      result.push(c.xor(x1, a));
    }

    return result;
  }

  /**
   * Sum payout amounts with enable mask
   */
  _sumPayouts(c, payouts) {
    // Start with zero
    let sum = c.constantBits(0, AMOUNT_BITS);

    for (const payout of payouts) {
      // Mask amount with enabled bit
      const maskedAmount = payout.amount.map(bit =>
        c.and(bit, payout.enabled)
      );
      // Add to sum
      const { sum: newSum } = c.addN(sum, maskedAmount);
      sum = newSum;
    }

    return sum;
  }

  /**
   * Get circuit stats
   */
  getStats() {
    return this.circuit.getStats();
  }

  /**
   * Export to Bristol format
   */
  toBristol() {
    return this.circuit.toBristol();
  }
}

/**
 * Generate a minimal referee circuit with default parameters
 */
function generateRefereeCircuit(options = {}) {
  const referee = new RefereeCircuit(options);
  const result = referee.build();
  return {
    ...result,
    stats: referee.getStats(),
    bristol: referee.toBristol()
  };
}

/**
 * Convert verification inputs to circuit witness format
 */
function toCircuitWitness(commitment, sweep, leaves) {
  // Helper to convert BigInt to bit array
  const toBits = (value, width) => {
    const bits = [];
    const v = BigInt(value);
    for (let i = 0; i < width; i++) {
      bits.push((v >> BigInt(i)) & 1n ? 1 : 0);
    }
    return bits;
  };

  // Helper to convert Buffer to bit array
  const bufferToBits = (buf, width = buf.length * 8) => {
    const bits = [];
    for (let i = 0; i < buf.length && bits.length < width; i++) {
      for (let j = 0; j < 8 && bits.length < width; j++) {
        bits.push((buf[i] >> j) & 1);
      }
    }
    while (bits.length < width) bits.push(0);
    return bits;
  };

  const crypto = require('crypto');
  const spkHash = (spk) => crypto.createHash('sha256').update(spk).digest();

  return {
    commitEpochId: toBits(commitment.epochId, EPOCH_BITS),
    commitWithdrawalRoot: bufferToBits(commitment.withdrawalRoot, HASH_BITS),
    commitCapSats: toBits(commitment.capSats, AMOUNT_BITS),
    commitResidualDest: bufferToBits(spkHash(commitment.residualDest), SPK_HASH_BITS),
    sweepEpochId: toBits(sweep.epochIdCommitted, EPOCH_BITS),
    sweepResidualAmount: toBits(sweep.residualOutput.amountSats, AMOUNT_BITS),
    sweepResidualDest: bufferToBits(spkHash(sweep.residualOutput.recipientScriptPubKey), SPK_HASH_BITS),
    // Payouts would need leaf hashes and merkle proofs converted similarly
    // This is a partial implementation - full witness generation is TODO
  };
}

module.exports = {
  EPOCH_BITS,
  AMOUNT_BITS,
  HASH_BITS,
  MAX_PAYOUTS,
  MAX_MERKLE_DEPTH,
  RefereeCircuit,
  generateRefereeCircuit,
  toCircuitWitness
};
