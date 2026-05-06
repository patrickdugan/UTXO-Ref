/**
 * Lightning Subswap DLC Transaction Helper Tests
 *
 * Run: node bitvm3/utxo_referee/lightning_subswap_dlc.test.js
 */

const crypto = require('crypto');
const {
  buildSwapWitnessScript,
  buildFullHtlcWitnessScript,
  buildCommittedDlcWitnessScript,
  p2wshAddress,
  p2wshScriptPubKey
} = require('./lightning_subswap_dlc_demo');

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

console.log('\n=== Lightning Subswap DLC Helper Tests ===\n');

test('swap witness script commits to payment hash', () => {
  const pubkey = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 1)]);
  const paymentHash = '22'.repeat(32);
  const script = buildSwapWitnessScript(pubkey, paymentHash);
  assert(script.includes(Buffer.from(paymentHash, 'hex')), 'missing payment hash');
  assert(script.toString('hex').startsWith('a8'), 'missing OP_SHA256');
  assert(script.toString('hex').endsWith('87'), 'missing OP_EQUAL');
});

test('full HTLC witness script has success and refund branches', () => {
  const claimPubkey = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 4)]);
  const refundPubkey = Buffer.concat([Buffer.from([0x03]), Buffer.alloc(32, 5)]);
  const paymentHash = '66'.repeat(32);
  const script = buildFullHtlcWitnessScript({
    claimPublicKeyCompressed: claimPubkey,
    refundPublicKeyCompressed: refundPubkey,
    paymentHashHex: paymentHash,
    refundLocktime: 144
  });
  assert(script[0] === 0x63, 'missing OP_IF');
  assert(script.includes(Buffer.from(paymentHash, 'hex')), 'missing payment hash');
  assert(script.includes(claimPubkey), 'missing claim pubkey');
  assert(script.includes(refundPubkey), 'missing refund pubkey');
  assert(script.includes(Buffer.from([0xb1, 0x75])), 'missing CLTV/drop refund branch');
  assert(script[script.length - 1] === 0x68, 'missing OP_ENDIF');
});

test('DLC witness script embeds funding commitment hash', () => {
  const pubkey = Buffer.concat([Buffer.from([0x03]), Buffer.alloc(32, 2)]);
  const commitmentHash = '33'.repeat(32);
  const script = buildCommittedDlcWitnessScript(pubkey, commitmentHash);
  assert(script.includes(Buffer.from(commitmentHash, 'hex')), 'missing commitment hash');
  assert(script.includes(pubkey), 'missing pubkey');
});

test('P2WSH address and scriptPubKey are regtest witness v0', () => {
  const script = Buffer.from('5121' + '02'.repeat(33) + '51ae', 'hex');
  const scriptPubKey = p2wshScriptPubKey(script);
  const address = p2wshAddress(script);
  assert(scriptPubKey.toString('hex').startsWith('0020'), 'not P2WSH');
  assert(address.startsWith('bcrt1q'), 'not a regtest bech32 v0 address');
  assert(scriptPubKey.subarray(2).equals(crypto.createHash('sha256').update(script).digest()), 'bad witness hash');
});

console.log(`\nTests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
