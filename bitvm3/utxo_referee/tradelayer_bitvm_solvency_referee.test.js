/**
 * Run: node bitvm3/utxo_referee/tradelayer_bitvm_solvency_referee.test.js
 */

const cmp = require('./tradelayer_bitvm_comparator');
const sol = require('./tradelayer_bitvm_solvency_referee');
const { sha256, wireHash } = require('./tradelayer_bitvm_circuit');
const r = require('./index');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEq(a, e, m) { if (a !== e) throw new Error(m || `expected ${e}, got ${a}`); }

const CHALLENGER = 'b'.repeat(64);
const OPERATOR = 'a'.repeat(64);

console.log('\n=== TradeLayer BitVM Solvency Referee (input binding) Tests ===\n');

test('bound wire commitments are deterministic from the reconciliation hash', () => {
  const circuit = cmp.buildComparatorCircuit(8);
  const w1 = sol.commitBoundWires(circuit, 'recon-hash-x');
  const w2 = sol.commitBoundWires(circuit, 'recon-hash-x');
  const w3 = sol.commitBoundWires(circuit, 'recon-hash-y');
  assertEq(w1.r0.hash0, w2.r0.hash0, 'same seed -> same commitment');
  assert(w1.r0.hash0 !== w3.r0.hash0, 'different reconciliation -> different commitment');
});

test('honest inputs have no satisfiable input-binding leaf', () => {
  const circuit = cmp.buildComparatorCircuit(8);
  const wireMap = sol.commitBoundWires(circuit, 'h');
  const reserve = 200; const cap = 100;
  const asserted = { r: sol.valueBits(reserve, 8), c: sol.valueBits(cap, 8) };
  assertEq(sol.findInputFraud(circuit, wireMap, reserve, cap, asserted, CHALLENGER), null);
});

test('a faked input bit is caught by the binding leaf and the reveal matches', () => {
  const circuit = cmp.buildComparatorCircuit(8);
  const wireMap = sol.commitBoundWires(circuit, 'h');
  const reserve = 100; const cap = 200; // truly insolvent
  const fakedR = sol.valueBits(reserve, 8); fakedR[7] = 1; // inflate reserve to claim solvent
  const asserted = { r: fakedR, c: sol.valueBits(cap, 8) };
  const fraud = sol.findInputFraud(circuit, wireMap, reserve, cap, asserted, CHALLENGER);
  assert(fraud, 'faked input must be caught');
  assertEq(fraud.wire, 'r7');
  // the binding leaf is one of the committed input-binding leaves
  const leaves = sol.buildInputBindingLeaves(circuit, wireMap, reserve, cap, CHALLENGER);
  assert(leaves.some((l) => l.script === fraud.script), 'fraud leaf is a committed input-binding leaf');
  // the reveal hashes to the operator's wrong-bit commitment
  assertEq(sha256(Buffer.from(fraud.revealPreimages[0], 'hex')).toString('hex'), wireHash(wireMap.r7, 1));
});

test('full assert tree = gate leaves + input-binding leaves + timeout leaf', () => {
  const circuit = cmp.buildComparatorCircuit(8);
  const wireMap = sol.commitBoundWires(circuit, 'h');
  const tree = sol.buildSolvencyAssertTree({ circuit, wireMap, reserve: 200, cap: 100, challengerXonly: CHALLENGER, operatorXonly: OPERATOR, csvDelay: 2 });
  assertEq(tree.inputLeafCount, 16, '8 r-bits + 8 c-bits');
  assertEq(tree.leaves.length, tree.gateLeafCount + tree.inputLeafCount + 1, 'gate + input + timeout');
  assert(tree.timeoutLeaf, 'timeout leaf present');
});

test('binds to a real reconciliation from the reserve referee', () => {
  // build a real (insolvent) reconciliation via the referee shipped at the start
  const queue = r.buildTradeLayerWithdrawalQueue({ requests: [{ id: 'w1', txid: '11'.repeat(32), address: 'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz', sats: 200000 }] });
  const recon = r.buildTradeLayerReserveReconciliation({ queue, reserve: 100000 });
  assert(!recon.solvent, 'reserve 100000 < cap 200000 -> insolvent');
  const circuit = cmp.buildComparatorCircuit(32);
  const wireMap = sol.commitBoundWires(circuit, recon.reconciliationHash);
  const reserve = Number(recon.core.reservedSats); const cap = Number(recon.core.capSats);
  // honest circuit evaluation says insolvent
  const trace = cmp.evaluateComparator(circuit, reserve, cap);
  assertEq(trace.solvent, 0, 'circuit agrees: insolvent');
  // operator who feeds the honest inputs cannot reach solvent without a gate lie
  assertEq(sol.findInputFraud(circuit, wireMap, reserve, cap, { r: sol.valueBits(reserve, 32), c: sol.valueBits(cap, 32) }, CHALLENGER), null);
});

if (failed > 0) { console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`); process.exit(1); }
console.log(`\nPASS: ${passed} tests\n`);
