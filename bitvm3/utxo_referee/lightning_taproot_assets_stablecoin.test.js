#!/usr/bin/env node

const crypto = require('crypto');
const {
  buildTaprootAssetDescriptor,
  buildTaprootAssetProofCommitment,
  buildStablecoinRfqQuote,
  buildStablecoinChallengeEvidence,
  buildTaprootAssetsStablecoinBundle,
  verifyTaprootAssetsStablecoinBundle
} = require('./lightning_taproot_assets_stablecoin');
const { buildLiquidityLeaseBundle } = require('./lightning_liquidity_lease');

const LEASE_HTLC = {
  lightning: { paymentHashHex: 'aa'.repeat(32) },
  swap: { fundingTxid: 'bb'.repeat(32), refundLocktime: 10 },
  dlcFunding: { claimTxid: 'cc'.repeat(32), outputVout: 1, commitmentHash: 'dd'.repeat(32), outputAmountSats: '10000' }
};

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  OK  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log('\n=== Taproot Assets Stablecoin Lightning Tests ===\n');

test('asset descriptor commits to genesis and asset id', () => {
  const asset = buildTaprootAssetDescriptor({ ticker: 'USDSIM' });
  assert(asset.kind === 'taproot_asset_stablecoin_descriptor', 'wrong descriptor kind');
  assert(asset.descriptorCore.assetId.length === 64, 'asset id should be 32-byte hex');
  assert(asset.descriptorCore.genesisPoint.includes(':'), 'missing genesis point');
});

test('asset proof commitment binds universe and anchor evidence', () => {
  const asset = buildTaprootAssetDescriptor({ ticker: 'USDSIM' });
  const proof = buildTaprootAssetProofCommitment({ asset, amountUnits: 1000000n });
  assert(proof.proofCore.assetId === asset.descriptorCore.assetId, 'proof asset mismatch');
  assert(proof.proofCore.amountUnits === '1000000', 'amount units mismatch');
  assert(proof.proofCore.universeRoot.length === 64, 'missing universe root');
});

test('rfq quote commits to asset amount and BTC route amount', () => {
  const asset = buildTaprootAssetDescriptor({ ticker: 'USDSIM' });
  const assetProof = buildTaprootAssetProofCommitment({ asset, amountUnits: 25000000n });
  const quote = buildStablecoinRfqQuote({
    asset,
    assetProof,
    assetAmountUnits: 25000000n,
    btcRouteSats: 49000n
  });
  assert(quote.quoteCore.assetAmountUnits === '25000000', 'asset amount mismatch');
  assert(quote.quoteCore.btcRouteSats === '49000', 'BTC route amount mismatch');
  assert(quote.commitment.assetProofId === assetProof.proofId, 'asset proof not committed');
  assert(quote.quoteCore.proofAnchorHandleId.length === 64, 'missing proof anchor handle');
  assert(quote.quoteCore.proofCarrierCommitmentId.length === 64, 'missing proof carrier commitment');
});

test('stablecoin bundle verifies positive settlement and challenge evidence', () => {
  const preimageHex = '00'.repeat(32);
  const paymentHashHex = crypto.createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');
  const bundle = buildTaprootAssetsStablecoinBundle({
    paymentHashHex,
    preimageHex,
    btcRouteSats: 49000n,
    deliveredBtcSats: 49000n,
    observedBlock: 100,
    expiryBlock: 144,
    liquidityLease: buildLiquidityLeaseBundle({ htlcProof: LEASE_HTLC }),
    challengeDeliveredBtcSats: 0n,
    challengeObservedBlock: 145
  });
  const verification = verifyTaprootAssetsStablecoinBundle(bundle);
  assert(verification.ok, verification.reason || 'bundle should verify');
  assert(bundle.bundleCore.jurassicMechanismRefId === bundle.rfqQuote.quoteCore.jurassicMechanisms.refId, 'missing Jurassic ref binding');
  assert(bundle.settlementEvidence.settlementCore.proofAnchorHandleId === bundle.rfqQuote.quoteCore.proofAnchorHandleId, 'settlement should bind proof anchor handle');
  assert(bundle.challengeEvidence.slashable, 'challenge should be slashable');
});

function hashCanonical(value) {
  return crypto.createHash('sha256').update(require('./m1_spec').canonicalStringify(value)).digest('hex');
}

test('a settlement cannot claim a lease that does not verify', () => {
  const preimageHex = '00'.repeat(32);
  const paymentHashHex = crypto.createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');
  const lease = buildLiquidityLeaseBundle({ htlcProof: LEASE_HTLC });
  const bogus = { ...lease, successEvidence: { ...lease.successEvidence, evidenceCore: { ...lease.successEvidence.evidenceCore, observedInboundSats: '1' } } };
  const bundle = buildTaprootAssetsStablecoinBundle({
    paymentHashHex, preimageHex, btcRouteSats: 49000n, deliveredBtcSats: 49000n, observedBlock: 100, expiryBlock: 144,
    liquidityLease: bogus, challengeDeliveredBtcSats: 0n, challengeObservedBlock: 145
  });
  const verification = verifyTaprootAssetsStablecoinBundle(bundle);
  assert(!verification.ok && /bitvmLeaseVerified/.test(verification.reason), 'a lease that fails its own verification is not a verified lease');
});

test('a stablecoin challenge whose violations do not follow from its core is refused', () => {
  const preimageHex = '00'.repeat(32);
  const paymentHashHex = crypto.createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');
  const bundle = buildTaprootAssetsStablecoinBundle({
    paymentHashHex, preimageHex, btcRouteSats: 49000n, deliveredBtcSats: 49000n, observedBlock: 100, expiryBlock: 144,
    liquidityLease: buildLiquidityLeaseBundle({ htlcProof: LEASE_HTLC }), challengeDeliveredBtcSats: 0n, challengeObservedBlock: 145
  });
  assert(verifyTaprootAssetsStablecoinBundle(bundle).ok, 'the honest bundle verifies');
  const forged = JSON.parse(JSON.stringify(bundle));
  forged.challengeEvidence.challengeCore.violations = [];
  forged.challengeEvidence.challengeId = hashCanonical(forged.challengeEvidence.challengeCore);
  forged.bundleCore.challengeId = forged.challengeEvidence.challengeId;
  forged.bundleId = hashCanonical(forged.bundleCore);
  const verification = verifyTaprootAssetsStablecoinBundle(forged);
  assert(!verification.ok && /violations/.test(verification.reason), 'violations are recomputed from the core');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

test('a challenge at observed block 0 is judged at block 0, not at the expiry block plus one', () => {
  const rfqQuote = buildStablecoinRfqQuote({});
  const challenge = buildStablecoinChallengeEvidence({
    rfqQuote,
    deliveredBtcSats: rfqQuote.quoteCore.btcRouteSats,
    observedSpreadPpm: rfqQuote.quoteCore.maxSpreadPpm,
    observedRoutingFeePpm: rfqQuote.quoteCore.maxRoutingFeePpm,
    observedBlock: 0
  });
  assert(challenge.challengeCore.observedBlock === 0, 'observed block 0 was replaced');
  assert(challenge.slashable === false, 'a block-0 observation was judged expired');
});

console.log(`\nTests: ${passed} passed, ${failed} failed`);
