/**
 * Merkle Memory Verification Demo
 *
 * Demonstrates sparse Merkle tree for memory commitment
 * and proof generation for BitVM3.
 *
 * Run: node bitvm3/merkle-demo.js
 */

const {
  SparseMerkleTree,
  MerkleMemory,
  MerkleCircuitBuilder,
  Circuit,
  RiscVState,
  executeStep,
  getOpcodeName,
  proofToWitness,
  updateProofToWitness,
  bufToHex
} = require('./index');
const merkle = require('./merkle');

console.log('=== BitVM3 Merkle Memory Verification ===\n');

// Demo 1: Basic Sparse Merkle Tree
console.log('1. Sparse Merkle Tree basics\n');

const tree = new SparseMerkleTree(8); // 8 levels = 256 words for demo

console.log('   Empty tree root:', bufToHex(tree.getRoot()).slice(0, 16) + '...');

// Set some values
tree.set(0, 0xDEADBEEF);
tree.set(5, 0xCAFEBABE);
tree.set(100, 0x12345678);

console.log('   After setting 3 values:');
console.log('     tree[0]   = 0x' + tree.get(0).toString(16));
console.log('     tree[5]   = 0x' + tree.get(5).toString(16));
console.log('     tree[100] = 0x' + tree.get(100).toString(16));
console.log('   New root:', bufToHex(tree.getRoot()).slice(0, 16) + '...');
console.log('');

// Demo 2: Merkle Proofs
console.log('2. Merkle inclusion proofs\n');

const proof = tree.getProof(5);
console.log('   Proof for tree[5]:');
console.log('     Word index:', proof.wordIndex);
console.log('     Value: 0x' + proof.value.toString(16));
console.log('     Siblings:', proof.siblings.length, 'hashes');
console.log('     Root:', bufToHex(proof.root).slice(0, 16) + '...');

// Verify the proof
const isValid = SparseMerkleTree.verifyProof(proof);
console.log('     Proof valid:', isValid);
console.log('');

// Demo 3: Update proofs (for stores)
console.log('3. Merkle update proofs (for memory stores)\n');

const updateProof = tree.getUpdateProof(5, 0x11111111);
console.log('   Update tree[5] from 0xCAFEBABE to 0x11111111:');
console.log('     Old value: 0x' + updateProof.oldValue.toString(16));
console.log('     New value: 0x' + updateProof.newValue.toString(16));
console.log('     Old root:', bufToHex(updateProof.oldRoot).slice(0, 16) + '...');
console.log('     New root:', bufToHex(updateProof.newRoot).slice(0, 16) + '...');
console.log('     Same siblings can verify both roots!');
console.log('');

// Demo 4: MerkleMemory for RISC-V
console.log('4. MerkleMemory integration with RISC-V\n');

// Use a custom shallow tree for demo (production uses 30 levels)
const mem = { tree: new SparseMerkleTree(12) }; // 12 levels = 4K words
mem.addrToWordIndex = (addr) => (addr >>> 2) & 0xFFF;
mem.loadWord = function(addr) {
  const wordIndex = this.addrToWordIndex(addr);
  const value = this.tree.get(wordIndex);
  const proof = this.tree.getProof(wordIndex);
  return { value, proof };
};
mem.storeWord = function(addr, value) {
  const wordIndex = this.addrToWordIndex(addr);
  const updateProof = this.tree.getUpdateProof(wordIndex, value);
  return { updateProof };
};

// Store some words
mem.tree.set(mem.addrToWordIndex(0x1000), 0x00500093); // addi x1, x0, 5
mem.tree.set(mem.addrToWordIndex(0x1004), 0x00300113); // addi x2, x0, 3

console.log('   Memory at 0x1000: 0x' + mem.loadWord(0x1000).value.toString(16));
console.log('   Memory at 0x1004: 0x' + mem.loadWord(0x1004).value.toString(16));
console.log('');

// Load with proof
const loadResult = mem.loadWord(0x1000);
console.log('   Load word at 0x1000 with proof:');
console.log('     Value: 0x' + loadResult.value.toString(16));
console.log('     Proof siblings:', loadResult.proof.siblings.length);
console.log('');

// Store with update proof
console.log('   Store 0xABCD at 0x2000:');
const storeResult = mem.storeWord(0x2000, 0xABCD);
console.log('     Old root:', bufToHex(storeResult.updateProof.oldRoot).slice(0, 16) + '...');
console.log('     New root:', bufToHex(storeResult.updateProof.newRoot).slice(0, 16) + '...');
console.log('');

// Demo 5: Sub-word access
console.log('5. Sub-word memory access (byte/halfword)\n');

// Demonstrate byte extraction from word
const testWord = 0x44332211;
mem.tree.set(mem.addrToWordIndex(0x3000), testWord);

