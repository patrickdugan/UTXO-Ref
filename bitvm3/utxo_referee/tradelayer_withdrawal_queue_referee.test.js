/**
 * Run: node bitvm3/utxo_referee/tradelayer_withdrawal_queue_referee.test.js
 */

const { sha256Hex } = require('./tradelayer_pnl_route_adapter');
const {
  buildTradeLayerWithdrawalQueue,
  verifyTradeLayerWithdrawalQueue,
  buildTradeLayerWithdrawalQueueChallenge,
  verifyTradeLayerWithdrawalQueueChallenge
} = require('./tradelayer_withdrawal_queue_referee');

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
  {
    id: 'wd-1',
    txid: '11'.repeat(32),
    address: 'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz',
    sats: 25000,
    propertyId: 0
  },
  {
    id: 'wd-2',
    txid: '22'.repeat(32),
    address: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
    sats: 74000,
    propertyId: 0
  }
];

console.log('\n=== TradeLayer Withdrawal Queue Referee Tests ===\n');

test('builds and verifies a BitVM-gated withdrawal queue commitment', () => {
  const queue = buildTradeLayerWithdrawalQueue({
    epochId: 77,
    requests: REQUESTS
  });
  const result = verifyTradeLayerWithdrawalQueue(queue);

  assert(result.ok, result.reason);
  assertEq(result.payableCount, 2);
  assert(queue.queueHash.length === 64, 'queue hash should be present');
  assert(queue.commitment.withdrawalRootHex.length === 64, 'withdrawal root should be present');
});

test('rejects queue total tampering', () => {
  const queue = buildTradeLayerWithdrawalQueue({ requests: REQUESTS });
  const tampered = clone(queue);
  tampered.queueCore.totalSats = '1';
  const result = verifyTradeLayerWithdrawalQueue(tampered);

  assert(!result.ok, 'tampered queue should fail');
  assert(String(result.reason).includes('queue hash mismatch') || String(result.reason).includes('queue total mismatch'), 'expected queue mismatch');
});

test('rejects a queue whose withdrawal root is not the root of its payable entries', () => {
  const honest = buildTradeLayerWithdrawalQueue({ requests: REQUESTS });
  // Root of a tree paying 1 BTC to an attacker, substituted in both places and rehashed.
  const attacker = buildTradeLayerWithdrawalQueue({
    requests: [{ id: 'wd-attacker', txid: 'cc'.repeat(32), address: 'tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22', sats: 100000000 }]
  });
  const forged = clone(honest);
  forged.queueCore.withdrawalRootHex = attacker.queueCore.withdrawalRootHex;
  forged.commitment.withdrawalRootHex = attacker.queueCore.withdrawalRootHex;
  forged.queueHash = sha256Hex(forged.queueCore);
  const result = verifyTradeLayerWithdrawalQueue(forged);

  assert(!result.ok, 'forged withdrawal root must not verify');
  assertEq(result.reason, 'withdrawal root mismatch');
});

test('builds challengeable omission and amount mismatch proofs', () => {
  const queue = buildTradeLayerWithdrawalQueue({ requests: REQUESTS });
  // An omission is a payable request missing from the committed queue. wd-1 is in
  // the full queue, so the omission is claimed against the queue without it.
  const withheld = buildTradeLayerWithdrawalQueue({ requests: REQUESTS.slice(1) });
  const omission = buildTradeLayerWithdrawalQueueChallenge(withheld, {
    challengeType: 'omitted_withdrawal',
    request: REQUESTS[0]
  });
  const amount = buildTradeLayerWithdrawalQueueChallenge(queue, {
    challengeType: 'amount_mismatch',
    request: REQUESTS[1]
  });

  assert(verifyTradeLayerWithdrawalQueueChallenge(omission, withheld).ok, 'omission proof should verify');
  assert(verifyTradeLayerWithdrawalQueueChallenge(amount, queue).ok, 'amount proof should verify');
  assert(omission.challengeable, 'omission should be challengeable');
  assert(amount.challengeable, 'amount mismatch should be challengeable');
});

test('excludes non-payable statuses fail-closed (only approved/settled pay)', () => {
  const queue = buildTradeLayerWithdrawalQueue({
    requests: [
      { id: 'ok-approved', txid: '11'.repeat(32), address: REQUESTS[0].address, sats: 25000, status: 'approved' },
      { id: 'ok-settled', txid: '22'.repeat(32), address: REQUESTS[1].address, sats: 74000, status: 'settled' },
      { id: 'no-pending', txid: '33'.repeat(32), address: REQUESTS[0].address, sats: 1000, status: 'pending' },
      { id: 'no-unknown', txid: '44'.repeat(32), address: REQUESTS[0].address, sats: 1000, status: 'queued-maybe' },
      { id: 'no-rejected', txid: '55'.repeat(32), address: REQUESTS[0].address, sats: 1000, status: 'rejected' }
    ]
  });
  const result = verifyTradeLayerWithdrawalQueue(queue);
  assert(result.ok, result.reason);
  assertEq(result.payableCount, 2, 'only approved + settled should be payable');
  assertEq(queue.queueCore.totalSats, '99000', 'unknown/pending statuses must not add to the cap');
});

test('rejects two ids producing the identical payout leaf (double-pay guard)', () => {
  let threw = false;
  try {
    buildTradeLayerWithdrawalQueue({
      requests: [
        { id: 'wd-a', txid: 'ab'.repeat(32), address: REQUESTS[0].address, sats: 25000, propertyId: 0 },
        { id: 'wd-b', txid: 'ab'.repeat(32), address: REQUESTS[0].address, sats: 25000, propertyId: 0 }
      ]
    });
  } catch (err) {
    threw = /duplicate withdrawal payout/.test(err.message);
  }
  assert(threw, 'identical payout leaf across distinct ids must be rejected');
});

test('rejects the same withdrawal repeated with an uppercase address', () => {
  let threw = false;
  try {
    buildTradeLayerWithdrawalQueue({
      requests: [
        { id: 'wd-a', txid: 'ab'.repeat(32), address: REQUESTS[0].address, sats: 25000, propertyId: 0 },
        { id: 'wd-b', txid: 'ab'.repeat(32), address: REQUESTS[0].address.toUpperCase(), sats: 25000, propertyId: 0 }
      ]
    });
  } catch (err) {
    threw = /duplicate withdrawal payout/.test(err.message);
  }
  assert(threw, 'bech32 case must not create a second payout for one withdrawal');
});

test('rejects a withdrawal entry that omits its origin txid', () => {
  let threw = false;
  try {
    buildTradeLayerWithdrawalQueue({
      requests: [
        { id: 'wd-a', txid: 'ab'.repeat(32), address: REQUESTS[0].address, sats: 25000, propertyId: 0 },
        { id: 'wd-b', address: REQUESTS[0].address, sats: 25000, propertyId: 0 }
      ]
    });
  } catch (err) {
    threw = /requires txid/.test(err.message);
  }
  assert(threw, 'an entry without its origin txid must be rejected');
});

test('allows one send txid to fan out to distinct recipients', () => {
  const queue = buildTradeLayerWithdrawalQueue({
    requests: [
      { id: 'out-0', txid: 'cd'.repeat(32), address: REQUESTS[0].address, sats: 25000, propertyId: 0 },
      { id: 'out-1', txid: 'cd'.repeat(32), address: REQUESTS[1].address, sats: 74000, propertyId: 0 }
    ]
  });
  assertEq(verifyTradeLayerWithdrawalQueue(queue).payableCount, 2, 'shared txid with distinct outputs must be allowed');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
