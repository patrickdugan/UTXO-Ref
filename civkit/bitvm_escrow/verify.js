const referee = require('../../bitvm3/utxo_referee');
const { buildEscrowSettlement } = require('./projector');

function verifyEscrowSettlement(orderLike, decisionLike, options = {}) {
  let settlement;

  try {
    settlement = buildEscrowSettlement(orderLike, decisionLike, options);
  } catch (error) {
    return {
      ok: false,
      reason: error.message
    };
  }

  if (!settlement.verification.ok) {
    return settlement.verification;
  }

  return {
    ok: true,
    settlement
  };
}

function generateEscrowCircuit(options = {}) {
  return referee.generateRefereeCircuit(options);
}

function toEscrowCircuitWitness(orderLike, decisionLike, options = {}) {
  const settlement = buildEscrowSettlement(orderLike, decisionLike, options);
  return {
    settlement,
    witness: referee.toCircuitWitness(
      settlement.commitment,
      settlement.sweep,
      settlement.leaves
    )
  };
}

module.exports = {
  verifyEscrowSettlement,
  generateEscrowCircuit,
  toEscrowCircuitWitness
};
