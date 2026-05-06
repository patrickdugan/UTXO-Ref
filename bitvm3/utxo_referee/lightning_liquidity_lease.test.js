/**
 * Lightning liquidity lease tests
 *
 * Run: node bitvm3/utxo_referee/lightning_liquidity_lease.test.js
 */

const {
  buildLiquidityLeaseOffer,
  buildLiquidityLeaseBundle,
  verifyLiquidityLeaseBundle
} = require('./index');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `expected ${expected}, got ${actual}`);
  }
}

console.log('\n=== Lightning Liquidity Lease Tests ===\n');

test('lease offer commits to routing terms and payment hash', () => {
  const offer = buildLiquidityLeaseOffer({
    leaseId: 'lease-a',
    promisedInboundSats: 100000n,
    penaltySats: 10000n,
    leasePremiumSats: 2000n,
    paymentHashHex: '11'.repeat(32),
    maxFeePpm: 500
  });

  assertEq(offer.terms.promisedInboundSats, '100000');
  assertEq(offer.terms.maxFeePpm, 500);
  assertEq(offer.invoiceAmountMsat, '12000000');
  assert(offer.offerId.length === 64, 'offer id should be a digest');
  assert(offer.terms.jurassicMechanisms.refId.length === 64, 'missing Jurassic ref id');
  assert(offer.terms.jurassicMechanisms.transcriptSwitchboardId.length === 64, 'missing switchboard id');
});

test('lease bundle verifies against HTLC/DLC funding proof', () => {
  const htlcProof = {
    lightning: {
      paymentHashHex: '22'.repeat(32)
    },
    swap: {
      fundingTxid: '33'.repeat(32),
      refundLocktime: 200
    },
    dlcFunding: {
      claimTxid: '44'.repeat(32),
      outputVout: 0,
      commitmentHash: '55'.repeat(32),
      outputAmountSats: '49000'
    }
  };

  const bundle = buildLiquidityLeaseBundle({
    htlcProof,
    promisedInboundSats: 49000n,
    observedInboundSats: 49000n,
    observedFeePpm: 900,
    observedCltvDelta: 34,
    maxFeePpm: 1000,
    maxCltvDelta: 40
  });
  const result = verifyLiquidityLeaseBundle(bundle);
  assert(result.ok, result.reason);
  assertEq(bundle.successEvidence.evidenceCore.channelOutpoint, `${'44'.repeat(32)}:0`);
  assertEq(
    bundle.bundleCore.jurassicMechanismRefId,
    bundle.offer.terms.jurassicMechanisms.refId,
    'bundle should bind the Jurassic mechanism ref'
  );
  assertEq(
    bundle.successEvidence.evidenceCore.transcriptSwitchboardId,
    bundle.offer.terms.jurassicMechanisms.transcriptSwitchboardId,
    'success evidence should bind the transcript switchboard'
  );
  assert(bundle.challengeEvidence.slashable, 'demo challenge should be slashable');
});

test('lease bundle rejects insufficient success evidence', () => {
  const htlcProof = {
    lightning: { paymentHashHex: 'aa'.repeat(32) },
    swap: { fundingTxid: 'bb'.repeat(32), refundLocktime: 10 },
    dlcFunding: {
      claimTxid: 'cc'.repeat(32),
      outputVout: 1,
      commitmentHash: 'dd'.repeat(32),
      outputAmountSats: '10000'
    }
  };
  const bundle = buildLiquidityLeaseBundle({
    htlcProof,
    promisedInboundSats: 20000n,
    observedInboundSats: 10000n
  });
  const result = verifyLiquidityLeaseBundle(bundle);
  assert(!result.ok, 'insufficient capacity should fail');
  assert(String(result.reason).includes('inboundCapacityMet'), 'expected inbound failure');
});

console.log(`\nTests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
