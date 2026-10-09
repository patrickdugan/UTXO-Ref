const platform = require('../p2p_platform');
const agent = require('./index');
const fs = require('fs');
const path = require('path');

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

function makePrivateKey(byte) {
  return Buffer.alloc(32, byte).toString('hex');
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
      notaryId: 'notary-east-1',
      nostrPubkey: agent.derivePubkeyHex(makePrivateKey(0x22)),
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

  return {
    policy,
    offer,
    session: platform.openTradeSession({
      policy,
      registry,
      offer,
      startBlock: 910000n
    })
  };
}

console.log('\n=== CivKit Nostr Agent Tests ===\n');

test('signed managed offer event verifies', () => {
  const { policy, offer, session } = createSession();
  const event = agent.buildManagedOfferEvent({
    privateKeyHex: makePrivateKey(0x11),
    policy,
    offer,
    threadId: session.tradeId
  });

  assert(agent.verifyEvent(event), 'Expected valid signed event');
});

test('settlement decision event carries taproot and tx package', () => {
  const { session } = createSession();
  const buyerAmountSats = 50000n;
  const sellerAmountSats =
    session.offer.amountSats -
    session.feeQuote.platformFeeSats -
    session.feeQuote.bookingFeeSats -
    session.feeQuote.resolverFeeSats -
    buyerAmountSats;
  const decisionEvent = agent.buildSettlementDecisionEvent({
    privateKeyHex: makePrivateKey(0x33),
    session,
    decisionLike: {
      route: 'split',
      sellerAmountSats,
      buyerAmountSats,
      resolverFeeSats: session.feeQuote.resolverFeeSats,
      decisionId: 'agent-split-1'
    },
    keyset: {
      releasePubkey: agent.derivePubkeyHex(makePrivateKey(0x44)),
      refundPubkey: agent.derivePubkeyHex(makePrivateKey(0x55)),
      notaryPubkey: agent.derivePubkeyHex(makePrivateKey(0x66))
    },
    fundingOutpoint: {
      txid: '44'.repeat(32),
      vout: 0,
      valueSats: session.offer.amountSats
    },
    network: 'regtest'
  });

  assert(agent.verifyEvent(decisionEvent), 'Decision event should verify');
  const content = JSON.parse(decisionEvent.content);
  assertEqual(content.authorizationMode, 'threshold_2_of_3');
  assertEqual(content.authorizationPath, 'quorum_2_of_3');
  assertEqual(content.commitmentType, 'transition');
  assertEqual(content.signerSet.buyerSigned, true);
  assertEqual(content.signerSet.sellerSigned, false);
  assertEqual(content.signerSet.notarySigned, true);
  assertEqual(content.authorization.witnessPlan.witnessStack[0], 'notary_signature');
  assertEqual(content.authorization.witnessPlan.witnessStack[1], 'buyer_signature');
  assertEqual(content.authorization.witnessPlan.witnessStack[2], 'OP_0');
  assertEqual(content.binding.selectedCommitmentHashHex, content.bitvmTransitionCommitmentHash);
  assert(content.bitvmChallenge.verification.ok, 'Expected valid BitVM transition');
  assert(
    typeof content.bitvmTransitionCommitmentHash === 'string' &&
      content.bitvmTransitionCommitmentHash.length === 64,
    'Expected transition commitment hash'
  );
  assert(content.taprootAddress.startsWith('bcrt1p'), 'Expected regtest taproot address');
  assert(typeof content.txHex === 'string' && content.txHex.length > 0, 'Expected txHex');
});

test('trade reducer derives follow-up tasks from signed events', () => {
  const { policy, offer, session } = createSession();
  const offerEvent = agent.buildManagedOfferEvent({
    privateKeyHex: makePrivateKey(0x11),
    policy,
    offer,
    threadId: session.tradeId
  });
  const assignmentEvent = agent.buildNotaryAssignmentEvent({
    privateKeyHex: makePrivateKey(0x22),
    session
  });
  const releaseEvent = agent.buildSettlementDecisionEvent({
    privateKeyHex: makePrivateKey(0x33),
    session,
    decisionLike: {
      route: 'release',
      decisionId: 'release-agent'
    },
    keyset: {
      releasePubkey: agent.derivePubkeyHex(makePrivateKey(0x44)),
      refundPubkey: agent.derivePubkeyHex(makePrivateKey(0x55)),
      notaryPubkey: agent.derivePubkeyHex(makePrivateKey(0x66))
    },
    fundingOutpoint: {
      txid: '55'.repeat(32),
      vout: 1,
      valueSats: session.offer.amountSats
    },
    network: 'regtest'
  });

  const reduced = agent.reduceManagedTradeEvents([
    offerEvent,
    assignmentEvent,
    releaseEvent
  ]);

  assertEqual(reduced.phase, 'decision_ready');
  assertEqual(reduced.derivedTasks[0].role, agent.AGENT_ROLES.signing);
  assertEqual(reduced.derivedTasks[0].action, 'collect_quorum_2_of_3_signatures');
});

