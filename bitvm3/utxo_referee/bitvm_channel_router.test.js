const {
  derivePreimageHex,
  derivePaymentHashHex,
  buildFundingOutputCommitment
} = require('./lightning_integration');
const { buildLiquidityLeaseBundle } = require('./lightning_liquidity_lease');
const { buildArkLiquidityGraftManagerBundle } = require('./ark_liquidity_graft_manager');
const { buildLnBtcTlUsdLiquidityPatchBundle } = require('./lnbtc_tlusd_liquidity_patch');
const { buildLightningTradeLayerOracleDlcBundle } = require('./lightning_tradelayer_oracle_dlc');
const {
  buildDlcSubswapFundingRequest,
  buildDlcSubswapFundingWalletView,
  verifyDlcSubswapFundingRequest
} = require('./utxoref_dlc_subswap_funding');
const {
  buildBitvmChannelInventory,
  buildBitvmChannelRouterBundle,
  verifyBitvmChannelRouterBundle,
  verifyBitvmChannelRouterPlan,
  buildBitvmChannelRouterWalletView
} = require('./bitvm_channel_router');

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

function sampleHtlcProof() {
  const preimageHex = derivePreimageHex('bitvm-channel-router-test-preimage');
  const paymentHashHex = derivePaymentHashHex(preimageHex);
  const fundingOutput = buildFundingOutputCommitment({
    epochId: 1n,
    dlcId: 'bitvm-router-test-dlc',
    bitvmCommitmentRoot: '11'.repeat(32),
    collateralSats: 60000n,
    refundAddress: 'tb1qbitvmrouterrefund0000000000000000000000',
    timeoutBlock: 144
  });
  return {
    kind: 'lightning_subswap_into_dlc_funding_demo',
    lightning: {
      label: 'bitvm-channel-router-test',
      bolt11: 'lnbcrt600u1ptestbitvmchannelrouter',
      paymentHashHex,
      paymentPreimageHex: preimageHex
    },
    swap: {
      fundingTxid: '22'.repeat(32),
      fundingVout: 0,
      refundLocktime: 144
    },
    dlcFunding: {
      claimTxid: '33'.repeat(32),
      claimWtxid: '44'.repeat(32),
      outputVout: 0,
      outputAmountSats: '60000',
      commitmentHash: fundingOutput.commitmentHash,
      fundingOutput
    },
    refundPath: {
      refundTxid: '55'.repeat(32),
      refundBroadcasted: true
    },
    checks: {
      invoiceHashMatchesPreimage: true,
      claimPaysDlcFundingOutput: true,
      dlcOutputCommitsFundingHash: true,
      successBroadcasted: true,
      refundBroadcasted: true
    }
  };
}

function sampleSources() {
  const htlcProof = sampleHtlcProof();
  const liquidityLease = buildLiquidityLeaseBundle({
    htlcProof,
    leaseId: 'lease-bitvm-router-test',
    promisedInboundSats: 60000n,
    observedInboundSats: 60000n,
    observedFeePpm: 800,
    observedCltvDelta: 30,
    challengeObservedInboundSats: 0n,
    challengeObservedFeePpm: 2500,
    challengeObservedCltvDelta: 80
  });
  const verifiedLiquidityLease = { ...liquidityLease, verification: { ok: true } };
  const arkManager = buildArkLiquidityGraftManagerBundle({
    managerId: 'ark-router-test-manager',
    vtxoAmountsSats: [50000n, 75000n, 20000n],
    routeIntents: [
      { routeId: 'router-ark-a', requestedInboundSats: 50000n, priority: 3, maxFeePpm: 900 },
      { routeId: 'router-ark-b', requestedInboundSats: 75000n, priority: 2, maxFeePpm: 1000 },
      { routeId: 'router-ark-c', requestedInboundSats: 20000n, priority: 1, maxFeePpm: 1100 }
    ],
    routeObservations: [
      {
        routeId: 'router-ark-c',
        deliveredInboundSats: 1000n,
        observedFeePpm: 3000,
        observedCltvDelta: 90,
        missingForfeitPath: true
      }
    ],
    htlcProof,
    liquidityLease: verifiedLiquidityLease,
    maxAspExposureSats: 200000n
  });
  const tlusdPatch = buildLnBtcTlUsdLiquidityPatchBundle({
    htlcProof,
    liquidityLease: verifiedLiquidityLease,
    lnbtcSats: 60000n,
    stakedTlUsdUnits: 50000000n,
    routingNotionalSats: 30000n,
    routeIntents: [
      {
        routeId: 'router-tlusd-a',
        edgeNodeId: 'ldk-tlusd-router-a',
        requestedInboundSats: 30000n,
        priority: 2,
        maxFeePpm: 850
      }
    ],
    routeObservations: [],
    vtxoAmountsSats: [30000n],
    maxAspExposureSats: 90000n
  });
  const dlcBundle = buildLightningTradeLayerOracleDlcBundle({
    contract: {
      contractId: 'bitvm-router-dlc-test',
      totalCollateralSats: '60000',
      longParty: { nodeId: 'router-long', collateralSats: '30000' },
      shortParty: { nodeId: 'router-short', collateralSats: '30000' }
    }
  });
  const request = buildDlcSubswapFundingRequest({
    dlcBundle,
    subswapProof: htlcProof,
    options: {
      walletNodeId: 'zeus-router-test-wallet',
      requestedCollateralSats: '30000',
      swapFeeSats: '1000'
    }
  });
  const dlcSubswapFunding = {
    kind: 'utxoref_dlc_subswap_funding_bundle',
    request,
    walletView: buildDlcSubswapFundingWalletView(request),
    verification: verifyDlcSubswapFundingRequest(request)
  };
  return {
    liquidityLease: verifiedLiquidityLease,
    arkManager: { ...arkManager, verification: { ok: true } },
    tlusdPatch: { ...tlusdPatch, verification: { ok: true } },
    dlcSubswapFunding
  };
}

