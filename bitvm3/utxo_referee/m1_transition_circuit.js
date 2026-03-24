/**
 * Milestone 1 Transition Circuit
 *
 * Circuit scaffolding for the exact-satoshi router:
 * - one-hot route selection: flat | pnl | roll
 * - exact arithmetic over collateral and payout basis points
 * - timeout roll-forward state transition
 *
 * This is intentionally compact: it proves the transition rule, not the
 * surrounding wallet/PSBT plumbing.
 */

const { Circuit } = require('../circuit');

const U64_BITS = 64;
const HASH_BITS = 256;
const BALANCE_MERKLE_DEPTH = 16;
const ROUTE_BITS = 1;

function bitsFromBigInt(value, width) {
  const v = BigInt(value);
  const bits = [];
  for (let i = 0; i < width; i++) {
    bits.push(((v >> BigInt(i)) & 1n) ? 1 : 0);
  }
  return bits;
}

function bitsToBigInt(bits) {
  let out = 0n;
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out |= 1n << BigInt(i);
  }
  return out;
}

function bitsFromHex(hex, width = HASH_BITS) {
  const clean = String(hex || '').replace(/^0x/, '');
  if (clean === '') {
    return Array.from({ length: width }, () => 0);
  }

  const buf = Buffer.from(clean.padStart(Math.ceil(clean.length / 2) * 2, '0'), 'hex');
  const bits = [];
  for (let i = 0; i < buf.length && bits.length < width; i++) {
    for (let j = 0; j < 8 && bits.length < width; j++) {
      bits.push((buf[i] >> j) & 1);
    }
  }
  while (bits.length < width) bits.push(0);
  return bits;
}

function hexListToBits(list, width = HASH_BITS) {
  return list.map(item => bitsFromHex(item, width));
}

class TransitionCircuit {
  constructor(options = {}) {
    this.bitWidth = options.bitWidth || U64_BITS;
    this.circuit = new Circuit('m1_binary_settlement_transition');
  }

