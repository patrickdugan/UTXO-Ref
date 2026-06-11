/**
 * Run: node bitvm3/utxo_referee/tradelayer_bitvm_comparator.test.js
 */

const crypto = require('crypto');
const {
  buildComparatorCircuit, evaluateComparator, commitCircuitWires,
  buildComparatorDisproveLeaves, findComparatorFraud
} = require('./tradelayer_bitvm_comparator');
const { sha256, wireHash } = require('./tradelayer_bitvm_circuit');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEq(a, e, m) { if (a !== e) throw new Error(m || `expected ${e}, got ${a}`); }

const CHALLENGER = 'a'.repeat(64);

console.log('\n=== TradeLayer BitVM Comparator (cap <= reserve) Tests ===\n');

test('comparator computes cap <= reserve for random values', () => {
  const circuit = buildComparatorCircuit(16);
  for (let i = 0; i < 200; i++) {
    const reserve = Math.floor(Math.random() * 65536);
    const cap = Math.floor(Math.random() * 65536);
    const trace = evaluateComparator(circuit, reserve, cap);
    const expected = cap <= reserve ? 1 : 0;
    assertEq(trace.solvent, expected, `reserve=${reserve} cap=${cap}`);
  }
});

test('boundary cases', () => {
  const circuit = buildComparatorCircuit(16);
  assertEq(evaluateComparator(circuit, 100, 100).solvent, 1, 'equal -> solvent');
  assertEq(evaluateComparator(circuit, 100, 101).solvent, 0, 'cap just over -> insolvent');
  assertEq(evaluateComparator(circuit, 0, 0).solvent, 1);
  assertEq(evaluateComparator(circuit, 65535, 0).solvent, 1);
  assertEq(evaluateComparator(circuit, 0, 65535).solvent, 0);
});

test('honest trace has no satisfiable disprove leaf', () => {
  const circuit = buildComparatorCircuit(16);
  const wireMap = commitCircuitWires(circuit);
  const trace = evaluateComparator(circuit, 17164718 & 0xffff, 99000 & 0xffff);
  assertEq(findComparatorFraud(circuit, wireMap, trace, CHALLENGER), null);
});

test('a tampered solvency claim is localized to exactly one bad gate', () => {
  const circuit = buildComparatorCircuit(16);
  const wireMap = commitCircuitWires(circuit);
  // reserve < cap (truly insolvent) but prover flips the final solvent bit to claim solvent
  const trace = evaluateComparator(circuit, 1000, 2000);
  assertEq(trace.solvent, 0, 'truly insolvent');
  trace.solvent = 1; // the lie

  const fraud = findComparatorFraud(circuit, wireMap, trace, CHALLENGER);
  assert(fraud, 'tampered output must be caught');
  assertEq(fraud.gate.output, 'solvent', 'the inconsistency is at the final NOT gate');
  // the disprove leaf must be one of the circuit's committed leaves
  const leaves = buildComparatorDisproveLeaves(circuit, wireMap, CHALLENGER);
  assert(leaves.some((l) => l.script === fraud.script), 'fraud leaf is a committed disprove leaf');
  // reveals hash to the claimed (inconsistent) wire values
  fraud.gate.inputs.forEach((l, i) => assertEq(sha256(Buffer.from(fraud.revealPreimages[i], 'hex')).toString('hex'), wireHash(wireMap[l], trace[l])));
});

test('a flipped internal wire is also caught', () => {
  const circuit = buildComparatorCircuit(16);
  const wireMap = commitCircuitWires(circuit);
  const trace = evaluateComparator(circuit, 5000, 4000); // solvent
  // flip an internal borrow wire to corrupt the chain
  const internal = circuit.labels.find((l) => l.startsWith('borrow'));
  trace[internal] = 1 - trace[internal];
  const fraud = findComparatorFraud(circuit, wireMap, trace, CHALLENGER);
  assert(fraud, 'internal tamper must be caught at some gate');
});

test('disprove leaf count is gates x invalid-rows', () => {
  const circuit = buildComparatorCircuit(8);
  const wireMap = commitCircuitWires(circuit);
  const leaves = buildComparatorDisproveLeaves(circuit, wireMap, CHALLENGER);
  let expected = 0;
  for (const g of circuit.gates) expected += (g.inputs.length === 1 ? 2 : 4);
  assertEq(leaves.length, expected);
});

if (failed > 0) { console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`); process.exit(1); }
console.log(`\nPASS: ${passed} tests\n`);
