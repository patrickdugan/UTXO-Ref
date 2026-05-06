const types = require('./types');
const fees = require('./fees');
const registry = require('./registry');
const workflow = require('./workflow');

module.exports = {
  MarketplacePolicy: types.MarketplacePolicy,
  NotaryProfile: types.NotaryProfile,
  MarketOffer: types.MarketOffer,
  feeFromBps: fees.feeFromBps,
  quotePlatformFee: fees.quotePlatformFee,
  quoteNotaryFees: fees.quoteNotaryFees,
  NotaryRegistry: registry.NotaryRegistry,
  openTradeSession: workflow.openTradeSession,
  deriveTradeSignerSet: workflow.deriveTradeSignerSet,
  resolveTradeSignerSet: workflow.resolveTradeSignerSet,
  buildTradeSpendPackage: workflow.buildTradeSpendPackage,
  buildTradeBitvmChallengeBundle: workflow.buildTradeBitvmChallengeBundle,
  verifyTradeSettlement: workflow.verifyTradeSettlement,
  planReleaseSettlement: workflow.planReleaseSettlement,
  planRefundSettlement: workflow.planRefundSettlement,
  planSplitSettlement: workflow.planSplitSettlement,
  types,
  fees,
  registry,
  workflow
};
