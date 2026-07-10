const crypto = require('crypto');
const {
  buildWireSecretSetV2,
  buildPublicTraceV2,
  verifyPublicTraceV2,
  containsSecretPair,
  buildGateDisproveLeavesV2,
  buildInputBindingLeavesV2,
  findGateDisproveV2,
  findInputBindingDisproveV2
} = require('./bitvm_trace_v2');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

const CHALLENGER = '11'.repeat(32);
const GATES = [{ type: 'and', inputs: ['a', 'b'], output: 'c' }];

function fixture(values) {
  const wireBundle = buildWireSecretSetV2(['a', 'b', 'c']);
  const trace = buildPublicTraceV2({
    circuitId: 'and-v2',
    binding: { commitmentHash: '22'.repeat(32) },
    gates: GATES,
    wireBundle,
    values
  });
  return { wireBundle, trace };
}

console.log('\n=== BitVM Trace V2 Tests ===\n');

test('public trace reveals one preimage per wire and no secret pair', () => {
  const { trace } = fixture({ a: 1, b: 1, c: 1 });
  assert(!containsSecretPair(trace), 'public trace leaked secret pair');
  assert(!JSON.stringify(trace).includes('preimage0'));
  assert(!JSON.stringify(trace).includes('preimage1'));
  assert(verifyPublicTraceV2(trace).ok);
});

test('fresh wire sets are not derivable from a public binding', () => {
  const first = fixture({ a: 1, b: 1, c: 1 });
  const second = fixture({ a: 1, b: 1, c: 1 });
  assert(first.trace.publicWires.a.hash0 !== second.trace.publicWires.a.hash0);
  assert(first.trace.traceRoot !== second.trace.traceRoot);
});

test('honest trace has no constructible invalid-row witness', () => {
  const { trace } = fixture({ a: 1, b: 1, c: 1 });
  const verification = verifyPublicTraceV2(trace);
  assert(verification.ok && verification.frauds.length === 0);
  assert(findGateDisproveV2(trace, CHALLENGER) === null);
});

test('fraudulent trace yields exactly one committed disprove leaf', () => {
  const { trace } = fixture({ a: 1, b: 1, c: 0 });
  const disprove = findGateDisproveV2(trace, CHALLENGER);
  assert(disprove, 'fraud should be challengeable');
  const leaves = buildGateDisproveLeavesV2(GATES, trace.publicWires, CHALLENGER);
  assert(leaves.some((leaf) => leaf.scriptHex === disprove.scriptHex));
  disprove.revealPreimages.forEach((preimage, index) => {
    const labels = ['a', 'b', 'c'];
    const reveal = trace.reveals[labels[index]];
    const expectedHash = reveal.bit ? trace.publicWires[labels[index]].hash1 : trace.publicWires[labels[index]].hash0;
    const actualHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    assert(actualHash === expectedHash);
  });
});

test('input-binding fraud uses only the selected wrong-bit reveal', () => {
  const { trace } = fixture({ a: 1, b: 1, c: 1 });
  const leaves = buildInputBindingLeavesV2({ a: 0 }, trace.publicWires, CHALLENGER);
  const disprove = findInputBindingDisproveV2(trace, { a: 0 }, CHALLENGER);
  assert(disprove);
  assert(leaves[0].scriptHex === disprove.scriptHex);
  assert(disprove.revealPreimages[0] === trace.reveals.a.preimage);
});

test('tampered reveal and leaked opposite preimage are rejected', () => {
  const { trace } = fixture({ a: 1, b: 1, c: 1 });
  const tampered = JSON.parse(JSON.stringify(trace));
  tampered.reveals.a.preimage = 'ff'.repeat(32);
  assert(!verifyPublicTraceV2(tampered).ok);

  const leaked = JSON.parse(JSON.stringify(trace));
  leaked.reveals.a.preimage0 = '00'.repeat(32);
  assert(!verifyPublicTraceV2(leaked).ok);
});

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
