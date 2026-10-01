const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseJsonStrict,
  readJsonStrict
} = require('./strict_artifact_ingress');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
function rejects(text, pattern, options) {
  try { parseJsonStrict(text, 'fixture', options); }
  catch (err) { return pattern.test(err.message); }
  return false;
}

test('accepts canonical UTXORef-shaped JSON', () => {
  const value = parseJsonStrict(JSON.stringify({
    kind: 'utxoref_commitment_v2',
    version: 2,
    contractId: 'contract-1',
    feeSats: '1000',
    payouts: [{ role: 'winner', amountSats: '9000' }]
  }));
  assert(value.feeSats === '1000');
});

test('rejects duplicate direct and escaped object keys', () => {
  assert(rejects('{"kind":"a","kind":"b"}', /duplicate object key/));
  assert(rejects('{"a":1,"\\u0061":2}', /duplicate object key/));
});

test('treats special object keys as data without mutating prototypes', () => {
  const parsed = parseJsonStrict('{"__proto__":{"polluted":true},"constructor":"data"}');
  assert(Object.prototype.polluted === undefined, 'Object.prototype must remain unchanged');
  assert(Object.prototype.hasOwnProperty.call(parsed, '__proto__'), '__proto__ must be an own data property');
  assert(JSON.stringify(parsed.__proto__) === '{"polluted":true}', '__proto__ data must be preserved');
  assert(parsed.constructor === 'data', 'constructor data must be preserved');
});

test('rejects exponent, negative zero, and unsafe integer fields', () => {
  assert(rejects('{"feeSats":1e3}', /exponent-form/));
  assert(rejects('{"version":-0}', /negative zero/));
  assert(rejects('{"snapshotHeight":9007199254740992}', /safe integer/));
});

test('rejects fractional and noncanonical integer strings', () => {
  assert(rejects('{"feeSats":1.5}', /safe integer/));
  assert(rejects('{"feeSats":"01"}', /canonical integer string/));
  assert(rejects('{"feeSats":"+1"}', /canonical integer string/));
});

test('accepts exact integers larger than the JS safe range as strings', () => {
  const value = parseJsonStrict('{"amountSats":"9007199254740993"}');
  assert(value.amountSats === '9007199254740993');
});

test('rejects Unicode schema keys and identifier values', () => {
  assert(rejects('{"k\\u0456nd":"x"}', /printable ASCII/));
  assert(rejects('{"contractId":"contr\\u0430ct"}', /identifier must be printable ASCII/));
});

test('rejects unpaired Unicode surrogates', () => {
  assert(rejects('{"note":"\\ud800"}', /unpaired high surrogate/));
  assert(rejects('{"note":"\\udc00"}', /unpaired low surrogate/));
});

test('enforces byte, depth, node, object, array, and string limits', () => {
  assert(rejects('{"a":"12345"}', /exceeds 8 bytes/, { maxBytes: 8 }));
  assert(rejects('{"a":{"b":{"c":1}}}', /nesting depth/, { maxDepth: 2 }));
  assert(rejects('[1,2,3]', /node count/, { maxTotalNodes: 3 }));
  assert(rejects('{"a":1,"b":2}', /object key count/, { maxObjectKeys: 1 }));
  assert(rejects('[1,2]', /array item count/, { maxArrayItems: 1 }));
  assert(rejects('{"note":"abc"}', /string exceeds/, { maxStringBytes: 2 }));
});

test('rejects malformed and trailing JSON without executing a permissive parser', () => {
  assert(rejects('{"a":1,}', /expected string/));
  assert(rejects('{"a":1} garbage', /trailing data/));
  assert(rejects('{"a":"\\x41"}', /invalid escape/));
});

test('readJsonStrict checks regular file size before parsing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-strict-json-'));
  const file = path.join(root, 'artifact.json');
  fs.writeFileSync(file, '{"kind":"ok"}\n');
  assert(readJsonStrict(file).kind === 'ok');
  let rejected = false;
  try { readJsonStrict(file, 'fixture', { maxBytes: 4 }); }
  catch (err) { rejected = /exceeds 4 bytes/.test(err.message); }
  assert(rejected);
  fs.rmSync(root, { recursive: true, force: true });
});

test('readJsonStrict rejects malformed UTF-8 bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-strict-utf8-'));
  try {
    const artifactPath = path.join(root, 'artifact.json');
    fs.writeFileSync(artifactPath, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
    let error;
    try { readJsonStrict(artifactPath); } catch (err) { error = err; }
    assert(error && /not valid UTF-8/.test(error.message), 'malformed UTF-8 must fail closed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

let passed = 0;
let failed = 0;
for (const item of tests) {
  try { item.fn(); console.log(`  OK  ${item.name}`); passed += 1; }
  catch (err) { console.log(`  FAIL ${item.name}\n       ${err.message}`); failed += 1; }
}
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
