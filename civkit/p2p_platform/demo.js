const platform = require('./index');

function makeSpk(byte) {
  return Buffer.concat([Buffer.from([0x00, 0x14]), Buffer.alloc(20, byte)]);
}

function summarizePayouts(settlement) {
  return settlement.payouts.map((payout) => `${payout.role}:${payout.amountSats}`).join(', ');
}

console.log('=== CivKit P2P Platform Demo ===\n');

const policy = new platform.MarketplacePolicy({
  policyId: 'civil-us-cash',
  platformFeeScriptPubKey: makeSpk(0xaa),
  platformFeeBps: 50,
  platformFlatFeeSats: 500n,
  escrowExpiryBlocks: 72n,
  requiredWhitelistTag: 'usd-cash-curated',
  minNotaryReputation: 70,
  maxResolverFeeBps: 300,
  allowedPaymentMethods: ['cash_deposit'],
  allowedRegions: ['US-NY']
});

const registry = new platform.NotaryRegistry([
  {
    notaryId: 'notary-east-1',
    nostrPubkey: 'npub-east-1',
    settlementScriptPubKey: makeSpk(0xbb),
    bookingFlatFeeSats: 1200n,
    resolverFlatFeeSats: 2000n,
    resolverFeeBps: 100,
    supportedPaymentMethods: ['cash_deposit'],
    supportedRegions: ['US-NY'],
    whitelistTags: ['usd-cash-curated'],
    reputationScore: 92
  },
  {
    notaryId: 'notary-east-2',
    nostrPubkey: 'npub-east-2',
    settlementScriptPubKey: makeSpk(0xbc),
    bookingFlatFeeSats: 900n,
    resolverFlatFeeSats: 2600n,
    resolverFeeBps: 120,
    supportedPaymentMethods: ['cash_deposit'],
    supportedRegions: ['US-NY'],
    whitelistTags: ['usd-cash-curated'],
    reputationScore: 88
  }
]);

const offer = new platform.MarketOffer({
  offerId: 'offer-nyc-1',
  epochId: 77n,
  sellerId: 'seller-alice',
  amountSats: 500000n,
  fiatCurrency: 'USD',
  fiatAmountMinor: 150000n,
  paymentMethod: 'cash_deposit',
  region: 'US-NY',
  sellerPayoutScriptPubKey: makeSpk(0xcc),
  buyerRefundScriptPubKey: makeSpk(0xdd),
  preferredNotaryIds: ['notary-east-1']
});

const session = platform.openTradeSession({
  policy,
  registry,
  offer,
  startBlock: 900000n
});

console.log(`tradeId: ${session.tradeId}`);
console.log(`selected notary: ${session.notary.notaryId}`);
console.log(`expiry block: ${session.expiryBlock}`);
console.log(
  `fees: platform=${session.feeQuote.platformFeeSats}, booking=${session.feeQuote.bookingFeeSats}, resolver=${session.feeQuote.resolverFeeSats}`
);
console.log('');

const release = platform.planReleaseSettlement(session);
console.log('Release route:');
console.log(`  ok: ${release.result.ok}`);
console.log(`  payouts: ${summarizePayouts(release.result.settlement)}`);
console.log('');

const splitBuyerAmountSats = 50000n;
const splitSellerAmountSats =
  session.offer.amountSats -
  session.feeQuote.platformFeeSats -
  session.feeQuote.bookingFeeSats -
  session.feeQuote.resolverFeeSats -
  splitBuyerAmountSats;
const split = platform.planSplitSettlement(session, {
  sellerAmountSats: splitSellerAmountSats,
  buyerAmountSats: splitBuyerAmountSats,
  resolverFeeSats: session.feeQuote.resolverFeeSats,
  decisionId: 'dispute-nyc-1'
});
console.log('Split route:');
console.log(`  ok: ${split.result.ok}`);
console.log(`  payouts: ${split.result.ok ? summarizePayouts(split.result.settlement) : split.result.reason}`);
console.log('');

const refund = platform.planRefundSettlement(session, {
  currentBlock: 900080n
});
console.log('Refund route after expiry:');
console.log(`  ok: ${refund.result.ok}`);
console.log(`  payouts: ${summarizePayouts(refund.result.settlement)}`);
