const platform = require('../p2p_platform');
const agent = require('./index');

function makeSpk(byte) {
  return Buffer.concat([Buffer.from([0x00, 0x14]), Buffer.alloc(20, byte)]);
}

function makeXOnlyPriv(byte) {
  return Buffer.alloc(32, byte).toString('hex');
}

const marketKey = makeXOnlyPriv(0x11);
const notaryKey = makeXOnlyPriv(0x22);
const settlementKey = makeXOnlyPriv(0x33);

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
    nostrPubkey: agent.derivePubkeyHex(notaryKey),
    settlementScriptPubKey: makeSpk(0xbb),
    bookingFlatFeeSats: 1200n,
    resolverFlatFeeSats: 2000n,
    resolverFeeBps: 100,
    supportedPaymentMethods: ['cash_deposit'],
    supportedRegions: ['US-NY'],
    whitelistTags: ['usd-cash-curated'],
    reputationScore: 92
  }
]);

const offer = new platform.MarketOffer({
  offerId: 'offer-agent-1',
  epochId: 88n,
  sellerId: 'seller-alice',
  amountSats: 500000n,
  fiatCurrency: 'USD',
  fiatAmountMinor: 150000n,
  paymentMethod: 'cash_deposit',
  region: 'US-NY',
  sellerPayoutScriptPubKey: makeSpk(0xcc),
  buyerRefundScriptPubKey: makeSpk(0xdd)
});

const session = platform.openTradeSession({
  policy,
  registry,
  offer,
  startBlock: 910000n
});

const offerEvent = agent.buildManagedOfferEvent({
  privateKeyHex: marketKey,
  policy,
  offer,
  threadId: session.tradeId
});
const assignmentEvent = agent.buildNotaryAssignmentEvent({
  privateKeyHex: notaryKey,
  session
});
const buyerAmountSats = 50000n;
const sellerAmountSats =
  session.offer.amountSats -
  session.feeQuote.platformFeeSats -
  session.feeQuote.bookingFeeSats -
  session.feeQuote.resolverFeeSats -
  buyerAmountSats;
const decisionEvent = agent.buildSettlementDecisionEvent({
  privateKeyHex: settlementKey,
  session,
  decisionLike: {
    route: 'split',
    sellerAmountSats,
    buyerAmountSats,
    resolverFeeSats: session.feeQuote.resolverFeeSats,
    decisionId: 'agent-split-1'
  },
  keyset: {
    releasePubkey: agent.derivePubkeyHex(makeXOnlyPriv(0x44)),
    refundPubkey: agent.derivePubkeyHex(makeXOnlyPriv(0x55)),
    notaryPubkey: agent.derivePubkeyHex(makeXOnlyPriv(0x66))
  },
  fundingOutpoint: {
    txid: '44'.repeat(32),
    vout: 0,
    valueSats: session.offer.amountSats
  },
  network: 'regtest'
});

const reduced = agent.reduceManagedTradeEvents([
  offerEvent,
  assignmentEvent,
  decisionEvent
]);

console.log('=== CivKit Nostr Agent Demo ===\n');
console.log(`threadId: ${session.tradeId}`);
console.log(`offer verified: ${agent.verifyEvent(offerEvent)}`);
console.log(`assignment verified: ${agent.verifyEvent(assignmentEvent)}`);
console.log(`decision verified: ${agent.verifyEvent(decisionEvent)}`);
console.log(`phase: ${reduced.phase}`);
console.log(`decision route: ${decisionEvent.content.includes('"route":"split"') ? 'split' : 'unknown'}`);
console.log(`derived tasks: ${reduced.derivedTasks.map((task) => `${task.role}:${task.action}`).join(', ')}`);