test('evidence and appeal events move thread into appeal state', () => {
  const { policy, offer, session } = createSession();
  const offerEvent = agent.buildManagedOfferEvent({
    privateKeyHex: makePrivateKey(0x11),
    policy,
    offer,
    threadId: session.tradeId
  });
  const assignmentEvent = agent.buildNotaryAssignmentEvent({
    privateKeyHex: makePrivateKey(0x22),
    session
  });
  const evidenceEvent = agent.buildEvidenceSubmissionEvent({
    privateKeyHex: makePrivateKey(0x44),
    threadId: session.tradeId,
    evidence: {
      kind: 'fiat_receipt_match',
      summary: 'Receipt uploaded'
    },
    evidenceHashHex: 'aa'.repeat(32),
    submittedBy: 'buyer'
  });
  const decisionEvent = agent.buildSettlementDecisionEvent({
    privateKeyHex: makePrivateKey(0x33),
    session,
    decisionLike: {
      route: 'release',
      decisionId: 'release-agent'
    },
    keyset: {
      releasePubkey: agent.derivePubkeyHex(makePrivateKey(0x44)),
      refundPubkey: agent.derivePubkeyHex(makePrivateKey(0x55)),
      notaryPubkey: agent.derivePubkeyHex(makePrivateKey(0x66))
    },
    fundingOutpoint: {
      txid: '55'.repeat(32),
      vout: 1,
      valueSats: session.offer.amountSats
    },
    network: 'regtest'
  });
  const appealEvent = agent.buildAppealRequestEvent({
    privateKeyHex: makePrivateKey(0x77),
    threadId: session.tradeId,
    decisionEvent,
    reasonCode: 'seller_contests_receipt',
    requestedBy: 'seller'
  });

  const reduced = agent.reduceManagedTradeEvents([
    offerEvent,
    assignmentEvent,
    evidenceEvent,
    decisionEvent,
    appealEvent
  ]);

  assertEqual(reduced.phase, 'appeal_pending');
  assertEqual(reduced.evidence.length, 1);
  assertEqual(reduced.appeal.content.status, 'pending');
});

test('local event store persists threads and signer runtime', () => {
  const tempDir = path.join(__dirname, 'artifacts', 'test_store');
  const eventsPath = path.join(tempDir, 'events.jsonl');
  const relayStatePath = path.join(tempDir, 'relay_state.json');
  fs.rmSync(tempDir, { recursive: true, force: true });

  const { policy, offer, session } = createSession();
  const store = new agent.LocalEventStore({ eventsPath, relayStatePath });
  store.append(agent.buildManagedOfferEvent({
    privateKeyHex: makePrivateKey(0x11),
    policy,
    offer,
    threadId: session.tradeId
  }));
  store.append(agent.buildNotaryAssignmentEvent({
    privateKeyHex: makePrivateKey(0x22),
    session
  }));
  store.append(agent.buildSettlementDecisionEvent({
    privateKeyHex: makePrivateKey(0x33),
    session,
    decisionLike: {
      route: 'release',
      decisionId: 'release-agent'
    },
    keyset: {
      releasePubkey: agent.derivePubkeyHex(makePrivateKey(0x44)),
      refundPubkey: agent.derivePubkeyHex(makePrivateKey(0x55)),
      notaryPubkey: agent.derivePubkeyHex(makePrivateKey(0x66))
    },
    fundingOutpoint: {
      txid: '66'.repeat(32),
      vout: 0,
      valueSats: session.offer.amountSats
    },
    network: 'regtest'
  }));
  store.updateRelayCursor('wss://relay.example', {
    lastEventId: 'evt-1',
    lastSeenAt: 1234
  });

  const runtime = agent.summarizeThreadRuntime(store.listThread(session.tradeId));
  assertEqual(runtime.signerJob.authorizationPath, 'quorum_2_of_3');
  assertEqual(runtime.operationalTasks[0].role, agent.AGENT_ROLES.signing);
  assertEqual(store.readRelayState()['wss://relay.example'].lastEventId, 'evt-1');
});

console.log('');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log('');

if (failed > 0) {
  process.exit(1);
}
