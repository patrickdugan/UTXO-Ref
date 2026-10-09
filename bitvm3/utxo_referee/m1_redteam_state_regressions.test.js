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
const { toTransitionWitness, bitsFromBigInt } = require('./m1_transition_circuit');
const { applyBinarySettlementTransition } = require('./m1_transition');

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

// ---- Remaining off-chain REDTEAM_FINDINGS.md state items ----

const U64_MAX = (1n << 64n) - 1n;

test('credits that would overflow u64 are refused and witnesses never truncate', () => {
  const ledger = new ReceiptLedger();
  ledger.applyDeposit({ depositId: 'big', accountId: 'alice', amountSats: U64_MAX - 5n });
  expectThrow(() => ledger.applyDeposit({ depositId: 'over', accountId: 'alice', amountSats: 6n }), /resulting balanceSats/);
  expectThrow(() => ledger.applyDeposit({ depositId: 'supply', accountId: 'bob', amountSats: 6n }), /resulting totalSupplySats/);
  assert(ledger.balanceOf('alice') === U64_MAX - 5n && ledger.balanceOf('bob') === 0n, 'failed credit changed balances');
  const state = new ReceiptTallyMap({ epochId: 1n });
  state.applyDeposit({ depositId: 'big', accountId: 'alice', amountSats: U64_MAX });
  expectThrow(() => state.applyDeposit({ depositId: 'one', accountId: 'bob', amountSats: 1n }), /resulting totalSupplySats/);
  expectThrow(() => bitsFromBigInt(1n << 64n, 64), /does not fit in 64 bits/);
  expectThrow(() => bitsFromBigInt(-1n, 64), /does not fit/);
  assert(bitsFromBigInt(U64_MAX, 64).every((bit) => bit === 1), 'u64 max did not convert');
});

test('loading a committed snapshot checks its kind, root, supply and hash', () => {
  const state = new ReceiptTallyMap({ epochId: 3n, challengeWindowLength: 10n });
  state.applyDeposit({ depositId: 'd1', accountId: 'alice', amountSats: 100n });
  const committed = state.getCommittedSnapshot();
  assert(ReceiptTallyMap.fromBlob(JSON.stringify(committed)).snapshotHashHex() === committed.snapshotHash);
  expectThrow(() => ReceiptTallyMap.fromSnapshot({ ...committed, kind: 'something-else' }), /kind must be receipt-tally-map/);
  expectThrow(() => ReceiptTallyMap.fromSnapshot({ ...committed, balanceRoot: '00'.repeat(32) }), /balanceRoot does not match/);
  expectThrow(() => ReceiptTallyMap.fromSnapshot({ ...committed, totalSupplySats: '999' }), /totalSupplySats does not match/);
  expectThrow(() => ReceiptTallyMap.fromSnapshot({ ...committed, snapshotHash: 'ff'.repeat(32) }), /snapshot hash does not match/);
  const inflated = { ...committed, balances: [{ accountId: 'alice', balanceSats: '1000' }] };
  expectThrow(() => ReceiptTallyMap.fromSnapshot(inflated), /does not match/);
});

test('epochs only move forward and challenge windows stay consistent', () => {
  const state = new ReceiptTallyMap({ epochId: 5n, challengeWindowLength: 10n });
  expectThrow(() => state.finalizeEpoch(5n), /must be greater than the current epoch/);
  expectThrow(() => state.finalizeEpoch(4n), /must be greater than the current epoch/);
  expectThrow(() => state.finalizeEpoch(6n, 'ab'.repeat(32)), /prevSnapshotHash must be the hash/);
  const next = state.finalizeEpoch(6n);
  assert(next.epochId === 6n && next.prevSnapshotHash === state.snapshotHashHex() && next.challengeWindowEnd === 16n,
    'forward finalization is wrong');
  expectThrow(() => new ReceiptTallyMap({ epochId: 1n, challengeWindowStart: 1n, challengeWindowLength: 10n, challengeWindowEnd: 5n }),
    /challengeWindowEnd must equal/);
  const transition = (overrides) => applyBinarySettlementTransition({ collateralSats: 1000n, epochId: 1n, ...overrides }, { route: 'roll' });
  expectThrow(() => transition({ epochId: U64_MAX }), /no successor within uint64/);
  expectThrow(() => transition({ epochId: -1n }), /uint64/);
  expectThrow(() => transition({ collateralSats: -5n }), /uint64/);
  expectThrow(() => transition({ challengeWindowStart: 1n, challengeWindowLength: 10n, challengeWindowEnd: 3n }),
    /end must equal start \+ length/);
  expectThrow(() => transition({ challengeWindowStart: 10n, challengeWindowEnd: 5n }), /uint64/);
  assert(transition({}).route === 'roll', 'honest transition refused');
});

test('account ordering is by code unit, not locale', () => {
  // Distinct IDs that localeCompare may rank as equal (precomposed vs combining accent).
  const precomposed = 'café';
  const combining = 'café';
  const roots = [[precomposed, combining], [combining, precomposed]].map((order) => {
    const state = new ReceiptTallyMap({ epochId: 1n });
    for (const [index, accountId] of order.entries()) {
      state.applyDeposit({ depositId: `d-${index}-${accountId}`, accountId, amountSats: BigInt(100 + accountId.length) });
    }
    return state.getBalanceMerkleRootHex();
  });
  assert(roots[0] === roots[1], 'insertion order changed the balance root');
  const ledger = new ReceiptLedger();
  ledger.applyDeposit({ depositId: 'a', accountId: 'b', amountSats: 1n });
  ledger.applyDeposit({ depositId: 'b', accountId: 'B', amountSats: 1n });
  assert(ledger.getBalancesSorted().map((row) => row.accountId).join() === 'B,b', 'ledger order is not code-unit order');
});

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
