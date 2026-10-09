const crypto = require('crypto');
const { Circuit } = require('../../bitvm3/circuit');
const { buildEscrowSettlement } = require('./projector');

const VALID_ESCROW_ROUTES = new Set(['release', 'refund', 'split', 'timeout']);
const U64_BITS = 64;

function toBigInt(value, fieldName) {
  try {
    return BigInt(value);
  } catch (error) {
    throw new Error(`${fieldName} must be convertible to BigInt`);
  }
}

function normalizeEscrowRoute(route) {
  const normalized = String(route || '').trim().toLowerCase();
  if (!VALID_ESCROW_ROUTES.has(normalized)) {
    throw new Error(`Unsupported escrow route: ${route}`);
  }
  return normalized;
}

function normalizeSignerSet(value = {}) {
  if (Array.isArray(value)) {
    const roles = new Set(value.map((role) => String(role).trim().toLowerCase()));
    return {
      buyerSigned: roles.has('buyer'),
      sellerSigned: roles.has('seller'),
      notarySigned: roles.has('notary')
    };
  }

  return {
    buyerSigned: !!value.buyerSigned,
    sellerSigned: !!value.sellerSigned,
    notarySigned: !!value.notarySigned
  };
}

function countSignerSet(signerSet) {
  return Number(!!signerSet.buyerSigned) +
    Number(!!signerSet.sellerSigned) +
    Number(!!signerSet.notarySigned);
}

function bigintToBits(value, width = U64_BITS) {
  const normalized = BigInt(value);
  const bits = [];
  for (let i = 0; i < width; i++) {
    bits.push(((normalized >> BigInt(i)) & 1n) === 1n ? 1 : 0);
  }
  return bits;
}

function boolToBit(value) {
  return value ? 1 : 0;
}

function zeroValueMap() {
  return {
    sellerAmountSats: 0n,
    buyerAmountSats: 0n,
    resolverFeeSats: 0n
  };
}

function extractTransitionAmounts(settlement) {
  const amounts = settlement.payouts.reduce((result, payout) => {
    if (payout.role === 'seller') {
      result.sellerAmountSats = BigInt(payout.amountSats);
    } else if (payout.role === 'buyer') {
      result.buyerAmountSats = BigInt(payout.amountSats);
    } else if (payout.role === 'resolver_fee') {
      result.resolverFeeSats = BigInt(payout.amountSats);
    }
    return result;
  }, zeroValueMap());

  return amounts;
}

function computeFixedFeesSum(order) {
  return order.fixedFeeOutputs.reduce(
    (sum, output) => sum + BigInt(output.amountSats),
    0n
  );
}

function deriveEscrowBitvmCommitmentHash(settlement, signerSet, route) {
  return crypto.createHash('sha256')
    .update(settlement.orderHash)
    .update(settlement.decisionHash)
    .update(settlement.commitment.hash())
    .update(Buffer.from([
      signerSet.buyerSigned ? 1 : 0,
      signerSet.sellerSigned ? 1 : 0,
      signerSet.notarySigned ? 1 : 0
    ]))
    .update(Buffer.from(String(route), 'utf8'))
    .digest();
}

