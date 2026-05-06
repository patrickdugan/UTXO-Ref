const escrow = require('./index');
const tinysecp = require('../../node-dlc/packages/messaging/node_modules/tiny-secp256k1');

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

function makeXOnlyPubkey(byte) {
  const scalar = Buffer.alloc(32, 0);
  scalar[31] = byte;
  const point = tinysecp.pointFromScalar(scalar, true);
  return point.slice(1, 33);
}

function createOrder(overrides = {}) {
  return new escrow.EscrowOrder({
    orderId: 'order-test-1',
    epochId: 11n,
    escrowAmountSats: 100000n,
    sellerPayoutScriptPubKey: makeSpk(0x11),
    buyerRefundScriptPubKey: makeSpk(0x22),
    serviceFeeScriptPubKey: makeSpk(0x33),
    serviceFeeSats: 1000n,
    resolverFeeScriptPubKey: makeSpk(0x44),
    expiryBlock: 800000n,
    residualDest: makeSpk(0x55),
    ...overrides
  });
}

console.log('\n=== CivKit BitVM Escrow Tests ===\n');

test('release route projects seller payout and fee', () => {
  const result = escrow.verifyEscrowSettlement(createOrder(), {
    route: 'release',
    decisionId: 'release-1'
  });

  assert(result.ok, result.reason);
  assertEqual(result.settlement.payouts.length, 2, 'Expected seller and service fee outputs');
  assertEqual(result.settlement.payouts[0].amountSats, 99000n);
  assertEqual(result.settlement.payouts[1].amountSats, 1000n);
  assert(result.settlement.verification.ok, 'Underlying referee verification should pass');
});

test('release route supports multiple fixed fee outputs', () => {
  const order = createOrder({
    fixedFeeOutputs: [
      {
        feeId: 'platform_fee',
        role: 'platform_fee',
        recipientScriptPubKey: makeSpk(0x66),
        amountSats: 1000n
      },
      {
        feeId: 'notary_booking_fee',
        role: 'notary_booking_fee',
        recipientScriptPubKey: makeSpk(0x77),
        amountSats: 500n
      }
    ],
    serviceFeeScriptPubKey: null,
    serviceFeeSats: 0n
  });
  const result = escrow.verifyEscrowSettlement(order, {
    route: 'release',
    decisionId: 'release-multi-fee'
  });

  assert(result.ok, result.reason);
  assertEqual(result.settlement.payouts.length, 3);
  assertEqual(result.settlement.payouts[0].amountSats, 98500n);
  assertEqual(result.settlement.payouts[1].role, 'platform_fee');
  assertEqual(result.settlement.payouts[2].role, 'notary_booking_fee');
});

test('refund route is blocked before expiry when currentBlock is provided', () => {
  const result = escrow.verifyEscrowSettlement(createOrder(), {
    route: 'refund',
    decisionId: 'refund-early'
  }, {
    currentBlock: 799999n
  });

  assert(!result.ok, 'Expected refund to fail before expiry');
  assert(result.reason.includes('Refund locked until block 800000'), `Wrong reason: ${result.reason}`);
});

test('refund route pays buyer after expiry', () => {
  const result = escrow.verifyEscrowSettlement(createOrder(), {
    route: 'refund',
    decisionId: 'refund-late'
  }, {
    currentBlock: 800001n
  });

  assert(result.ok, result.reason);
  assertEqual(result.settlement.payouts[0].role, 'buyer');
  assertEqual(result.settlement.payouts[0].amountSats, 99000n);
  assertEqual(result.settlement.payouts[1].role, 'service_fee');
});

