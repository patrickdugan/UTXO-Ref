/**
 * Run: node bitvm3/utxo_referee/tradelayer_trace_publication.test.js
 *
 * Validates SECURITY_BLOCKERS.md #6: a bonded circuit's wire trace can be
 * published and retrieved with hash verification, substitution/corruption
 * is detected, and - the actual soundness rule - a trace that is not
 * retrievable within the SLA window is itself treated as a fault.
 */

const fs = require('fs');
const path = require('path');
const {
  hashTrace,
  publishTrace,
  retrieveTrace,
  checkPublicationFault
} = require('./tradelayer_trace_publication');
const { buildComparatorCircuit, commitCircuitWires } = require('./tradelayer_bitvm_comparator');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
function assertEq(x, e, msg) { if (x !== e) throw new Error(msg || `expected ${e}, got ${x}`); }

const TMP_DIR = path.join(__dirname, 'artifacts', 'live', 'test-tmp');
function tmpTracePath(name) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  return path.join(TMP_DIR, `trace_${name}_${process.pid}.json`);
}

console.log('\n=== TradeLayer Trace Publication Tests (SECURITY_BLOCKERS.md #6) ===\n');

test('publishing a real circuit wire trace and retrieving it round-trips exactly', () => {
  const circuit = buildComparatorCircuit(8);
  const wireMap = commitCircuitWires(circuit);
  const retrievalPath = tmpTracePath('roundtrip');

  const commitment = publishTrace(wireMap, { retrievalPath, publishedAtHeight: 1000 });
  assertEq(commitment.traceHash, hashTrace(wireMap));
  assert(fs.existsSync(retrievalPath), 'trace file should exist after publishing');

  const retrieved = retrieveTrace(commitment.traceHash, retrievalPath);
  assertEq(JSON.stringify(retrieved), JSON.stringify(wireMap), 'retrieved trace must match the published one exactly');
});

test('retrieving a trace that was never published throws TRACE_NOT_AVAILABLE', () => {
  const retrievalPath = tmpTracePath('never-published');
  if (fs.existsSync(retrievalPath)) fs.unlinkSync(retrievalPath);
  let threw = null;
  try { retrieveTrace('deadbeef'.repeat(8), retrievalPath); } catch (err) { threw = err; }
  assert(threw && threw.code === 'TRACE_NOT_AVAILABLE');
});

test('a substituted (tampered) trace fails hash verification on retrieval', () => {
  const retrievalPath = tmpTracePath('substituted');
  const original = { wireA: 'commitment-a', wireB: 'commitment-b' };
  const commitment = publishTrace(original, { retrievalPath });

  // Someone swaps in a different trace at the same retrieval path.
  fs.writeFileSync(retrievalPath, JSON.stringify({ wireA: 'DIFFERENT', wireB: 'commitment-b' }));

  let threw = null;
  try { retrieveTrace(commitment.traceHash, retrievalPath); } catch (err) { threw = err; }
  assert(threw && threw.code === 'TRACE_HASH_MISMATCH', 'substituted trace must be detected, not silently accepted');
});

test('a published trace, retrieved within the SLA window, is not a fault', () => {
  const retrievalPath = tmpTracePath('within-sla');
  const commitment = publishTrace({ some: 'trace' }, { retrievalPath, publishedAtHeight: 1000 });
  const result = checkPublicationFault({
    traceHash: commitment.traceHash, retrievalPath, bondedAtHeight: 1000, currentHeight: 1003, slaBlocks: 6
  });
  assert(!result.fault, 'trace is retrievable and hash-verified - no fault');
});

test('an unpublished trace still inside the SLA grace period is not yet a fault', () => {
  const retrievalPath = tmpTracePath('grace-period');
  const result = checkPublicationFault({
    traceHash: 'aa'.repeat(32), retrievalPath, bondedAtHeight: 1000, currentHeight: 1002, slaBlocks: 6
  });
  assert(!result.fault, 'still within the grace period - not yet a fault');
  assert(result.withinSla === true);
});

test('an unpublished trace past the SLA window IS a fault - the actual soundness rule', () => {
  const retrievalPath = tmpTracePath('sla-expired');
  const result = checkPublicationFault({
    traceHash: 'bb'.repeat(32), retrievalPath, bondedAtHeight: 1000, currentHeight: 1010, slaBlocks: 6
  });
  assert(result.fault === true, 'withholding the trace past the SLA must itself be a fault');
  assert(/TRACE_WITHHOLDING_FAULT/.test(result.reason));
});

test('a published-but-then-corrupted trace past the SLA window is also a fault, not silently trusted', () => {
  const retrievalPath = tmpTracePath('corrupted-late');
  const commitment = publishTrace({ some: 'trace' }, { retrievalPath, publishedAtHeight: 1000 });
  fs.writeFileSync(retrievalPath, JSON.stringify({ some: 'CORRUPTED' }));
  const result = checkPublicationFault({
    traceHash: commitment.traceHash, retrievalPath, bondedAtHeight: 1000, currentHeight: 1010, slaBlocks: 6
  });
  assert(result.fault === true, 'a corrupted trace is exactly as bad as a missing one for soundness purposes');
});

console.log(`\nPASS: ${passed} tests${failed ? `, FAIL: ${failed}` : ''}`);
if (failed > 0) process.exit(1);
