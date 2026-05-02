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
const m1Spec = require('./m1_spec');
const m1ReceiptLedger = require('./m1_receipt_ledger');
const m1DepositIndexer = require('./m1_deposit_indexer');
const m1Transition = require('./m1_transition');
const m1TransitionCircuit = require('./m1_transition_circuit');
const m1TallyMap = require('./m1_tally_map');
const m1ChallengeWitness = require('./m1_challenge_witness');
const m1OracleDeltaPublication = require('./m1_oracle_delta_publication');
const m1WitnessDelta = require('./m1_witness_delta');
const m1RoutingCommitments = require('./m1_routing_commitments');
const m1ChainEnv = require('./m1_chain_env');
const m1ProceduralSync = require('./m1_procedural_sync');
const m1Pipeline = require('./m1_pipeline');
const m1ParallelUtxoIndex = require('./m1_parallel_utxo_index');
const m1BitvmSearchManifolds = require('./m1_bitvm_search_manifolds');
const lightningIntegration = require('./lightning_integration');
const spiralLdkValueAdd = require('./spiral_ldk_value_add');
const lightningLiquidityLease = require('./lightning_liquidity_lease');
const lightningWalletIntegration = require('./lightning_wallet_integration');
const lightningTaprootAssetsStablecoin = require('./lightning_taproot_assets_stablecoin');
const lightningArkLiquidityGraft = require('./lightning_ark_liquidity_graft');
const arkDlcSettlement = require('./ark_dlc_settlement');
const arkLiquidityGraftManager = require('./ark_liquidity_graft_manager');
const lnbtcTlusdLiquidityPatch = require('./lnbtc_tlusd_liquidity_patch');
const lightningTradeLayerOracleDlc = require('./lightning_tradelayer_oracle_dlc');
const tradeLayerPnlRouteAdapter = require('./tradelayer_pnl_route_adapter');
const tradeLayerSendOracleExtractor = require('./tradelayer_send_oracle_extractor');
const tradeLayerSendSweepPsbt = require('./tradelayer_send_sweep_psbt');

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
  deriveSettlementRouting: verify.deriveSettlementRouting,
  verifySettlementRouting: verify.verifySettlementRouting,

  // Circuit
  RefereeCircuit: circuit.RefereeCircuit,
  generateRefereeCircuit: circuit.generateRefereeCircuit,
  toCircuitWitness: circuit.toCircuitWitness,

  // Milestone 1 spec helpers
  PAYOUT_LEAF_SCHEMA_FIELDS: m1Spec.PAYOUT_LEAF_SCHEMA_FIELDS,
  COMMITMENT_PACKAGE_SCHEMA_FIELDS: m1Spec.COMMITMENT_PACKAGE_SCHEMA_FIELDS,
  RECEIPT_DLC_TEMPLATE_V1: m1Spec.RECEIPT_DLC_TEMPLATE_V1,
  buildReceiptDlcTemplate: m1Spec.buildReceiptDlcTemplate,
  normalizeEpochId: m1Spec.normalizeEpochId,
  normalizeAmountSats: m1Spec.normalizeAmountSats,
  validatePayoutLeafRecord: m1Spec.validatePayoutLeafRecord,
  validateCommitmentPackageRecord: m1Spec.validateCommitmentPackageRecord,
  templateHashHex: m1Spec.templateHashHex,
  ReceiptLedger: m1ReceiptLedger.ReceiptLedger,
  ReceiptDepositIndexer: m1DepositIndexer.ReceiptDepositIndexer,
  ReceiptTallyMap: m1TallyMap.ReceiptTallyMap,
  computeRouteAmounts: m1Transition.computeRouteAmounts,
  computeBoundedSettlementAmounts: m1Transition.computeBoundedSettlementAmounts,
  computeSendRouteAmounts: m1Transition.computeSendRouteAmounts,
  applyBinarySettlementTransition: m1Transition.applyBinarySettlementTransition,
  TransitionCircuit: m1TransitionCircuit.TransitionCircuit,
  generateTransitionCircuit: m1TransitionCircuit.generateTransitionCircuit,
  toTransitionWitness: m1TransitionCircuit.toTransitionWitness,
  normalizeChallengeRoute: m1ChallengeWitness.normalizeRoute,
  buildTransitionStateFromChallengeBundle: m1ChallengeWitness.buildTransitionStateFromChallengeBundle,
  buildChallengeWitnessBundle: m1ChallengeWitness.buildChallengeWitnessBundle,
  buildOracleDeltaPublication: m1OracleDeltaPublication.buildOracleDeltaPublication,
  buildFastRollHandoff: m1OracleDeltaPublication.buildFastRollHandoff,
  deriveOracleMapId: m1OracleDeltaPublication.deriveOracleMapId,
  deriveNextContractId: m1OracleDeltaPublication.deriveNextContractId,
  buildSettlementBreakdown: m1WitnessDelta.buildSettlementBreakdown,
  buildSettlementDeltaAnnotation: m1WitnessDelta.buildSettlementDeltaAnnotation,
  buildWitnessBlobWithDelta: m1WitnessDelta.buildWitnessBlobWithDelta,
  CHAIN_PROFILES: m1ChainEnv.CHAIN_PROFILES,
  resolveChainId: m1ChainEnv.resolveChainId,
  resolveChainEnv: m1ChainEnv.resolveChainEnv,
  buildEpochEventId: m1ChainEnv.buildEpochEventId,
  normalizeRoutingCommitments: m1RoutingCommitments.normalizeRoutingCommitments,
  withCommittedRouting: m1RoutingCommitments.withCommittedRouting,
  assertCommittedRouting: m1RoutingCommitments.assertCommittedRouting,
  buildProceduralSyncSummary: m1ProceduralSync.buildProceduralSyncSummary,
  loadLatestProceduralSyncInputs: m1ProceduralSync.loadLatestProceduralSyncInputs,
  writeProceduralSyncSummary: m1ProceduralSync.writeProceduralSyncSummary,
  buildParallelUtxoIndex: m1ParallelUtxoIndex.buildParallelUtxoIndex,
  loadLatestParallelUtxoIndexInputs: m1ParallelUtxoIndex.loadLatestParallelUtxoIndexInputs,
  writeParallelUtxoIndex: m1ParallelUtxoIndex.writeParallelUtxoIndex,
  CONSTANT_ONE_DIGEST_HEX: m1BitvmSearchManifolds.CONSTANT_ONE_DIGEST_HEX,
  deriveSettlementCore: m1BitvmSearchManifolds.deriveSettlementCore,
  buildTranscriptMultiplicityFamily: m1BitvmSearchManifolds.buildTranscriptMultiplicityFamily,
  buildIdentifierBifurcationFamily: m1BitvmSearchManifolds.buildIdentifierBifurcationFamily,
  buildBitvmSearchManifolds: m1BitvmSearchManifolds.buildBitvmSearchManifolds,
  loadLatestBitvmSearchManifoldInputs: m1BitvmSearchManifolds.loadLatestBitvmSearchManifoldInputs,
  writeBitvmSearchManifolds: m1BitvmSearchManifolds.writeBitvmSearchManifolds,
  deriveLightningPreimageHex: lightningIntegration.derivePreimageHex,
  deriveLightningPaymentHashHex: lightningIntegration.derivePaymentHashHex,
  makePrototypeLightningInvoice: lightningIntegration.makePrototypeInvoice,
  buildLightningFundingOutputCommitment: lightningIntegration.buildFundingOutputCommitment,
  buildLightningFundedPositionOpen: lightningIntegration.buildLightningFundedPositionOpen,
  buildLightningPayoutCompression: lightningIntegration.buildLightningPayoutCompression,
  verifyLightningPayoutCompression: lightningIntegration.verifyLightningPayoutCompression,
  buildLightningWatchtowerBounty: lightningIntegration.buildLightningWatchtowerBounty,
  buildContractOpenApiPrototype: lightningIntegration.buildContractOpenApiPrototype,
  buildLightningFundedRollover: lightningIntegration.buildLightningFundedRollover,
  buildAllLightningIntegrationPrototypes: lightningIntegration.buildAllLightningIntegrationPrototypes,
  SPIRAL_LDK_PUBLIC_COMMIT_EVIDENCE: spiralLdkValueAdd.PUBLIC_COMMIT_EVIDENCE,
  PUBLIC_COMMIT_EVIDENCE: spiralLdkValueAdd.PUBLIC_COMMIT_EVIDENCE,
  buildLdkExternalFundingReceipt: spiralLdkValueAdd.buildLdkExternalFundingReceipt,
  verifyLdkExternalFundingReceipt: spiralLdkValueAdd.verifyLdkExternalFundingReceipt,
  buildSpiralLdkValueAddBrief: spiralLdkValueAdd.buildSpiralLdkValueAddBrief,
  buildLiquidityLeaseOffer: lightningLiquidityLease.buildLiquidityLeaseOffer,
  buildLeaseSuccessEvidence: lightningLiquidityLease.buildLeaseSuccessEvidence,
  buildLeaseChallengeEvidence: lightningLiquidityLease.buildLeaseChallengeEvidence,
  buildLiquidityLeaseBundle: lightningLiquidityLease.buildLiquidityLeaseBundle,
  verifyLiquidityLeaseBundle: lightningLiquidityLease.verifyLiquidityLeaseBundle,
  buildWalletIntegrationManifest: lightningWalletIntegration.buildWalletIntegrationManifest,
  verifyWalletIntegrationManifest: lightningWalletIntegration.verifyWalletIntegrationManifest,
  buildTaprootAssetDescriptor: lightningTaprootAssetsStablecoin.buildTaprootAssetDescriptor,
  buildTaprootAssetProofCommitment: lightningTaprootAssetsStablecoin.buildTaprootAssetProofCommitment,
  buildStablecoinRfqQuote: lightningTaprootAssetsStablecoin.buildStablecoinRfqQuote,
  buildStablecoinSettlementEvidence: lightningTaprootAssetsStablecoin.buildStablecoinSettlementEvidence,
  buildStablecoinChallengeEvidence: lightningTaprootAssetsStablecoin.buildStablecoinChallengeEvidence,
  buildTaprootAssetsStablecoinBundle: lightningTaprootAssetsStablecoin.buildTaprootAssetsStablecoinBundle,
  verifyTaprootAssetsStablecoinBundle: lightningTaprootAssetsStablecoin.verifyTaprootAssetsStablecoinBundle,
  buildArkTemplateCommitment: lightningArkLiquidityGraft.buildArkTemplateCommitment,
  buildArkVtxoLiquidityCommitment: lightningArkLiquidityGraft.buildArkVtxoLiquidityCommitment,
  buildArkLiquidityGraftQuote: lightningArkLiquidityGraft.buildArkLiquidityGraftQuote,
  buildArkGraftSettlementEvidence: lightningArkLiquidityGraft.buildArkGraftSettlementEvidence,
  buildArkGraftChallengeEvidence: lightningArkLiquidityGraft.buildArkGraftChallengeEvidence,
  buildArkGraftCostModel: lightningArkLiquidityGraft.buildArkGraftCostModel,
  buildArkLiquidityGraftBundle: lightningArkLiquidityGraft.buildArkLiquidityGraftBundle,
  verifyArkLiquidityGraftBundle: lightningArkLiquidityGraft.verifyArkLiquidityGraftBundle,
  buildArkDlcContract: arkDlcSettlement.buildArkDlcContract,
  buildVirtualCetSet: arkDlcSettlement.buildVirtualCetSet,
  buildArkDlcSettlement: arkDlcSettlement.buildArkDlcSettlement,
  buildArkDlcAspChallenge: arkDlcSettlement.buildArkDlcAspChallenge,
  buildArkDlcFeeModel: arkDlcSettlement.buildArkDlcFeeModel,
  buildArkDlcSettlementBundle: arkDlcSettlement.buildArkDlcSettlementBundle,
  verifyArkDlcSettlementBundle: arkDlcSettlement.verifyArkDlcSettlementBundle,
  buildArkLiquidityInventory: arkLiquidityGraftManager.buildArkLiquidityInventory,
  buildLightningRouteDemand: arkLiquidityGraftManager.buildLightningRouteDemand,
  buildBitvmEnforcementPolicy: arkLiquidityGraftManager.buildBitvmEnforcementPolicy,
  allocateArkGrafts: arkLiquidityGraftManager.allocateArkGrafts,
  buildArkLiquidityManagerChallenge: arkLiquidityGraftManager.buildArkLiquidityManagerChallenge,
  buildArkLiquidityGraftManagerBundle: arkLiquidityGraftManager.buildArkLiquidityGraftManagerBundle,
  verifyArkLiquidityGraftManagerBundle: arkLiquidityGraftManager.verifyArkLiquidityGraftManagerBundle,
  usdUnitsFromBtcSats: lnbtcTlusdLiquidityPatch.usdUnitsFromBtcSats,
  buildLnBtcToTlUsdConversion: lnbtcTlusdLiquidityPatch.buildLnBtcToTlUsdConversion,
  buildTlUsdLiquidityStake: lnbtcTlusdLiquidityPatch.buildTlUsdLiquidityStake,
  buildLiquidityPatchMandate: lnbtcTlusdLiquidityPatch.buildLiquidityPatchMandate,
  buildLnBtcTlUsdLiquidityPatchBundle: lnbtcTlusdLiquidityPatch.buildLnBtcTlUsdLiquidityPatchBundle,
  verifyLnBtcTlUsdLiquidityPatchBundle: lnbtcTlusdLiquidityPatch.verifyLnBtcTlUsdLiquidityPatchBundle,
  TRADELAYER_ORACLE_MAX_PRICE_DEVIATION_BPS: lightningTradeLayerOracleDlc.DEFAULT_MAX_PRICE_DEVIATION_BPS,
  TRADELAYER_DEFAULT_DESIGNATED_ORACLE_ADDRESS: lightningTradeLayerOracleDlc.DEFAULT_DESIGNATED_ORACLE_ADDRESS,
  encodeTradeLayerPublishOracleData: lightningTradeLayerOracleDlc.encodeTradeLayerPublishOracleData,
  decodeTradeLayerPublishOracleData: lightningTradeLayerOracleDlc.decodeTradeLayerPublishOracleData,
  buildTradeLayerOracleOpReturnScriptHex: lightningTradeLayerOracleDlc.buildOpReturnScriptHex,
  priceDeviationBps: lightningTradeLayerOracleDlc.priceDeviationBps,
  buildTradeLayerOracleAddressProof: lightningTradeLayerOracleDlc.buildOracleAddressProof,
  computeTradeLayerVwapScaledPrice: lightningTradeLayerOracleDlc.computeVwapScaledPrice,
  buildTradeLayerVwapStateOracle: lightningTradeLayerOracleDlc.buildTradeLayerVwapStateOracle,
  verifyTradeLayerVwapStateOracle: lightningTradeLayerOracleDlc.verifyTradeLayerVwapStateOracle,
  buildTradeLayerVwapStateOracleChallenge: lightningTradeLayerOracleDlc.buildTradeLayerVwapStateOracleChallenge,
  buildTradeLayerPricePublishTrigger: lightningTradeLayerOracleDlc.buildTradeLayerPricePublishTrigger,
  buildBilateralLnDlcContract: lightningTradeLayerOracleDlc.buildBilateralLnDlcContract,
  selectTradeLayerOracleDlcOutcomeForPrice: lightningTradeLayerOracleDlc.selectOutcomeForPrice,
  buildBitvmTradeLayerOracleDlcOrganizer: lightningTradeLayerOracleDlc.buildBitvmOrganizer,
  buildLnTradeLayerOracleDlcSettlement: lightningTradeLayerOracleDlc.buildLnDlcSettlement,
  buildBitvmTradeLayerOracleDlcChallenge: lightningTradeLayerOracleDlc.buildBitvmDlcChallenge,
  buildLightningTradeLayerOracleDlcBundle: lightningTradeLayerOracleDlc.buildLightningTradeLayerOracleDlcBundle,
  verifyLightningTradeLayerOracleDlcBundle: lightningTradeLayerOracleDlc.verifyLightningTradeLayerOracleDlcBundle,
  tradeLayerAddressToScriptPubKey: tradeLayerPnlRouteAdapter.addressToScriptPubKey,
  computeTradeLayerPnlPlanHash: tradeLayerPnlRouteAdapter.computeTradeLayerPlanHash,
  buildTradeLayerPnlCommitment: tradeLayerPnlRouteAdapter.buildTradeLayerPnlCommitment,
  verifyTradeLayerPnlRoutePlan: tradeLayerPnlRouteAdapter.verifyTradeLayerPnlRoutePlan,
  buildTradeLayerSendOracleCommitment: tradeLayerPnlRouteAdapter.buildTradeLayerSendOracleCommitment,
  buildTradeLayerSendOracleSigningPayload: tradeLayerPnlRouteAdapter.buildTradeLayerSendOracleSigningPayload,
  verifyTradeLayerSendOracleSignature: tradeLayerPnlRouteAdapter.verifyTradeLayerSendOracleSignature,
  buildTradeLayerSendIntentFromStateOracle: tradeLayerPnlRouteAdapter.buildTradeLayerSendIntentFromStateOracle,
  buildTradeLayerSendRoutePlan: tradeLayerPnlRouteAdapter.buildTradeLayerSendRoutePlan,
  verifyTradeLayerSendRoutePlan: tradeLayerPnlRouteAdapter.verifyTradeLayerSendRoutePlan,
  verifyTradeLayerSendStateOracleRoute: tradeLayerPnlRouteAdapter.verifyTradeLayerSendStateOracleRoute,
  buildTradeLayerSendStateOracleFromConsensus: tradeLayerSendOracleExtractor.buildTradeLayerSendStateOracleFromConsensus,
  buildTradeLayerSendSweepPlan: tradeLayerSendSweepPsbt.buildTradeLayerSendSweepPlan,
  verifyTradeLayerObservedSweepOutputs: tradeLayerSendSweepPsbt.verifyObservedSweepOutputs,
  resolvePipelineOptions: m1Pipeline.resolvePipelineOptions,
  buildPipelinePlan: m1Pipeline.buildPipelinePlan,
  buildPipelineSummary: m1Pipeline.buildPipelineSummary,
  resolvePipelineValidationSkipReason: m1Pipeline.resolveValidationSkipReason,

  // Re-export submodules for advanced usage
  types,
  merkle,
  verify,
  circuit,
  m1Spec,
  m1ReceiptLedger,
  m1DepositIndexer,
  m1Transition,
  m1TransitionCircuit,
  m1TallyMap,
  m1ChallengeWitness,
  m1OracleDeltaPublication,
  m1WitnessDelta,
  m1ChainEnv,
  m1RoutingCommitments,
  m1ProceduralSync,
  m1Pipeline,
  m1ParallelUtxoIndex,
  m1BitvmSearchManifolds,
  lightningIntegration,
  spiralLdkValueAdd,
  lightningLiquidityLease,
  lightningWalletIntegration,
  lightningTaprootAssetsStablecoin,
  lightningArkLiquidityGraft,
  arkDlcSettlement,
  arkLiquidityGraftManager,
  lnbtcTlusdLiquidityPatch,
  lightningTradeLayerOracleDlc,
  tradeLayerPnlRouteAdapter,
  tradeLayerSendOracleExtractor,
  tradeLayerSendSweepPsbt
};
