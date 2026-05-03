/**
 * Run: node bitvm3/utxo_referee/tradelayer_utxoref_live_path.test.js
 */

const {
  buildUtxoRefLivePathEvidence,
  verifyUtxoRefLivePathEvidence,
  buildDecodedFinalTxFromSweepPlan
} = require('./tradelayer_utxoref_live_path');
const {
  buildTradeLayerBitvmStackBundle
} = require('./tradelayer_bitvm_stack');

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

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEq(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

console.log('\n=== UTXORef Live Path Evidence Tests ===\n');

test('builds verifiable live path evidence from the stack bundle', () => {
  const evidence = buildUtxoRefLivePathEvidence();
  const result = verifyUtxoRefLivePathEvidence(evidence);

  assert(result.ok, result.reason);
  assert(evidence.evidenceHash.length === 64, 'evidence hash should be present');
  assert(evidence.core.finalTxOutputHash.length === 64, 'final output hash should be present');
  assertEq(evidence.core.stackHash, evidence.stack.stackHash);
  assertEq(evidence.core.finalSpendBindingHash, evidence.finalSpendBinding.bindingHash);
  assertEq(evidence.finalSpendBinding.core.routeTranscriptHash, evidence.stack.sweepPlan.routeTranscriptHash);
  assert(evidence.operatorChecklist.some((item) => item.step === 'final_outputs'), 'missing final output checklist item');
});

test('creates deterministic decoded final transactions from sweep plans', () => {
  const stack = buildTradeLayerBitvmStackBundle();
  const decodedA = buildDecodedFinalTxFromSweepPlan(stack.sweepPlan);
  const decodedB = buildDecodedFinalTxFromSweepPlan(stack.sweepPlan);

  assertEq(decodedA.txid, decodedB.txid);
  assertEq(decodedA.vout.length, stack.sweepPlan.outputs.length);
  assertEq(decodedA.vout[0].scriptPubKey.address, stack.sweepPlan.outputs[0].address);
});

test('detects decoded final output tampering', () => {
  const evidence = buildUtxoRefLivePathEvidence();
  const tampered = clone(evidence);
  tampered.decodedFinalTx.vout[0].value = 0.00001;
  const result = verifyUtxoRefLivePathEvidence(tampered);

  assert(!result.ok, 'tampered final output should fail');
  assert(String(result.reason).includes('decoded final output hash mismatch'), 'expected final output mismatch');
});

test('detects final output challenge tampering', () => {
  const evidence = buildUtxoRefLivePathEvidence();
  const tampered = clone(evidence);
  tampered.finalOutputChallenge.core.claimed.finalTxOutputHash = evidence.core.finalTxOutputHash;
  const result = verifyUtxoRefLivePathEvidence(tampered);

  assert(!result.ok, 'tampered challenge should fail');
  assert(String(result.reason).includes('final output challenge'), 'expected final output challenge failure');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
