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
const m1Transition = require('./m1_transition');
const m1TransitionCircuit = require('./m1_transition_circuit');
const m1TallyMap = require('./m1_tally_map');
const m1DepositIndexer = require('./m1_deposit_indexer');
const utxoRefV2 = require('./utxoref_v2');
const dlcContractState = require('./dlc_contract_state');
const dlcThresholdOracle = require('./dlc_threshold_oracle');
const { DlcStateStore } = require('./dlc_state_store');
const dlcCryptoProvider = require('./dlc_crypto_provider');
const { DlcOracleEventStore } = require('./dlc_oracle_event_store');
const { DlcSigningAuthorizationStore } = require('./dlc_signing_authorization_store');
const dlcNativeSignerProcessClient = require('./dlc_native_signer_process_client');
const dlcTransactionValidator = require('./dlc_transaction_validator');
const dlcSignatureValidator = require('./dlc_signature_validator');
const dlcChainGuard = require('./dlc_chain_guard');
const dlcBitcoinCoreObserver = require('./dlc_bitcoin_core_observer');
const dlcPeerTranscript = require('./dlc_peer_transcript');
const { DlcPeerSessionStore } = require('./dlc_peer_session_store');
const { DlcWatchtowerJournal } = require('./dlc_watchtower_journal');
const dlcAnchorRecoveryGuard = require('./dlc_anchor_recovery_guard');

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

  // Milestone 1 spec helpers
  PAYOUT_LEAF_SCHEMA_FIELDS: m1Spec.PAYOUT_LEAF_SCHEMA_FIELDS,
  COMMITMENT_PACKAGE_SCHEMA_FIELDS: m1Spec.COMMITMENT_PACKAGE_SCHEMA_FIELDS,
  RECEIPT_DLC_TEMPLATE_V1: m1Spec.RECEIPT_DLC_TEMPLATE_V1,
  normalizeEpochId: m1Spec.normalizeEpochId,
  normalizeAmountSats: m1Spec.normalizeAmountSats,
  validatePayoutLeafRecord: m1Spec.validatePayoutLeafRecord,
  validateCommitmentPackageRecord: m1Spec.validateCommitmentPackageRecord,
  templateHashHex: m1Spec.templateHashHex,
  ReceiptLedger: m1ReceiptLedger.ReceiptLedger,
  ReceiptDepositIndexer: m1DepositIndexer.ReceiptDepositIndexer,
  DEPOSIT_STATUSES: m1DepositIndexer.DEPOSIT_STATUSES,
  computeConfirmations: m1DepositIndexer.computeConfirmations,
  ReceiptTallyMap: m1TallyMap.ReceiptTallyMap,
  computeRouteAmounts: m1Transition.computeRouteAmounts,
  applyBinarySettlementTransition: m1Transition.applyBinarySettlementTransition,
  TransitionCircuit: m1TransitionCircuit.TransitionCircuit,
  generateTransitionCircuit: m1TransitionCircuit.generateTransitionCircuit,
  toTransitionWitness: m1TransitionCircuit.toTransitionWitness,

  // Re-export submodules for advanced usage
  types,
  merkle,
  verify,
  circuit,
  m1Spec,
  m1ReceiptLedger,
  m1Transition,
  m1TransitionCircuit,
  m1TallyMap,
  m1DepositIndexer,

  // Stable BitAgent compatibility surface. Additional V2 settlement helpers can
  // be added here without changing legacy referee exports.
  v2: Object.freeze({
    settlement: Object.freeze({
      VERSION: utxoRefV2.VERSION,
      buildFundingSetV2: utxoRefV2.buildFundingSetV2
    })
  }),

  // Experimental DLC infrastructure. Cryptographic signing remains disabled
  // for production; these interfaces enforce transcript, threshold-oracle,
  // and persistence gates on regtest and Bitcoin testnet4.
  dlc: Object.freeze({
    securityBoundaryVersion: 34,
    createContract: dlcContractState.createDlcContract,
    validateContract: dlcContractState.validateDlcContract,
    transitionContract: dlcContractState.transitionDlcContract,
    requiredEvidence: dlcContractState.REQUIRED_EVIDENCE,
    StateStore: DlcStateStore,
    OracleEventStore: DlcOracleEventStore,
    SigningAuthorizationStore: DlcSigningAuthorizationStore,
    NativeSignerProcessClient: dlcNativeSignerProcessClient.DlcNativeSignerProcessClient,
    nativeSignerRuntimeDigest: dlcNativeSignerProcessClient.nativeSignerRuntimeDigest,
    validateOracleSet: dlcThresholdOracle.validateOracleSet,
    buildThresholdOutcomeSets: dlcThresholdOracle.buildThresholdOutcomeSets,
    combineThresholdAttestations: dlcThresholdOracle.combineThresholdAttestations,
    createCryptoProvider: dlcCryptoProvider.createDlcCryptoProvider,
    requireSigningProvider: dlcCryptoProvider.requireDlcSigningProvider,
    createAdaptorSignAuthorization: dlcCryptoProvider.createDlcAdaptorSignAuthorization,
    authorizeAdaptorSign: dlcCryptoProvider.authorizeDlcAdaptorSign,
    parseCanonicalUnsignedTransaction: dlcTransactionValidator.parseCanonicalUnsignedTransaction,
    validateTransactionSet: dlcTransactionValidator.validateDlcTransactionSet,
    validateTransactionSetCommitments: dlcTransactionValidator.validateDlcTransactionSetCommitments,
    trucPolicy: Object.freeze({
      strategy: 'truc-p2a-v1',
      transactionVersion: dlcTransactionValidator.TRUC_VERSION,
      p2aScriptPubKeyHex: dlcTransactionValidator.P2A_SCRIPT_PUBKEY_HEX,
      maxSettlementVsize: dlcTransactionValidator.TRUC_MAX_VSIZE,
      maxRecoveryVsize: dlcTransactionValidator.TRUC_CHILD_MAX_VSIZE,
      maxUnconfirmedClusterTransactions: dlcTransactionValidator.TRUC_MAX_UNCONFIRMED_CLUSTER_TRANSACTIONS
    }),
    recoveryPolicy: Object.freeze({
      proposalPolicyRpc: 'testmempoolaccept',
      exactTxidAndWtxid: true,
      stableMempoolSequence: true,
      failClosedOnCoreRejection: true
    }),
    signerPolicy: Object.freeze({
      nativeCapabilityAttestation: 'ed25519',
      operatorPinnedAuditKeys: true,
      binaryDigestBound: true,
      auditDigestBound: true,
      contractTranscriptBound: true,
      processOneShotAdaptorAuthorization: true,
      durableAuthorizationStore: true,
      consumeBeforeSign: true,
      crossProcessSingleConsumer: true,
      rawAdaptorSignHidden: true,
      nativeSigningRequestKind: 'utxoref_dlc_native_adaptor_sign_request_v1',
      callerSuppliesNativeSecret: false,
      nativeKeySelection: 'authorized-xonly-pubkey',
      nativeVerifiesAuthorization: true,
      hostSecretInputRejected: true,
      enforcedProcessClient: true,
      runtimeClosureRehashedPerRequest: true,
      runtimeClosureRegularFilesOnly: true,
      runtimeClosureRejectsLinkedPaths: true,
      runtimeClosureCheckedAfterExecution: true,
      maxAuditedExecutableBytes: 134217728,
      maxAuditedCodeFileBytes: 16777216,
      challengeBoundRuntimeIdentity: true,
      boundedProcessIoAndTimeout: true,
      sanitizedProcessEnvironment: true,
      nativeCandidateImplementation: 'rust-k256-v1',
      nativeCandidateProtocol: 'utxoref-dlc-native-signer-process-v2',
      nativeCandidateBinarySha256: '8fd09d948b81b6ac65ca49bd53a27970422dfd0fd007e815724eaa67a1ddcbc9',
      nativeCandidateCargoLockSha256: 'a5715dcfcf1eef714ffb08afe6b35fdd5db6278176ead3994286da12ba01c5e2',
      lockedDirectDependencies: true,
      unsafeRustRestrictedToDpapiFfi: true,
      unsafeDpapiFfiBlocks: 7,
      reproducibleWindowsBuild: true,
      crossLanguageAdaptorVerification: true,
      signerLocalDurableReplayStore: true,
      validatorPolicyClosureBound: true,
      signerKeyPolicyClosureBound: true,
      secretIntermediatesZeroizeOnDrop: true,
      directSignerReplayRaceWorkers: 16,
      exactOneDirectSignerRaceWinner: true,
      adaptorAuthorizationKind: 'utxoref_dlc_adaptor_sign_authorization_v3',
      maxAdaptorAuthorizationTtlSeconds: 300,
      maxAdaptorAuthorizationClockSkewSeconds: 30,
      nativeAuthorizationFreshnessVerified: true,
      trustedWallClockRequired: true,
      runtimeIdentitySignedClockFloor: true,
      maxSignedClockObservations: 4096,
      clockRollbackFailsBeforeKeyUse: true,
      keyStorageBackend: 'windows-dpapi-current-user-v1',
      plaintextKeyFilesRejected: true,
      pinnedDpapiAccessVerifier: true,
      dedicatedSignerAccountRequired: true,
      expectedWindowsAccountSidBound: true,
      protectedKeyDirectoryAclRequired: true,
      allowedKeyDirectoryPrincipals: Object.freeze(['signer-account', 'SYSTEM', 'Administrators']),
      nativeDpapiDecryption: true,
      decryptionSecretIpcEliminated: true,
      dpapiAccessVerifierOutput: 'none',
      dpapiOutputMemoryLocked: true,
      decryptedKeyBufferMemoryLocked: true,
      memoryLockFailureFailsClosed: true,
      processMitigationsApplied: true,
      system32OnlyDllSearch: true,
      dynamicCodeProhibited: true,
      microsoftSignedImagesOnly: true,
      extensionPointsDisabled: true,
      remoteAndLowIntegrityImagesRejected: true,
      selfVerifiedExecutableDigest: true,
      signerAccountKeyGeneration: 'in-account-windows-csprng-dpapi-v1',
      provisioningSecretIpcEliminated: true,
      signerTransport: 'windows-named-pipe-broker-v1',
      pipeRequestMaxBytes: 65536,
      pipeResponseMaxBytes: 1048576,
      pipeBrokerPrivateKeyAccess: false,
      pipeTransportDescriptorAttested: true,
      unauthorizedPipeClientsRejected: true,
      runtimeSignedPipeResponses: true,
      rustSecAuditRequired: true,
      rustSecVulnerabilitiesAllowed: 0,
      rustSecWarningsAllowed: 0,
      dependencyAuditEvidenceBound: true,
      externalAuditRequired: true,
      productionReady: false
    }),
    bitAgentCriticalSurface: Object.freeze({
      manifest: 'utxoref-bitagent-critical-surface-v2',
      dependencyDiscovery: 'static-commonjs-relative-require-v1',
      entryPoints: Object.freeze(['index.js', 'taproot_reserve_vault.js']),
      normalizedTextLineEndings: 'lf',
      regularFilesOnly: true,
      maxFileBytes: 4194304
    }),
    validateCetAdaptorSignatures: dlcSignatureValidator.validateCetAdaptorSignatures,
    validateRefundSignature: dlcSignatureValidator.validateRefundSignature,
    evaluateChainSnapshot: dlcChainGuard.evaluateDlcChainSnapshot,
    captureBitcoinCoreSnapshot: dlcBitcoinCoreObserver.captureDlcChainSnapshot,
    captureBitcoinCoreAnchorSnapshot: dlcBitcoinCoreObserver.captureDlcAnchorRecoverySnapshot,
    observeBitcoinCoreChain: dlcBitcoinCoreObserver.observeAndEvaluateDlcChain,
    peerMessageTypes: dlcPeerTranscript.TYPES,
    testnet4ChainHash: dlcPeerTranscript.TESTNET4_CHAIN_HASH,
    computeOraclePolicyDigest: dlcPeerTranscript.computeOraclePolicyDigest,
    computeContractId: dlcPeerTranscript.computeDlcContractId,
    signPeerMessage: dlcPeerTranscript.signDlcPeerMessage,
    verifyPeerMessage: dlcPeerTranscript.verifyDlcPeerMessage,
    validatePeerTranscript: dlcPeerTranscript.validateDlcPeerTranscript,
    PeerSessionStore: DlcPeerSessionStore,
    WatchtowerJournal: DlcWatchtowerJournal,
    settlementAnchor: dlcAnchorRecoveryGuard.settlementAnchor,
    evaluateAnchorRecovery: dlcAnchorRecoveryGuard.evaluateDlcAnchorRecovery
  })
};
