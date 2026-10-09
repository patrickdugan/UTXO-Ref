/**
 * Run: node bitvm3/utxo_referee/tradelayer_bitvm_circuit.test.js
 */

const {
  GATES, buildWire, wireHash, wirePreimage, buildRevealScript,
  gateInvalidRows, buildGateDisproveLeaves, findGateFraud, sha256
} = require('./tradelayer_bitvm_circuit');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEq(a, e, m) { if (a !== e) throw new Error(m || `expected ${e}, got ${a}`); }

const CHALLENGER = 'a'.repeat(64);

console.log('\n=== TradeLayer BitVM Circuit (wires + gates) Tests ===\n');

test('gate truth tables are correct', () => {
  assertEq(GATES.and.f(1, 1), 1); assertEq(GATES.and.f(1, 0), 0);
  assertEq(GATES.or.f(0, 0), 0); assertEq(GATES.or.f(1, 0), 1);
  assertEq(GATES.xor.f(1, 1), 0); assertEq(GATES.xor.f(1, 0), 1);
  assertEq(GATES.nand.f(1, 1), 0); assertEq(GATES.nand.f(0, 0), 1);
  assertEq(GATES.not.f(0), 1); assertEq(GATES.not.f(1), 0);
});

test('wire commitments are valid bit commitments', () => {
  const w = buildWire('w');
  assertEq(sha256(Buffer.from(wirePreimage(w, 0), 'hex')).toString('hex'), wireHash(w, 0));
  assertEq(sha256(Buffer.from(wirePreimage(w, 1), 'hex')).toString('hex'), wireHash(w, 1));
});

test('invalid-row counts match truth-table size', () => {
  assertEq(gateInvalidRows('and').length, 4);   // 4 input combos, each one wrong output
  assertEq(gateInvalidRows('xor').length, 4);
  assertEq(gateInvalidRows('not').length, 2);
});

test('a gate instance produces one disprove leaf per invalid row', () => {
  const wires = { inputs: [buildWire('a'), buildWire('b')], output: buildWire('c') };
  const leaves = buildGateDisproveLeaves('and', wires, CHALLENGER);
  assertEq(leaves.length, 4);
  for (const leaf of leaves) assert(leaf.script.length > 0, 'leaf script present');
});

test('honest gate assertion has no satisfiable disprove leaf', () => {
  const wires = { inputs: [buildWire('a'), buildWire('b')], output: buildWire('c') };
  // 1 AND 1 = 1 (honest)
  const fraud = findGateFraud('and', wires, { inputs: [1, 1], output: 1 }, CHALLENGER);
  assertEq(fraud, null);
});

test('fraudulent gate assertion is punishable and the reveals satisfy exactly that leaf', () => {
  const wires = { inputs: [buildWire('a'), buildWire('b')], output: buildWire('c') };
  // prover lies: 1 AND 1 = 0
  const fraud = findGateFraud('and', wires, { inputs: [1, 1], output: 0 }, CHALLENGER);
  assert(fraud, 'fraud must be detected');

  // the disprove leaf for this fraud must be one of the gate's committed leaves
  const leaves = buildGateDisproveLeaves('and', wires, CHALLENGER);
  assert(leaves.some((l) => l.script === fraud.script), 'fraud leaf must be a committed disprove leaf');

  // the prover's revealed preimages hash to exactly the values the leaf checks:
  // a=1, b=1, c=0
  assertEq(sha256(Buffer.from(fraud.revealPreimages[0], 'hex')).toString('hex'), wireHash(wires.inputs[0], 1));
  assertEq(sha256(Buffer.from(fraud.revealPreimages[1], 'hex')).toString('hex'), wireHash(wires.inputs[1], 1));
  assertEq(sha256(Buffer.from(fraud.revealPreimages[2], 'hex')).toString('hex'), wireHash(wires.output, 0));
});

test('NOT gate fraud detection', () => {
  const wires = { inputs: [buildWire('a')], output: buildWire('c') };
  assertEq(findGateFraud('not', wires, { inputs: [0], output: 1 }, CHALLENGER), null); // NOT 0 = 1 honest
  assert(findGateFraud('not', wires, { inputs: [0], output: 0 }, CHALLENGER), 'NOT 0 = 0 is fraud');
});

test('reveal script generalizes the equivocation gadget shape (n hashes)', () => {
  const h = ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)];
  const script = buildRevealScript(h, CHALLENGER);
  // reverse order: hash[2], hash[1], hash[0], then pk + checksig
  const expected = 'a820' + h[2] + '88' + 'a820' + h[1] + '88' + 'a820' + h[0] + '88' + '20' + CHALLENGER + 'ac';
  assertEq(script, expected);
});

if (failed > 0) { console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`); process.exit(1); }
console.log(`\nPASS: ${passed} tests\n`);
