/**
 * Milestone 1 Transition Circuit
 *
 * Circuit scaffolding for the exact-satoshi router:
 * - one-hot route selection: flat | pnl | settle-loss | settle-gain | roll | send
 * - exact arithmetic over collateral, bounded realized PnL, and fees
 * - timeout roll-forward state transition
 *
 * This is intentionally compact: it proves the transition rule, not the
 * surrounding wallet/PSBT plumbing.
 */

const { Circuit } = require('../circuit');
const { sha256PairCircuit } = require('../sha256');

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
    const sendBps = c.addInput(n, 'sendBps');
    const bucketCapBps = c.addInput(n, 'bucketCapBps');
    const realizedPnlBps = c.addInput(n, 'realizedPnlBps');
    const effectivePnlBps = c.addInput(n, 'effectivePnlBps');
    const feeBps = c.addInput(n, 'feeBps');
    const flatPayoutSats = c.addInput(n, 'flatPayoutSats');
    const pnlPayoutSats = c.addInput(n, 'pnlPayoutSats');
    const sendPayoutSats = c.addInput(n, 'sendPayoutSats');
    const actualPayoutSats = c.addInput(n, 'actualPayoutSats');
    const feeSats = c.addInput(n, 'feeSats');
    const refundSats = c.addInput(n, 'refundSats');
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
    const routeSettleLoss = c.addInputScalar('routeSettleLoss');
    const routeSettleGain = c.addInputScalar('routeSettleGain');
    const routeSend = c.addInputScalar('routeSend');

    const oneBits = c.constantBits(1, n);
    const tenThousandBits = c.constantBits(10000, n);

    // Route selection must be one-hot.
    const routeInputs = [routeFlat, routePnl, routeRoll, routeSettleLoss, routeSettleGain, routeSend];
    let pairwiseCollision = c.zero();
    for (let i = 0; i < routeInputs.length; i++) {
      for (let j = i + 1; j < routeInputs.length; j++) {
        pairwiseCollision = c.or(pairwiseCollision, c.and(routeInputs[i], routeInputs[j]));
      }
    }
    const anyRoute = routeInputs.reduce((acc, bit) => c.or(acc, bit), c.zero());
    const routeIsOne = c.inv(c.xor(anyRoute, c.one()));
    const routeExclusive = c.inv(pairwiseCollision);
    const routeValid = c.and(routeIsOne, routeExclusive);
    const routeLegacy = c.or(c.or(routeFlat, routePnl), routeRoll);
    const routeBounded = c.or(routeSettleLoss, routeSettleGain);

    const implies = (premise, consequence) => c.or(c.inv(premise), consequence);

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

    // Bounded settlement identity:
    // payout + fee + refund + dust == collateral
    const payoutPlusFee = c.addN(actualPayoutSats, feeSats).sum;
    const payoutFeePlusRefund = c.addN(payoutPlusFee, refundSats).sum;
    const boundedIdentity = c.eqN(c.addN(payoutFeePlusRefund, dustCarrySats).sum, collateralSats);
    const payoutAliasValid = c.eqN(actualPayoutSats, pnlPayoutSats);
    const refundAliasValid = c.eqN(refundSats, rolloverCollateralSats);
    const residualAliasValid = c.eqN(refundSats, flatPayoutSats);
    const effectiveLeBucket = c.inv(c.ltN(bucketCapBps, effectivePnlBps));
    const effectiveLeRealized = c.inv(c.ltN(realizedPnlBps, effectivePnlBps));
    const bucketLtRealized = c.ltN(bucketCapBps, realizedPnlBps);
    const realizedLtBucket = c.ltN(realizedPnlBps, bucketCapBps);
    const effectiveEqBucket = c.eqN(effectivePnlBps, bucketCapBps);
    const effectiveEqRealized = c.eqN(effectivePnlBps, realizedPnlBps);
    const minWhenBucket = implies(bucketLtRealized, effectiveEqBucket);
    const minWhenRealized = implies(realizedLtBucket, effectiveEqRealized);
    const minWhenEqual = implies(c.and(c.inv(bucketLtRealized), c.inv(realizedLtBucket)), c.and(effectiveEqBucket, effectiveEqRealized));
    const collateralTimesEffective = c.mulN(collateralSats, effectivePnlBps);
    const payoutTimesTenThousand = c.mulN(actualPayoutSats, tenThousandBits);
    const payoutPlusOne = c.addN(actualPayoutSats, oneBits).sum;
    const payoutPlusOneTimesTenThousand = c.mulN(payoutPlusOne, tenThousandBits);
    const payoutLowerBound = c.inv(c.ltN(collateralTimesEffective, payoutTimesTenThousand));
    const payoutUpperBound = c.ltN(collateralTimesEffective, payoutPlusOneTimesTenThousand);
    const boundedPayoutFloor = c.and(payoutLowerBound, payoutUpperBound);
    const collateralTimesFee = c.mulN(collateralSats, feeBps);
    const feeTimesTenThousand = c.mulN(feeSats, tenThousandBits);
    const feePlusOne = c.addN(feeSats, oneBits).sum;
    const feePlusOneTimesTenThousand = c.mulN(feePlusOne, tenThousandBits);
    const feeLowerBound = c.inv(c.ltN(collateralTimesFee, feeTimesTenThousand));
    const feeUpperBound = c.ltN(collateralTimesFee, feePlusOneTimesTenThousand);
    const boundedFeeFloor = c.and(feeLowerBound, feeUpperBound);

    // Send route identity:
    // send + fee + refund + dust == collateral, where send is floor(collateral * sendBps / 10000).
    const sendPlusFee = c.addN(sendPayoutSats, feeSats).sum;
    const sendFeePlusRefund = c.addN(sendPlusFee, refundSats).sum;
    const sendIdentity = c.eqN(c.addN(sendFeePlusRefund, dustCarrySats).sum, collateralSats);
    const sendAliasValid = c.eqN(actualPayoutSats, sendPayoutSats);
    const collateralTimesSend = c.mulN(collateralSats, sendBps);
    const sendTimesTenThousand = c.mulN(sendPayoutSats, tenThousandBits);
    const sendPlusOne = c.addN(sendPayoutSats, oneBits).sum;
    const sendPlusOneTimesTenThousand = c.mulN(sendPlusOne, tenThousandBits);
    const sendLowerBound = c.inv(c.ltN(collateralTimesSend, sendTimesTenThousand));
    const sendUpperBound = c.ltN(collateralTimesSend, sendPlusOneTimesTenThousand);
    const sendFloor = c.and(sendLowerBound, sendUpperBound);

    // Roll-forward state.
    const epochPlusOne = c.addN(epochId, oneBits).sum;
    const nextEpochValid = c.eqN(epochPlusOne, nextEpochId);
    const dustComplement = c.subN(collateralSats, dustCarrySats);
    const rolloverValid = c.and(
      implies(routeRoll, c.eqN(dustComplement, rolloverCollateralSats)),
      implies(routeBounded, c.eqN(refundSats, rolloverCollateralSats)),
      implies(routeSend, c.eqN(refundSats, rolloverCollateralSats)),
      implies(c.or(routeFlat, routePnl), c.eqN(dustComplement, rolloverCollateralSats))
    );

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
    valid = c.and(valid, implies(routeLegacy, payoutIdentity));
    valid = c.and(valid, implies(routeLegacy, floorValid));
    valid = c.and(valid, implies(routeLegacy, flatValid));
    valid = c.and(valid, implies(routeBounded, boundedIdentity));
    valid = c.and(valid, implies(routeBounded, payoutAliasValid));
    valid = c.and(valid, implies(routeBounded, refundAliasValid));
    valid = c.and(valid, implies(routeBounded, residualAliasValid));
    valid = c.and(valid, implies(routeBounded, effectiveLeBucket));
    valid = c.and(valid, implies(routeBounded, effectiveLeRealized));
    valid = c.and(valid, implies(routeBounded, minWhenBucket));
    valid = c.and(valid, implies(routeBounded, minWhenRealized));
    valid = c.and(valid, implies(routeBounded, minWhenEqual));
    valid = c.and(valid, implies(routeBounded, boundedPayoutFloor));
    valid = c.and(valid, implies(routeBounded, boundedFeeFloor));
    valid = c.and(valid, implies(routeSend, sendIdentity));
    valid = c.and(valid, implies(routeSend, sendAliasValid));
    valid = c.and(valid, implies(routeSend, sendFloor));
    valid = c.and(valid, implies(routeSend, boundedFeeFloor));
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
        sendBps,
        bucketCapBps,
        realizedPnlBps,
        effectivePnlBps,
        feeBps,
        flatPayoutSats,
        pnlPayoutSats,
        sendPayoutSats,
        actualPayoutSats,
        feeSats,
        refundSats,
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
        routeRoll,
        routeSettleLoss,
        routeSettleGain,
        routeSend
      }
    };
  }

  hashPairCircuit(leftBits, rightBits) {
    return sha256PairCircuit(this.circuit, leftBits, rightBits);
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
  const sendBps = computed.sendBps ?? state.sendBps ?? 0n;
  const bucketCapBps = computed.bucketCapBps ?? state.bucketCapBps ?? pnlPayoutBps;
  const realizedPnlBps = computed.realizedPnlBps ?? state.realizedPnlBps ?? bucketCapBps;
  const effectivePnlBps = computed.effectivePnlBps ?? state.effectivePnlBps ?? realizedPnlBps;
  const feeBps = computed.feeBps ?? state.feeBps ?? 0n;
  const routeFlat = route === 'flat' ? 1 : 0;
  const routePnl = route === 'pnl' ? 1 : 0;
  const routeRoll = route === 'roll' ? 1 : 0;
  const routeSettleLoss = route === 'settle-loss' ? 1 : 0;
  const routeSettleGain = route === 'settle-gain' ? 1 : 0;
  const routeSend = route === 'send' ? 1 : 0;

  let flatPayoutSats = computed.flatPayoutSats;
  let pnlPayoutSats = computed.pnlPayoutSats;
  let sendPayoutSats = computed.sendPayoutSats;
  let actualPayoutSats = computed.actualPayoutSats;
  let feeSats = computed.feeSats;
  let refundSats = computed.refundSats;
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

  if (routeSend) {
    sendPayoutSats = BigInt(sendPayoutSats ?? computed.payoutSats ?? state.payoutSats ?? 0n);
    actualPayoutSats = sendPayoutSats;
    feeSats = BigInt(feeSats ?? 0n);
    refundSats = BigInt(refundSats ?? computed.residualSats ?? state.residualSats ?? (collateral - sendPayoutSats - feeSats));
    flatPayoutSats = refundSats;
    pnlPayoutSats = 0n;
  } else if (routeSettleLoss || routeSettleGain) {
    actualPayoutSats = BigInt(actualPayoutSats ?? computed.payoutSats ?? state.payoutSats ?? 0n);
    feeSats = BigInt(feeSats ?? 0n);
    refundSats = BigInt(refundSats ?? computed.residualSats ?? state.residualSats ?? (collateral - actualPayoutSats - feeSats));
    flatPayoutSats = refundSats;
    pnlPayoutSats = actualPayoutSats;
  } else if (flatPayoutSats === undefined || pnlPayoutSats === undefined) {
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

  if (actualPayoutSats === undefined) {
    actualPayoutSats = route === 'pnl' ? pnlPayoutSats : BigInt(computed.payoutSats ?? state.payoutSats ?? 0n);
  }
  if (sendPayoutSats === undefined) {
    sendPayoutSats = routeSend ? BigInt(actualPayoutSats) : 0n;
  }
  if (feeSats === undefined) {
    feeSats = 0n;
  }
  if (refundSats === undefined) {
    refundSats = route === 'roll'
      ? collateral - BigInt(dustCarrySats ?? 0n)
      : BigInt(computed.residualSats ?? state.residualSats ?? collateral);
  }
  if (dustCarrySats === undefined) {
    dustCarrySats = 0n;
  }
  if (rolloverCollateralSats === undefined) {
    rolloverCollateralSats = route === 'roll'
      ? collateral - BigInt(dustCarrySats)
      : (routeSettleLoss || routeSettleGain || routeSend)
        ? BigInt(refundSats)
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
    sendBps: bitsFromBigInt(sendBps, U64_BITS),
    bucketCapBps: bitsFromBigInt(bucketCapBps, U64_BITS),
    realizedPnlBps: bitsFromBigInt(realizedPnlBps, U64_BITS),
    effectivePnlBps: bitsFromBigInt(effectivePnlBps, U64_BITS),
    feeBps: bitsFromBigInt(feeBps, U64_BITS),
    flatPayoutSats: bitsFromBigInt(flatPayoutSats, U64_BITS),
    pnlPayoutSats: bitsFromBigInt(pnlPayoutSats, U64_BITS),
    sendPayoutSats: bitsFromBigInt(sendPayoutSats, U64_BITS),
    actualPayoutSats: bitsFromBigInt(actualPayoutSats, U64_BITS),
    feeSats: bitsFromBigInt(feeSats, U64_BITS),
    refundSats: bitsFromBigInt(refundSats, U64_BITS),
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
    routeRoll,
    routeSettleLoss,
    routeSettleGain,
    routeSend
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
