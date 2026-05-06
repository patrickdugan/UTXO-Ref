const platform = require('./index');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`FAIL ${name}`);
    console.log(`  ${error.message}`);
    failed += 1;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function makeSpk(byte) {
  return Buffer.concat([Buffer.from([0x00, 0x14]), Buffer.alloc(20, byte)]);
}

function createPolicy(overrides = {}) {
  return new platform.MarketplacePolicy({
    policyId: 'civil-us-cash',
    platformFeeScriptPubKey: makeSpk(0xaa),
    platformFeeBps: 50,
    platformFlatFeeSats: 500n,
    escrowExpiryBlocks: 72n,
    requiredWhitelistTag: 'usd-cash-curated',
    minNotaryReputation: 70,
    maxResolverFeeBps: 300,
    allowedPaymentMethods: ['cash_deposit'],
    allowedRegions: ['US-NY'],
    ...overrides
  });
}

function createRegistry() {
  return new platform.NotaryRegistry([
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
      bookingFlatFeeSats: 800n,
      resolverFlatFeeSats: 1500n,
      resolverFeeBps: 80,
      supportedPaymentMethods: ['cash_deposit'],
      supportedRegions: ['US-NY'],
      whitelistTags: ['usd-cash-curated'],
      reputationScore: 80
    },
    {
      notaryId: 'notary-wrong-region',
      nostrPubkey: 'npub-wrong-region',
      settlementScriptPubKey: makeSpk(0xbd),
      bookingFlatFeeSats: 100n,
      resolverFlatFeeSats: 100n,
      resolverFeeBps: 10,
      supportedPaymentMethods: ['cash_deposit'],
      supportedRegions: ['US-TX'],
      whitelistTags: ['usd-cash-curated'],
      reputationScore: 99
    }
  ]);
}

function createOffer(overrides = {}) {
  return new platform.MarketOffer({
    offerId: 'offer-1',
    epochId: 91n,
    sellerId: 'seller-alice',
    amountSats: 500000n,
    fiatCurrency: 'USD',
    fiatAmountMinor: 150000n,
    paymentMethod: 'cash_deposit',
    region: 'US-NY',
    sellerPayoutScriptPubKey: makeSpk(0xcc),
    buyerRefundScriptPubKey: makeSpk(0xdd),
    ...overrides
  });
}

console.log('\n=== CivKit P2P Platform Tests ===\n');

test('registry selects lowest-fee eligible curated notary', () => {
  const registry = createRegistry();
  const selection = registry.chooseNotary(createPolicy(), createOffer());

  assertEqual(selection.profile.notaryId, 'notary-east-2');
});

test('preferred notary is honored when eligible', () => {
  const registry = createRegistry();
  const session = platform.openTradeSession({
    policy: createPolicy(),
    registry,
    offer: createOffer({
      preferredNotaryIds: ['notary-east-1']
    }),
    startBlock: 900000n
  });

  assertEqual(session.notary.notaryId, 'notary-east-1');
});

test('trade session creates separate platform and booking fee outputs', () => {
  const session = platform.openTradeSession({
    policy: createPolicy(),
    registry: createRegistry(),
    offer: createOffer(),
    startBlock: 900000n
  });

  assertEqual(session.escrowOrder.fixedFeeOutputs.length, 2);
  assertEqual(session.escrowOrder.fixedFeeOutputs[0].role, 'platform_fee');
  assertEqual(session.escrowOrder.fixedFeeOutputs[1].role, 'notary_booking_fee');
  assertEqual(session.expiryBlock, 900072n);
  assertEqual(session.authorizationMode, 'threshold_2_of_3');
});

