/**
 * Run: node bitvm3/utxo_referee/tradelayer_live_reserve_adapter.test.js
 */

const { buildLiveReserveFromUnspent, toAmountSats } = require('./tradelayer_live_reserve_adapter');
const {
  buildTradeLayerWithdrawalQueue
} = require('./tradelayer_withdrawal_queue_referee');
const {
  buildTradeLayerReserveReconciliation,
  verifyTradeLayerReserveReconciliation
} = require('./tradelayer_reserve_reconciliation_referee');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEq(a, e, m) { if (a !== e) throw new Error(m || `expected ${e}, got ${a}`); }

// Shape mirrors `litecoin-cli listunspent` rows (LTC amounts + confirmations).
const UNSPENT = [
  { txid: 'aa'.repeat(32), vout: 0, address: 'tltc1qa', amount: 0.001, confirmations: 100 },
  { txid: 'bb'.repeat(32), vout: 1, address: 'tltc1qb', amount: 0.002, confirmations: 50 },
  { txid: 'cc'.repeat(32), vout: 0, address: 'tltc1qc', amountSats: 30000, confirmations: 10 }
];

console.log('\n=== TradeLayer Live Reserve Adapter Tests ===\n');

test('converts LTC amounts and explicit sats consistently', () => {
  assertEq(toAmountSats({ txid: 't', vout: 0, amount: 0.001 }), 100000);
  assertEq(toAmountSats({ txid: 't', vout: 0, amountSats: 30000 }), 30000);
});

test('credits confirmed unspent outputs into a deposit reserve', () => {
  const reserve = buildLiveReserveFromUnspent(UNSPENT, { minConfirmations: 1 });
  assertEq(reserve.creditedCount, 3);
  assertEq(reserve.observedCount, 3);
  // 100000 + 200000 + 30000
  assertEq(reserve.reservedSats.toString(), '330000');
  assertEq(reserve.snapshot.kind, 'receipt-deposit-indexer');
});

test('excludes outputs below the confirmation threshold from the reserve', () => {
  const reserve = buildLiveReserveFromUnspent(UNSPENT, { minConfirmations: 60, currentHeight: 100 });
  // only the 100-conf output (blockHeight 1) clears a 60-conf threshold at tip 100
  assertEq(reserve.creditedCount, 1);
  assertEq(reserve.reservedSats.toString(), '100000');
});

test('live reserve snapshot drives a solvent reconciliation', () => {
  const reserve = buildLiveReserveFromUnspent(UNSPENT, { minConfirmations: 1 });
  const queue = buildTradeLayerWithdrawalQueue({
    requests: [{ id: 'w1', txid: '11'.repeat(32), address: 'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz', sats: 250000 }]
  });
  const rec = buildTradeLayerReserveReconciliation({ queue, reserve: reserve.snapshot });
  assert(verifyTradeLayerReserveReconciliation(rec, queue).ok, 'reconciliation should verify');
  assertEq(rec.core.reserveSourceKind, 'receipt-deposit-indexer');
  assert(rec.solvent, 'cap 250000 <= reserve 330000');
  assertEq(rec.core.marginSats, '80000');
});

test('live reserve snapshot flags an insolvent reconciliation', () => {
  const reserve = buildLiveReserveFromUnspent(UNSPENT, { minConfirmations: 1 });
  const queue = buildTradeLayerWithdrawalQueue({
    requests: [{ id: 'w1', txid: '11'.repeat(32), address: 'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz', sats: 400000 }]
  });
  const rec = buildTradeLayerReserveReconciliation({ queue, reserve: reserve.snapshot });
  assert(!rec.solvent, 'cap 400000 > reserve 330000');
  assertEq(rec.core.marginSats, '-70000');
});

test('rejects malformed unspent rows', () => {
  let threw = false;
  try { buildLiveReserveFromUnspent([{ address: 'x' }]); } catch (e) { threw = /txid and vout/.test(e.message); }
  assert(threw, 'rows without txid/vout must be rejected');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}
console.log(`\nPASS: ${passed} tests\n`);
