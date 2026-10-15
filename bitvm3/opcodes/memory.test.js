/**
 * Run: node bitvm3/opcodes/memory.test.js
 */

const assert = require('assert');
const { Circuit } = require('../circuit');
const { LoadWordConstraint } = require('./memory');

function wires() {
  const circuit = new Circuit('lw');
  return {
    circuit,
    inputs: {
      rs1: circuit.addInput(32, 'rs1'),
      imm: circuit.addInput(32, 'imm'),
      memValue: circuit.addInput(32, 'memValue'),
      rdClaimed: circuit.addInput(32, 'rdClaimed')
    }
  };
}

const tests = [
  ['a load without a Merkle proof builds its value check', () => {
    const { circuit, inputs } = wires();
    new LoadWordConstraint().constrain(circuit, inputs);
  }],
  ['a load with a Merkle proof is refused, never accepted by a constant-true wire', () => {
    const { circuit, inputs } = wires();
    assert.throws(
      () => new LoadWordConstraint().constrain(circuit, { ...inputs, merkleProof: { siblings: [], root: null } }),
      /not wired into the opcode circuit/
    );
  }]
];

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  OK  ${name}`); }
  catch (err) { failed++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${tests.length - failed} passed${failed ? `, ${failed} failed` : ''}`);
if (failed) process.exit(1);
