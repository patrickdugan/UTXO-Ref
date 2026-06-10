/**
 * Run: node bitvm3/utxo_referee/tradelayer_reserve_reconciliation_referee.test.js
 */

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
  assert(verifyTradeLayerReserveInsolvencyChallenge(challenge, insolvent).ok, 'challenge should verify');

  const solvent = buildTradeLayerReserveReconciliation({ queue, reserve: 100000 });
  const noChallenge = buildTradeLayerReserveInsolvencyChallenge(solvent);
  assert(!noChallenge.challengeable, 'solvent reconciliation is not challengeable');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