function buildEscrowBitvmTransitionState(orderLike, decisionLike, options = {}) {
  const currentBlock = options.currentBlock == null
    ? null
    : toBigInt(options.currentBlock, 'currentBlock');
  const settlement = buildEscrowSettlement(orderLike, decisionLike, {
    currentBlock
  });

  const route = options.timeoutRoute
    ? 'timeout'
    : normalizeEscrowRoute(settlement.decision.route);
  if (route === 'timeout' && settlement.decision.route !== 'refund') {
    throw new Error('timeout route only applies to refund decisions');
  }

  const signerSet = normalizeSignerSet(options.signerSet || options.signers || {});
  const amounts = extractTransitionAmounts(settlement);
  const fixedFeesSumSats = computeFixedFeesSum(settlement.order);

  const transitionState = {
    route,
    escrowAmountSats: BigInt(settlement.order.escrowAmountSats),
    fixedFeesSumSats,
    sellerAmountSats: amounts.sellerAmountSats,
    buyerAmountSats: amounts.buyerAmountSats,
    resolverFeeSats: amounts.resolverFeeSats,
    expiryBlock: settlement.order.expiryBlock == null ? 0n : BigInt(settlement.order.expiryBlock),
    currentBlock: currentBlock == null ? 0n : currentBlock,
    signerSet,
    signerCount: countSignerSet(signerSet),
    threshold: 2,
    orderHashHex: settlement.orderHash.toString('hex'),
    decisionHashHex: settlement.decisionHash.toString('hex'),
    settlementCommitmentHashHex: settlement.commitment.hash().toString('hex'),
    splitRequiresNotary: !!options.splitRequiresNotary,
    settlement
  };

  transitionState.transitionCommitmentHash = deriveEscrowBitvmCommitmentHash(
    settlement,
    signerSet,
    route
  );
  transitionState.transitionCommitmentHashHex = transitionState.transitionCommitmentHash.toString('hex');

  return transitionState;
}

function verifyEscrowBitvmTransition(stateLike, options = {}) {
  const route = normalizeEscrowRoute(stateLike.route);
  const escrowAmountSats = toBigInt(stateLike.escrowAmountSats, 'escrowAmountSats');
  const fixedFeesSumSats = toBigInt(stateLike.fixedFeesSumSats, 'fixedFeesSumSats');
  const sellerAmountSats = toBigInt(stateLike.sellerAmountSats, 'sellerAmountSats');
  const buyerAmountSats = toBigInt(stateLike.buyerAmountSats, 'buyerAmountSats');
  const resolverFeeSats = toBigInt(stateLike.resolverFeeSats, 'resolverFeeSats');
  const expiryBlock = toBigInt(stateLike.expiryBlock ?? 0n, 'expiryBlock');
  const currentBlock = toBigInt(stateLike.currentBlock ?? 0n, 'currentBlock');
  const signerSet = normalizeSignerSet(stateLike.signerSet);
  const splitRequiresNotary = options.splitRequiresNotary ?? stateLike.splitRequiresNotary ?? false;

  if (fixedFeesSumSats > escrowAmountSats) {
    return {
      ok: false,
      reason: `fixedFeesSumSats exceeds escrowAmountSats: ${fixedFeesSumSats} > ${escrowAmountSats}`
    };
  }

  const signerQuorum = countSignerSet(signerSet) >= 2;
  if (route !== 'timeout' && !signerQuorum) {
    return {
      ok: false,
      reason: 'Signer quorum failed: expected at least 2 of buyer/seller/notary'
    };
  }

  if (route === 'split' && splitRequiresNotary && !signerSet.notarySigned) {
    return {
      ok: false,
      reason: 'Split route requires notary signature'
    };
  }

  const fixedOnlyRemainder = escrowAmountSats - fixedFeesSumSats;

  if (route === 'release') {
    if (sellerAmountSats !== fixedOnlyRemainder || buyerAmountSats !== 0n || resolverFeeSats !== 0n) {
      return {
        ok: false,
        reason: 'Release route amounts do not match escrow - fixed fees'
      };
    }
  } else if (route === 'refund') {
    if (buyerAmountSats !== fixedOnlyRemainder || sellerAmountSats !== 0n || resolverFeeSats !== 0n) {
      return {
        ok: false,
        reason: 'Refund route amounts do not match escrow - fixed fees'
      };
    }
  } else if (route === 'split') {
    const total = sellerAmountSats + buyerAmountSats + fixedFeesSumSats + resolverFeeSats;
    if (total !== escrowAmountSats) {
      return {
        ok: false,
        reason: `Split route conservation failed: ${total} != ${escrowAmountSats}`
      };
    }
  } else if (route === 'timeout') {
    if (expiryBlock === 0n) {
      return {
        ok: false,
        reason: 'Timeout route requires expiryBlock'
      };
    }
    if (currentBlock < expiryBlock) {
      return {
        ok: false,
        reason: `Timeout route not yet mature: currentBlock ${currentBlock} < expiryBlock ${expiryBlock}`
      };
    }
    if (!signerSet.buyerSigned) {
      return {
        ok: false,
        reason: 'Timeout route requires buyer signature'
      };
    }
    if (buyerAmountSats !== fixedOnlyRemainder || sellerAmountSats !== 0n || resolverFeeSats !== 0n) {
      return {
        ok: false,
        reason: 'Timeout route amounts do not match escrow - fixed fees'
      };
    }
  }

  return { ok: true };
}

