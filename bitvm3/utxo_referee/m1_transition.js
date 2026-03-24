/**
 * Milestone 1 Transition Function
 *
 * A minimal VM-style state transition for bounded settlement:
 * - route: flat | pnl | roll
 * - exact integer satoshi arithmetic
 * - roll-forward on timeout
 *
 * This is the concrete "router" shape for the current M1 harness.
 */

function toBigInt(value, fieldName) {
  try {
    return BigInt(value);
  } catch (e) {
    throw new Error(`${fieldName} must be convertible to BigInt`);
  }
}

function validateBps(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10000) {
    throw new Error(`${fieldName} must be an integer in 0..10000`);
  }
  return n;
}

function computeRouteAmounts(collateralSats, pnlPayoutBps) {
  const collateral = toBigInt(collateralSats, 'collateralSats');
  const bps = validateBps(pnlPayoutBps, 'pnlPayoutBps');
  const pnl = (collateral * BigInt(bps)) / 10000n;
  const flat = collateral - pnl;
  const dust = collateral - flat - pnl;

  return {
    collateralSats: collateral,
    pnlPayoutBps: bps,
    flatPayoutSats: flat,
    pnlPayoutSats: pnl,
    dustCarrySats: dust
  };
}

function applyBinarySettlementTransition(state, event) {
  const collateralSats = toBigInt(state.collateralSats, 'state.collateralSats');
  const pnlPayoutBps = validateBps(state.pnlPayoutBps ?? 5000, 'state.pnlPayoutBps');
  const epochId = toBigInt(state.epochId ?? 0n, 'state.epochId');
  const route = String(event.route || 'roll');
  const timeout = !!event.timeout;
  const computed = computeRouteAmounts(collateralSats, pnlPayoutBps);
  const receiptBalanceRoot = state.receiptBalanceRoot || null;
  const prevBalanceRoot = state.prevBalanceRoot || receiptBalanceRoot || null;
  const balanceClaim = state.balanceClaim || null;
  const challengeWindowStart = toBigInt(state.challengeWindowStart ?? epochId, 'state.challengeWindowStart');
  const challengeWindowLength = toBigInt(
    state.challengeWindowLength ?? (state.challengeWindowEnd != null ? toBigInt(state.challengeWindowEnd, 'state.challengeWindowEnd') - challengeWindowStart : 0n),
    'state.challengeWindowLength'
  );
  const challengeWindowEnd = toBigInt(state.challengeWindowEnd ?? (challengeWindowStart + challengeWindowLength), 'state.challengeWindowEnd');

  if (timeout || route === 'roll') {
    return {
      route: 'roll',
      epochId: epochId.toString(),
      nextEpochId: (epochId + 1n).toString(),
      collateralSats: computed.collateralSats.toString(),
      dustCarrySats: computed.dustCarrySats.toString(),
      rolloverCollateralSats: (computed.collateralSats - computed.dustCarrySats).toString(),
      receiptBalanceRoot,
      prevBalanceRoot,
      balanceClaim,
      challengeWindowStart: challengeWindowStart.toString(),
      challengeWindowLength: challengeWindowLength.toString(),
      challengeWindowEnd: challengeWindowEnd.toString(),
      outputs: {
        residualSats: (computed.collateralSats - computed.dustCarrySats).toString()
      }
    };
  }

  if (route !== 'flat' && route !== 'pnl') {
    throw new Error(`Unsupported route: ${route}`);
  }

  const payoutSats = route === 'flat'
    ? computed.flatPayoutSats
    : computed.pnlPayoutSats;

  const residualSats = computed.collateralSats - payoutSats;

  return {
    route,
    epochId: epochId.toString(),
    collateralSats: computed.collateralSats.toString(),
    pnlPayoutBps: computed.pnlPayoutBps,
    receiptBalanceRoot,
    prevBalanceRoot,
    balanceClaim,
    challengeWindowStart: challengeWindowStart.toString(),
    challengeWindowLength: challengeWindowLength.toString(),
    challengeWindowEnd: challengeWindowEnd.toString(),
    payoutSats: payoutSats.toString(),
    residualSats: residualSats.toString(),
    dustCarrySats: computed.dustCarrySats.toString(),
    outputs: {
      payoutSats: payoutSats.toString(),
      residualSats: residualSats.toString()
    }
  };
}

module.exports = {
  computeRouteAmounts,
  applyBinarySettlementTransition
};
