#!/usr/bin/env node

const {
  buildAspBitvmReserveBundle,
  verifyAspBitvmReserveBundle,
  buildAspReserveDashboardProof
} = require('./asp_bitvm_reserve_bond');

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

console.log('\n=== ASP BitVM Reserve Bond Tests ===\n');

test('reserve bundle verifies a slashable LN liquidity underdelivery claim', () => {
  const bundle = buildAspBitvmReserveBundle({
    reserveAmountSats: 1000000n,
    promisedInboundSats: 250000n,
    deliveredInboundSats: 190000n
  });
  const result = verifyAspBitvmReserveBundle(bundle);

  assert(result.ok, result.reason || 'bundle should verify');
  assert(bundle.reserve.reserveCore.reserveAmountSats === '1000000', 'reserve amount mismatch');
  assert(bundle.obligationSet.obligations.length === 4, 'obligation count mismatch');
  assert(bundle.misbehaviorClaim.claimCore.violation === 'delivered_below_signed_minimum', 'wrong violation');
  assert(bundle.misbehaviorClaim.claimCore.claimedSlashSats === '60000', 'wrong slash amount');
  assert(bundle.bitvmChallenge.slashable, 'challenge should be slashable');
});

test('dashboard projection explains reserve lock, obligations, ZK call, and slash path', () => {
  const proof = buildAspReserveDashboardProof();
  const projection = proof.projection;

  assert(proof.verification.ok, proof.verification.reason || 'dashboard proof should verify');
  assert(projection.flow.length === 4, 'flow should have four reserve stages');
  assert(projection.summary.obligationCount === 4, 'projection obligation count mismatch');
  assert(projection.summary.slashable === true, 'projection should be slashable');
  assert(projection.obligations.some(item => item.type === 'ln-liquidity-delivery'), 'missing LN obligation');
  assert(projection.obligations.some(item => item.type === 'virtual-cet-settlement'), 'missing virtual CET obligation');
  assert(projection.publicInputs.includes('reserve_outpoint'), 'missing reserve public input');
});

test('virtual CET payout root mismatch can select the reserve slash path', () => {
  const bundle = buildAspBitvmReserveBundle({
    obligationType: 'virtual-cet-settlement',
    observedPayoutRoot: '0'.repeat(64)
  });
  const result = verifyAspBitvmReserveBundle(bundle);

  assert(result.ok, result.reason || 'bundle should verify');
  assert(bundle.misbehaviorClaim.claimCore.violation === 'wrong_virtual_cet_payout_root', 'wrong violation');
  assert(BigInt(bundle.misbehaviorClaim.claimCore.claimedSlashSats) > 0n, 'slash should be non-zero');
});

test('exit withholding can select the reserve slash path', () => {
  const bundle = buildAspBitvmReserveBundle({
    obligationType: 'exit-availability',
    exitAvailable: false,
    withdrawalAmountSats: 125000n
  });
  const result = verifyAspBitvmReserveBundle(bundle);

  assert(result.ok, result.reason || 'bundle should verify');
  assert(bundle.misbehaviorClaim.claimCore.violation === 'exit_path_withheld', 'wrong violation');
  assert(bundle.misbehaviorClaim.claimCore.claimedSlashSats === '125000', 'wrong exit slash');
});

test('verification fails on tampered ASP obligation signature', () => {
  const bundle = clone(buildAspBitvmReserveBundle());
  bundle.obligationSet.obligations[1].aspSignature = 'bad-signature';

  const result = verifyAspBitvmReserveBundle(bundle);
  assert(!result.ok, 'bad ASP signature should fail');
});

test('verification fails when claim exceeds reserve amount', () => {
  const bundle = clone(buildAspBitvmReserveBundle());
  bundle.misbehaviorClaim.claimCore.claimedSlashSats = '999999999';
  bundle.misbehaviorClaim.claimId = require('crypto')
    .createHash('sha256')
    .update(require('./m1_spec').canonicalStringify(bundle.misbehaviorClaim.claimCore))
    .digest('hex');
  bundle.zkReceipt.receiptCore.claimId = bundle.misbehaviorClaim.claimId;
  bundle.zkReceipt.receiptCore.claimDigest = require('crypto')
    .createHash('sha256')
    .update(require('./m1_spec').canonicalStringify(bundle.misbehaviorClaim.claimCore))
    .digest('hex');
  bundle.zkReceipt.receiptId = require('crypto')
    .createHash('sha256')
    .update(require('./m1_spec').canonicalStringify(bundle.zkReceipt.receiptCore))
    .digest('hex');

  const result = verifyAspBitvmReserveBundle(bundle);
  assert(!result.ok, 'oversized slash should fail');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
