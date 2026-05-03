/**
 * Run: node bitvm3/utxo_referee/tradelayer_utxoref_live_path.test.js
 */

const {
  buildUtxoRefLivePathEvidence,
  verifyUtxoRefLivePathEvidence,
  buildDecodedFinalTxFromSweepPlan,
  buildFinalOutputReview,
  loadDecodedFinalTxFromRpc
} = require('./tradelayer_utxoref_live_path');
const {
  buildTradeLayerBitvmStackBundle
} = require('./tradelayer_bitvm_stack');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
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

async function run() {
await test('builds verifiable live path evidence from the stack bundle', () => {
  const evidence = buildUtxoRefLivePathEvidence();
  const result = verifyUtxoRefLivePathEvidence(evidence);

  assert(result.ok, result.reason);
  assert(evidence.evidenceHash.length === 64, 'evidence hash should be present');
  assert(evidence.core.finalTxOutputHash.length === 64, 'final output hash should be present');
  assert(evidence.finalOutputReview.ok, 'final output review should pass');
  assertEq(evidence.core.finalOutputReviewHash, evidence.finalOutputReview.reviewHash);
  assertEq(evidence.core.stackHash, evidence.stack.stackHash);
  assertEq(evidence.core.finalSpendBindingHash, evidence.finalSpendBinding.bindingHash);
  assertEq(evidence.finalSpendBinding.core.routeTranscriptHash, evidence.stack.sweepPlan.routeTranscriptHash);
  assert(evidence.operatorChecklist.some((item) => item.step === 'final_outputs'), 'missing final output checklist item');
});

await test('creates deterministic decoded final transactions from sweep plans', () => {
  const stack = buildTradeLayerBitvmStackBundle();
  const decodedA = buildDecodedFinalTxFromSweepPlan(stack.sweepPlan);
  const decodedB = buildDecodedFinalTxFromSweepPlan(stack.sweepPlan);

  assertEq(decodedA.txid, decodedB.txid);
  assertEq(decodedA.vout.length, stack.sweepPlan.outputs.length);
  assertEq(decodedA.vout[0].scriptPubKey.address, stack.sweepPlan.outputs[0].address);
});

await test('reviews decoded final outputs against the planned sweep outputs', () => {
  const stack = buildTradeLayerBitvmStackBundle();
  const decoded = buildDecodedFinalTxFromSweepPlan(stack.sweepPlan);
  const review = buildFinalOutputReview(stack.sweepPlan, decoded);

  assert(review.ok, 'expected matching final outputs');
  assertEq(review.core.observedOutputs[0].sats, stack.sweepPlan.outputs[0].sats);
  assertEq(review.core.expectedOutputs.length, stack.sweepPlan.outputs.length);
});

await test('detects decoded final output tampering', () => {
  const evidence = buildUtxoRefLivePathEvidence();
  const tampered = clone(evidence);
  tampered.decodedFinalTx.vout[0].value = 0.00001;
  const result = verifyUtxoRefLivePathEvidence(tampered);

  assert(!result.ok, 'tampered final output should fail');
  assert(String(result.reason).includes('decoded final output hash mismatch'), 'expected final output mismatch');
});

await test('detects semantic final output mismatch even when hashes are rebuilt', () => {
  const stack = buildTradeLayerBitvmStackBundle();
  const decoded = buildDecodedFinalTxFromSweepPlan(stack.sweepPlan);
  decoded.vout[0].value = 0.00001;
  const evidence = buildUtxoRefLivePathEvidence({
    stack,
    decodedFinalTx: decoded
  });
  const result = verifyUtxoRefLivePathEvidence(evidence);

  assert(!result.ok, 'semantic mismatch should fail');
  assert(String(result.reason).includes('final output review failed'), 'expected final output review failure');
  assert(result.mismatchCodes.includes('output_value_mismatch'), 'expected value mismatch');
});

await test('loads decoded final transactions from RPC hex', async () => {
  const calls = [];
  const decoded = await loadDecodedFinalTxFromRpc({
    finalHex: '02000000',
    rpc: async (method, params) => {
      calls.push({ method, params });
      return {
        txid: 'aa'.repeat(32),
        hash: 'bb'.repeat(32),
        vout: []
      };
    }
  });

  assertEq(decoded.txid, 'aa'.repeat(32));
  assertEq(calls[0].method, 'decoderawtransaction');
});

await test('detects final output challenge tampering', () => {
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
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