class EscrowBitvmTransitionCircuit {
  constructor(options = {}) {
    this.bitWidth = options.bitWidth || U64_BITS;
    this.splitRequiresNotary = !!options.splitRequiresNotary;
    this.circuit = new Circuit('civkit_escrow_transition');
  }

  build() {
    const c = this.circuit;
    const n = this.bitWidth;

    const escrowAmountSats = c.addInput(n, 'escrowAmountSats');
    const fixedFeesSumSats = c.addInput(n, 'fixedFeesSumSats');
    const sellerAmountSats = c.addInput(n, 'sellerAmountSats');
    const buyerAmountSats = c.addInput(n, 'buyerAmountSats');
    const resolverFeeSats = c.addInput(n, 'resolverFeeSats');
    const expiryBlock = c.addInput(n, 'expiryBlock');
    const currentBlock = c.addInput(n, 'currentBlock');

    const routeRelease = c.addInputScalar('routeRelease');
    const routeRefund = c.addInputScalar('routeRefund');
    const routeSplit = c.addInputScalar('routeSplit');
    const routeTimeout = c.addInputScalar('routeTimeout');

    const buyerSigned = c.addInputScalar('buyerSigned');
    const sellerSigned = c.addInputScalar('sellerSigned');
    const notarySigned = c.addInputScalar('notarySigned');

    const implies = (premise, consequence) => c.or(c.inv(premise), consequence);
    const zeroBits = c.constantBits(0, n);

    const routeBits = [routeRelease, routeRefund, routeSplit, routeTimeout];
    let pairwiseCollision = c.zero();
    for (let i = 0; i < routeBits.length; i++) {
      for (let j = i + 1; j < routeBits.length; j++) {
        pairwiseCollision = c.or(pairwiseCollision, c.and(routeBits[i], routeBits[j]));
      }
    }
    const anyRoute = routeBits.reduce((acc, bit) => c.or(acc, bit), c.zero());
    const routeValid = c.and(c.inv(pairwiseCollision), c.inv(c.xor(anyRoute, c.one())));

    const signerQuorum = c.or(
      c.or(c.and(buyerSigned, sellerSigned), c.and(buyerSigned, notarySigned)),
      c.and(sellerSigned, notarySigned)
    );

    const escrowMinusFixed = c.subN(escrowAmountSats, fixedFeesSumSats);
    const releaseValid = c.and(
      c.eqN(sellerAmountSats, escrowMinusFixed),
      c.and(c.eqN(buyerAmountSats, zeroBits), c.eqN(resolverFeeSats, zeroBits))
    );
    const refundValid = c.and(
      c.eqN(buyerAmountSats, escrowMinusFixed),
      c.and(c.eqN(sellerAmountSats, zeroBits), c.eqN(resolverFeeSats, zeroBits))
    );

    const splitSum = c.addN(
      c.addN(sellerAmountSats, buyerAmountSats).sum,
      c.addN(fixedFeesSumSats, resolverFeeSats).sum
    ).sum;
    const splitValid = c.eqN(splitSum, escrowAmountSats);

    const timeoutMature = c.inv(c.ltN(currentBlock, expiryBlock));
    const timeoutValid = c.and(
      refundValid,
      c.and(timeoutMature, buyerSigned)
    );

    const nonTimeoutRoute = c.or(c.or(routeRelease, routeRefund), routeSplit);

    let valid = routeValid;
    valid = c.and(valid, implies(nonTimeoutRoute, signerQuorum));
    valid = c.and(valid, implies(routeRelease, releaseValid));
    valid = c.and(valid, implies(routeRefund, refundValid));
    valid = c.and(valid, implies(routeSplit, splitValid));
    valid = c.and(valid, implies(routeTimeout, timeoutValid));

    if (this.splitRequiresNotary) {
      valid = c.and(valid, implies(routeSplit, notarySigned));
    }

    c.setOutputs([valid]);

    return {
      circuit: c,
      inputs: {
        escrowAmountSats,
        fixedFeesSumSats,
        sellerAmountSats,
        buyerAmountSats,
        resolverFeeSats,
        expiryBlock,
        currentBlock,
        routeRelease,
        routeRefund,
        routeSplit,
        routeTimeout,
        buyerSigned,
        sellerSigned,
        notarySigned
      }
    };
  }

