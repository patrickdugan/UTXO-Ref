const types = require('./types');
const projector = require('./projector');
const verify = require('./verify');
const onchain = require('./onchain');
const bitvmTransition = require('./bitvm_transition');

module.exports = {
  ORDER_TAG: types.ORDER_TAG,
  DECISION_TAG: types.DECISION_TAG,
  ROUTE_IDS: types.ROUTE_IDS,
  EscrowOrder: types.EscrowOrder,
  EscrowDecision: types.EscrowDecision,
  asScriptPubKeyBuffer: types.asScriptPubKeyBuffer,
  normalizeRoute: types.normalizeRoute,
  asEscrowOrder: projector.asEscrowOrder,
  asEscrowDecision: projector.asEscrowDecision,
  computeEscrowPayoutPlan: projector.computeEscrowPayoutPlan,
  buildEscrowSettlement: projector.buildEscrowSettlement,
  verifyEscrowSettlement: verify.verifyEscrowSettlement,
  generateEscrowCircuit: verify.generateEscrowCircuit,
  toEscrowCircuitWitness: verify.toEscrowCircuitWitness,
  DEFAULT_SCRIPT_ONLY_INTERNAL_KEY: onchain.DEFAULT_SCRIPT_ONLY_INTERNAL_KEY,
  ROUTE_TO_AUTHORIZATION_PATH: onchain.ROUTE_TO_AUTHORIZATION_PATH,
  AUTHORIZATION_MODES: onchain.AUTHORIZATION_MODES,
  COMMITMENT_TYPES: onchain.COMMITMENT_TYPES,
  normalizeCommitmentType: onchain.normalizeCommitmentType,
  deriveEscrowCommitmentHash: onchain.deriveEscrowCommitmentHash,
  buildEscrowTapLeaves: onchain.buildEscrowTapLeaves,
  buildEscrowTaprootContract: onchain.buildEscrowTaprootContract,
  buildEscrowAuthorizationWitnessPlan: onchain.buildEscrowAuthorizationWitnessPlan,
  buildSettlementTxTemplate: onchain.buildSettlementTxTemplate,
  buildTaprootPsbt: onchain.buildTaprootPsbt,
  buildEscrowSpendPackage: onchain.buildEscrowSpendPackage,
  VALID_ESCROW_ROUTES: bitvmTransition.VALID_ESCROW_ROUTES,
  normalizeSignerSet: bitvmTransition.normalizeSignerSet,
  buildEscrowBitvmTransitionState: bitvmTransition.buildEscrowBitvmTransitionState,
  verifyEscrowBitvmTransition: bitvmTransition.verifyEscrowBitvmTransition,
  EscrowBitvmTransitionCircuit: bitvmTransition.EscrowBitvmTransitionCircuit,
  generateEscrowBitvmCircuit: bitvmTransition.generateEscrowBitvmCircuit,
  toEscrowBitvmWitness: bitvmTransition.toEscrowBitvmWitness,
  buildEscrowBitvmChallengeBundle: bitvmTransition.buildEscrowBitvmChallengeBundle,
  types,
  projector,
  verify,
  onchain,
  bitvmTransition
};