test('split route conserves escrow including resolver fee', () => {
  const result = escrow.verifyEscrowSettlement(createOrder(), {
    route: 'split',
    sellerAmountSats: 60000n,
    buyerAmountSats: 37000n,
    resolverFeeSats: 2000n,
    decisionId: 'split-1'
  }, {
    currentBlock: 800010n
  });

  assert(result.ok, result.reason);
  assertEqual(result.settlement.payouts.length, 4);
  assertEqual(result.settlement.payouts[2].role, 'service_fee');
  assertEqual(result.settlement.payouts[3].role, 'resolver_fee');
  assertEqual(result.settlement.residualAmountSats, 0n);
});

test('invalid split sum is rejected before referee projection', () => {
  const result = escrow.verifyEscrowSettlement(createOrder(), {
    route: 'split',
    sellerAmountSats: 60000n,
    buyerAmountSats: 36000n,
    resolverFeeSats: 2000n,
    decisionId: 'split-bad'
  });

  assert(!result.ok, 'Expected invalid split to fail');
  assert(
    result.reason.includes('Escrow conservation failed'),
    `Wrong reason: ${result.reason}`
  );
});

test('resolver fee requires resolver script', () => {
  const result = escrow.verifyEscrowSettlement(createOrder({
    resolverFeeScriptPubKey: null
  }), {
    route: 'split',
    sellerAmountSats: 60000n,
    buyerAmountSats: 37000n,
    resolverFeeSats: 2000n,
    decisionId: 'split-no-resolver'
  });

  assert(!result.ok, 'Expected missing resolver script to fail');
  assert(
    result.reason.includes('resolverFeeScriptPubKey is required'),
    `Wrong reason: ${result.reason}`
  );
});

test('order and decision hashes are deterministic', () => {
  const order = createOrder();
  const decision = new escrow.EscrowDecision({
    route: 'release',
    decisionId: 'release-hash'
  });

  assert(order.hash().equals(order.hash()), 'Order hash should be deterministic');
  assert(decision.hash().equals(decision.hash()), 'Decision hash should be deterministic');
});

test('taproot escrow package builds real approval and timeout leaves', () => {
  const spendPackage = escrow.buildEscrowSpendPackage({
    orderLike: createOrder({
      fixedFeeOutputs: [
        {
          feeId: 'platform_fee',
          role: 'platform_fee',
          recipientScriptPubKey: makeSpk(0x66),
          amountSats: 1000n
        },
        {
          feeId: 'notary_booking_fee',
          role: 'notary_booking_fee',
          recipientScriptPubKey: makeSpk(0x77),
          amountSats: 500n
        }
      ],
      serviceFeeScriptPubKey: null,
      serviceFeeSats: 0n
    }),
    decisionLike: {
      route: 'split',
      sellerAmountSats: 96500n,
      buyerAmountSats: 0n,
      resolverFeeSats: 2000n,
      decisionId: 'split-onchain'
    },
    keyset: {
      releasePubkey: makeXOnlyPubkey(1),
      refundPubkey: makeXOnlyPubkey(2),
      notaryPubkey: makeXOnlyPubkey(3)
    },
    fundingOutpoint: {
      txid: '11'.repeat(32),
      vout: 0,
      valueSats: 100000n
    },
    network: 'regtest'
  });

  assert(spendPackage.taproot.address.startsWith('bcrt1p'), 'Expected regtest taproot address');
  assertEqual(spendPackage.txTemplate.authorizationPath, 'dispute_resolution');
  assert(
    spendPackage.taproot.leaves.some((leaf) => leaf.name === 'refund_timeout'),
    'Expected refund timeout leaf'
  );
  assertEqual(spendPackage.txTemplate.outputs.length, 4);
  assertEqual(spendPackage.txTemplate.outputs[1].role, 'platform_fee');
  assertEqual(spendPackage.txTemplate.outputs[2].role, 'notary_booking_fee');
  assertEqual(spendPackage.txTemplate.outputs[3].role, 'resolver_fee');
});

