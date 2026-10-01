/**
 * UTXO Referee Tests
 *
 * Run: node bitvm3/utxo_referee/test.js
 */

const api = require('./index');
const {
  CommitmentPackage,
  PayoutLeaf,
  SweepObject,
  PayoutMerkleTree,
  buildTreeWithProofs,
  computeWithdrawalRoot,
  LEAF_TAG,
  ZERO_HASH,
  verifySweep,
  verifyRules
} = api.legacyUnsafe.load({ acknowledgeUnsafePrototype: true });

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

test('protocol objects copy caller-owned byte arrays and Merkle proofs', () => {
  const root = Buffer.alloc(32, 0x11);
  const residual = sampleScriptPubKey(7);
  const commitment = new CommitmentPackage({
    epochId: 7n,
    withdrawalRoot: root,
    capSats: 1000n,
    residualDest: residual
  });
  const commitmentHash = commitment.hash();
  root[0] ^= 0xff;
  residual[0] ^= 0xff;
  commitment.withdrawalRoot[1] ^= 0xff;
  commitment.residualDest[1] ^= 0xff;
  commitment.capSats = 1n;
  assert(commitment.hash().equals(commitmentHash), 'caller buffer mutation changed the commitment');
  assert(Object.isFrozen(commitment), 'commitment object is not frozen');

  const leafInput = sampleScriptPubKey(10);
  const leaf = new PayoutLeaf({ epochId: 7n, recipientScriptPubKey: leafInput, amountSats: 500n });
  const leafHash = leaf.hash();
  leafInput[0] ^= 0xff;
  leaf.recipientScriptPubKey[0] ^= 0xff;
  LEAF_TAG[0] ^= 0xff;
  assert(leaf.hash().equals(leafHash), 'public byte mutation changed the payout leaf');
  assert(Object.isFrozen(leaf), 'payout leaf is not frozen');
  LEAF_TAG[0] ^= 0xff;

  const zeroHashCopy = Buffer.from(ZERO_HASH);
  ZERO_HASH[0] ^= 0xff;
  assert(computeWithdrawalRoot([]).equals(zeroHashCopy), 'exported zero hash mutated internal Merkle state');
  ZERO_HASH[0] ^= 0xff;

  const tree = new PayoutMerkleTree([
    leaf,
    new PayoutLeaf({ epochId: 7n, recipientScriptPubKey: sampleScriptPubKey(11), amountSats: 500n })
  ]);
  const exposedTreeRoot = tree.getRoot();
  const expectedTreeRoot = Buffer.from(exposedTreeRoot);
  const exposedProof = tree.getProof(0);
  const expectedSibling = Buffer.from(exposedProof.siblings[0]);
  exposedTreeRoot[0] ^= 0xff;
  exposedProof.siblings[0][0] ^= 0xff;
  assert(tree.getRoot().equals(expectedTreeRoot), 'returned Merkle root aliased internal tree state');
  assert(tree.getProof(0).siblings[0].equals(expectedSibling), 'returned Merkle proof aliased internal tree state');

  const payoutScript = sampleScriptPubKey(8);
  const sibling = Buffer.alloc(32, 0x22);
  const payout = {
    recipientScriptPubKey: payoutScript,
    amountSats: 500n,
    merkleProof: { index: 0, siblings: [sibling] }
  };
  const residualOutput = {
    recipientScriptPubKey: sampleScriptPubKey(9),
    amountSats: 500n
  };
  const sweep = new SweepObject({
    epochIdCommitted: 7n,
    payoutOutputs: [payout],
    residualOutput
  });
  payoutScript[0] ^= 0xff;
  sibling[0] ^= 0xff;
  residualOutput.recipientScriptPubKey[0] ^= 0xff;
  assert(sweep.payoutOutputs[0].recipientScriptPubKey[0] !== payoutScript[0], 'payout script was aliased');
  assert(sweep.payoutOutputs[0].merkleProof.siblings[0][0] !== sibling[0], 'Merkle sibling was aliased');
  assert(sweep.residualOutput.recipientScriptPubKey[0] !== residualOutput.recipientScriptPubKey[0],
    'residual script was aliased');
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
