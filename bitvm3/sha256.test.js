const crypto = require('crypto');
const { Circuit } = require('./circuit');
const { evaluateCircuit } = require('./witness');
const { sha256Pair, bufferToBits, bitsToBuffer, sha256PairCircuit } = require('./sha256');

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

function assertBufferEq(actual, expected, message) {
  assert(actual.equals(expected), message || `expected ${expected.toString('hex')}, got ${actual.toString('hex')}`);
}

function evaluatePairHash(left, right) {
  const circuit = new Circuit('sha256_pair_hash');
  const leftInput = circuit.addInput(256, 'left');
  const rightInput = circuit.addInput(256, 'right');
  const output = sha256PairCircuit(circuit, leftInput, rightInput);
  circuit.setOutputs(output);
  const evaluated = evaluateCircuit(circuit, [
    ...bufferToBits(left, 256),
    ...bufferToBits(right, 256)
  ]);
  return bitsToBuffer(evaluated);
}

console.log('\n=== SHA256 Circuit Tests ===\n');

test('sha256Pair matches Node crypto for zero pair', () => {
  const left = Buffer.alloc(32, 0x00);
  const right = Buffer.alloc(32, 0x00);
  const actual = evaluatePairHash(left, right);
  const expected = sha256Pair(left, right);
  assertBufferEq(actual, expected);
});

test('sha256Pair circuit matches Node crypto for deterministic vector', () => {
  const left = crypto.createHash('sha256').update('left-seed').digest();
  const right = crypto.createHash('sha256').update('right-seed').digest();
  const actual = evaluatePairHash(left, right);
  const expected = sha256Pair(left, right);
  assertBufferEq(actual, expected);
});

console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
