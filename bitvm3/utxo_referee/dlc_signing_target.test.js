/**
 * Run: node bitvm3/utxo_referee/dlc_signing_target.test.js
 *
 * MAIN-3: the host derivation of a signing target agrees with the frozen
 * cross-implementation vectors that the Rust signer is also tested against
 * (native/dlc-signer/tests/signing_target_vectors.json, `cargo test --lib`),
 * and refuses every invalid signing context in them.
 */

const crypto = require('crypto');
const path = require('path');
const { deriveSigningContextTarget } = require('./dlc_signing_target');
const { deriveDlcFundingInternalXonly, buildDlcFundingOutput } = require('./dlc_funding_output');
const { canonicalJson } = require('./dlc_canonical_json');
const { normalizeDlcTransactionSet } = require('./dlc_transaction_validator');

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
  assert(target.oracleEventId === expected.oracleEventId, 'oracle event id differs');
  assert(target.partyPubkeyXs.includes(expected.signerPubkeyX), 'vector signer is not a funding party');
});

for (const invalid of vectors.invalid) {
  test(`host refuses: ${invalid.name}`, () => {
    let threw = false;
    try { deriveSigningContextTarget(invalid.signingContext); } catch (_error) { threw = true; }
    assert(threw, `${invalid.name} was accepted`);
  });
}

// A transaction set as a peer could hand it over: every digest recomputed so
// that only the field under test can make it fail.
const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');
function redigestTransactionSet(set) {
  set.fundingTemplateDigest = sha256Hex(canonicalJson(set.funding));
  set.cetSetDigest = sha256Hex(canonicalJson(set.cets));
  set.refundTransactionDigest = sha256Hex(canonicalJson(set.refund));
  set.feePolicyDigest = sha256Hex(canonicalJson(set.feePolicy));
  set.validationDigest = sha256Hex(canonicalJson({
    fundingTemplateDigest: set.fundingTemplateDigest,
    cetSetDigest: set.cetSetDigest,
    refundTransactionDigest: set.refundTransactionDigest,
    feePolicyDigest: set.feePolicyDigest
  }));
  return set;
}
const vectorTransactionSet = () => JSON.parse(JSON.stringify(vectors.valid.signingContext.transactionSet));

test('the refund delay must be a JSON number: string and BigInt spellings are refused', () => {
  normalizeDlcTransactionSet(redigestTransactionSet(vectorTransactionSet()));
  const csv = vectorTransactionSet().funding.refundCsvBlocks;
  assert(Number.isSafeInteger(csv), 'vector refund delay is not a number');
  // Strings survive canonical JSON, so the funding output itself must refuse them.
  for (const spelling of [String(csv), `0${csv}`]) {
    const set = vectorTransactionSet();
    set.funding.refundCsvBlocks = spelling;
    let error = null;
    try { normalizeDlcTransactionSet(redigestTransactionSet(set)); } catch (err) { error = err; }
    assert(error && /refundCsvBlocks must be an integer/.test(error.message),
      `refund delay ${JSON.stringify(spelling)} was not refused by the funding output check: ${error ? error.message : 'accepted'}`);
  }
  // (A BigInt never reaches the validator: canonical JSON refuses it first.)
  const parties = vectorTransactionSet().funding.partyPubkeyXs;
  for (const spelling of [String(csv), `0${csv}`, BigInt(csv)]) {
    let direct = null;
    try { buildDlcFundingOutput({ partyPubkeyXs: parties, refundCsvBlocks: spelling }); } catch (err) { direct = err; }
    assert(direct && /refundCsvBlocks must be an integer/.test(direct.message),
      `buildDlcFundingOutput accepted ${typeof spelling} ${String(spelling)}`);
  }
});

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