test('refund timeout template applies locktime and timeout leaf', () => {
  const spendPackage = escrow.buildEscrowSpendPackage({
    orderLike: createOrder(),
    decisionLike: {
      route: 'refund',
      decisionId: 'refund-timeout'
    },
    keyset: {
      releasePubkey: makeXOnlyPubkey(1),
      refundPubkey: makeXOnlyPubkey(2),
      notaryPubkey: makeXOnlyPubkey(3)
    },
    fundingOutpoint: {
      txid: '22'.repeat(32),
      vout: 1,
      valueSats: 100000n
    },
    authorizationPath: 'refund_timeout',
    currentBlock: 800010n,
    network: 'regtest'
  });

  assertEqual(spendPackage.txTemplate.locktime, 800000);
  assertEqual(spendPackage.txTemplate.authorizationPath, 'refund_timeout');
  assertEqual(spendPackage.psbt.selectedLeaf.name, 'refund_timeout');
});

test('threshold 2-of-3 authorization mode selects quorum leaf', () => {
  const spendPackage = escrow.buildEscrowSpendPackage({
    orderLike: createOrder(),
    decisionLike: {
      route: 'release',
      decisionId: 'release-threshold'
    },
    keyset: {
      releasePubkey: makeXOnlyPubkey(1),
      refundPubkey: makeXOnlyPubkey(2),
      notaryPubkey: makeXOnlyPubkey(3)
    },
    fundingOutpoint: {
      txid: '33'.repeat(32),
      vout: 0,
      valueSats: 100000n
    },
    authorizationMode: escrow.AUTHORIZATION_MODES.threshold2of3,
    signerSet: {
      buyerSigned: true,
      sellerSigned: false,
      notarySigned: true
    },
    network: 'regtest'
  });

  assertEqual(spendPackage.txTemplate.authorizationPath, 'quorum_2_of_3');
  assertEqual(spendPackage.psbt.selectedLeaf.name, 'quorum_2_of_3');
  assertEqual(spendPackage.authorization.witnessPlan.witnessStack[0], 'notary_signature');
  assertEqual(spendPackage.authorization.witnessPlan.witnessStack[1], 'buyer_signature');
  assertEqual(spendPackage.authorization.witnessPlan.witnessStack[2], 'OP_0');
});

test('litecoin testnet network emits tltc taproot address', () => {
  const spendPackage = escrow.buildEscrowSpendPackage({
    orderLike: createOrder(),
    decisionLike: {
      route: 'release',
      decisionId: 'release-litecoin-testnet'
    },
    keyset: {
      releasePubkey: makeXOnlyPubkey(1),
      refundPubkey: makeXOnlyPubkey(2),
      notaryPubkey: makeXOnlyPubkey(3)
    },
    fundingOutpoint: {
      txid: '35'.repeat(32),
      vout: 0,
      valueSats: 100000n
    },
    authorizationMode: escrow.AUTHORIZATION_MODES.threshold2of3,
    signerSet: {
      buyerSigned: true,
      sellerSigned: true,
      notarySigned: false
    },
    network: 'litecoin-testnet'
  });

  assert(spendPackage.taproot.address.startsWith('tltc1p'), 'Expected litecoin testnet taproot address');
});

test('transition commitment mode anchors BitVM transition hash', () => {
  const spendPackage = escrow.buildEscrowSpendPackage({
    orderLike: createOrder(),
    decisionLike: {
      route: 'release',
      decisionId: 'release-transition-anchor'
    },
    keyset: {
      releasePubkey: makeXOnlyPubkey(1),
      refundPubkey: makeXOnlyPubkey(2),
      notaryPubkey: makeXOnlyPubkey(3)
    },
    fundingOutpoint: {
      txid: '34'.repeat(32),
      vout: 0,
      valueSats: 100000n
    },
    authorizationMode: escrow.AUTHORIZATION_MODES.threshold2of3,
    signerSet: {
      buyerSigned: true,
      sellerSigned: true,
      notarySigned: false
    },
    commitmentType: escrow.COMMITMENT_TYPES.transition,
    network: 'regtest'
  });

  assertEqual(spendPackage.commitmentType, 'transition');
  assertEqual(
    spendPackage.binding.selectedCommitmentHashHex,
    spendPackage.binding.transitionCommitmentHashHex
  );
  assertEqual(
    spendPackage.txTemplate.commitmentAnchor.hashHex,
    spendPackage.binding.transitionCommitmentHashHex
  );
  assert(spendPackage.bitvm.verification.ok, spendPackage.bitvm.verification.reason);
});

