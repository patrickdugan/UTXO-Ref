#!/usr/bin/env node

const path = require('path');
const {
  loadRbtcDlcZkSettlementBundle,
  buildRbtcDlcBitvmSettlementReceipt,
  verifyRbtcDlcBitvmSettlementReceipt,
  buildRbtcDlcBitvmChallenge
} = require('./rbtc_dlc_zk_settlement_adapter');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  OK  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

console.log('\n=== rBTC DLC ZK Settlement Adapter Tests ===\n');

const TLZK_ARTIFACT = path.join(
  'C:\\projects',
  'TLZK',
  'artifacts',
  'rbtc_dlc_zk',
  'rbtc_dlc_zk_settlement_latest.json'
);

test('loads TLZK rBTC proof artifact and builds BitVM release receipt', () => {
  const bundle = loadRbtcDlcZkSettlementBundle(TLZK_ARTIFACT);
  const receipt = buildRbtcDlcBitvmSettlementReceipt(bundle);
  const result = verifyRbtcDlcBitvmSettlementReceipt(receipt);

  assert(result.ok, result.reason || 'receipt should verify');
  assert(receipt.receiptCore.bitvmAction === 'authorize_dlc_escrow_release_if_roots_match', 'wrong action');
  assert(receipt.receiptCore.expectedPayoutRoot === receipt.receiptCore.observedPayoutRoot, 'root mismatch');
});

test('wrong payout root selects BitVM challenge path', () => {
  const bundle = loadRbtcDlcZkSettlementBundle(TLZK_ARTIFACT);
  const receipt = buildRbtcDlcBitvmSettlementReceipt(bundle);
  const challenge = buildRbtcDlcBitvmChallenge(receipt, { observedPayoutRoot: '0'.repeat(64) });

  assert(challenge.slashable, 'challenge should be slashable');
  assert(challenge.challengeCore.violation === 'wrong_payout_root', 'wrong violation');
});

test('verification rejects tampered observed payout root', () => {
  const bundle = loadRbtcDlcZkSettlementBundle(TLZK_ARTIFACT);
  const receipt = clone(buildRbtcDlcBitvmSettlementReceipt(bundle));
  receipt.receiptCore.observedPayoutRoot = '1'.repeat(64);
  const result = verifyRbtcDlcBitvmSettlementReceipt(receipt);

  assert(!result.ok, 'tampered receipt should fail');
  assert(result.reason === 'DLC payout root mismatch', 'wrong rejection reason');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
