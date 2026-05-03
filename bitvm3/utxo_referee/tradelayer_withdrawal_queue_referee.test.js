/**
 * Run: node bitvm3/utxo_referee/tradelayer_withdrawal_queue_referee.test.js
 */

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

test('builds challengeable omission and amount mismatch proofs', () => {
  const queue = buildTradeLayerWithdrawalQueue({ requests: REQUESTS });
  const omission = buildTradeLayerWithdrawalQueueChallenge(queue, {
    challengeType: 'omitted_withdrawal',
    request: REQUESTS[0]
  });
  const amount = buildTradeLayerWithdrawalQueueChallenge(queue, {
    challengeType: 'amount_mismatch',
    request: REQUESTS[1]
  });

  assert(verifyTradeLayerWithdrawalQueueChallenge(omission, queue).ok, 'omission proof should verify');
  assert(verifyTradeLayerWithdrawalQueueChallenge(amount, queue).ok, 'amount proof should verify');
  assert(omission.challengeable, 'omission should be challengeable');
  assert(amount.challengeable, 'amount mismatch should be challengeable');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
