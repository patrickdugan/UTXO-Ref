/**
 * Run: node bitvm3/utxo_referee/m1_redteam_state_regressions.test.js
 *
 * MAIN-4 regressions (port of readiness-assessment poc10, items from
 * REDTEAM_FINDINGS.md): 64-bit circuit constants, balance claims bound to
 * their account and balance, and deposit replay refused by funding outpoint.
 */

const { Circuit } = require('../circuit');
const { ReceiptLedger } = require('./m1_receipt_ledger');
const { ReceiptTallyMap } = require('./m1_tally_map');
const { toTransitionWitness } = require('./m1_transition_circuit');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
function expectThrow(fn, pattern) {
  try { fn(); } catch (err) { if (pattern.test(err.message)) return; throw err; }
  throw new Error(`expected error matching ${pattern}`);
}

console.log('\n=== M1 State and Circuit Red-Team Regressions (MAIN-4) ===\n');

test('64-bit circuit constants set exactly their own bits', () => {
  const circuit = new Circuit();
  circuit.addInput(1, 'x');
  const one = circuit.one();
  const setBits = (value, width) => circuit.constantBits(value, width)
    .map((wire, index) => (wire === one ? index : -1)).filter((index) => index >= 0);
  assert(JSON.stringify(setBits(1, 64)) === '[0]', `constant 1 sets ${JSON.stringify(setBits(1, 64))}`);
  const expected10000 = [...Array(64).keys()].filter((index) => (10000n >> BigInt(index)) & 1n);
  assert(JSON.stringify(setBits(10000, 64)) === JSON.stringify(expected10000), 'constant 10000 is wrong at 64 bits');
  assert(JSON.stringify(setBits(2n ** 40n + 5n, 64)) === '[0,2,40]', 'constants above 32 bits are truncated');
  expectThrow(() => circuit.constantBits(256, 8), /does not fit in 8 bits/);
  expectThrow(() => circuit.constantBits(-1, 8), /does not fit/);
});

test('a balance claim rewritten to another account or balance does not verify', () => {
  const ledger = new ReceiptLedger();
  ledger.applyDeposit({ depositId: 'd1', accountId: 'alice', amountSats: 100n });
  ledger.applyDeposit({ depositId: 'd2', accountId: 'bob', amountSats: 200n });
  const state = ReceiptTallyMap.fromLedger(ledger, { epochId: 42n });
  const claim = state.getBalanceClaim('alice');
  assert(ReceiptTallyMap.verifyBalanceClaim(claim, claim.balanceRoot), 'honest claim must verify');
  const forged = { ...claim, accountId: 'mallory', balanceSats: '2100000000000000' };
  assert(!ReceiptTallyMap.verifyBalanceClaim(forged, claim.balanceRoot), 'rewritten claim verified');
  const inflated = { ...claim, balanceSats: '101' };
  assert(!ReceiptTallyMap.verifyBalanceClaim(inflated, claim.balanceRoot), 'inflated balance verified');
  // Recomputing the leaf without a leafHash field still binds account and balance.
  const { leafHash: _omit, ...withoutLeaf } = claim;
  assert(ReceiptTallyMap.verifyBalanceClaim(withoutLeaf, claim.balanceRoot), 'claim without leafHash must verify');
  assert(!ReceiptTallyMap.verifyBalanceClaim({ ...withoutLeaf, accountId: 'mallory' }, claim.balanceRoot),
    'rewritten claim without leafHash verified');
  // The transition witness refuses a claim whose leaf does not commit to it.
  const leafForBob = ReceiptTallyMap.hashBalanceRow('bob', 200n).toString('hex');
  const honestWitness = toTransitionWitness({
    tallyMap: state, epochId: 42n, collateralSats: state.totalSupplySats(), balanceClaim: claim
  }, 'flat');
  assert(honestWitness.balanceClaimLeafHash.length === 256, 'honest claim witness was not built');
  expectThrow(() => toTransitionWitness({
    tallyMap: state, epochId: 42n, collateralSats: state.totalSupplySats(),
    balanceClaim: { ...claim, leafHash: leafForBob }
  }, 'flat'), /does not commit to its accountId and balanceSats/);
});

test('one funding outpoint is credited once, whatever the deposit id', () => {
  const ledger = new ReceiptLedger();
  const chainTxRef = { txid: 'ab'.repeat(32), vout: 0 };
  ledger.applyDeposit({ depositId: 'first', accountId: 'alice', amountSats: 100n, chainTxRef });
  expectThrow(() => ledger.applyDeposit({ depositId: 'second', accountId: 'alice', amountSats: 100n, chainTxRef }),
    /already credited as first/);
  expectThrow(() => ledger.applyDeposit({
    depositId: 'third', accountId: 'bob', amountSats: 100n, chainTxRef: { txid: 'AB'.repeat(32), vout: 0 }
  }), /already credited/);
  assert(ledger.balanceOf('alice') === 100n && ledger.balanceOf('bob') === 0n, 'replay changed balances');
  // A different output of the same transaction is a different deposit.
  ledger.applyDeposit({ depositId: 'other-vout', accountId: 'bob', amountSats: 50n, chainTxRef: { ...chainTxRef, vout: 1 } });
  // After a rollback (e.g. reorg) the outpoint may be credited again, once.
  ledger.rollbackDeposit('first', { reason: 'reorg' });
  ledger.applyDeposit({ depositId: 'first-reconfirmed', accountId: 'alice', amountSats: 100n, chainTxRef });
  assert(ledger.balanceOf('alice') === 100n, 'reconfirmed deposit not credited exactly once');
  expectThrow(() => ledger.applyDeposit({ depositId: 'bad-ref', accountId: 'alice', amountSats: 1n, chainTxRef: { txid: 'zz', vout: 0 } }),
    /must name a funding outpoint/);

  // The tally map carries the credited outpoints and refuses replay too.
  const state = ReceiptTallyMap.fromLedger(ledger, { epochId: 7n });
  expectThrow(() => state.applyDeposit({ depositId: 'tally-replay', accountId: 'carol', amountSats: 5n, chainTxRef }),
    /already credited/);
  const restored = ReceiptTallyMap.fromSnapshot(state.toSnapshot());
  expectThrow(() => restored.applyDeposit({ depositId: 'snapshot-replay', accountId: 'carol', amountSats: 5n, chainTxRef }),
    /already credited/);
  assert(restored.snapshotHashHex() === state.snapshotHashHex(), 'snapshot round trip changed the hash');
});

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
