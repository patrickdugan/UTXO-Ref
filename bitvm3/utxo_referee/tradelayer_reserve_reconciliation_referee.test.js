/**
 * Run: node bitvm3/utxo_referee/tradelayer_reserve_reconciliation_referee.test.js
 */

const { sha256Hex } = require('./tradelayer_pnl_route_adapter');
const {
  buildTradeLayerWithdrawalQueue
} = require('./tradelayer_withdrawal_queue_referee');
const {
  reservedSatsFromDepositSnapshot,
  buildTradeLayerReserveReconciliation,
  verifyTradeLayerReserveReconciliation,
  buildTradeLayerReserveInsolvencyChallenge,
  verifyTradeLayerReserveInsolvencyChallenge
} = require('./tradelayer_reserve_reconciliation_referee');
const { ReceiptDepositIndexer } = require('./m1_deposit_indexer');
const { ReceiptLedger } = require('./m1_receipt_ledger');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEq(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const REQUESTS = [
  { id: 'wd-1', txid: '11'.repeat(32), address: 'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz', sats: 25000, propertyId: 0 },
  { id: 'wd-2', txid: '22'.repeat(32), address: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa', sats: 74000, propertyId: 0 }
];

function buildQueue() {
  return buildTradeLayerWithdrawalQueue({ epochId: 77, requests: REQUESTS });
}

console.log('\n=== TradeLayer Reserve Reconciliation Referee Tests ===\n');

test('reconciles a solvent queue against an explicit reserve', () => {
  const queue = buildQueue();
  const rec = buildTradeLayerReserveReconciliation({ queue, reserve: { reservedSats: 100000 } });
  const result = verifyTradeLayerReserveReconciliation(rec, queue);

  assert(result.ok, result.reason);
  assert(rec.solvent, 'cap 99000 <= reserve 100000 should be solvent');
  assertEq(rec.core.capSats, '99000');
  assertEq(rec.core.reservedSats, '100000');
  assertEq(rec.core.marginSats, '1000');
});

test('flags an insolvent queue when cap exceeds reserve', () => {
  const queue = buildQueue();
  const rec = buildTradeLayerReserveReconciliation({ queue, reserve: 50000 });
  const result = verifyTradeLayerReserveReconciliation(rec, queue);

  assert(result.ok, result.reason);
  assert(!rec.solvent, 'cap 99000 > reserve 50000 should be insolvent');
  assertEq(rec.core.marginSats, '-49000');
});

test('exactly-funded reserve is solvent (margin zero)', () => {
  const queue = buildQueue();
  const rec = buildTradeLayerReserveReconciliation({ queue, reserve: 99000 });
  assert(rec.solvent, 'cap == reserve should be solvent');
  assertEq(rec.core.marginSats, '0');
});

test('derives reserve from a deposit indexer snapshot (credited only)', () => {
  const indexer = new ReceiptDepositIndexer({ minConfirmations: 1 });
  const ledger = new ReceiptLedger();
  indexer.observeDeposit({ depositId: 'd1', accountId: 'a1', txid: 'aa'.repeat(32), vout: 0, amountSats: 60000, blockHeight: 10 }, 10);
  indexer.observeDeposit({ depositId: 'd2', accountId: 'a2', txid: 'bb'.repeat(32), vout: 0, amountSats: 60000, blockHeight: 10 }, 10);
  // d3 stays observed (no block height) -> not part of credited reserve
  indexer.observeDeposit({ depositId: 'd3', accountId: 'a3', txid: 'cc'.repeat(32), vout: 0, amountSats: 999999, blockHeight: null }, 10);
  indexer.applyConfirmedDepositsToLedger(ledger, 10);

  const snapshot = indexer.getDeterministicSnapshot();
  assertEq(reservedSatsFromDepositSnapshot(snapshot).toString(), '120000');

  const queue = buildQueue();
  const rec = buildTradeLayerReserveReconciliation({ queue, reserve: snapshot });
  assertEq(rec.core.reserveSourceKind, 'receipt-deposit-indexer');
  assert(rec.solvent, 'cap 99000 <= credited reserve 120000');
  assertEq(rec.core.reservedSats, '120000');
});

test('derives reserve from a ledger snapshot', () => {
  const ledger = new ReceiptLedger();
  ledger.applyDeposit({ depositId: 'd1', accountId: 'a1', amountSats: 99000 });
  const queue = buildQueue();
  const rec = buildTradeLayerReserveReconciliation({ queue, reserve: ledger.getDeterministicSnapshot() });
  assertEq(rec.core.reserveSourceKind, 'receipt-ledger');
  assertEq(rec.core.reservedSats, '99000');
  assert(rec.solvent, 'cap == ledger supply');
});

test('detects reconciliation tampering', () => {
  const queue = buildQueue();
  const rec = buildTradeLayerReserveReconciliation({ queue, reserve: 50000 });
  const tampered = clone(rec);
  tampered.core.reservedSats = '100000';
  tampered.solvent = true;
  tampered.core.solvent = true;
  tampered.core.marginSats = '1000';
  const result = verifyTradeLayerReserveReconciliation(tampered, queue);
  assert(!result.ok, 'tampered reconciliation should fail');
});

test('binds reconciliation to the queue it was built against', () => {
  const queue = buildQueue();
  const rec = buildTradeLayerReserveReconciliation({ queue, reserve: 100000 });
  const otherQueue = buildTradeLayerWithdrawalQueue({
    epochId: 88,
    requests: [{ id: 'wd-9', txid: '99'.repeat(32), address: REQUESTS[0].address, sats: 5000 }]
  });
  const result = verifyTradeLayerReserveReconciliation(rec, otherQueue);
  assert(!result.ok, 'reconciliation must not verify against a different queue');
});

test('builds and verifies a challengeable insolvency proof', () => {
  const queue = buildQueue();
  const insolvent = buildTradeLayerReserveReconciliation({ queue, reserve: 50000 });
  const challenge = buildTradeLayerReserveInsolvencyChallenge(insolvent);
  assert(challenge.challengeable, 'shortfall should be challengeable');
  assertEq(challenge.core.shortfallSats, '49000');
  assert(verifyTradeLayerReserveInsolvencyChallenge(challenge, insolvent, queue, { reserve: 50000 }).ok, 'challenge should verify');

  const solvent = buildTradeLayerReserveReconciliation({ queue, reserve: 100000 });
  const noChallenge = buildTradeLayerReserveInsolvencyChallenge(solvent);
  assert(!noChallenge.challengeable, 'solvent reconciliation is not challengeable');
});

// --- SECURITY_BLOCKERS.md #4: freshness-window fail-closed tests ---

test('omitting observedAtHeight leaves staleness unchecked (fully backward compatible)', () => {
  const queue = buildQueue();
  const rec = buildTradeLayerReserveReconciliation({ queue, reserve: 100000 });
  assert(rec.solvent, 'no observedAtHeight supplied -> staleness must not be enforced');
  assertEq(rec.core.observedAtHeight, null);
  assertEq(rec.core.staleAtBuild, null);
});

test('reserve snapshot within the freshness window is solvent', () => {
  const queue = buildQueue();
  const rec = buildTradeLayerReserveReconciliation({
    queue, reserve: 100000, observedAtHeight: 1000, currentHeight: 1002, maxReserveAgeBlocks: 6
  });
  assert(rec.solvent, 'age 2 <= window 6 should remain solvent');
  assertEq(rec.core.ageBlocksAtBuild, 2);
  assertEq(rec.core.staleAtBuild, false);
});

test('reserve snapshot older than the freshness window is fail-closed at build time', () => {
  const queue = buildQueue();
  const rec = buildTradeLayerReserveReconciliation({
    queue, reserve: 100000, observedAtHeight: 1000, currentHeight: 1010, maxReserveAgeBlocks: 6
  });
  assert(!rec.solvent, 'age 10 > window 6 must force insolvent regardless of cap<=reserve math');
  assertEq(rec.core.mathSolvent, true, 'the underlying arithmetic is still recorded as solvent for audit');
  assertEq(rec.core.staleAtBuild, true);
});

test('a reconciliation that was fresh at build time is caught stale at verify time', () => {
  const queue = buildQueue();
  const rec = buildTradeLayerReserveReconciliation({
    queue, reserve: 100000, observedAtHeight: 1000, currentHeight: 1002, maxReserveAgeBlocks: 6
  });
  assert(rec.solvent, 'fresh at build time');

  // Time passes; re-verify with a much later live height.
  const freshCheck = verifyTradeLayerReserveReconciliation(rec, queue, { currentHeight: 1002, reserve: 100000 });
  assert(freshCheck.ok && freshCheck.solvent, 'still fresh a moment later');

  const staleCheck = verifyTradeLayerReserveReconciliation(rec, queue, { currentHeight: 1050, reserve: 100000 });
  assert(staleCheck.ok, staleCheck.reason);
  assert(!staleCheck.solvent, 'live re-check at height 1050 (age 50 > window 6) must force insolvent');
  assert(staleCheck.staleNow === true, 'staleNow must reflect the live re-check');
  assertEq(staleCheck.mathSolvent, true, 'the math itself is unchanged - only the freshness policy blocks it');
});

test('rejects a reconciliation whose reservedSats is not the reserve evidence', () => {
  const queue = buildQueue();
  const honest = buildTradeLayerReserveReconciliation({ queue, reserve: 1000 });
  assert(!honest.solvent, 'honest reserve of 1000 is insolvent against a 99000 cap');
  const forged = clone(honest);
  forged.core.reservedSats = '999999999';
  forged.core.marginSats = (999999999n - 99000n).toString();
  forged.core.mathSolvent = true;
  forged.core.solvent = true;
  forged.solvent = true;
  forged.reconciliationHash = sha256Hex(forged.core);
  const result = verifyTradeLayerReserveReconciliation(forged, queue, { currentHeight: 5, reserve: 1000 });

  assert(!result.ok, 'inflated reservedSats must not verify against the reserve evidence');
  assert(String(result.reason).includes('does not match reserve evidence'), result.reason);
});

test('verification without reserve evidence is not solvent', () => {
  const queue = buildQueue();
  const rec = buildTradeLayerReserveReconciliation({ queue, reserve: 999999 });
  assert(rec.solvent, 'built solvent');
  const result = verifyTradeLayerReserveReconciliation(rec, queue);

  assert(result.ok, result.reason);
  assert(!result.solvent, 'solvency cannot be established without the reserve evidence');
});

test('the verifier policy sets the staleness window, not the artifact', () => {
  const queue = buildQueue();
  const rec = buildTradeLayerReserveReconciliation({
    queue, reserve: 100000, observedAtHeight: 1000, currentHeight: 1000, maxReserveAgeBlocks: 6
  });
  const forged = clone(rec);
  forged.core.maxReserveAgeBlocks = 1000000;
  forged.reconciliationHash = sha256Hex(forged.core);
  const result = verifyTradeLayerReserveReconciliation(forged, queue, { currentHeight: 1100, reserve: 100000 });

  assert(result.ok, result.reason);
  assert(!result.solvent, 'age 100 exceeds the verifier window of 6 regardless of the artifact');
});

test('an observed reserve is not solvent when verified without currentHeight', () => {
  const queue = buildQueue();
  const rec = buildTradeLayerReserveReconciliation({
    queue, reserve: 100000, observedAtHeight: 1000, currentHeight: 1002, maxReserveAgeBlocks: 6
  });
  const result = verifyTradeLayerReserveReconciliation(rec, queue, { reserve: 100000 });

  assert(result.ok, result.reason);
  assert(!result.solvent, 'freshness cannot be established without currentHeight');
});

test('rejects a deposit snapshot that lists one credited deposit twice', () => {
  const queue = buildQueue();
  const deposit = { depositId: 'd1', status: 'credited', amountSats: 5000, txid: 'aa'.repeat(32), vout: 0 };
  let threw = false;
  try {
    buildTradeLayerReserveReconciliation({ queue, reserve: { kind: 'receipt-deposit-indexer', deposits: [deposit, { ...deposit }] } });
  } catch (err) {
    threw = /duplicate credited deposit/.test(err.message);
  }
  assert(threw, 'a repeated credited deposit must not be counted twice');
});

test('distinct credited deposits without an outpoint are each counted', () => {
  const queue = buildQueue();
  const reserve = {
    kind: 'receipt-deposit-indexer',
    deposits: [
      { depositId: 'd1', status: 'credited', amountSats: 5000 },
      { depositId: 'd2', status: 'credited', amountSats: 7000 }
    ]
  };
  assertEq(reservedSatsFromDepositSnapshot(reserve).toString(), '12000');
  assert(buildTradeLayerReserveReconciliation({ queue, reserve }), 'both deposits should build');
});

test('rejects two deposit ids that spend the same outpoint', () => {
  const queue = buildQueue();
  const outpoint = { status: 'credited', amountSats: 5000, txid: 'aa'.repeat(32), vout: 0 };
  let threw = false;
  try {
    buildTradeLayerReserveReconciliation({
      queue,
      reserve: { kind: 'receipt-deposit-indexer', deposits: [{ ...outpoint, depositId: 'd1' }, { ...outpoint, depositId: 'd2' }] }
    });
  } catch (err) {
    threw = /duplicate credited deposit/.test(err.message);
  }
  assert(threw, 'one outpoint must not be credited under two deposit ids');
});

test('currentHeight before observedAtHeight (reorg/bad input) fails closed, not silently accepted', () => {
  const queue = buildQueue();
  const rec = buildTradeLayerReserveReconciliation({
    queue, reserve: 100000, observedAtHeight: 1000, currentHeight: 990, maxReserveAgeBlocks: 6
  });
  assert(!rec.solvent, 'currentHeight before observedAtHeight must never be treated as fresh/solvent');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
