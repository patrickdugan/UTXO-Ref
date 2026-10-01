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

function resolveDestinations(state = {}, destinations = {}) {
  return {
    winnerAddress: destinations.winnerAddress ?? state.winnerAddress ?? null,
    sendAddress: destinations.sendAddress ?? state.sendAddress ?? state.resolvedSendAddress ?? null,
    refundAddress: destinations.refundAddress ?? state.refundAddress ?? null,
    feeAddress: destinations.feeAddress ?? state.feeAddress ?? null,
    dustAddress: destinations.dustAddress ?? state.dustAddress ?? null
  };
}

function deriveSettlementRouting(state, destinations = {}) {
  const route = String(state?.route || '').trim();
  if (!route) {
    throw new Error('state.route is required');
  }
  const resolvedDestinations = resolveDestinations(state, destinations);

  const collateralSats = toBigInt(state.collateralSats ?? 0n, 'state.collateralSats');
  const feeSats = toBigInt(state.feeSats ?? 0n, 'state.feeSats');
  const dustCarrySats = toBigInt(state.dustCarrySats ?? 0n, 'state.dustCarrySats');
  const actualPayoutSats = toBigInt(
    state.actualPayoutSats ?? state.payoutSats ?? 0n,
    'state.actualPayoutSats'
  );
  const sendPayoutSats = toBigInt(
    state.sendPayoutSats ?? state.sendSats ?? state.actualPayoutSats ?? state.payoutSats ?? 0n,
    'state.sendPayoutSats'
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
  } else if (route === 'send') {
    winnerSweepSats = sendPayoutSats;
    refundRemainderSats = explicitRefundSats !== null
      ? explicitRefundSats
      : collateralSats - winnerSweepSats - feeSats - dustCarrySats;
    settlementKind = 'send-sweep';
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
        role: route === 'send' ? 'send-destination' : 'winner-sweep',
        address: route === 'send'
          ? (resolvedDestinations.sendAddress ? String(resolvedDestinations.sendAddress) : null)
          : (resolvedDestinations.winnerAddress ? String(resolvedDestinations.winnerAddress) : null),
        amountSats: winnerSweepSats
      },
      {
        role: 'refund-remainder',
        address: resolvedDestinations.refundAddress ? String(resolvedDestinations.refundAddress) : null,
        amountSats: refundRemainderSats
      },
      {
        role: 'fee',
        address: resolvedDestinations.feeAddress ? String(resolvedDestinations.feeAddress) : null,
        amountSats: feeSats
      },
      {
        role: 'dust-carry',
        address: resolvedDestinations.dustAddress ? String(resolvedDestinations.dustAddress) : null,
        amountSats: dustCarrySats
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
  if (observedTotal !== expected.totalOutputsSats) {
    return {
      ok: false,
      reason: `Observed output sum mismatch: expected ${expected.totalOutputsSats} sats, got ${observedTotal} sats`,
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
  verifyRules,
  deriveSettlementRouting,
  verifySettlementRouting
};