  getStats() {
    return this.circuit.getStats();
  }

  toBristol() {
    return this.circuit.toBristol();
  }
}

function generateEscrowBitvmCircuit(options = {}) {
  const built = new EscrowBitvmTransitionCircuit(options);
  const result = built.build();
  return {
    ...result,
    stats: built.getStats(),
    bristol: built.toBristol()
  };
}

function toEscrowBitvmWitness(stateLike) {
  const signerSet = normalizeSignerSet(stateLike.signerSet);
  const route = normalizeEscrowRoute(stateLike.route);

  return {
    escrowAmountSats: bigintToBits(stateLike.escrowAmountSats),
    fixedFeesSumSats: bigintToBits(stateLike.fixedFeesSumSats),
    sellerAmountSats: bigintToBits(stateLike.sellerAmountSats),
    buyerAmountSats: bigintToBits(stateLike.buyerAmountSats),
    resolverFeeSats: bigintToBits(stateLike.resolverFeeSats),
    expiryBlock: bigintToBits(stateLike.expiryBlock ?? 0n),
    currentBlock: bigintToBits(stateLike.currentBlock ?? 0n),
    routeRelease: boolToBit(route === 'release'),
    routeRefund: boolToBit(route === 'refund'),
    routeSplit: boolToBit(route === 'split'),
    routeTimeout: boolToBit(route === 'timeout'),
    buyerSigned: boolToBit(signerSet.buyerSigned),
    sellerSigned: boolToBit(signerSet.sellerSigned),
    notarySigned: boolToBit(signerSet.notarySigned)
  };
}

function buildEscrowBitvmChallengeBundle(orderLike, decisionLike, options = {}) {
  const transitionState = buildEscrowBitvmTransitionState(orderLike, decisionLike, options);
  const verification = verifyEscrowBitvmTransition(transitionState, options);

  return {
    route: transitionState.route,
    signerSet: transitionState.signerSet,
    threshold: transitionState.threshold,
    verification,
    binding: {
      orderHashHex: transitionState.orderHashHex,
      decisionHashHex: transitionState.decisionHashHex,
      settlementCommitmentHashHex: transitionState.settlementCommitmentHashHex,
      transitionCommitmentHashHex: transitionState.transitionCommitmentHashHex
    },
    transitionState: {
      route: transitionState.route,
      escrowAmountSats: transitionState.escrowAmountSats.toString(),
      fixedFeesSumSats: transitionState.fixedFeesSumSats.toString(),
      sellerAmountSats: transitionState.sellerAmountSats.toString(),
      buyerAmountSats: transitionState.buyerAmountSats.toString(),
      resolverFeeSats: transitionState.resolverFeeSats.toString(),
      expiryBlock: transitionState.expiryBlock.toString(),
      currentBlock: transitionState.currentBlock.toString(),
      signerSet: transitionState.signerSet,
      splitRequiresNotary: transitionState.splitRequiresNotary
    },
    transitionWitness: toEscrowBitvmWitness(transitionState),
    settlement: transitionState.settlement
  };
}

module.exports = {
  VALID_ESCROW_ROUTES,
  normalizeEscrowRoute,
  normalizeSignerSet,
  buildEscrowBitvmTransitionState,
  verifyEscrowBitvmTransition,
  EscrowBitvmTransitionCircuit,
  generateEscrowBitvmCircuit,
  toEscrowBitvmWitness,
  buildEscrowBitvmChallengeBundle
};
