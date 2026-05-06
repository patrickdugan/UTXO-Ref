const referee = require('../../bitvm3/utxo_referee');
const {
  EscrowOrder,
  EscrowDecision,
  normalizeOptionalBigInt
} = require('./types');

function asEscrowOrder(orderLike) {
  return orderLike instanceof EscrowOrder ? orderLike : new EscrowOrder(orderLike);
}

function asEscrowDecision(decisionLike) {
  return decisionLike instanceof EscrowDecision
    ? decisionLike
    : new EscrowDecision(decisionLike);
}

function computeEscrowPayoutPlan(orderLike, decisionLike, options = {}) {
  const order = asEscrowOrder(orderLike);
  const decision = asEscrowDecision(decisionLike);
  const currentBlock = normalizeOptionalBigInt(options.currentBlock, 'currentBlock');

  if (
    decision.route === 'refund' &&
    order.expiryBlock != null &&
    currentBlock != null &&
    currentBlock < order.expiryBlock
  ) {
    throw new Error(`Refund locked until block ${order.expiryBlock}`);
  }

  if (decision.resolverFeeSats > 0n && order.resolverFeeScriptPubKey == null) {
    throw new Error('resolverFeeScriptPubKey is required when resolverFeeSats > 0');
  }

  const fixedServiceFees = order.fixedFeeOutputs.reduce(
    (sum, output) => sum + output.amountSats,
    0n
  );
  const fixedFees = fixedServiceFees + decision.resolverFeeSats;
  if (fixedFees > order.escrowAmountSats) {
    throw new Error('Fees exceed escrowAmountSats');
  }

  let sellerAmountSats = 0n;
  let buyerAmountSats = 0n;

  switch (decision.route) {
    case 'release':
      sellerAmountSats = order.escrowAmountSats - fixedFees;
      break;
    case 'refund':
      buyerAmountSats = order.escrowAmountSats - fixedFees;
      break;
    case 'split':
      sellerAmountSats = decision.sellerAmountSats;
      buyerAmountSats = decision.buyerAmountSats;
      break;
    default:
      throw new Error(`Unsupported escrow route: ${decision.route}`);
  }

  const payoutSum = sellerAmountSats + buyerAmountSats + fixedFees;
  if (payoutSum !== order.escrowAmountSats) {
    throw new Error(
      `Escrow conservation failed: expected ${order.escrowAmountSats} sats, got ${payoutSum} sats`
    );
  }

  const payouts = [];
  if (sellerAmountSats > 0n) {
    payouts.push({
      role: 'seller',
      recipientScriptPubKey: order.sellerPayoutScriptPubKey,
      amountSats: sellerAmountSats
    });
  }
  if (buyerAmountSats > 0n) {
    payouts.push({
      role: 'buyer',
      recipientScriptPubKey: order.buyerRefundScriptPubKey,
      amountSats: buyerAmountSats
    });
  }
  for (const fixedFee of order.fixedFeeOutputs) {
    payouts.push({
      role: fixedFee.role,
      feeId: fixedFee.feeId,
      recipientScriptPubKey: fixedFee.recipientScriptPubKey,
      amountSats: fixedFee.amountSats
    });
  }
  if (decision.resolverFeeSats > 0n) {
    payouts.push({
      role: 'resolver_fee',
      recipientScriptPubKey: order.resolverFeeScriptPubKey,
      amountSats: decision.resolverFeeSats
    });
  }

  if (payouts.length === 0) {
    throw new Error('Escrow payout plan cannot be empty');
  }

  return {
    order,
    decision,
    currentBlock,
    payouts,
    payoutSumSats: payoutSum,
    residualAmountSats: order.escrowAmountSats - payoutSum
  };
}

function buildEscrowSettlement(orderLike, decisionLike, options = {}) {
  const plan = computeEscrowPayoutPlan(orderLike, decisionLike, options);

  const leaves = plan.payouts.map((payout) => new referee.PayoutLeaf({
    epochId: plan.order.epochId,
    recipientScriptPubKey: payout.recipientScriptPubKey,
    amountSats: payout.amountSats
  }));

  const { root, proofs, tree } = referee.buildTreeWithProofs(leaves);
  const commitment = new referee.CommitmentPackage({
    epochId: plan.order.epochId,
    withdrawalRoot: root,
    capSats: plan.order.escrowAmountSats,
    residualDest: plan.order.residualDest
  });

  const sweep = new referee.SweepObject({
    epochIdCommitted: plan.order.epochId,
    payoutOutputs: plan.payouts.map((payout, index) => ({
      recipientScriptPubKey: payout.recipientScriptPubKey,
      amountSats: payout.amountSats,
      merkleProof: proofs[index]
    })),
    residualOutput: {
      recipientScriptPubKey: plan.order.residualDest,
      amountSats: plan.residualAmountSats
    }
  });

  return {
    ...plan,
    orderHash: plan.order.hash(),
    decisionHash: plan.decision.hash(),
    leaves,
    root,
    proofs,
    tree,
    commitment,
    sweep,
    verification: referee.verifySweep(commitment, sweep)
  };
}

module.exports = {
  asEscrowOrder,
  asEscrowDecision,
  computeEscrowPayoutPlan,
  buildEscrowSettlement
};
