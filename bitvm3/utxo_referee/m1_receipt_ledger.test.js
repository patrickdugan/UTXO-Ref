/**
 * Milestone 1 Receipt Ledger Tests
 *
 * Run: node bitvm3/utxo_referee/m1_receipt_ledger.test.js
 */

const { buildTreeWithProofs } = require('./merkle');
const { ReceiptLedger } = require('./m1_receipt_ledger');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `expected ${expected}, got ${actual}`);
  }
}

function makeP2WPKH(tag) {
  const hash = Buffer.alloc(20);
  Buffer.from(tag).copy(hash);
  return Buffer.concat([Buffer.from([0x00, 0x14]), hash]);
}

console.log('\n=== Milestone 1 Receipt Ledger Tests ===\n');

test('deposit mints 1:1 sats', () => {
  const ledger = new ReceiptLedger();
  const out = ledger.applyDeposit({
    depositId: 'd1',
    accountId: 'alice',
    amountSats: 12345n,
    chainTxRef: { txid: 'aa'.repeat(32), vout: 0 }
  });

  assertEq(out.mintedSats, 12345n);
  assertEq(ledger.balanceOf('alice'), 12345n);
  assertEq(ledger.totalSupplySats(), 12345n);
});

test('duplicate deposit is rejected', () => {
  const ledger = new ReceiptLedger();
  ledger.applyDeposit({ depositId: 'd1', accountId: 'alice', amountSats: 1n });

  let threw = false;
  try {
    ledger.applyDeposit({ depositId: 'd1', accountId: 'alice', amountSats: 1n });
  } catch (e) {
    threw = e.message.includes('duplicate depositId');
  }
  assert(threw, 'expected duplicate deposit rejection');
});

test('redemption burns and enforces balance', () => {
  const ledger = new ReceiptLedger();
  ledger.applyDeposit({ depositId: 'd1', accountId: 'alice', amountSats: 5000n });

  const burn = ledger.applyRedemption({
    redemptionId: 'r1',
    accountId: 'alice',
    amountSats: 2000n
  });
  assertEq(burn.burnedSats, 2000n);
  assertEq(ledger.balanceOf('alice'), 3000n);

  let threw = false;
  try {
    ledger.applyRedemption({
      redemptionId: 'r2',
      accountId: 'alice',
      amountSats: 4000n
    });
  } catch (e) {
    threw = e.message.includes('insufficient balance');
  }
  assert(threw, 'expected insufficient balance rejection');
});

test('snapshot hash is deterministic for same event stream', () => {
  const a = new ReceiptLedger();
  const b = new ReceiptLedger();

  const events = [
    { depositId: 'd1', accountId: 'alice', amountSats: 10n },
    { depositId: 'd2', accountId: 'bob', amountSats: 25n },
    { redemptionId: 'r1', accountId: 'bob', amountSats: 5n, kind: 'redeem' }
  ];

  for (const e of events) {
    if (e.kind === 'redeem') {
      a.applyRedemption(e);
      b.applyRedemption(e);
    } else {
      a.applyDeposit(e);
      b.applyDeposit(e);
    }
  }

  assertEq(a.snapshotHashHex(), b.snapshotHashHex());
});

test('epoch payout leaves are deterministic and merklizable', () => {
  const ledger = new ReceiptLedger();
  ledger.applyDeposit({ depositId: 'd1', accountId: 'bob', amountSats: 21n });
  ledger.applyDeposit({ depositId: 'd2', accountId: 'alice', amountSats: 13n });

  const leaves = ledger.createEpochPayoutLeaves(7n, {
    alice: makeP2WPKH('alice'),
    bob: makeP2WPKH('bob')
  });

  assertEq(leaves.length, 2);
  assertEq(leaves[0].amountSats, 13n);
  assertEq(leaves[1].amountSats, 21n);

  const { root, proofs } = buildTreeWithProofs(leaves);
  assertEq(root.length, 32);
  assertEq(proofs.length, 2);
});

console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}

