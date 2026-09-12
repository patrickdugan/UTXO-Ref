/**
 * Deposit indexer tests
 *
 * Run: node bitvm3/utxo_referee/m1_deposit_indexer.test.js
 */

const { ReceiptLedger } = require('./m1_receipt_ledger');
const { ReceiptDepositIndexer, computeConfirmations } = require('./m1_deposit_indexer');

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
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `expected ${expected}, got ${actual}`);
  }
}

console.log('\n=== M1 Deposit Indexer Tests ===\n');

test('confirmations are derived from block height and tip', () => {
  assertEq(computeConfirmations(100, 100), 1);
  assertEq(computeConfirmations(100, 105), 6);
  assertEq(computeConfirmations(null, 105), 0);
});

test('deposit remains observed until confirmation threshold is met', () => {
  const indexer = new ReceiptDepositIndexer({ network: 'litecoin-mainnet', minConfirmations: 6 });
  const observed = indexer.observeDeposit({
    depositId: 'd1',
    accountId: 'alice',
    amountSats: 125000n,
    txid: 'aa'.repeat(32),
    vout: 0,
    blockHeight: 500
  }, 502);

  assertEq(observed.status, 'observed');
  assertEq(observed.confirmations, 3);

  indexer.syncConfirmations(505);
  const confirmed = indexer.getDeposit('d1');
  assertEq(confirmed.status, 'confirmed');
  assertEq(confirmed.confirmations, 6);
});

test('confirmed deposits can be credited into the ledger once', () => {
  const indexer = new ReceiptDepositIndexer({ minConfirmations: 2 });
  const ledger = new ReceiptLedger();

  indexer.observeDeposit({
    depositId: 'd1',
    accountId: 'alice',
    amountSats: 21000n,
    txid: 'bb'.repeat(32),
    vout: 1,
    blockHeight: 700
  }, 701);

  const credited = indexer.applyConfirmedDepositsToLedger(ledger, 701);
  assertEq(credited.length, 1);
  assertEq(ledger.balanceOf('alice'), 21000n);
  assertEq(indexer.getDeposit('d1').status, 'credited');

  const secondPass = indexer.applyConfirmedDepositsToLedger(ledger, 702);
  assertEq(secondPass.length, 0);
});

test('credited deposits can be rolled back with ledger reconciliation', () => {
  const indexer = new ReceiptDepositIndexer({ minConfirmations: 1 });
  const ledger = new ReceiptLedger();

  indexer.observeDeposit({
    depositId: 'd1',
    accountId: 'alice',
    amountSats: 5000n,
    txid: 'cc'.repeat(32),
    vout: 0,
    blockHeight: 900
  }, 900);
  indexer.applyConfirmedDepositsToLedger(ledger, 900);

  const rolledBack = indexer.rollbackDeposit('d1', {
    ledger,
    reason: 'reorg'
  });

  assertEq(rolledBack.status, 'rolled_back');
  assertEq(ledger.balanceOf('alice'), 0n);
});

test('rolling back credited deposits without a ledger is rejected', () => {
  const indexer = new ReceiptDepositIndexer({ minConfirmations: 1 });
  const ledger = new ReceiptLedger();

  indexer.observeDeposit({
    depositId: 'd1',
    accountId: 'alice',
    amountSats: 123n,
    txid: 'dd'.repeat(32),
    vout: 0,
    blockHeight: 1
  }, 1);
  indexer.applyConfirmedDepositsToLedger(ledger, 1);

  let threw = false;
  try {
    indexer.rollbackDeposit('d1');
  } catch (err) {
    threw = String(err.message).includes('ledger is required');
  }

  assert(threw, 'expected credited rollback to require ledger');
});

console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
