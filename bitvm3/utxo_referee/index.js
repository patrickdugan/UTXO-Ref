/**
 * UTXO Referee - BitVM3 Module
 *
 * Verifies sweep transactions against committed settlement rules.
 * Receipt tokens are 1:1 with sats - no price/conversion logic.
 *
 * Usage:
 *   const referee = require('./bitvm3/utxo_referee');
 *
 *   // Build payout tree
 *   const leaves = [
 *     { epochId: 1, recipientScriptPubKey: '...', amountSats: 10000 },
 *     ...
 *   ];
 *   const { root, proofs } = referee.buildTreeWithProofs(leaves);
 *
 *   // Create commitment
 *   const commitment = new referee.CommitmentPackage({
 *     epochId: 1,
 *     withdrawalRoot: root,
 *     capSats: 100000,
 *     residualDest: '...'
 *   });
 *
 *   // Verify sweep
 *   const sweep = new referee.SweepObject({ ... });
 *   const result = referee.verifySweep(commitment, sweep);
 */

const types = require('./types');
const merkle = require('./merkle');
const verify = require('./verify');
const circuit = require('./circuit');

module.exports = {
  // Types
  CommitmentPackage: types.CommitmentPackage,
  PayoutLeaf: types.PayoutLeaf,
  PayoutOutput: types.PayoutOutput,
  ResidualOutput: types.ResidualOutput,
  SweepObject: types.SweepObject,
  LEAF_TAG: types.LEAF_TAG,

  // Serialization helpers
  writeU64LE: types.writeU64LE,
  readU64LE: types.readU64LE,
  serializeScriptPubKey: types.serializeScriptPubKey,

  // Merkle tree
  PayoutMerkleTree: merkle.PayoutMerkleTree,
  computeWithdrawalRoot: merkle.computeWithdrawalRoot,
  buildTreeWithProofs: merkle.buildTreeWithProofs,
  ZERO_HASH: merkle.ZERO_HASH,

  // Verification
  verifySweep: verify.verifySweep,
  verifyRules: verify.verifyRules,

  // Circuit
  RefereeCircuit: circuit.RefereeCircuit,
  generateRefereeCircuit: circuit.generateRefereeCircuit,
  toCircuitWitness: circuit.toCircuitWitness,

  // Re-export submodules for advanced usage
  types,
  merkle,
  verify,
  circuit
};