test('bitvm transition accepts 2-of-3 release quorum', () => {
  const state = escrow.buildEscrowBitvmTransitionState(
    createOrder({
      fixedFeeOutputs: [
        {
          feeId: 'platform_fee',
          role: 'platform_fee',
          recipientScriptPubKey: makeSpk(0x66),
          amountSats: 1000n
        }
      ],
      serviceFeeScriptPubKey: null,
      serviceFeeSats: 0n
    }),
    {
      route: 'release',
      decisionId: 'release-bitvm'
    },
    {
      signerSet: {
        buyerSigned: true,
        sellerSigned: true,
        notarySigned: false
      }
    }
  );
  const result = escrow.verifyEscrowBitvmTransition(state);

  assert(result.ok, result.reason);
});

test('bitvm transition rejects one-signer release', () => {
  const state = escrow.buildEscrowBitvmTransitionState(
    createOrder(),
    {
      route: 'release',
      decisionId: 'release-one-signer'
    },
    {
      signerSet: {
        buyerSigned: false,
        sellerSigned: true,
        notarySigned: false
      }
    }
  );
  const result = escrow.verifyEscrowBitvmTransition(state);

  assert(!result.ok, 'Expected quorum failure');
  assert(result.reason.includes('Signer quorum failed'), `Wrong reason: ${result.reason}`);
});

test('bitvm transition supports timeout refund after expiry', () => {
  const state = escrow.buildEscrowBitvmTransitionState(
    createOrder(),
    {
      route: 'refund',
      decisionId: 'refund-timeout-bitvm'
    },
    {
      timeoutRoute: true,
      currentBlock: 800010n,
      signerSet: {
        buyerSigned: true,
        sellerSigned: false,
        notarySigned: false
      }
    }
  );
  const result = escrow.verifyEscrowBitvmTransition(state);

  assert(result.ok, result.reason);
});

test('bitvm transition can require notary on split', () => {
  const state = escrow.buildEscrowBitvmTransitionState(
    createOrder(),
    {
      route: 'split',
      sellerAmountSats: 60000n,
      buyerAmountSats: 37000n,
      resolverFeeSats: 2000n,
      decisionId: 'split-notary-required'
    },
    {
      signerSet: {
        buyerSigned: true,
        sellerSigned: true,
        notarySigned: false
      },
      splitRequiresNotary: true
    }
  );
  const result = escrow.verifyEscrowBitvmTransition(state);

  assert(!result.ok, 'Expected notary requirement failure');
  assert(result.reason.includes('requires notary signature'), `Wrong reason: ${result.reason}`);
});

test('bitvm challenge bundle includes witness and transition commitment', () => {
  const bundle = escrow.buildEscrowBitvmChallengeBundle(
    createOrder(),
    {
      route: 'release',
      decisionId: 'release-bundle'
    },
    {
      signerSet: {
        buyerSigned: true,
        sellerSigned: false,
        notarySigned: true
      }
    }
  );

  assert(bundle.verification.ok, bundle.verification.reason);
  assertEqual(bundle.route, 'release');
  assert(typeof bundle.binding.transitionCommitmentHashHex === 'string' && bundle.binding.transitionCommitmentHashHex.length === 64);
  assertEqual(bundle.transitionWitness.routeRelease, 1);
});

console.log('');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log('');

if (failed > 0) {
  process.exit(1);
}
