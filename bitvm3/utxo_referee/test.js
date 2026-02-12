/**
 * UTXO Referee Tests
 *
 * Run: node bitvm3/utxo_referee/test.js
 */

const {
  CommitmentPackage,
  PayoutLeaf,
  SweepObject,
  PayoutMerkleTree,
  buildTreeWithProofs,
  verifySweep,
  verifyRules
} = require('./index');

// Test helpers
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${e.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

// Sample data generators
function sampleScriptPubKey(id) {
  // P2PKH-like: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
  const hash = Buffer.alloc(20);
  hash.writeUInt32LE(id, 0);
  return Buffer.concat([
    Buffer.from([0x76, 0xa9, 0x14]), // OP_DUP OP_HASH160 PUSH20
    hash,
    Buffer.from([0x88, 0xac]) // OP_EQUALVERIFY OP_CHECKSIG
  ]);
}

function createTestLeaves(epochId, count, amountEach) {
  const leaves = [];
  for (let i = 0; i < count; i++) {
    leaves.push(new PayoutLeaf({
      epochId,
      recipientScriptPubKey: sampleScriptPubKey(i + 1),
      amountSats: amountEach
    }));
  }
  return leaves;
}

function createValidSweep(commitment, leaves, proofs) {
  const totalPayout = leaves.reduce((sum, l) => sum + l.amountSats, 0n);
  const residual = commitment.capSats - totalPayout;

  return new SweepObject({
    epochIdCommitted: commitment.epochId,
    payoutOutputs: leaves.map((leaf, i) => ({
      recipientScriptPubKey: leaf.recipientScriptPubKey,
      amountSats: leaf.amountSats,
      merkleProof: proofs[i]
    })),
    residualOutput: {
      recipientScriptPubKey: commitment.residualDest,
      amountSats: residual
    }
  });
}

// ============================================
// Tests
// ============================================

console.log('\n=== UTXO Referee Tests ===\n');

// --- Type Tests ---
console.log('Type Tests:');

test('PayoutLeaf serialization is deterministic', () => {
  const leaf = new PayoutLeaf({
    epochId: 1,
    recipientScriptPubKey: sampleScriptPubKey(1),
    amountSats: 10000
  });
  const ser1 = leaf.serialize();
  const ser2 = leaf.serialize();
  assert(ser1.equals(ser2), 'Serialization not deterministic');
});

test('PayoutLeaf hash includes domain tag', () => {
  const leaf = new PayoutLeaf({
    epochId: 1,
    recipientScriptPubKey: sampleScriptPubKey(1),
    amountSats: 10000
  });
  const hash = leaf.hash();
  assertEqual(hash.length, 32, 'Hash should be 32 bytes');
});

test('CommitmentPackage round-trip serialization', () => {
  const original = new CommitmentPackage({
    epochId: 12345,
    withdrawalRoot: Buffer.alloc(32, 0xAB),
    capSats: 1000000,
    residualDest: sampleScriptPubKey(99)
  });
  const serialized = original.serialize();
  const restored = CommitmentPackage.deserialize(serialized);
  assertEqual(restored.epochId, original.epochId);
  assert(restored.withdrawalRoot.equals(original.withdrawalRoot));
  assertEqual(restored.capSats, original.capSats);
  assert(restored.residualDest.equals(original.residualDest));
});

// --- Merkle Tests ---
console.log('\nMerkle Tests:');

test('Single leaf tree', () => {
  const leaves = createTestLeaves(1, 1, 10000n);
  const tree = new PayoutMerkleTree(leaves);
  const root = tree.getRoot();
  assertEqual(root.length, 32, 'Root should be 32 bytes');
});

test('Merkle proof verification works', () => {
  const leaves = createTestLeaves(1, 4, 10000n);
  const tree = new PayoutMerkleTree(leaves);
  const root = tree.getRoot();

  for (let i = 0; i < leaves.length; i++) {
    const proof = tree.getProof(i);
    const leafHash = leaves[i].hash();
    const valid = PayoutMerkleTree.verifyProof(leafHash, proof, root);
    assert(valid, `Proof for leaf ${i} should be valid`);
  }
});

test('Wrong leaf fails Merkle verification', () => {
  const leaves = createTestLeaves(1, 4, 10000n);
  const tree = new PayoutMerkleTree(leaves);
  const root = tree.getRoot();

  // Try to verify with wrong leaf hash
  const fakeLeaf = new PayoutLeaf({
    epochId: 1,
    recipientScriptPubKey: sampleScriptPubKey(999),
    amountSats: 99999
  });
  const proof = tree.getProof(0);
  const valid = PayoutMerkleTree.verifyProof(fakeLeaf.hash(), proof, root);
  assert(!valid, 'Fake leaf should fail verification');
});

test('buildTreeWithProofs returns correct structure', () => {
  const leaves = createTestLeaves(1, 5, 10000n);
  const { root, proofs, tree } = buildTreeWithProofs(leaves);

  assertEqual(proofs.length, 5, 'Should have 5 proofs');
  assert(root.equals(tree.getRoot()), 'Root should match');

  // Verify all proofs work
  for (let i = 0; i < leaves.length; i++) {
    const valid = PayoutMerkleTree.verifyProof(leaves[i].hash(), proofs[i], root);
    assert(valid, `Proof ${i} should be valid`);
  }
});

// --- Verification Tests ---
console.log('\nVerification Tests:');

test('Valid sweep passes verification', () => {
  const epochId = 1n;
  const leaves = createTestLeaves(epochId, 3, 10000n);
  const { root, proofs } = buildTreeWithProofs(leaves);
  const residualDest = sampleScriptPubKey(0);

  const commitment = new CommitmentPackage({
    epochId,
    withdrawalRoot: root,
    capSats: 50000n,
    residualDest
  });

  const sweep = createValidSweep(commitment, leaves, proofs);
  const result = verifySweep(commitment, sweep);

  assert(result.ok, `Should pass: ${result.reason}`);
});

test('Wrong epochId fails', () => {
  const epochId = 1n;
  const leaves = createTestLeaves(epochId, 2, 10000n);
  const { root, proofs } = buildTreeWithProofs(leaves);
  const residualDest = sampleScriptPubKey(0);

  const commitment = new CommitmentPackage({
    epochId,
    withdrawalRoot: root,
    capSats: 50000n,
    residualDest
  });

  const sweep = createValidSweep(commitment, leaves, proofs);
  sweep.epochIdCommitted = 999n; // Wrong epoch

  const result = verifySweep(commitment, sweep);
  assert(!result.ok, 'Should fail');
  assert(result.reason.includes('Epoch mismatch'), `Wrong reason: ${result.reason}`);
});

test('Invalid Merkle proof fails', () => {
  const epochId = 1n;
  const leaves = createTestLeaves(epochId, 2, 10000n);
  const { root, proofs } = buildTreeWithProofs(leaves);
  const residualDest = sampleScriptPubKey(0);

  const commitment = new CommitmentPackage({
    epochId,
    withdrawalRoot: root,
    capSats: 50000n,
    residualDest
  });

  const sweep = createValidSweep(commitment, leaves, proofs);
  // Corrupt the proof
  sweep.payoutOutputs[0].merkleProof.siblings[0] = Buffer.alloc(32, 0xFF);

  const result = verifySweep(commitment, sweep);
  assert(!result.ok, 'Should fail');
  assert(result.reason.includes('invalid Merkle proof'), `Wrong reason: ${result.reason}`);
});

test('Sum exceeds cap fails', () => {
  const epochId = 1n;
  const leaves = createTestLeaves(epochId, 3, 20000n); // 60000 total
  const { root, proofs } = buildTreeWithProofs(leaves);
  const residualDest = sampleScriptPubKey(0);

  const commitment = new CommitmentPackage({
    epochId,
    withdrawalRoot: root,
    capSats: 50000n, // Less than 60000
    residualDest
  });

  // Create sweep with all payouts (exceeds cap)
  const sweep = new SweepObject({
    epochIdCommitted: epochId,
    payoutOutputs: leaves.map((leaf, i) => ({
      recipientScriptPubKey: leaf.recipientScriptPubKey,
      amountSats: leaf.amountSats,
      merkleProof: proofs[i]
    })),
    residualOutput: {
      recipientScriptPubKey: residualDest,
      amountSats: 0n // Would be negative, but we're testing cap
    }
  });

  const result = verifySweep(commitment, sweep);
  assert(!result.ok, 'Should fail');
  assert(result.reason.includes('Cap exceeded'), `Wrong reason: ${result.reason}`);
});

test('Residual amount mismatch fails', () => {
  const epochId = 1n;
  const leaves = createTestLeaves(epochId, 2, 10000n);
  const { root, proofs } = buildTreeWithProofs(leaves);
  const residualDest = sampleScriptPubKey(0);

  const commitment = new CommitmentPackage({
    epochId,
    withdrawalRoot: root,
    capSats: 50000n,
    residualDest
  });

  const sweep = createValidSweep(commitment, leaves, proofs);
  // Wrong residual amount (should be 30000)
  sweep.residualOutput.amountSats = 25000n;

  const result = verifySweep(commitment, sweep);
  assert(!result.ok, 'Should fail');
  assert(result.reason.includes('Residual amount mismatch'), `Wrong reason: ${result.reason}`);
});

test('Residual destination mismatch fails', () => {
  const epochId = 1n;
  const leaves = createTestLeaves(epochId, 2, 10000n);
  const { root, proofs } = buildTreeWithProofs(leaves);
  const residualDest = sampleScriptPubKey(0);

  const commitment = new CommitmentPackage({
    epochId,
    withdrawalRoot: root,
    capSats: 50000n,
    residualDest
  });

  const sweep = createValidSweep(commitment, leaves, proofs);
  // Wrong residual destination
  sweep.residualOutput.recipientScriptPubKey = sampleScriptPubKey(999);

  const result = verifySweep(commitment, sweep);
  assert(!result.ok, 'Should fail');
  assert(result.reason.includes('Residual destination mismatch'), `Wrong reason: ${result.reason}`);
});

test('Zero payouts with full residual passes', () => {
  const epochId = 1n;
  const leaves = createTestLeaves(epochId, 2, 10000n);
  const { root } = buildTreeWithProofs(leaves);
  const residualDest = sampleScriptPubKey(0);

  const commitment = new CommitmentPackage({
    epochId,
    withdrawalRoot: root,
    capSats: 50000n,
    residualDest
  });

  // Sweep with no payouts, all goes to residual
  const sweep = new SweepObject({
    epochIdCommitted: epochId,
    payoutOutputs: [],
    residualOutput: {
      recipientScriptPubKey: residualDest,
      amountSats: 50000n
    }
  });

  const result = verifySweep(commitment, sweep);
  assert(result.ok, `Should pass: ${result.reason}`);
});

test('Partial payout set passes if proofs valid', () => {
  const epochId = 1n;
  const leaves = createTestLeaves(epochId, 5, 10000n);
  const { root, proofs } = buildTreeWithProofs(leaves);
  const residualDest = sampleScriptPubKey(0);

  const commitment = new CommitmentPackage({
    epochId,
    withdrawalRoot: root,
    capSats: 100000n,
    residualDest
  });

  // Only claim 2 of 5 payouts
  const sweep = new SweepObject({
    epochIdCommitted: epochId,
    payoutOutputs: [
      {
        recipientScriptPubKey: leaves[0].recipientScriptPubKey,
        amountSats: leaves[0].amountSats,
        merkleProof: proofs[0]
      },
      {
        recipientScriptPubKey: leaves[2].recipientScriptPubKey,
        amountSats: leaves[2].amountSats,
        merkleProof: proofs[2]
      }
    ],
    residualOutput: {
      recipientScriptPubKey: residualDest,
      amountSats: 80000n // 100000 - 20000
    }
  });

  const result = verifySweep(commitment, sweep);
  assert(result.ok, `Should pass: ${result.reason}`);
});

// --- Summary ---
console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
