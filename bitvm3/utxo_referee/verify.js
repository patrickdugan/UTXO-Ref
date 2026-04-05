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

function toBigInt(value, fieldName) {
  try {
    return BigInt(value);
  } catch (err) {
    throw new Error(`${fieldName} must be convertible to BigInt`);
  }
}

function normalizeOutput(output, index) {
  if (!output || typeof output !== 'object') {
    throw new Error(`output ${index} must be an object`);
  }

  return {
    role: output.role ? String(output.role) : null,
    address: output.address ? String(output.address) : null,
    amountSats: toBigInt(output.amountSats, `outputs[${index}].amountSats`)
  };
}

function deriveSettlementRouting(state, destinations = {}) {
  const route = String(state?.route || '').trim();
  if (!route) {
    throw new Error('state.route is required');
  }

  const collateralSats = toBigInt(state.collateralSats ?? 0n, 'state.collateralSats');
  const feeSats = toBigInt(state.feeSats ?? 0n, 'state.feeSats');
  const dustCarrySats = toBigInt(state.dustCarrySats ?? 0n, 'state.dustCarrySats');
  const actualPayoutSats = toBigInt(
    state.actualPayoutSats ?? state.payoutSats ?? 0n,
    'state.actualPayoutSats'
  );
  const rolloverCollateralSats = toBigInt(
    state.rolloverCollateralSats ?? state.timeoutRemainderSats ?? state.refundSats ?? state.residualSats ?? 0n,
    'state.rolloverCollateralSats'
  );
  const timeoutRemainderSats = state.timeoutRemainderSats !== undefined && state.timeoutRemainderSats !== null
    ? toBigInt(state.timeoutRemainderSats, 'state.timeoutRemainderSats')
    : null;
  const explicitRefundSats = state.refundSats !== undefined && state.refundSats !== null
    ? toBigInt(state.refundSats, 'state.refundSats')
    : null;

  let winnerSweepSats = 0n;
  let refundRemainderSats = 0n;
  let settlementKind = 'unknown';

  if (route === 'roll') {
    winnerSweepSats = rolloverCollateralSats;
    refundRemainderSats = timeoutRemainderSats !== null
      ? timeoutRemainderSats
      : collateralSats - winnerSweepSats - feeSats - dustCarrySats;
    settlementKind = 'timeout-refund';
  } else if (route === 'settle-gain' || route === 'settle-loss') {
    winnerSweepSats = actualPayoutSats;
    refundRemainderSats = explicitRefundSats !== null
      ? explicitRefundSats
      : collateralSats - winnerSweepSats - feeSats - dustCarrySats;
    settlementKind = 'pnl-sweep';
  } else if (route === 'flat' || route === 'pnl') {
    winnerSweepSats = actualPayoutSats;
    refundRemainderSats = collateralSats - winnerSweepSats - feeSats - dustCarrySats;
    settlementKind = route === 'pnl' ? 'pnl-sweep' : 'flat-sweep';
  } else {
    throw new Error(`Unsupported settlement route: ${route}`);
  }

  if (winnerSweepSats < 0n) {
    throw new Error('winnerSweepSats cannot be negative');
  }
  if (refundRemainderSats < 0n) {
    throw new Error('refundRemainderSats cannot be negative');
  }

  const totalOutputsSats = winnerSweepSats + refundRemainderSats + feeSats + dustCarrySats;
  const conservationHolds = totalOutputsSats === collateralSats;

  return {
    route,
    settlementKind,
    collateralSats,
    winnerSweepSats,
    refundRemainderSats,
    feeSats,
    dustCarrySats,
    totalOutputsSats,
    conservationHolds,
    outputs: [
      {
        role: 'winner-sweep',
        address: destinations.winnerAddress ? String(destinations.winnerAddress) : null,
        amountSats: winnerSweepSats
      },
      {
        role: 'refund-remainder',
        address: destinations.refundAddress ? String(destinations.refundAddress) : null,
        amountSats: refundRemainderSats
      },
      {
        role: 'fee',
        address: destinations.feeAddress ? String(destinations.feeAddress) : null,
        amountSats: feeSats
      }
    ].filter((output) => output.amountSats > 0n)
  };
}

function verifySettlementRouting(state, observed = {}, destinations = {}) {
  const expected = deriveSettlementRouting(state, destinations);
  if (!expected.conservationHolds) {
    return {
      ok: false,
      reason: `Settlement conservation mismatch: outputs sum to ${expected.totalOutputsSats} sats, collateral is ${expected.collateralSats} sats`,
      expected
    };
  }

  const outputs = Array.isArray(observed.outputs)
    ? observed.outputs.map(normalizeOutput)
    : [];

  for (const expectedOutput of expected.outputs) {
    const matched = outputs.find((output) => {
      const roleMatches = output.role === expectedOutput.role;
      const addressMatches = !expectedOutput.address || output.address === expectedOutput.address;
      return roleMatches && addressMatches;
    });

    if (!matched) {
      return {
        ok: false,
        reason: `Missing expected ${expectedOutput.role} output`,
        expected
      };
    }

    if (matched.amountSats !== expectedOutput.amountSats) {
      return {
        ok: false,
        reason: `${expectedOutput.role} amount mismatch: expected ${expectedOutput.amountSats} sats, got ${matched.amountSats} sats`,
        expected
      };
    }
  }

  const observedTotal = outputs.reduce((sum, output) => sum + output.amountSats, 0n);
  if (observedTotal !== expected.winnerSweepSats + expected.refundRemainderSats + expected.feeSats) {
    return {
      ok: false,
      reason: `Observed output sum mismatch: expected ${expected.winnerSweepSats + expected.refundRemainderSats + expected.feeSats} sats, got ${observedTotal} sats`,
      expected
    };
  }

  return {
    ok: true,
    expected,
    observed: {
      outputs
    }
  };
}

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
  verifyRules,
  deriveSettlementRouting,
  verifySettlementRouting
};