console.log('\n=== BitVM Channel Router Tests ===\n');

test('normalizes UTXORef examples into BitVM channel candidates', () => {
  const inventory = buildBitvmChannelInventory(sampleSources());
  assertEq(inventory.kind, 'bitvm_channel_router_inventory');
  assert(inventory.channels.length >= 5, 'expected lease, ark, tlusd, and DLC candidates');
  assert(inventory.channels.some(channel => channel.channelCore.sourceType === 'liquidity_lease'));
  assert(inventory.channels.some(channel => channel.channelCore.sourceType === 'ark_graft_manager'));
  assert(inventory.channels.some(channel => channel.channelCore.sourceType === 'tlusd_liquidity_patch'));
  assert(inventory.channels.some(channel => channel.channelCore.sourceType === 'dlc_subswap_funding'));
});

test('builds an automated split route without selecting slashable channels', () => {
  const bundle = buildBitvmChannelRouterBundle({
    sources: sampleSources(),
    routeIntent: {
      intentId: 'router-test-120k',
      amountSats: '120000',
      maxFeePpm: 1000,
      maxCltvDelta: 45
    }
  });
  const verification = verifyBitvmChannelRouterBundle(bundle);
  assert(verification.ok, verification.reason);
  assertEq(bundle.walletView.status, 'ready');
  assert(BigInt(bundle.plan.planCore.assignedSats) >= 120000n, 'route should be fully covered');
  assert(!bundle.plan.selectedChannels.some(channel => channel.status === 'slashable'), 'slashable route selected');
});

test('rejects a tampered router id', () => {
  const bundle = buildBitvmChannelRouterBundle({
    sources: sampleSources(),
    routeIntent: { amountSats: '50000' }
  });
  const tampered = {
    ...bundle,
    plan: {
      ...bundle.plan,
      routerId: '00'.repeat(32)
    }
  };
  const verification = verifyBitvmChannelRouterBundle(tampered);
  assert(!verification.ok, 'tampered router should fail');
  assertEq(verification.reason, 'router id mismatch');
});

test('rejects assigned shard amounts above available channel capacity', () => {
  const bundle = buildBitvmChannelRouterBundle({
    sources: sampleSources(),
    routeIntent: { amountSats: '50000' }
  });
  const plan = JSON.parse(JSON.stringify(bundle.plan));
  plan.selectedChannels[0].assignedSats = (
    BigInt(plan.selectedChannels[0].availableCapacitySats) + 1n
  ).toString();
  const verification = verifyBitvmChannelRouterPlan(plan);
  assert(!verification.ok, 'over-assigned route should fail');
  assert(verification.reason.includes('exceeds available channel capacity'));
});

test('builds a wallet view with router actions and channel shards', () => {
  const bundle = buildBitvmChannelRouterBundle({
    sources: sampleSources(),
    routeIntent: { amountSats: '90000' }
  });
  const view = buildBitvmChannelRouterWalletView(bundle.plan);
  assertEq(view.kind, 'wallet_bitvm_channel_router_view');
  assert(view.selectedChannels.length > 0, 'wallet view needs selected channels');
  assert(view.actions.some(action => action.id === 'verify_router_plan'));
});

console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
