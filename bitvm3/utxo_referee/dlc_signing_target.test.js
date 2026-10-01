/**
 * Run: node bitvm3/utxo_referee/dlc_signing_target.test.js
 *
 * MAIN-3: the host derivation of a signing target agrees with the frozen
 * cross-implementation vectors that the Rust signer is also tested against
 * (native/dlc-signer/tests/signing_target_vectors.json, `cargo test --lib`),
 * and refuses every invalid signing context in them.
 */

const path = require('path');
const { deriveSigningContextTarget } = require('./dlc_signing_target');
const { deriveDlcFundingInternalXonly } = require('./dlc_funding_output');

const vectors = require(path.join(__dirname, '..', '..', 'native', 'dlc-signer', 'tests', 'signing_target_vectors.json'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

console.log('\n=== DLC Signing Target Vector Tests ===\n');

test('host derives the vector signing target', () => {
  const expected = vectors.valid.expected;
  const target = deriveSigningContextTarget(vectors.valid.signingContext);
  assert(deriveDlcFundingInternalXonly() === expected.internalXonly, 'NUMS internal key differs');
  assert(target.sighash === expected.sighash, 'sighash differs');
  assert(target.adaptorPoint.x === expected.adaptorPoint.x && target.adaptorPoint.y === expected.adaptorPoint.y,
    'adaptor point differs');
  assert(target.cetSetDigest === expected.cetSetDigest, 'CET set digest differs');
  assert(target.fundingTemplateDigest === expected.fundingTemplateDigest, 'funding template digest differs');
  assert(target.oracleAnnouncementsDigest === expected.oracleAnnouncementsDigest, 'announcement digest differs');
  assert(target.cetTxid === expected.cetTxid, 'CET txid differs');
  assert(target.partyPubkeyXs.includes(expected.signerPubkeyX), 'vector signer is not a funding party');
});

for (const invalid of vectors.invalid) {
  test(`host refuses: ${invalid.name}`, () => {
    let threw = false;
    try { deriveSigningContextTarget(invalid.signingContext); } catch (_error) { threw = true; }
    assert(threw, `${invalid.name} was accepted`);
  });
}

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
