const platform = require('../p2p_platform');
const arbitration = require('./index');

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

function createSession() {
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
      notaryId: 'ai-arb-1',
      nostrPubkey: 'npub-ai-arb-1',
      settlementScriptPubKey: makeSpk(0xbb),
      bookingFlatFeeSats: 1000n,
      resolverFlatFeeSats: 2000n,
      resolverFeeBps: 100,
      supportedPaymentMethods: ['cash_deposit'],
      supportedRegions: ['US-NY'],
      whitelistTags: ['usd-cash-curated'],
      reputationScore: 90
    }
  ]);
  const offer = new platform.MarketOffer({
    offerId: 'arb-offer-1',
    epochId: 77n,
    sellerId: 'seller-alice',
    amountSats: 500000n,
    fiatCurrency: 'USD',
    fiatAmountMinor: 150000n,
    paymentMethod: 'cash_deposit',
    region: 'US-NY',
    sellerPayoutScriptPubKey: makeSpk(0xcc),
    buyerRefundScriptPubKey: makeSpk(0xdd)
  });

  return platform.openTradeSession({
    policy,
    registry,
    offer,
    startBlock: 910000n
  });
}

function createKeyset() {
  return {
    releasePubkey: Buffer.alloc(32, 0x11),
    refundPubkey: Buffer.alloc(32, 0x22),
    notaryPubkey: Buffer.alloc(32, 0x33)
  };
}

console.log('\n=== CivKit Arbitration Agent Tests ===\n');

test('consensus evidence allows autonomous release', () => {
  const session = createSession();
  const result = arbitration.runArbitratedTrade({
    session,
    policy: {
      policyId: 'bounded-ai-v1'
    },
    evidence: [
      {
        evidenceId: 'funding',
        kind: 'chain_funding_confirmed',
        submittedBy: 'system',
        reliabilityBps: 9800,
        summary: 'Funding tx confirmed'
      },
      {
        evidenceId: 'bank-attest',
        kind: 'open_banking_attestation',
        submittedBy: 'buyer',
        reliabilityBps: 9200,
        summary: 'Open banking attestation confirms transfer settled'
      },
      {
        evidenceId: 'seller-ack',
        kind: 'seller_ack',
        submittedBy: 'seller',
        reliabilityBps: 8500,
        summary: 'Seller acknowledged cash pick-up'
      }
    ],
    keyset: createKeyset(),
    fundingOutpoint: {
      txid: '77'.repeat(32),
      vout: 0,
      valueSats: session.offer.amountSats
    }
  });

  assertEqual(result.decisionSummary.route, 'release');
  assert(result.decisionSummary.trustedToSign, 'Expected trusted release');
  assertEqual(result.spendPackage.txTemplate.authorizationPath, 'quorum_2_of_3');
});

test('conflicting evidence forces trusted split with resolver fee', () => {
  const session = createSession();
  const result = arbitration.runArbitratedTrade({
    session,
    policy: {
      policyId: 'bounded-ai-v1',
      minDecisionConfidenceBps: 7000
    },
    evidence: [
      {
        evidenceId: 'funding',
        kind: 'chain_funding_confirmed',
        submittedBy: 'system',
        reliabilityBps: 9800,
        summary: 'Funding tx confirmed'
      },
      {
        evidenceId: 'receipt',
        kind: 'fiat_receipt_match',
        submittedBy: 'buyer',
        reliabilityBps: 7800,
        summary: 'Cash receipt uploaded'
      },
      {
        evidenceId: 'receipt-mismatch',
        kind: 'receipt_mismatch',
        submittedBy: 'seller',
        reliabilityBps: 8600,
        summary: 'Deposit slip account number mismatched'
      },
      {
        evidenceId: 'seller-denial',
        kind: 'seller_denial',
        submittedBy: 'seller',
        reliabilityBps: 8300,
        summary: 'Seller denies receipt'
      },
      {
        evidenceId: 'metadata',
        kind: 'payment_method_match',
        submittedBy: 'system',
        reliabilityBps: 7400,
        summary: 'Payment metadata still matches offer'
      }
    ],
    keyset: createKeyset(),
    fundingOutpoint: {
      txid: '88'.repeat(32),
      vout: 1,
      valueSats: session.offer.amountSats
    }
  });

  assertEqual(result.decisionSummary.route, 'split');
  assert(result.decisionSummary.trustedToSign, 'Expected trusted split');
  assertEqual(result.bitvmChallengeBundle.signerSet.notarySigned, true);
  assert(result.bitvmChallengeBundle.verification.ok, result.bitvmChallengeBundle.verification.reason);
});

