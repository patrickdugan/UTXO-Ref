/**
 * Run: node bitvm3/utxo_referee/tradelayer_dlc_cet_oracle_selection.test.js
 */

const crypto = require('crypto');
const {
  OUTCOME_IDS,
  buildDlcSettlementOutcomes,
  buildDlcOracleAttestation,
  verifyDlcOracleAttestation,
  selectCetForAttestation
} = require('./tradelayer_dlc_cet_oracle_selection');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEq(a, e, m) { if (a !== e) throw new Error(m || `expected ${e}, got ${a}`); }

const ADDRESSES = {
  alice: 'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz',
  bob: 'tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22',
  operator: 'tltc1qop',
  residual: 'tltc1q2hjwxlj8muw5kq2r56ms9794zzz7st0kryffl4'
};
const FUNDING = { contractId: 'dlc-test-77', fundingTxid: 'ab'.repeat(32), fundingVout: 0 };

function outcomes() {
  return buildDlcSettlementOutcomes({
    collateralSats: 150000,
    minerFeeSats: 1000,
    bucketCapBps: 500,
    realizedPnlBps: 500,
    feeBps: 100,
    addresses: ADDRESSES
  });
}

console.log('\n=== TradeLayer DLC CET Oracle Selection Tests ===\n');

test('builds three settlement outcomes that conserve collateral minus miner fee', () => {
  const o = outcomes();
  assertEq(o.outcomes.length, 3);
  assertEq(o.outcomes.map((x) => x.outcomeId).join(','), OUTCOME_IDS.join(','));
  for (const outcome of o.outcomes) {
    assertEq(outcome.totalOutSats, '149000', `${outcome.outcomeId} should spend collateral - minerFee`);
  }
  // settle-gain: alice wins the 5% payout (7500), operator fee 1% (1500), residual rest - fee
  const gain = o.outcomes.find((x) => x.outcomeId === 'settle-gain');
  assertEq(gain.outputsSats[ADDRESSES.alice], '7500');
  assertEq(gain.outputsSats[ADDRESSES.operator], '1500');
});

test('oracle attestation verifies and is tamper-evident', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const att = buildDlcOracleAttestation({ ...FUNDING, outcomeId: 'settle-gain' }, privateKey);
  assert(verifyDlcOracleAttestation(att, publicKey).ok, 'valid attestation should verify');

  const tampered = { ...att, outcomeId: 'settle-loss' };
  assert(!verifyDlcOracleAttestation(tampered, publicKey).ok, 'outcome swap must fail verification');

  const { publicKey: otherPub } = crypto.generateKeyPairSync('ed25519');
  assert(!verifyDlcOracleAttestation(att, otherPub).ok, 'wrong key must fail');
});

test('selects the CET matching the attested outcome', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const o = outcomes();
  const att = buildDlcOracleAttestation({ ...FUNDING, outcomeId: 'settle-loss' }, privateKey);
  const sel = selectCetForAttestation(o, att, { publicKey, ...FUNDING });
  assertEq(sel.selection.outcomeId, 'settle-loss');
  assertEq(sel.selection.winnerRole, 'bob');
  assertEq(sel.selection.outputsSats[ADDRESSES.bob], '7500');
  assert(sel.selectionHash.length === 64, 'selection hash present');
});

test('rejects selection when attestation does not bind the funding outpoint', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const o = outcomes();
  const att = buildDlcOracleAttestation({ ...FUNDING, outcomeId: 'settle-gain' }, privateKey);
  let threw = false;
  try {
    selectCetForAttestation(o, att, { publicKey, contractId: FUNDING.contractId, fundingTxid: 'cd'.repeat(32), fundingVout: 0 });
  } catch (e) { threw = /funding txid mismatch/.test(e.message); }
  assert(threw, 'mismatched funding outpoint must be rejected');
});

test('rejects selection with a bad oracle signature', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const { publicKey: otherPub } = crypto.generateKeyPairSync('ed25519');
  const o = outcomes();
  const att = buildDlcOracleAttestation({ ...FUNDING, outcomeId: 'roll' }, privateKey);
  let threw = false;
  try { selectCetForAttestation(o, att, { publicKey: otherPub, ...FUNDING }); }
  catch (e) { threw = /oracle attestation rejected/.test(e.message); }
  assert(threw, 'bad signature must block CET selection');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}
console.log(`\nPASS: ${passed} tests\n`);
