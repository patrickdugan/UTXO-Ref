/**
 * Run: node bitvm3/utxo_referee/tradelayer_bitvm_sha256.test.js
 */

const crypto = require('crypto');
const { buildSha256Circuit, evaluateSha256 } = require('./tradelayer_bitvm_sha256');
const circ = require('./tradelayer_bitvm_circuit');
const sol = require('./tradelayer_bitvm_solvency_referee');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEq(a, e, m) { if (a !== e) throw new Error(m || `expected ${e}, got ${a}`); }

console.log('\n=== TradeLayer BitVM SHA256 Circuit Tests ===\n');

test('SHA256 circuit matches the reference for NIST + random inputs', () => {
  for (const msg of ['abc', '', 'The quick brown fox jumps over the lazy dog', 'tradelayer-utxoref']) {
    const buf = Buffer.from(msg);
    const built = buildSha256Circuit(buf.length);
    const out = evaluateSha256(built, buf).digestHex;
    assertEq(out, crypto.createHash('sha256').update(buf).digest('hex'), `msg="${msg}"`);
  }
  for (let i = 0; i < 5; i++) {
    const buf = crypto.randomBytes(1 + Math.floor(Math.random() * 40));
    const built = buildSha256Circuit(buf.length);
    assertEq(evaluateSha256(built, buf).digestHex, crypto.createHash('sha256').update(buf).digest('hex'), `random ${buf.length}B`);
  }
});

test('a tampered SHA256 gate is localized to exactly that gate', () => {
  const buf = Buffer.from('utxoref-final-output');
  const built = buildSha256Circuit(buf.length);
  const wireMap = sol.commitBoundWires({ labels: built.labels }, 'sha256-fraud');
  const { trace } = evaluateSha256(built, buf);
  // honest trace: no fraud
  assertEq(circ.findGatesFraud(built.gates, wireMap, trace, 'a'.repeat(64)), null);
  // tamper one gate's output deep in the circuit
  const victim = built.gates[Math.floor(built.gates.length / 2)];
  trace[victim.output] = 1 - trace[victim.output];
  const fraud = circ.findGatesFraud(built.gates, wireMap, trace, 'a'.repeat(64));
  assert(fraud, 'tampered gate must be caught');
  assertEq(fraud.gate.output, victim.output, 'localized to the tampered gate (first inconsistency)');
});

test('gate count is in the expected SHA256 range (single block)', () => {
  const built = buildSha256Circuit(20);
  assert(built.gates.length > 90000 && built.gates.length < 130000, `unexpected gate count ${built.gates.length}`);
});

if (failed > 0) { console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`); process.exit(1); }
console.log(`\nPASS: ${passed} tests\n`);