test('governance policy authorizes bonded arbitrator model', () => {
  const result = arbitration.evaluateArbitratorAuthority(
    {
      arbitratorId: 'ai-arb-1',
      approved: true,
      modelVersion: 'gpt-5.4-arb',
      capabilities: ['escrow_split', 'escrow_release'],
      bondSats: 500000n
    },
    {
      policyId: 'gov-v1',
      minBondSats: 100000n,
      requiredCapabilities: ['escrow_split'],
      allowedModelVersions: ['gpt-5.4-arb']
    }
  );

  assert(result.authorized, 'Expected arbitrator to be authorized');
  assertEqual(result.missingCapabilities.length, 0);
});

test('governance policy rejects unapproved arbitrator', () => {
  const result = arbitration.evaluateArbitratorAuthority(
    {
      arbitratorId: 'ai-arb-2',
      approved: false,
      modelVersion: 'gpt-5.4-arb',
      capabilities: ['escrow_split'],
      bondSats: 500000n
    },
    {
      policyId: 'gov-v1',
      minBondSats: 100000n,
      requiredCapabilities: ['escrow_split'],
      allowedModelVersions: ['gpt-5.4-arb']
    }
  );

  assert(!result.authorized, 'Expected arbitrator to be rejected');
});

test('screenshot-only buyer release claim cannot force release', () => {
  const session = createSession();
  const result = arbitration.runArbitratedTrade({
    session,
    policy: {
      policyId: 'bounded-ai-v2',
      claimType: 'buyer_release_claim',
      minReleaseAuthenticityBps: 8000,
      minRefundAuthenticityBps: 3000,
      screenshotPenaltyBps: 2500
    },
    evidence: [
      {
        evidenceId: 'funding',
        kind: 'chain_funding_confirmed',
        submittedBy: 'system',
        reliabilityBps: 9800,
        summary: 'Funding tx confirmed'
      },
      {
        evidenceId: 'receipt-screen',
        kind: 'fiat_receipt_match',
        submittedBy: 'buyer',
        reliabilityBps: 9100,
        authenticityBps: 5000,
        evidenceFormat: 'screenshot',
        summary: 'Buyer provided bank-transfer screenshot'
      },
      {
        evidenceId: 'offer-match',
        kind: 'payment_method_match',
        submittedBy: 'system',
        reliabilityBps: 7600,
        summary: 'Trade metadata matches offer'
      },
      {
        evidenceId: 'seller-denial',
        kind: 'seller_denial',
        submittedBy: 'seller',
        reliabilityBps: 8300,
        summary: 'Seller denies receiving payment'
      }
    ],
    keyset: createKeyset(),
    fundingOutpoint: {
      txid: '99'.repeat(32),
      vout: 0,
      valueSats: session.offer.amountSats
    }
  });

  assert(result.decisionSummary.route !== 'release', 'Expected screenshot-only release claim to fail release');
  assert(
    result.decisionSummary.reasonCode.includes('authenticity') || result.decisionSummary.route === 'split',
    'Expected authenticity-driven downgrade'
  );
});

test('seller non-payment complaint can still resolve to refund with modest authenticity', () => {
  const session = createSession();
  const result = arbitration.runArbitratedTrade({
    session,
    policy: {
      policyId: 'bounded-ai-v2',
      claimType: 'seller_refund_claim',
      minReleaseAuthenticityBps: 8000,
      minRefundAuthenticityBps: 3000
    },
    evidence: [
      {
        evidenceId: 'funding',
        kind: 'chain_funding_confirmed',
        submittedBy: 'system',
        reliabilityBps: 9800,
        summary: 'Funding tx confirmed'
      },
      {
        evidenceId: 'seller-denial',
        kind: 'seller_denial',
        submittedBy: 'seller',
        reliabilityBps: 8600,
        authenticityBps: 7200,
        evidenceFormat: 'statement',
        summary: 'Seller reports no payment was received'
      },
      {
        evidenceId: 'receipt-screen',
        kind: 'unverifiable_screenshot',
        submittedBy: 'buyer',
        reliabilityBps: 6000,
        authenticityBps: 2000,
        evidenceFormat: 'screenshot',
        summary: 'Buyer sent unverifiable screenshot'
      },
      {
        evidenceId: 'receipt-mismatch',
        kind: 'receipt_mismatch',
        submittedBy: 'system',
        reliabilityBps: 8400,
        summary: 'Receipt metadata mismatched beneficiary'
      }
    ],
    keyset: createKeyset(),
    fundingOutpoint: {
      txid: 'ab'.repeat(32),
      vout: 0,
      valueSats: session.offer.amountSats
    }
  });

  assertEqual(result.decisionSummary.route, 'refund');
  assert(result.decisionSummary.averageRefundAuthenticityBps >= 3000, 'Expected refund authenticity floor to pass');
});

console.log('');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log('');

if (failed > 0) {
  process.exit(1);
}
