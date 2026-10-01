#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildSyntheticZkReceiptRef,
  buildLightningPaymentConditionProof,
  verifyLightningPaymentConditionProof,
  buildProgrammableWatchtower,
  verifyProgrammableWatchtower,
  buildProgrammableAspPolicy,
  verifyProgrammableAspPolicy,
  writeProgrammableLightningZkBundle,
  verifyProgrammableLightningZkBundle
} = require('./lightning_zk_programs');

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

console.log('\n=== Programmable Lightning ZK Program Tests ===\n');

test('payment proof exposes a public receipt without route preimage', () => {
  const proof = buildLightningPaymentConditionProof({
    routeId: 'private-route-a',
    amountSats: 42000n
  });
  const verification = verifyLightningPaymentConditionProof(proof, {
    expectedAmountSats: 42000n,
    requirePrivateWitness: true
  });
  assert(verification.ok, verification.reason || 'proof should verify');
  assert(proof.publicReceipt.paymentHashHex.length === 64, 'missing payment hash');
  assert(!Object.prototype.hasOwnProperty.call(proof.publicReceipt, 'preimageHex'), 'preimage leaked');
  assert(!Object.prototype.hasOwnProperty.call(proof.proofCore, 'invoice'), 'invoice leaked in public core');
});

test('payment proof rejects a bad private preimage', () => {
  const proof = buildLightningPaymentConditionProof({ routeId: 'private-route-b' });
  proof.privateWitness.preimageHex = '00'.repeat(32);
  const verification = verifyLightningPaymentConditionProof(proof, { requirePrivateWitness: true });
  assert(!verification.ok, 'tampered proof should fail');
  assert(/preimage/.test(verification.reason), `unexpected reason: ${verification.reason}`);
});

test('watchtower accepts a matching payment-conditioned Ark transition', () => {
  const program = buildProgrammableWatchtower({
    zkReceiptRef: buildSyntheticZkReceiptRef('utxoref_challenge_publication'),
    currentHeight: 820000,
    challengeDeadlineHeight: 820144
  });
  const verification = verifyProgrammableWatchtower(program);
  assert(verification.ok, verification.reason || 'watchtower should verify');
  assert(program.programCore.action === 'accept_and_monitor', 'watchtower should monitor');
  assert(!program.challenge.challengeable, 'matching transition should not challenge');
});

test('watchtower challenges a mismatched transition', () => {
  const program = buildProgrammableWatchtower({
    zkReceiptRef: buildSyntheticZkReceiptRef('utxoref_challenge_publication'),
    observedStateTransitionHash: 'ff'.repeat(32)
  });
  const verification = verifyProgrammableWatchtower(program);
  assert(verification.ok, verification.reason || 'challenge artifact should verify');
  assert(program.programCore.action === 'publish_utxoref_challenge', 'watchtower should challenge');
  assert(program.challenge.challengeable, 'mismatch should be challengeable');
  assert(
    program.challenge.challengeCore.violations.includes('transitionMatchesProgram'),
    'missing transition mismatch violation'
  );
});

test('ASP policy settles when payment and ZK receipts satisfy obligations', () => {
  const policy = buildProgrammableAspPolicy({
    promisedInboundSats: 75000n,
    deliveredInboundSats: 75000n,
    observedFeePpm: 700,
    observedCltvDelta: 30,
    settlementZkReceiptRef: buildSyntheticZkReceiptRef('cooperative_round'),
    forfeitZkReceiptRef: buildSyntheticZkReceiptRef('asp_forfeit_guard')
  });
  const verification = verifyProgrammableAspPolicy(policy);
  assert(verification.ok, verification.reason || 'ASP policy should verify');
  assert(policy.policyCore.action === 'settle_and_release_asp_fee', 'ASP should settle');
  assert(!policy.challenge.slashable, 'settled policy should not be slashable');
});

test('ASP policy slashes underdelivery or missing forfeit path', () => {
  const policy = buildProgrammableAspPolicy({
    promisedInboundSats: 75000n,
    deliveredInboundSats: 10000n,
    missingForfeitPath: true,
    settlementZkReceiptRef: buildSyntheticZkReceiptRef('cooperative_round'),
    forfeitZkReceiptRef: buildSyntheticZkReceiptRef('asp_forfeit_guard')
  });
  const verification = verifyProgrammableAspPolicy(policy);
  assert(verification.ok, verification.reason || 'slash policy should verify');
  assert(policy.policyCore.action === 'slash_or_force_exit', 'ASP should slash or exit');
  assert(policy.challenge.slashable, 'failed policy should be slashable');
  assert(policy.challenge.challengeCore.violations.includes('deliveredInboundMet'), 'missing delivery violation');
  assert(policy.challenge.challengeCore.violations.includes('forfeitPathAvailable'), 'missing forfeit violation');
});

test('bundle writer emits JSON and markdown artifacts that verify', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ln-zk-programs-'));
  const { bundle, jsonPath, mdPath } = writeProgrammableLightningZkBundle({
    outDir,
    watchtower: {
      zkReceiptRef: buildSyntheticZkReceiptRef('utxoref_challenge_publication')
    },
    aspPolicy: {
      settlementZkReceiptRef: buildSyntheticZkReceiptRef('cooperative_round'),
      forfeitZkReceiptRef: buildSyntheticZkReceiptRef('asp_forfeit_guard')
    }
  });
  assert(fs.existsSync(jsonPath), 'JSON artifact not written');
  assert(fs.existsSync(mdPath), 'markdown artifact not written');
  const verification = verifyProgrammableLightningZkBundle(bundle);
  assert(verification.ok, verification.reason || 'bundle should verify');
  assert(bundle.verification.ok, bundle.verification.reason || 'written bundle should verify');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