console.log('   Word at 0x3000: 0x' + testWord.toString(16));
console.log('   Byte extraction (circuit does this with MUX):');
console.log('     Byte 0 (offset 0): 0x' + ((testWord >> 0) & 0xFF).toString(16).padStart(2, '0'));
console.log('     Byte 1 (offset 1): 0x' + ((testWord >> 8) & 0xFF).toString(16).padStart(2, '0'));
console.log('     Byte 2 (offset 2): 0x' + ((testWord >> 16) & 0xFF).toString(16).padStart(2, '0'));
console.log('     Byte 3 (offset 3): 0x' + ((testWord >> 24) & 0xFF).toString(16).padStart(2, '0'));
console.log('   Halfword extraction:');
console.log('     Half 0 (lower): 0x' + ((testWord >> 0) & 0xFFFF).toString(16).padStart(4, '0'));
console.log('     Half 1 (upper): 0x' + ((testWord >> 16) & 0xFFFF).toString(16).padStart(4, '0'));
console.log('');

// Demo 6: Circuit for Merkle verification
console.log('6. Merkle verification circuit\n');

const circuit = new Circuit('merkle_verify');

// Need some inputs first for constants
circuit.addInput(32, 'dummy');

const merkleBuilder = new MerkleCircuitBuilder(circuit, 256, 8);
const proofInputs = merkleBuilder.addProofInputs('mem');

// Build verification circuit
const validWire = merkleBuilder.verifyInclusionCircuit(proofInputs);
circuit.setOutputs([validWire]);

const stats = circuit.getStats();
console.log('   Merkle verification circuit (8 levels, simplified hash):');
console.log('     Total gates:', stats.totalGates);
console.log('     AND gates:', stats.gates.AND);
console.log('     XOR gates:', stats.gates.XOR);
console.log('     Input bits:', stats.inputBits);
console.log('');

// Demo 7: Witness format conversion
console.log('7. Witness format for circuits\n');

const witnessProof = tree.getProof(100);
const witnessBits = proofToWitness(witnessProof, 8);

console.log('   Proof converted to bit arrays:');
console.log('     wordIndex bits:', witnessBits.wordIndex.length);
console.log('     leafValue bits:', witnessBits.leafValue.length);
console.log('     sibling arrays:', witnessBits.siblings.length, 'x', witnessBits.siblings[0].length, 'bits');
console.log('     root bits:', witnessBits.root.length);
console.log('');

// Demo 8: Full memory trace with Merkle proofs
console.log('8. RISC-V execution with Merkle-committed memory\n');

const state = new RiscVState();
state.pc = 0x1000;

// Program: load value, add to it, store back
// Assume memory[0x2000] = 100
state.storeWord(0x1000, 0x00002503); // lw x10, 0(x0) - load from 0x0 (placeholder)
state.storeWord(0x1004, 0x00550513); // addi x10, x10, 5
state.storeWord(0x1008, 0x00a02023); // sw x10, 0(x0) - store to 0x0 (placeholder)

// Just demo the instruction sequence
console.log('   Program loaded at 0x1000');
console.log('   Instructions:');
console.log('     0x1000: lw x10, 0(x0)');
console.log('     0x1004: addi x10, x10, 5');
console.log('     0x1008: sw x10, 0(x0)');
console.log('');

// Execute and show opcodes
const instr1 = state.loadWord(0x1000);
const instr2 = state.loadWord(0x1004);
const instr3 = state.loadWord(0x1008);

console.log('   Decoded opcodes:');
console.log('     0x' + instr1.toString(16), '->', getOpcodeName(instr1));
console.log('     0x' + instr2.toString(16), '->', getOpcodeName(instr2));
console.log('     0x' + instr3.toString(16), '->', getOpcodeName(instr3));
console.log('');

console.log('=== Merkle Memory Summary ===\n');
console.log('Components implemented:');
console.log('  - SparseMerkleTree: Efficient tree with zero-hash optimization');
console.log('  - MerkleMemory: RISC-V memory with automatic proof generation');
console.log('  - MerkleCircuitBuilder: Circuit constraints for proof verification');
console.log('  - proofToWitness: Convert proofs to circuit-ready bit arrays');
console.log('');
console.log('Memory operations now support:');
console.log('  - LW/SW: Word load/store with full Merkle proofs');
console.log('  - LB/SB/LH/SH: Sub-word access with byte selection circuits');
console.log('  - Update proofs: Verify state transitions for stores');
console.log('');
console.log('Next steps for production:');
console.log('  - Replace simplified hash with SHA256 or Poseidon');
console.log('  - Integrate proofs into trace verification');
console.log('  - Add memory root to RISC-V state commitment');
console.log('');
console.log('=== Done ===');
