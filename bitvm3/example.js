/**
 * BitVM3 Example: Circuit Generation Demo
 *
 * Run: node bitvm3/example.js
 */

const bitvm3 = require('./index');

console.log('=== BitVM3 Circuit Generator ===\n');

// Example 1: Generate ADD circuit
console.log('1. Generating ADD instruction circuit...\n');
const addCircuit = bitvm3.generateOpcodeCircuit('ADD');
console.log('ADD Circuit Stats:', JSON.stringify(addCircuit.getStats(), null, 2));
console.log('');

// Example 2: Generate MUL circuit (more complex)
console.log('2. Generating MUL instruction circuit...\n');
const mulCircuit = bitvm3.generateOpcodeCircuit('MUL');
console.log('MUL Circuit Stats:', JSON.stringify(mulCircuit.getStats(), null, 2));
console.log('');

// Example 3: Generate BEQ (branch) circuit
console.log('3. Generating BEQ (branch) circuit...\n');
const beqCircuit = bitvm3.generateOpcodeCircuit('BEQ');
console.log('BEQ Circuit Stats:', JSON.stringify(beqCircuit.getStats(), null, 2));
console.log('');

// Example 4: Execute a small program
console.log('4. Executing RISC-V program...\n');

const state = new bitvm3.RiscVState();
state.pc = 0x1000;

// Simple program: compute 5 + 3 = 8
const program = [
  0x00500093,  // addi x1, x0, 5    (x1 = 5)
  0x00300113,  // addi x2, x0, 3    (x2 = 3)
  0x002081b3,  // add x3, x1, x2    (x3 = x1 + x2 = 8)
  0x00000073,  // ecall (halt)
];

const trace = bitvm3.executeProgram(state, program);

console.log(`Executed ${trace.length} instructions:\n`);
for (let i = 0; i < trace.length; i++) {
  const step = trace[i];
  const opcode = bitvm3.getOpcodeName(step.instruction);
  console.log(`  Step ${i}: ${opcode}`);
  console.log(`    PC: 0x${step.preState.pc.toString(16)} -> 0x${step.postState.pc.toString(16)}`);

  // Show register changes
  for (let r = 1; r < 32; r++) {
    const pre = step.preState.getReg(r);
    const post = step.postState.getReg(r);
    if (pre !== post) {
      console.log(`    x${r}: ${pre} -> ${post}`);
    }
  }
  console.log('');
}

// Example 5: Compute witness for a step
console.log('5. Computing witness for ADD step...\n');
const addStep = trace[2]; // The ADD instruction
const witness = bitvm3.computeStepWitness(addStep);
console.log('Witness:', JSON.stringify({
  opcode: witness._opcode,
  rs1: bitvm3.fromBits(witness.rs1),
  operand2: bitvm3.fromBits(witness.operand2),
  rdClaimed: bitvm3.fromBits(witness.rdClaimed)
}, null, 2));
console.log('');

// Example 6: Generate circuits for all opcodes
console.log('6. Generating all opcode circuits...\n');
const results = bitvm3.generateAllOpcodeCircuits();

const summary = {
  successful: [],
  failed: []
};

for (const [opcode, result] of Object.entries(results)) {
  if (result.success) {
    summary.successful.push({
      opcode,
      gates: result.stats.totalGates,
      andGates: result.stats.gates.AND,
      freeGates: result.stats.freeGates
    });
  } else {
    summary.failed.push({ opcode, error: result.error });
  }
}

console.log('Successful circuits:', summary.successful.length);
console.log('Failed circuits:', summary.failed.length);
console.log('');

// Sort by complexity
summary.successful.sort((a, b) => a.gates - b.gates);

console.log('Circuit complexity (by gate count):');
console.log('---------------------------------------');
for (const c of summary.successful) {
  console.log(`  ${c.opcode.padEnd(8)} ${String(c.gates).padStart(6)} gates (${c.andGates} AND)`);
}

if (summary.failed.length > 0) {
  console.log('\nFailed:');
  for (const f of summary.failed) {
    console.log(`  ${f.opcode}: ${f.error}`);
  }
}

console.log('\n=== Done ===');
