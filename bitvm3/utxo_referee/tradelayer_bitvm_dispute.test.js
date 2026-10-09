/**
 * Run: node bitvm3/utxo_referee/tradelayer_bitvm_dispute.test.js
 */

const {
  pushScriptNum, csvSequence, buildTimeoutLeafScript, buildDisputeTree, tapLeafHash
} = require('./tradelayer_bitvm_dispute');
const cmp = require('./tradelayer_bitvm_comparator');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEq(a, e, m) { if (a !== e) throw new Error(m || `expected ${e}, got ${a}`); }

console.log('\n=== TradeLayer BitVM Dispute Tree Tests ===\n');

test('script-number push is minimal', () => {
  assertEq(pushScriptNum(1).toString('hex'), '51');   // OP_1
  assertEq(pushScriptNum(16).toString('hex'), '60');  // OP_16
  assertEq(pushScriptNum(144).toString('hex'), '029000'); // len2, 0x0090 LE (144), positive
});

test('csv sequence is block-based and enabled', () => {
  assertEq(csvSequence(2), 2);
  assertEq(csvSequence(144), 144);
});

test('timeout leaf script has CSV + CHECKSIG shape', () => {
  const pk = 'a'.repeat(64);
  const s = buildTimeoutLeafScript(pk, 2);
  // OP_2 (52) OP_CSV (b2) OP_DROP (75) PUSH32 (20) <pk> OP_CHECKSIG (ac)
  assertEq(s, '52' + 'b2' + '75' + '20' + pk + 'ac');
});

test('dispute tree contains the timeout leaf and all disprove leaves', () => {
  const circuit = cmp.buildComparatorCircuit(8);
  const wireMap = cmp.commitCircuitWires(circuit);
  const challengerXonly = 'b'.repeat(64);
  const operatorXonly = 'a'.repeat(64);
  const disproveScripts = cmp.buildComparatorDisproveLeaves(circuit, wireMap, challengerXonly).map((l) => l.script);
  const dispute = buildDisputeTree({ disproveScripts, operatorXonly, csvDelay: 2 });

  assertEq(dispute.leaves.length, disproveScripts.length + 1, 'all disprove leaves + 1 timeout leaf');
  assert(dispute.timeoutLeaf, 'timeout leaf present');
  // the timeout leaf hash matches the standalone leaf hash
  assertEq(dispute.timeoutLeaf.leafHash.toString('hex'), tapLeafHash(dispute.timeoutScript).toString('hex'));
  // the timeout leaf has a merkle path proving membership
  assert(dispute.timeoutLeaf.path.length > 0, 'timeout leaf has a merkle path');
});

if (failed > 0) { console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`); process.exit(1); }
console.log(`\nPASS: ${passed} tests\n`);