  build() {
    const c = this.circuit;
    const n = this.bitWidth;

    const epochId = c.addInput(n, 'epochId');
    const nextEpochId = c.addInput(n, 'nextEpochId');
    const collateralSats = c.addInput(n, 'collateralSats');
    const pnlPayoutBps = c.addInput(n, 'pnlPayoutBps');
    const flatPayoutSats = c.addInput(n, 'flatPayoutSats');
    const pnlPayoutSats = c.addInput(n, 'pnlPayoutSats');
    const dustCarrySats = c.addInput(n, 'dustCarrySats');
    const rolloverCollateralSats = c.addInput(n, 'rolloverCollateralSats');
    const receiptBalanceRoot = c.addInput(HASH_BITS, 'receiptBalanceRoot');
    const prevBalanceRoot = c.addInput(HASH_BITS, 'prevBalanceRoot');
    const balanceClaimEpochId = c.addInput(n, 'balanceClaimEpochId');
    const balanceClaimBalanceSats = c.addInput(n, 'balanceClaimBalanceSats');
    const balanceClaimLeafHash = c.addInput(HASH_BITS, 'balanceClaimLeafHash');
    const balanceClaimRoot = c.addInput(HASH_BITS, 'balanceClaimRoot');
    const balanceClaimIndex = c.addInput(BALANCE_MERKLE_DEPTH, 'balanceClaimIndex');
    const balanceClaimSiblings = Array.from({ length: BALANCE_MERKLE_DEPTH }, (_, i) =>
      c.addInput(HASH_BITS, `balanceClaimSibling_${i}`)
    );
    const challengeWindowStart = c.addInput(n, 'challengeWindowStart');
    const challengeWindowLength = c.addInput(n, 'challengeWindowLength');
    const challengeWindowEnd = c.addInput(n, 'challengeWindowEnd');

    const routeFlat = c.addInputScalar('routeFlat');
    const routePnl = c.addInputScalar('routePnl');
    const routeRoll = c.addInputScalar('routeRoll');

    const oneBits = c.constantBits(1, n);
    const tenThousandBits = c.constantBits(10000, n);

    // Route selection must be one-hot.
    const flatAndPnl = c.and(routeFlat, routePnl);
    const flatAndRoll = c.and(routeFlat, routeRoll);
    const pnlAndRoll = c.and(routePnl, routeRoll);
    const anyRoute = c.or(c.or(routeFlat, routePnl), routeRoll);
    const routeIsOne = c.inv(c.xor(anyRoute, c.one()));
    const routeExclusive = c.inv(c.or(c.or(flatAndPnl, flatAndRoll), pnlAndRoll));
    const routeValid = c.and(routeIsOne, routeExclusive);

    // Exact payout identity: flat + pnl + dust == collateral
    const flatPlusPnl = c.addN(flatPayoutSats, pnlPayoutSats).sum;
    const flatPlusPnlPlusDust = c.addN(flatPlusPnl, dustCarrySats).sum;
    const payoutIdentity = c.eqN(flatPlusPnlPlusDust, collateralSats);

    // Exact floor division proof:
    // pnl = floor(collateral * bps / 10000)
    // Prove: pnl*10000 <= collateral*bps < (pnl+1)*10000
    const collateralTimesBps = c.mulN(collateralSats, pnlPayoutBps);
    const pnlTimesTenThousand = c.mulN(pnlPayoutSats, tenThousandBits);
    const pnlPlusOne = c.addN(pnlPayoutSats, oneBits).sum;
    const pnlPlusOneTimesTenThousand = c.mulN(pnlPlusOne, tenThousandBits);
    const lowerBound = c.inv(c.ltN(collateralTimesBps, pnlTimesTenThousand));
    const upperBound = c.ltN(collateralTimesBps, pnlPlusOneTimesTenThousand);
    const floorValid = c.and(lowerBound, upperBound);

    // Flat is the complementary branch.
    const flatComplement = c.addN(pnlPayoutSats, flatPayoutSats).sum;
    const flatValid = c.eqN(flatComplement, collateralSats);

    // Roll-forward state.
    const epochPlusOne = c.addN(epochId, oneBits).sum;
    const nextEpochValid = c.eqN(epochPlusOne, nextEpochId);
    const dustComplement = c.subN(collateralSats, dustCarrySats);
    const rolloverValid = c.eqN(dustComplement, rolloverCollateralSats);

    // Receipt balance root is carried into the next epoch handoff.
    const balanceRootLinked = c.eqN(receiptBalanceRoot, prevBalanceRoot);

    // Account claim is bound to the same committed root and epoch.
    const claimEpochValid = c.eqN(balanceClaimEpochId, epochId);
    const claimRootLinked = c.eqN(balanceClaimRoot, receiptBalanceRoot);
    const windowOrderValid = c.inv(c.ltN(challengeWindowEnd, challengeWindowStart));
    const windowLengthValid = c.eqN(c.addN(challengeWindowStart, challengeWindowLength).sum, challengeWindowEnd);
    const claimAfterStart = c.inv(c.ltN(balanceClaimEpochId, challengeWindowStart));
    const claimBeforeEnd = c.inv(c.ltN(challengeWindowEnd, balanceClaimEpochId));
    const claimWindowValid = c.and(claimAfterStart, claimBeforeEnd);
    const claimMembershipValid = c.eqN(
      this.computeClaimRootCircuit(c, {
        balanceClaimIndex,
        balanceClaimLeafHash,
        balanceClaimSiblings
      }),
      balanceClaimRoot
    );

    let valid = routeValid;
    valid = c.and(valid, payoutIdentity);
    valid = c.and(valid, floorValid);
    valid = c.and(valid, flatValid);
    valid = c.and(valid, nextEpochValid);
    valid = c.and(valid, rolloverValid);
    valid = c.and(valid, balanceRootLinked);
    valid = c.and(valid, claimEpochValid);
    valid = c.and(valid, claimRootLinked);
    valid = c.and(valid, windowOrderValid);
    valid = c.and(valid, windowLengthValid);
    valid = c.and(valid, claimWindowValid);
    valid = c.and(valid, claimMembershipValid);

    c.setOutputs([valid]);

    return {
      circuit: c,
      inputs: {
        epochId,
        nextEpochId,
        collateralSats,
        pnlPayoutBps,
        flatPayoutSats,
        pnlPayoutSats,
        dustCarrySats,
        rolloverCollateralSats,
        receiptBalanceRoot,
        prevBalanceRoot,
        balanceClaimEpochId,
        balanceClaimBalanceSats,
        balanceClaimLeafHash,
        balanceClaimRoot,
        balanceClaimIndex,
        balanceClaimSiblings,
        challengeWindowStart,
        challengeWindowLength,
        challengeWindowEnd,
        routeFlat,
        routePnl,
        routeRoll
      }
    };
  }

