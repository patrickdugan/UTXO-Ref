/**
 * Run: node bitvm3/utxo_referee/tradelayer_state_checkpoint_referee.test.js
 */

const { sha256Hex } = require('./tradelayer_pnl_route_adapter');
const {
  buildTradeLayerStateCheckpoint,
  verifyTradeLayerStateCheckpoint,
  buildTradeLayerCheckpointFraudProof,
  verifyTradeLayerCheckpointFraudProof
} = require('./tradelayer_state_checkpoint_referee');

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

console.log('\n=== TradeLayer State Checkpoint Referee Tests ===\n');

test('builds and verifies a compact TradeLayer state checkpoint', () => {
  const checkpoint = buildTradeLayerStateCheckpoint({
    previousStateRoot: '00'.repeat(32),
    acceptedTxids: ['11'.repeat(32), '22'.repeat(32)],
    rejectedTxids: ['33'.repeat(32)],
    height: 500
  });
  const result = verifyTradeLayerStateCheckpoint(checkpoint);

  assert(result.ok, result.reason);
  assertEq(result.acceptedTxCount, 2);
  assertEq(result.rejectedTxCount, 1);
  assert(checkpoint.checkpointHash.length === 64, 'checkpoint hash should be present');
});

test('rejects checkpoint root tampering', () => {
  const checkpoint = buildTradeLayerStateCheckpoint({
    acceptedTxids: ['11'.repeat(32)]
  });
  const tampered = clone(checkpoint);
  tampered.core.acceptedTxRoot = '00'.repeat(32);
  const result = verifyTradeLayerStateCheckpoint(tampered);

  assert(!result.ok, 'tampered checkpoint should fail');
  assert(String(result.reason).includes('accepted tx root mismatch'), 'expected accepted root mismatch');
});

test('rejects a checkpoint that lists one txid as both accepted and rejected', () => {
  const txid = '11'.repeat(32);
  const honest = buildTradeLayerStateCheckpoint({ acceptedTxids: [txid] });
  const forged = clone(honest);
  forged.core.rejectedTxids = [txid];
  forged.core.rejectedTxRoot = sha256Hex(forged.core.rejectedTxids);
  forged.checkpointHash = sha256Hex(forged.core);
  const result = verifyTradeLayerStateCheckpoint(forged);

  assert(!result.ok, 'a txid cannot be both accepted and rejected');
  assert(/overlap/.test(result.reason), result.reason);
});

test('fraud proof verification requires the checkpoint it proves against', () => {
  const checkpoint = buildTradeLayerStateCheckpoint({ acceptedTxids: ['11'.repeat(32)] });
  const proof = buildTradeLayerCheckpointFraudProof(checkpoint, {
    proofType: 'invalid_accepted_tx',
    txid: '11'.repeat(32)
  });
  const result = verifyTradeLayerCheckpointFraudProof(proof);

  assert(!result.ok, 'a proof verified without its checkpoint must not pass');
});

test('builds a challengeable invalid accepted tx proof', () => {
  const checkpoint = buildTradeLayerStateCheckpoint({
    acceptedTxids: ['11'.repeat(32)]
  });
  const proof = buildTradeLayerCheckpointFraudProof(checkpoint, {
    proofType: 'invalid_accepted_tx',
    txid: '11'.repeat(32),
    rejectReason: 'insufficient balance'
  });
  const result = verifyTradeLayerCheckpointFraudProof(proof, checkpoint);

  assert(result.ok, result.reason);
  assert(proof.challengeable, 'invalid accepted tx should be challengeable');
});

test('builds a challengeable omitted valid tx proof', () => {
  const checkpoint = buildTradeLayerStateCheckpoint({
    acceptedTxids: ['11'.repeat(32)]
  });
  const proof = buildTradeLayerCheckpointFraudProof(checkpoint, {
    proofType: 'omitted_valid_tx',
    txid: '44'.repeat(32)
  });
  const result = verifyTradeLayerCheckpointFraudProof(proof, checkpoint);

  assert(result.ok, result.reason);
  assert(proof.challengeable, 'omitted valid tx should be challengeable');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
