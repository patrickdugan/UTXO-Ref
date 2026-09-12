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
  try {
    if (!commitment || typeof commitment.epochId !== 'bigint' ||
        typeof commitment.capSats !== 'bigint' || commitment.capSats < 0n ||
        !Buffer.isBuffer(commitment.withdrawalRoot) || commitment.withdrawalRoot.length !== 32 ||
        !Buffer.isBuffer(commitment.residualDest) ||
        !sweep || typeof sweep.epochIdCommitted !== 'bigint' ||
        !Array.isArray(sweep.payoutOutputs) ||
        !sweep.residualOutput) {
      return { ok: false, reason: 'Malformed commitment or sweep object' };
    }

    // Rule 1: Epoch binding
    if (sweep.epochIdCommitted !== commitment.epochId) {
      return {
        ok: false,
        reason: `Epoch mismatch: sweep has ${sweep.epochIdCommitted}, commitment has ${commitment.epochId}`
      };
    }

    // Rule 2: membership and per-sweep Merkle-position consumption.
    const consumedPositions = new Set();
    let proofDepth = null;
    let totalPayout = 0n;
    for (let i = 0; i < sweep.payoutOutputs.length; i++) {
      const output = sweep.payoutOutputs[i];
      if (!output || !Buffer.isBuffer(output.recipientScriptPubKey) ||
          typeof output.amountSats !== 'bigint' || output.amountSats < 0n ||
          !output.merkleProof || !Array.isArray(output.merkleProof.siblings)) {
        return { ok: false, reason: `Payout ${i}: malformed payout or Merkle proof` };
      }
      if (proofDepth === null) proofDepth = output.merkleProof.siblings.length;
      if (output.merkleProof.siblings.length !== proofDepth) {
        return { ok: false, reason: `Payout ${i}: inconsistent Merkle proof depth` };
      }
      if (!Number.isSafeInteger(output.merkleProof.index) || output.merkleProof.index < 0) {
        return { ok: false, reason: `Payout ${i}: non-canonical Merkle proof index` };
      }
      const position = `${proofDepth}:${output.merkleProof.index}`;
      if (consumedPositions.has(position)) {
        return { ok: false, reason: `Payout ${i}: Merkle position already consumed` };
      }

      const leaf = new PayoutLeaf({
        epochId: commitment.epochId,
        recipientScriptPubKey: output.recipientScriptPubKey,
        amountSats: output.amountSats
      });
      if (!PayoutMerkleTree.verifyProof(leaf.hash(), output.merkleProof, commitment.withdrawalRoot)) {
        return { ok: false, reason: `Payout ${i}: invalid Merkle proof` };
      }
      consumedPositions.add(position);
      totalPayout += output.amountSats;
      if (totalPayout > commitment.capSats) {
        return {
          ok: false,
          reason: `Cap exceeded: payouts sum to ${totalPayout} sats, cap is ${commitment.capSats} sats`
        };
      }
    }

    // Rule 4: Residual handling
    const residual = sweep.residualOutput;
    if (!Buffer.isBuffer(residual.recipientScriptPubKey) ||
        typeof residual.amountSats !== 'bigint' || residual.amountSats < 0n) {
      return { ok: false, reason: 'Malformed residual output' };
    }
    const expectedResidual = commitment.capSats - totalPayout;

    if (residual.amountSats !== expectedResidual) {
      return {
        ok: false,
        reason: `Residual amount mismatch: expected ${expectedResidual} sats, got ${residual.amountSats} sats`
      };
    }

    if (!residual.recipientScriptPubKey.equals(commitment.residualDest)) {
      return {
        ok: false,
        reason: `Residual destination mismatch: expected ${commitment.residualDest.toString('hex')}, got ${residual.recipientScriptPubKey.toString('hex')}`
      };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `Malformed sweep: ${error && error.message ? error.message : String(error)}`
    };
  }
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
    try {
      if (!output || typeof output.amountSats !== 'bigint' || output.amountSats < 0n) return false;
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
    } catch (_error) {
      return false;
    }
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
