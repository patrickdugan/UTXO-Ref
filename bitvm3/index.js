/**
 * BitVM3 - Bitcoin-native ZK RISC-V Verification
 *
 * Circuit generation system for verifying RISC-V execution traces
 * using arithmetic circuits in Bristol format.
 *
 * Architecture:
 *   - circuit.js: Core circuit primitives (gates, arithmetic)
 *   - riscv.js: RISC-V state model and execution
 *   - opcodes/: Constraint generators per opcode
 *   - witness.js: Witness computation from traces
 *   - generator.js: High-level circuit generation API
 *
 * Usage:
 *   const bitvm3 = require('./bitvm3');
 *
 *   // Generate circuit for ADD instruction
 *   const circuit = bitvm3.generateOpcodeCircuit('ADD');
 *   console.log(circuit.toBristol());
 *   console.log(circuit.getStats());
 *
 *   // Execute program and verify trace
 *   const state = new bitvm3.RiscVState();
 *   const trace = bitvm3.executeProgram(state, [
 *     0x00500093,  // addi x1, x0, 5
 *     0x00300113,  // addi x2, x0, 3
 *     0x002081b3,  // add x3, x1, x2
 *   ]);
 */

const { Circuit } = require('./circuit');
const riscv = require('./riscv');
const opcodes = require('./opcodes');
const witness = require('./witness');
const generator = require('./generator');
const merkle = require('./merkle');
const utxoReferee = require('./utxo_referee');

module.exports = {
  // Core circuit builder
  Circuit,

  // RISC-V model
  ...riscv,

  // Opcode constraints
  opcodes,
  registry: opcodes.registry,

  // Witness computation
  ...witness,

  // High-level API
  ...generator,

  // Merkle tree for memory verification
  merkle,
  SparseMerkleTree: merkle.SparseMerkleTree,
  MerkleMemory: merkle.MerkleMemory,
  MerkleCircuitBuilder: merkle.MerkleCircuitBuilder,
  proofToWitness: merkle.proofToWitness,
  updateProofToWitness: merkle.updateProofToWitness,
  bufToHex: merkle.bufToHex,

  // UTXO Referee (sweep verification)
  utxoReferee,
  verifySweep: utxoReferee.verifySweep,
  CommitmentPackage: utxoReferee.CommitmentPackage,
  PayoutLeaf: utxoReferee.PayoutLeaf,
  SweepObject: utxoReferee.SweepObject
};