  hashPairCircuit(leftBits, rightBits) {
    const c = this.circuit;
    const n = HASH_BITS;
    const result = [];

    for (let i = 0; i < n; i++) {
      const li = leftBits[i];
      const ri = rightBits[(i + 128) % n];
      const li2 = leftBits[(i + 64) % n];
      const ri2 = rightBits[(i + 192) % n];
      const x1 = c.xor(li, ri);
      const x2 = c.xor(li2, ri2);
      const a1 = c.and(x1, x2);
      result.push(c.xor(x1, a1));
    }

    return result;
  }

  computeClaimRootCircuit(c, inputs) {
    const { balanceClaimIndex, balanceClaimLeafHash, balanceClaimSiblings } = inputs;
    let current = balanceClaimLeafHash.slice();

    for (let level = 0; level < BALANCE_MERKLE_DEPTH; level++) {
      const sibling = balanceClaimSiblings[level];
      const isRight = balanceClaimIndex[level];
      const left = c.muxN(isRight, current, sibling);
      const right = c.muxN(isRight, sibling, current);
      current = this.hashPairCircuit(left, right);
    }

    return current;
  }

  getStats() {
    return this.circuit.getStats();
  }

  toBristol() {
    return this.circuit.toBristol();
  }
}

function generateTransitionCircuit(options = {}) {
  const transition = new TransitionCircuit(options);
  const result = transition.build();
  return {
    ...result,
    stats: transition.getStats(),
    bristol: transition.toBristol()
  };
}

