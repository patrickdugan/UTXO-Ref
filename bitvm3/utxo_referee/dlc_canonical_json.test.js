/**
 * Run: node bitvm3/utxo_referee/dlc_canonical_json.test.js
 *
 * Pins the shared digest, hex and ordering helpers that every DLC module now
 * imports. The DLC modules must agree on these bytes and orders, because the
 * digests they produce are compared across modules and with the native signer.
 */

const crypto = require('crypto');
const {
  compareCodeUnits,
  requireHash,
  requireHex,
  sha256,
  sha256Hex
} = require('./dlc_canonical_json');
const { ALL_EVIDENCE_KINDS } = require('./dlc_contract_state');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
function throwsWith(fn, pattern) {
  try { fn(); } catch (err) {
    assert(pattern.test(err.message), `unexpected error: ${err.message}`);
    return;
  }
  throw new Error(`expected ${pattern}`);
}

console.log('\n=== DLC Canonical Helper Tests ===\n');

test('sha256Hex and sha256 agree with the standard digest', () => {
  assert(sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'sha256Hex of "abc" differs');
  assert(sha256Hex(Buffer.from('abc')) === sha256Hex('abc'), 'string and Buffer inputs differ');
  assert(sha256('abc').equals(Buffer.from(sha256Hex('abc'), 'hex')), 'sha256 and sha256Hex differ');
  assert(sha256Hex('') === crypto.createHash('sha256').update('').digest('hex'), 'empty input differs');
});

test('requireHash accepts only lowercase 32-byte hex', () => {
  const good = 'ab'.repeat(32);
  assert(requireHash(good, 'digest') === good, 'valid hash rejected');
  throwsWith(() => requireHash('AB'.repeat(32), 'digest'), /digest must be lowercase 32-byte hex/);
  throwsWith(() => requireHash('ab'.repeat(31), 'digest'), /digest must be lowercase 32-byte hex/);
  throwsWith(() => requireHash(null, 'digest'), /digest must be lowercase 32-byte hex/);
});

test('requireHex honours the byte length it is given', () => {
  assert(requireHex('cd'.repeat(20), 20, 'key') === 'cd'.repeat(20), 'valid 20-byte hex rejected');
  throwsWith(() => requireHex('cd'.repeat(32), 20, 'key'), /key must be lowercase 20-byte hex/);
});

test('compareCodeUnits orders by code unit and returns a sign', () => {
  assert(compareCodeUnits('a', 'a') === 0, 'equal strings must compare as 0');
  assert(compareCodeUnits('a', 'b') < 0 && compareCodeUnits('b', 'a') > 0, 'order is inverted');
  assert(compareCodeUnits('Z', 'a') < 0, 'uppercase must sort before lowercase');
  assert(compareCodeUnits('10', '1:') < 0 && compareCodeUnits('1:', '10') > 0,
    'punctuation must order by code unit (":" after digits), not by locale');
});

test('evidence kinds keep the code-unit order the native signer uses', () => {
  const sorted = [...ALL_EVIDENCE_KINDS].sort(compareCodeUnits);
  assert(sorted.length === ALL_EVIDENCE_KINDS.length &&
    sorted.every((kind, index) => kind === ALL_EVIDENCE_KINDS[index]),
  'evidence kind order differs from code-unit order');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
