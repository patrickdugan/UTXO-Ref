/**
 * UTXO Referee Demo
 *
 * Demonstrates the complete flow:
 * 1. Generate payout leaves
 * 2. Build withdrawal tree and proofs
 * 3. Create commitment package
 * 4. Build sweep object
 * 5. Verify sweep
 *
 * Run: node bitvm3/utxo_referee/demo.js
 */

const {
  CommitmentPackage,
  PayoutLeaf,
  SweepObject,
  buildTreeWithProofs,
  verifySweep,
  generateRefereeCircuit
} = require('./index');

console.log('=== UTXO Referee Demo ===\n');

// === Step 1: Generate Payout Leaves ===
console.log('1. Generating payout leaves...\n');

const EPOCH_ID = 42n;
const NUM_PAYOUTS = 5;

// Helper to create sample scriptPubKey (P2WPKH-like)
function makeScriptPubKey(label) {
  // OP_0 <20-byte hash>
  const hash = Buffer.alloc(20);
  Buffer.from(label).copy(hash);
  return Buffer.concat([Buffer.from([0x00, 0x14]), hash]);
}

// Create payout leaves with different amounts
const payoutData = [
  { recipient: 'alice_______________', amount: 15000n },
  { recipient: 'bob_________________', amount: 25000n },
  { recipient: 'charlie_____________', amount: 10000n },
  { recipient: 'dave________________', amount: 30000n },
  { recipient: 'eve_________________', amount: 20000n }
];

const leaves = payoutData.map(p => new PayoutLeaf({
  epochId: EPOCH_ID,
  recipientScriptPubKey: makeScriptPubKey(p.recipient),
  amountSats: p.amount
}));

const totalPayouts = leaves.reduce((sum, l) => sum + l.amountSats, 0n);
console.log('   Payouts:');
payoutData.forEach((p, i) => {
  console.log(`     ${i + 1}. ${p.recipient.trim()}: ${p.amount} sats`);
});
console.log(`   Total: ${totalPayouts} sats\n`);

// === Step 2: Build Merkle Tree ===
console.log('2. Building withdrawal Merkle tree...\n');

const { root, proofs, tree } = buildTreeWithProofs(leaves);

console.log(`   Tree depth: ${tree.depth}`);
console.log(`   Leaf count: ${tree.leafCount}`);
console.log(`   Withdrawal root: ${root.toString('hex').slice(0, 16)}...`);
console.log('');

// === Step 3: Create Commitment Package ===
console.log('3. Creating commitment package...\n');

const CAP_SATS = 150000n; // Pool cap for this epoch
const residualDest = makeScriptPubKey('pool_reserve________');

const commitment = new CommitmentPackage({
  epochId: EPOCH_ID,
  withdrawalRoot: root,
  capSats: CAP_SATS,
  residualDest
});

console.log('   Commitment:');
console.log(`     Epoch ID: ${commitment.epochId}`);
console.log(`     Withdrawal Root: ${commitment.withdrawalRoot.toString('hex').slice(0, 16)}...`);
console.log(`     Cap: ${commitment.capSats} sats`);
console.log(`     Residual Dest: ${commitment.residualDest.toString('hex').slice(0, 16)}...`);
console.log(`     Commitment Hash: ${commitment.hash().toString('hex').slice(0, 16)}...`);
console.log('');

// === Step 4: Build Sweep Object ===
console.log('4. Building sweep transaction object...\n');

const residualAmount = CAP_SATS - totalPayouts;

const sweep = new SweepObject({
  epochIdCommitted: EPOCH_ID,
  payoutOutputs: leaves.map((leaf, i) => ({
    recipientScriptPubKey: leaf.recipientScriptPubKey,
    amountSats: leaf.amountSats,
    merkleProof: proofs[i]
  })),
  residualOutput: {
    recipientScriptPubKey: residualDest,
    amountSats: residualAmount
  }
});

console.log('   Sweep:');
console.log(`     Epoch ID: ${sweep.epochIdCommitted}`);
console.log(`     Payout outputs: ${sweep.payoutOutputs.length}`);
console.log(`     Total payouts: ${sweep.totalPayoutSats()} sats`);
console.log(`     Residual: ${sweep.residualOutput.amountSats} sats`);
console.log('');

// === Step 5: Verify Sweep ===
console.log('5. Verifying sweep against commitment...\n');

const result = verifySweep(commitment, sweep);

if (result.ok) {
  console.log('   ✓ Sweep verification PASSED');
  console.log('');
  console.log('   All rules satisfied:');
  console.log('     ✓ Epoch binding: sweep.epochId == commitment.epochId');
  console.log('     ✓ Membership: all payouts have valid Merkle proofs');
  console.log('     ✓ Cap: sum(payouts) <= capSats');
  console.log('     ✓ Residual: amount and destination match');
} else {
  console.log('   ✗ Sweep verification FAILED');
  console.log(`   Reason: ${result.reason}`);
}
console.log('');

// === Demo: Invalid Cases ===
console.log('6. Demonstrating failure cases...\n');

// Wrong epoch
const badEpoch = new SweepObject({
  ...sweep,
  epochIdCommitted: 999n
});
const r1 = verifySweep(commitment, badEpoch);
console.log(`   Wrong epoch: ${r1.ok ? 'PASS' : 'FAIL'} - ${r1.reason || 'OK'}`);

// Corrupt proof
const badProof = new SweepObject({
  epochIdCommitted: EPOCH_ID,
  payoutOutputs: sweep.payoutOutputs.map((o, i) => i === 0 ? {
    ...o,
    merkleProof: { ...o.merkleProof, siblings: [Buffer.alloc(32, 0xFF), ...o.merkleProof.siblings.slice(1)] }
  } : o),
  residualOutput: sweep.residualOutput
});
const r2 = verifySweep(commitment, badProof);
console.log(`   Bad proof: ${r2.ok ? 'PASS' : 'FAIL'} - ${r2.reason || 'OK'}`);

// Wrong residual
const badResidual = new SweepObject({
  epochIdCommitted: EPOCH_ID,
  payoutOutputs: sweep.payoutOutputs,
  residualOutput: { ...sweep.residualOutput, amountSats: 12345n }
});
const r3 = verifySweep(commitment, badResidual);
console.log(`   Bad residual: ${r3.ok ? 'PASS' : 'FAIL'} - ${r3.reason || 'OK'}`);

console.log('');

// === Circuit Generation ===
console.log('7. Generating referee circuit...\n');

try {
  const circuitResult = generateRefereeCircuit({
    maxPayouts: 4,
    merkleDepth: 8
  });

  console.log('   Circuit stats:');
  console.log(`     Total gates: ${circuitResult.stats.totalGates}`);
  console.log(`     AND gates: ${circuitResult.stats.gates.AND}`);
  console.log(`     XOR gates: ${circuitResult.stats.gates.XOR}`);
  console.log(`     Input bits: ${circuitResult.stats.inputBits}`);
  console.log(`     Output bits: ${circuitResult.stats.outputBits}`);
  console.log('');
  console.log('   NOTE: Circuit uses placeholder hash function.');
  console.log('   TODO: Replace with SHA256 for production (~22k gates/hash).');
} catch (e) {
  console.log(`   Circuit generation error: ${e.message}`);
}

console.log('');
console.log('=== Demo Complete ===\n');