function toTransitionWitness(state, route = 'flat') {
  const computed = state.computed || state;
  const collateralSats = computed.collateralSats ?? state.collateralSats ?? 0n;
  const epochId = computed.epochId ?? state.epochId ?? 0n;
  const pnlPayoutBps = computed.pnlPayoutBps ?? state.pnlPayoutBps ?? 5000n;
  const routeFlat = route === 'flat' ? 1 : 0;
  const routePnl = route === 'pnl' ? 1 : 0;
  const routeRoll = route === 'roll' ? 1 : 0;

  let flatPayoutSats = computed.flatPayoutSats;
  let pnlPayoutSats = computed.pnlPayoutSats;
  let dustCarrySats = computed.dustCarrySats;
  let rolloverCollateralSats = computed.rolloverCollateralSats;
  const balanceClaim = computed.balanceClaim || state.balanceClaim || null;
  const receiptBalanceRootHex = computed.receiptBalanceRoot
    || state.receiptBalanceRoot
    || (state.tallyMap && typeof state.tallyMap.getBalanceMerkleRootHex === 'function'
      ? state.tallyMap.getBalanceMerkleRootHex()
      : null);
  const prevBalanceRootHex = computed.prevBalanceRoot
    || state.prevBalanceRoot
    || receiptBalanceRootHex;

  const collateral = BigInt(collateralSats);

  if (flatPayoutSats === undefined || pnlPayoutSats === undefined) {
    if (route === 'flat') {
      flatPayoutSats = BigInt(computed.payoutSats ?? state.payoutSats ?? 0n);
      pnlPayoutSats = collateral - flatPayoutSats;
    } else if (route === 'pnl') {
      pnlPayoutSats = BigInt(computed.payoutSats ?? state.payoutSats ?? 0n);
      flatPayoutSats = collateral - pnlPayoutSats;
    } else {
      flatPayoutSats = 0n;
      pnlPayoutSats = 0n;
    }
  }

  if (dustCarrySats === undefined) {
    dustCarrySats = 0n;
  }
  if (rolloverCollateralSats === undefined) {
    rolloverCollateralSats = route === 'roll'
      ? collateral - BigInt(dustCarrySats)
      : collateral;
  }

  let resolvedClaim = balanceClaim;
  if (!resolvedClaim && state.tallyMap && typeof state.tallyMap.getBalanceClaim === 'function') {
    const claimAccountId = state.claimAccountId || state.accountId;
    if (claimAccountId) {
      resolvedClaim = state.tallyMap.getBalanceClaim(claimAccountId);
    }
  }

  const balanceClaimEpochId = resolvedClaim ? BigInt(resolvedClaim.epochId ?? epochId) : epochId;
  const balanceClaimBalanceSats = resolvedClaim ? BigInt(resolvedClaim.balanceSats ?? 0n) : 0n;
  const balanceClaimLeafHashHex = resolvedClaim ? (resolvedClaim.leafHash || null) : null;
  const balanceClaimRootHex = resolvedClaim ? (resolvedClaim.balanceRoot || receiptBalanceRootHex) : receiptBalanceRootHex;
  const balanceClaimIndex = resolvedClaim ? BigInt(resolvedClaim.index ?? 0n) : 0n;
  const balanceClaimSiblingHexes = resolvedClaim
    ? Array.from({ length: BALANCE_MERKLE_DEPTH }, (_, i) => resolvedClaim.siblings?.[i] || null)
    : Array.from({ length: BALANCE_MERKLE_DEPTH }, () => null);
  const challengeWindowStartValue = resolvedClaim
    ? BigInt(resolvedClaim.challengeWindowStart ?? state.challengeWindowStart ?? epochId)
    : BigInt(state.challengeWindowStart ?? epochId);
  const challengeWindowLengthValue = resolvedClaim
    ? BigInt(resolvedClaim.challengeWindowLength ?? state.challengeWindowLength ?? 0n)
    : BigInt(state.challengeWindowLength ?? 0n);
  const challengeWindowEndValue = resolvedClaim
    ? BigInt(resolvedClaim.challengeWindowEnd ?? state.challengeWindowEnd ?? (challengeWindowStartValue + challengeWindowLengthValue))
    : BigInt(state.challengeWindowEnd ?? (challengeWindowStartValue + challengeWindowLengthValue));

  return {
    epochId: bitsFromBigInt(epochId, U64_BITS),
    nextEpochId: bitsFromBigInt(BigInt(epochId) + 1n, U64_BITS),
    collateralSats: bitsFromBigInt(collateral, U64_BITS),
    pnlPayoutBps: bitsFromBigInt(pnlPayoutBps, U64_BITS),
    flatPayoutSats: bitsFromBigInt(flatPayoutSats, U64_BITS),
    pnlPayoutSats: bitsFromBigInt(pnlPayoutSats, U64_BITS),
    dustCarrySats: bitsFromBigInt(dustCarrySats, U64_BITS),
    rolloverCollateralSats: bitsFromBigInt(rolloverCollateralSats, U64_BITS),
    receiptBalanceRoot: bitsFromHex(receiptBalanceRootHex, HASH_BITS),
    prevBalanceRoot: bitsFromHex(prevBalanceRootHex, HASH_BITS),
    balanceClaimEpochId: bitsFromBigInt(balanceClaimEpochId, U64_BITS),
    balanceClaimBalanceSats: bitsFromBigInt(balanceClaimBalanceSats, U64_BITS),
    balanceClaimLeafHash: bitsFromHex(balanceClaimLeafHashHex, HASH_BITS),
    balanceClaimRoot: bitsFromHex(balanceClaimRootHex, HASH_BITS),
    balanceClaimIndex: bitsFromBigInt(balanceClaimIndex, BALANCE_MERKLE_DEPTH),
    balanceClaimSiblings: hexListToBits(balanceClaimSiblingHexes, HASH_BITS),
    challengeWindowStart: bitsFromBigInt(challengeWindowStartValue, U64_BITS),
    challengeWindowLength: bitsFromBigInt(challengeWindowLengthValue, U64_BITS),
    challengeWindowEnd: bitsFromBigInt(challengeWindowEndValue, U64_BITS),
    challengeWindowStartValue,
    challengeWindowLengthValue,
    challengeWindowEndValue,
    balanceClaim: resolvedClaim,
    routeFlat,
    routePnl,
    routeRoll
  };
}

module.exports = {
  U64_BITS,
  HASH_BITS,
  BALANCE_MERKLE_DEPTH,
  bitsFromBigInt,
  bitsToBigInt,
  bitsFromHex,
  hexListToBits,
  TransitionCircuit,
  generateTransitionCircuit,
  toTransitionWitness
};
