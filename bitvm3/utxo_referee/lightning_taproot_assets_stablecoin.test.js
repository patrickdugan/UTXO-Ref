#!/usr/bin/env node

const crypto = require('crypto');
const {
  buildTaprootAssetDescriptor,
  buildTaprootAssetProofCommitment,
  buildStablecoinRfqQuote,
  buildTaprootAssetsStablecoinBundle,
  verifyTaprootAssetsStablecoinBundle
} = require('./lightning_taproot_assets_stablecoin');

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
    liquidityLease: { bundleId: 'lease', verification: { ok: true } },
    challengeDeliveredBtcSats: 0n,
    challengeObservedBlock: 145
  });
  const verification = verifyTaprootAssetsStablecoinBundle(bundle);
  assert(verification.ok, verification.reason || 'bundle should verify');
  assert(bundle.bundleCore.jurassicMechanismRefId === bundle.rfqQuote.quoteCore.jurassicMechanisms.refId, 'missing Jurassic ref binding');
  assert(bundle.settlementEvidence.settlementCore.proofAnchorHandleId === bundle.rfqQuote.quoteCore.proofAnchorHandleId, 'settlement should bind proof anchor handle');
  assert(bundle.challengeEvidence.slashable, 'challenge should be slashable');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
