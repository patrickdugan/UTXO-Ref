/**
 * Lightning Integration Prototype Tests
 *
 * Run: node bitvm3/utxo_referee/lightning_integration.test.js
 */

const {
  deriveLightningPaymentHashHex,
  buildLightningFundedPositionOpen,
  buildLightningPayoutCompression,
  verifyLightningPayoutCompression,
  buildLightningWatchtowerBounty,
  buildContractOpenApiPrototype,
  buildLightningFundedRollover,
  buildAllLightningIntegrationPrototypes
} = require('./index');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
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

console.log('\n=== Lightning Integration Prototype Tests ===\n');

test('Lightning-funded position binds invoice hash to funding package', () => {
  const position = buildLightningFundedPositionOpen({
    collateralSats: 100000n,
    swapFeeSats: 300n,
    fundingFeeSats: 700n
  });

  assertEq(position.kind, 'lightning_funded_bitvm_dlc_position_open');
  assertEq(position.lightning.amountMsat, '101000000');
  assertEq(position.lightning.paymentHashHex, position.fundingPackage.swapLock.paymentHashHex);
  assert(position.atomicityChecklist.sameHashLocksLightningAndSwap, 'hash lock not shared');
  assert(position.atomicityChecklist.feeAccountingBalances, 'fee accounting failed');
  assert(position.atomicityChecklist.refundPathExists, 'refund path should exist');
});

test('Lightning payout compression verifies root and settled preimages', () => {
  const bundle = buildLightningPayoutCompression({
    payoutLeaves: [
      { accountId: 'alice', amountSats: 10000n, preimageHex: '11'.repeat(32) },
      { accountId: 'bob', amountSats: 20000n, preimageHex: '22'.repeat(32) },
      { accountId: 'carol', amountSats: 30000n, paymentHashHex: '33'.repeat(32) }
    ]
  });

  const result = verifyLightningPayoutCompression(bundle);
  assert(result.ok, result.reason);
  assertEq(bundle.totalPayoutSats, '60000');
  assertEq(bundle.compressionStats.originalOnchainOutputCount, 3);
  assertEq(bundle.compressionStats.lightningSettledCount, 2);
  assertEq(bundle.compressionStats.requiredOnchainFallbackOutputCount, 1);
});

test('Lightning payout compression rejects tampered root', () => {
  const bundle = buildLightningPayoutCompression();
  const result = verifyLightningPayoutCompression({
    ...bundle,
    root: '00'.repeat(32)
  });

  assert(!result.ok, 'tampered root should fail');
  assertEq(result.reason, 'payout root mismatch');
});

test('Watchtower bounty receipt proves paid invoice preimage', () => {
  const bounty = buildLightningWatchtowerBounty({
    challengeId: 'challenge-spiral-demo',
    bountySats: 1234n
  });

  assertEq(bounty.kind, 'lightning_watchtower_bounty');
  assertEq(bounty.amountMsat, '1234000');
  assertEq(deriveLightningPaymentHashHex(bounty.receipt.preimageHex), bounty.commitment.paymentHashHex);
  assert(bounty.verification.preimageMatchesPaymentHash, 'preimage mismatch');
  assert(bounty.verification.witnessBoundToChallenge, 'witness not bound');
});

test('Contract-open API prototype exposes the expected wallet workflow', () => {
  const api = buildContractOpenApiPrototype();
  const names = api.endpoints.map(endpoint => endpoint.name);

  assertEq(api.kind, 'ldk_bdk_contract_open_api_prototype');
  assert(names.includes('create_contract_offer'), 'missing offer endpoint');
  assert(names.includes('quote_lightning_funding'), 'missing quote endpoint');
  assert(names.includes('finalize_funding_psbt'), 'missing psbt endpoint');
  assert(names.includes('verify_referee_commitment'), 'missing verify endpoint');
  assertEq(api.stateMachine[api.stateMachine.length - 1], 'contract_opened');
});

test('Lightning-funded rollover conserves collateral plus top-up', () => {
  const rollover = buildLightningFundedRollover({
    previousCollateralSats: 75000n,
    topUpSats: 25000n,
    swapFeeSats: 100n
  });

  assertEq(rollover.kind, 'lightning_funded_rollover');
  assertEq(rollover.previousCollateralSats, '75000');
  assertEq(rollover.topUpSats, '25000');
  assertEq(rollover.nextCollateralSats, '100000');
  assertEq(rollover.lightning.amountMsat, '25100000');
  assert(rollover.conservation.holds, 'rollover conservation failed');
});

test('Full prototype bundle contains all grant pitch surfaces', () => {
  const bundle = buildAllLightningIntegrationPrototypes();

  assertEq(bundle.kind, 'lightning_bitvm_dlc_prototype_bundle');
  assert(bundle.prototypes.positionOpen, 'missing position open');
  assert(bundle.prototypes.payoutCompression, 'missing payout compression');
  assert(bundle.prototypes.watchtowerBounty, 'missing watchtower bounty');
  assert(bundle.prototypes.contractOpenApi, 'missing contract-open API');
  assert(bundle.prototypes.rollover, 'missing rollover');
});

console.log(`\nTests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
