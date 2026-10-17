#!/usr/bin/env node

const crypto = require('crypto');
const {
  buildArkTemplateCommitment,
  buildArkVtxoLiquidityCommitment,
  buildArkLiquidityGraftQuote,
  buildArkGraftCostModel,
  buildArkLiquidityGraftBundle,
  verifyArkLiquidityGraftBundle
} = require('./lightning_ark_liquidity_graft');
const { buildLiquidityLeaseBundle } = require('./lightning_liquidity_lease');

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

console.log('\n=== Ark Liquidity Graft Tests ===\n');

test('Ark template commits to ASP and taproot output key', () => {
  const template = buildArkTemplateCommitment({ aspId: 'asp-a', templateId: 'tpl-a' });
  assert(template.kind === 'ark_vtxo_template_commitment', 'wrong template kind');
  assert(template.templateCore.aspId === 'asp-a', 'asp mismatch');
  assert(template.templateCore.taprootOutputKey.length === 64, 'taproot output key should be 32-byte hex');
});

test('Ark VTXO commitment binds template and connector outpoint', () => {
  const template = buildArkTemplateCommitment({ aspId: 'asp-a', templateId: 'tpl-a' });
  const vtxo = buildArkVtxoLiquidityCommitment({
    template,
    vtxoAmountSats: 49000n,
    connectorOutpoint: `${'11'.repeat(32)}:2`
  });
  assert(vtxo.vtxoCore.templateCommitmentId === template.templateCommitmentId, 'template not bound');
  assert(vtxo.vtxoCore.vtxoAmountSats === '49000', 'amount mismatch');
  assert(vtxo.vtxoCore.connectorOutpoint.endsWith(':2'), 'connector mismatch');
});

test('graft quote commits to promised inbound and payment hash', () => {
  const template = buildArkTemplateCommitment({ aspId: 'asp-a', templateId: 'tpl-a' });
  const vtxo = buildArkVtxoLiquidityCommitment({ template, vtxoAmountSats: 49000n });
  const quote = buildArkLiquidityGraftQuote({
    template,
    vtxo,
    promisedInboundSats: 49000n,
    paymentHashHex: '22'.repeat(32)
  });
  assert(quote.quoteCore.vtxoCommitmentId === vtxo.vtxoCommitmentId, 'vtxo not committed');
  assert(quote.quoteCore.paymentHashHex === '22'.repeat(32), 'payment hash mismatch');
  assert(quote.quoteCore.roundClaimHandleId.length === 64, 'missing round claim handle');
  assert(quote.quoteCore.roundCarrierCommitmentId.length === 64, 'missing round carrier commitment');
});

const { canonicalStringify } = require('./m1_spec');

