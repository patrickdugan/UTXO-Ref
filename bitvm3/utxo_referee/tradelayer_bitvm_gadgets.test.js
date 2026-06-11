/**
 * Run: node bitvm3/utxo_referee/tradelayer_bitvm_gadgets.test.js
 */

const {
  sha256, buildBitCommitment, revealBit, buildEquivocationPunishmentScript
} = require('./tradelayer_bitvm_gadgets');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEq(a, e, m) { if (a !== e) throw new Error(m || `expected ${e}, got ${a}`); }

console.log('\n=== TradeLayer BitVM Gadget Tests ===\n');

test('bit commitment preimages hash to the committed digests', () => {
  const c = buildBitCommitment('referee-final-output-bit');
  assertEq(sha256(Buffer.from(c.preimage0, 'hex')).toString('hex'), c.hash0);
  assertEq(sha256(Buffer.from(c.preimage1, 'hex')).toString('hex'), c.hash1);
  assert(c.preimage0 !== c.preimage1, 'preimages must differ');
  assertEq(revealBit(c, 0), c.preimage0);
  assertEq(revealBit(c, 1), c.preimage1);
});

test('equivocation punishment script has the expected tapscript shape', () => {
  const c = buildBitCommitment('seed');
  const challengerXonly = 'a'.repeat(64);
  const script = buildEquivocationPunishmentScript({ hash0: c.hash0, hash1: c.hash1, challengerXonly });
  // a8 20 <hash1> 88 a8 20 <hash0> 88 20 <pk> ac
  const expected = 'a820' + c.hash1 + '88' + 'a820' + c.hash0 + '88' + '20' + challengerXonly + 'ac';
  assertEq(script, expected);
  // length: 2 + 33 + 1 + 2 + 33 + 1 ... = OP+push(2)+32 hash twice + verify, + push pk + checksig
  assertEq(Buffer.from(script, 'hex').length, 1 + 1 + 32 + 1 + 1 + 1 + 32 + 1 + 1 + 32 + 1);
});

test('script rejects malformed inputs', () => {
  let threw = false;
  try { buildEquivocationPunishmentScript({ hash0: 'ab', hash1: 'cd', challengerXonly: 'a'.repeat(64) }); }
  catch (e) { threw = /32 bytes/.test(e.message); }
  assert(threw, 'short hashes must be rejected');
});

if (failed > 0) { console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`); process.exit(1); }
console.log(`\nPASS: ${passed} tests\n`);
