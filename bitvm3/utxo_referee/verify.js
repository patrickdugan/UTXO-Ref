/**
 * UTXO Referee Off-Chain Verification
 *
 * Verifies that a sweep transaction follows the committed settlement rules.
 *
 * Rules checked:
 * 1) Epoch binding: epochIdCommitted == epochId
 * 2) Membership: each payout has valid Merkle proof
 * 3) Cap: sum(payouts) <= capSats
 * 4) Residual: residual amount and destination match commitment
 */

const { PayoutLeaf } = require('./types');
const { PayoutMerkleTree } = require('./merkle');

/**
 * Verify a sweep transaction against a commitment package
 *
 * @param {CommitmentPackage} commitment - The settlement commitment
 * @param {SweepObject} sweep - The sweep transaction object
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifySweep(commitment, sweep) {
  // Rule 1: Epoch binding
  if (sweep.epochIdCommitted !== commitment.epochId) {
    return {
      ok: false,
      reason: `Epoch mismatch: sweep has ${sweep.epochIdCommitted}, commitment has ${commitment.epochId}`
    };
  }

  // Rule 2: Membership - verify each payout's Merkle proof
  for (let i = 0; i < sweep.payoutOutputs.length; i++) {
    const output = sweep.payoutOutputs[i];

    // Reconstruct the leaf for this payout
    const leaf = new PayoutLeaf({
      epochId: commitment.epochId,
      recipientScriptPubKey: output.recipientScriptPubKey,
      amountSats: output.amountSats
    });

    const leafHash = leaf.hash();

    // Verify Merkle proof
    if (!output.merkleProof || !output.merkleProof.siblings) {
      return {
        ok: false,
        reason: `Payout ${i}: missing Merkle proof`
      };
    }

    const valid = PayoutMerkleTree.verifyProof(
      leafHash,
      output.merkleProof,
      commitment.withdrawalRoot
    );

    if (!valid) {
      return {
        ok: false,
        reason: `Payout ${i}: invalid Merkle proof`
      };
    }
  }

  // Rule 3: Cap - sum of payouts must not exceed cap
  const totalPayout = sweep.totalPayoutSats();

  if (totalPayout > commitment.capSats) {
    return {
      ok: false,
      reason: `Cap exceeded: payouts sum to ${totalPayout} sats, cap is ${commitment.capSats} sats`
    };
  }

  // Rule 4: Residual handling
  const expectedResidual = commitment.capSats - totalPayout;

  if (sweep.residualOutput.amountSats !== expectedResidual) {
    return {
      ok: false,
      reason: `Residual amount mismatch: expected ${expectedResidual} sats, got ${sweep.residualOutput.amountSats} sats`
    };
  }

  // Check residual destination
  if (!sweep.residualOutput.recipientScriptPubKey.equals(commitment.residualDest)) {
    return {
      ok: false,
      reason: `Residual destination mismatch: expected ${commitment.residualDest.toString('hex')}, got ${sweep.residualOutput.recipientScriptPubKey.toString('hex')}`
    };
  }

  return { ok: true };
}

/**
 * Verify individual rules (for debugging/testing)
 */
const verifyRules = {
  /**
   * Rule 1: Epoch binding
   */
  epochBinding(commitment, sweep) {
    return sweep.epochIdCommitted === commitment.epochId;
  },

  /**
   * Rule 2: Single payout membership
   */
  membership(commitment, output) {
    const leaf = new PayoutLeaf({
      epochId: commitment.epochId,
      recipientScriptPubKey: output.recipientScriptPubKey,
      amountSats: output.amountSats
    });

    return PayoutMerkleTree.verifyProof(
      leaf.hash(),
      output.merkleProof,
      commitment.withdrawalRoot
    );
  },

  /**
   * Rule 3: Cap check
   */
  capCheck(commitment, sweep) {
    return sweep.totalPayoutSats() <= commitment.capSats;
  },

  /**
   * Rule 4a: Residual amount
   */
  residualAmount(commitment, sweep) {
    const expectedResidual = commitment.capSats - sweep.totalPayoutSats();
    return sweep.residualOutput.amountSats === expectedResidual;
  },

  /**
   * Rule 4b: Residual destination
   */
  residualDest(commitment, sweep) {
    return sweep.residualOutput.recipientScriptPubKey.equals(commitment.residualDest);
  }
};

module.exports = {
  verifySweep,
  verifyRules
};