function hashCanonical(value) {
  return crypto.createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

// The honest graft bundle from the test above, as data, so a test can edit it.
function honestGraftBundle() {
  const preimageHex = '33'.repeat(32);
  return buildArkLiquidityGraftBundle({
    paymentHashHex: crypto.createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex'),
    preimageHex,
    vtxoAmountSats: 49000n,
    promisedInboundSats: 49000n,
    deliveredInboundSats: 49000n,
    observedFeePpm: 900,
    observedCltvDelta: 34,
    liquidityLease: buildLiquidityLeaseBundle({
      htlcProof: {
        lightning: { paymentHashHex: 'aa'.repeat(32) },
        swap: { fundingTxid: 'bb'.repeat(32), refundLocktime: 10 },
        dlcFunding: { claimTxid: 'cc'.repeat(32), outputVout: 1, commitmentHash: 'dd'.repeat(32), outputAmountSats: '10000' }
      }
    }),
    challengeDeliveredInboundSats: 0n,
    challengeMissingForfeitPath: true
  });
}

test('an Ark graft challenge whose violations do not follow from its core is refused', () => {
  const bundle = JSON.parse(JSON.stringify(honestGraftBundle()));
  assert(verifyArkLiquidityGraftBundle(bundle).ok, 'the honest bundle verifies');
  bundle.challengeEvidence.challengeCore.violations = [];
  bundle.challengeEvidence.challengeId = hashCanonical(bundle.challengeEvidence.challengeCore);
  bundle.bundleCore.challengeId = bundle.challengeEvidence.challengeId;
  bundle.bundleId = hashCanonical(bundle.bundleCore);
  const verification = verifyArkLiquidityGraftBundle(bundle);
  assert(!verification.ok && /violations/.test(verification.reason), 'violations are recomputed from the core');
});

test('an Ark graft settlement cannot claim a lease that does not verify', () => {
  const bundle = JSON.parse(JSON.stringify(honestGraftBundle()));
  bundle.liquidityLease.successEvidence.evidenceCore.observedInboundSats = '1';
  const verification = verifyArkLiquidityGraftBundle(bundle);
  assert(!verification.ok && /bitvmLeaseVerified/.test(verification.reason), 'a lease that fails its own verification is not a verified lease');
});

test('bundle verifies Ark graft plus BitVM lease settlement', () => {
  const preimageHex = '33'.repeat(32);
  const paymentHashHex = crypto.createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');
  const bundle = buildArkLiquidityGraftBundle({
    paymentHashHex,
    preimageHex,
    vtxoAmountSats: 49000n,
    promisedInboundSats: 49000n,
    deliveredInboundSats: 49000n,
    observedFeePpm: 900,
    observedCltvDelta: 34,
    liquidityLease: buildLiquidityLeaseBundle({
      htlcProof: {
        lightning: { paymentHashHex: 'aa'.repeat(32) },
        swap: { fundingTxid: 'bb'.repeat(32), refundLocktime: 10 },
        dlcFunding: { claimTxid: 'cc'.repeat(32), outputVout: 1, commitmentHash: 'dd'.repeat(32), outputAmountSats: '10000' }
      }
    }),
    challengeDeliveredInboundSats: 0n,
    challengeMissingForfeitPath: true
  });
  const verification = verifyArkLiquidityGraftBundle(bundle);
  assert(verification.ok, verification.reason || 'bundle should verify');
  assert(bundle.bundleCore.jurassicMechanismRefId === bundle.quote.quoteCore.jurassicMechanisms.refId, 'missing Jurassic ref binding');
  assert(bundle.taprootProofManifest.manifestCore.selectedLeafRole === 'cooperative_round', 'wrong taproot leaf role');
  assert(
    bundle.settlementEvidence.settlementCore.taprootProofManifestId === bundle.taprootProofManifest.manifestId,
    'settlement should bind taproot proof manifest'
  );
  assert(bundle.settlementEvidence.settlementCore.roundClaimHandleId === bundle.quote.quoteCore.roundClaimHandleId, 'settlement should bind round handle');
  assert(bundle.challengeEvidence.slashable, 'challenge should be slashable');
  assert(bundle.costModel.modelCore.comparison.saferMarginalCost, 'Ark path should have safer marginal cost');
});

test('cost model compares repeated LN ops against batched Ark grafts', () => {
  const model = buildArkGraftCostModel({
    graftCount: 24,
    graftAmountSats: 49000n,
    feeRateSatVb: 25,
    rebalanceFeePpm: 1200,
    arkAspFeePpm: 250,
    arkRoundParticipants: 24,
    bitvmChallengeReserveSats: 5000n
  });
  const core = model.modelCore;
  assert(core.baseline.perGraftSats !== core.ark.perGraftSats, 'per-graft costs should differ');
  assert(core.comparison.saferMarginalCost, 'Ark marginal cost should be lower in demo assumptions');
  assert(core.comparison.lowerTotalCost, 'Ark total cost should be lower after batching');
  assert(core.comparison.breakEvenGrafts > 0, 'missing break-even graft count');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