test('trade spend package defaults to threshold 2-of-3 authorization', () => {
  const session = platform.openTradeSession({
    policy: createPolicy(),
    registry: createRegistry(),
    offer: createOffer(),
    startBlock: 900000n
  });

  const spendPackage = platform.buildTradeSpendPackage(session, {
    route: 'release',
    decisionId: 'release-spend-package'
  }, {
    keyset: {
      releasePubkey: Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 0x11)]),
      refundPubkey: Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 0x22)]),
      notaryPubkey: Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 0x33)])
    },
    fundingOutpoint: {
      txid: '66'.repeat(32),
      vout: 0,
      valueSats: session.offer.amountSats
    },
    network: 'regtest'
  });

  assertEqual(spendPackage.txTemplate.authorizationPath, 'quorum_2_of_3');
  assertEqual(spendPackage.commitmentType, 'transition');
  assertEqual(spendPackage.authorization.witnessPlan.witnessStack[0], 'OP_0');
  assertEqual(spendPackage.authorization.witnessPlan.witnessStack[1], 'buyer_signature');
  assertEqual(spendPackage.authorization.witnessPlan.witnessStack[2], 'seller_signature');
  assertEqual(
    spendPackage.binding.selectedCommitmentHashHex,
    spendPackage.binding.transitionCommitmentHashHex
  );
});

test('trade BitVM challenge bundle defaults to cooperative quorum for release', () => {
  const session = platform.openTradeSession({
    policy: createPolicy(),
    registry: createRegistry(),
    offer: createOffer(),
    startBlock: 900000n
  });

  const challengeBundle = platform.buildTradeBitvmChallengeBundle(session, {
    route: 'release',
    decisionId: 'release-challenge-bundle'
  });

  assert(challengeBundle.verification.ok, challengeBundle.verification.reason);
  assertEqual(challengeBundle.signerSet.buyerSigned, true);
  assertEqual(challengeBundle.signerSet.sellerSigned, true);
  assertEqual(challengeBundle.signerSet.notarySigned, false);
});

test('release settlement verifies against escrow projection', () => {
  const session = platform.openTradeSession({
    policy: createPolicy(),
    registry: createRegistry(),
    offer: createOffer(),
    startBlock: 900000n
  });
  const release = platform.planReleaseSettlement(session);

  assert(release.result.ok, release.result.reason);
  assertEqual(release.result.settlement.payouts[0].role, 'seller');
  assertEqual(release.result.settlement.payouts[1].role, 'platform_fee');
  assertEqual(release.result.settlement.payouts[2].role, 'notary_booking_fee');
});

test('split settlement pays resolver fee to selected notary', () => {
  const session = platform.openTradeSession({
    policy: createPolicy(),
    registry: createRegistry(),
    offer: createOffer(),
    startBlock: 900000n
  });
  const buyerAmountSats = 50000n;
  const sellerAmountSats =
    session.offer.amountSats -
    session.feeQuote.platformFeeSats -
    session.feeQuote.bookingFeeSats -
    session.feeQuote.resolverFeeSats -
    buyerAmountSats;
  const split = platform.planSplitSettlement(session, {
    sellerAmountSats,
    buyerAmountSats,
    resolverFeeSats: session.feeQuote.resolverFeeSats
  });

  assert(split.result.ok, split.result.reason);
  assertEqual(split.result.settlement.payouts[4].role, 'resolver_fee');
  assert(
    split.result.settlement.payouts[4].recipientScriptPubKey.equals(session.notary.settlementScriptPubKey),
    'Resolver fee should go to selected notary'
  );
});

test('refund before expiry fails', () => {
  const session = platform.openTradeSession({
    policy: createPolicy(),
    registry: createRegistry(),
    offer: createOffer(),
    startBlock: 900000n
  });
  const refund = platform.planRefundSettlement(session, {
    currentBlock: 900010n
  });

  assert(!refund.result.ok, 'Expected refund to fail');
  assert(
    refund.result.reason.includes('Refund locked until block 900072'),
    `Wrong reason: ${refund.result.reason}`
  );
});

test('no eligible notary fails clearly', () => {
  const registry = createRegistry();

  let error = null;
  try {
    platform.openTradeSession({
      policy: createPolicy({
        allowedRegions: ['US-FL']
      }),
      registry,
      offer: createOffer(),
      startBlock: 900000n
    });
  } catch (caught) {
    error = caught;
  }

  assert(error != null, 'Expected session creation to throw');
  assert(error.message.includes('No eligible curated notaries found'), `Wrong error: ${error.message}`);
});

console.log('');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log('');

if (failed > 0) {
  process.exit(1);
}
