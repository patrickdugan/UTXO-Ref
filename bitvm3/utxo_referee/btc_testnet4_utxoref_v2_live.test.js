const { traceValuesForMode } = require('./btc_testnet4_utxoref_v2_live');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

console.log('\n=== Bitcoin Testnet4 UTXORef V2 Live Staging Tests ===\n');

test('honest trace is internally consistent', () => {
  const trace = traceValuesForMode('honest');
  assert(trace.mode === 'honest');
  assert(trace.values.settlement_authorized === 1);
});

test('gate fraud keeps true inputs but asserts a false output', () => {
  const trace = traceValuesForMode('gate');
  assert(trace.values.state_checkpoint_valid === 1);
  assert(trace.values.payout_vector_exact === 1);
  assert(trace.values.settlement_authorized === 0);
});

test('input fraud remains gate-consistent but violates expected input binding', () => {
  const trace = traceValuesForMode('input');
  assert(trace.values.state_checkpoint_valid === 0);
  assert(trace.values.payout_vector_exact === 1);
  assert(trace.values.settlement_authorized === 0);
});

test('unknown fraud modes fail closed', () => {
  let rejected = false;
  try { traceValuesForMode('anything'); }
  catch (err) { rejected = /fraudMode/.test(err.message); }
  assert(rejected);
});

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
