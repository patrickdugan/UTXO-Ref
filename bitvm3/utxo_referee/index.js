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
const dlcCanonicalJson = require('./dlc_canonical_json');
const dlcContractState = require('./dlc_contract_state');
const dlcThresholdOracle = require('./dlc_threshold_oracle');
const { DlcStateStore } = require('./dlc_state_store');
const dlcCryptoProvider = require('./dlc_crypto_provider');
const { DlcOracleEventStore } = require('./dlc_oracle_event_store');
const { DlcSigningAuthorizationStore } = require('./dlc_signing_authorization_store');
const { DlcRefundRecoveryStore } = require('./dlc_refund_recovery_store');
const dlcNativeSignerProcessClient = require('./dlc_native_signer_process_client');
const dlcTransactionValidator = require('./dlc_transaction_validator');
const dlcSignatureValidator = require('./dlc_signature_validator');
const dlcChainGuard = require('./dlc_chain_guard');
const dlcBitcoinCoreObserver = require('./dlc_bitcoin_core_observer');
const dlcPeerTranscript = require('./dlc_peer_transcript');
const { DlcPeerSessionStore } = require('./dlc_peer_session_store');
const { DlcWatchtowerJournal } = require('./dlc_watchtower_journal');
const dlcAnchorRecoveryGuard = require('./dlc_anchor_recovery_guard');
const dlcFundingPrebroadcastGuard = require('./dlc_funding_prebroadcast_guard');
const dlcExecutionPrebroadcastGuard = require('./dlc_execution_prebroadcast_guard');
const { DlcBroadcastAuthorizationStore } = require('./dlc_broadcast_authorization_store');
const dlcJournalCheckpoint = require('./dlc_journal_checkpoint');

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
    securityBoundaryVersion: 64,
    canonicalizeData: dlcCanonicalJson.canonicalize,
    canonicalJson: dlcCanonicalJson.canonicalJson,
    canonicalSerializationPolicy: Object.freeze({
      algorithm: 'utxoref-dlc-canonical-json-v2',
      sortedOwnStringKeys: true,
      plainObjectsAndArraysOnly: true,
      enumerableDataPropertiesOnly: true,
      accessorPropertiesAllowed: false,
      proxyObjectsAllowed: false,
      symbolPropertiesAllowed: false,
      sparseArraysAllowed: false,
      arrayExtraPropertiesAllowed: false,
      negativeZeroAllowed: false,
      ownProtoDataBound: true,
      inheritedToJsonHooksAllowed: false,
      containerEncoding: 'internal-recursive-json-v1',
      deeplyFrozenSnapshots: true,
      maxDepth: dlcCanonicalJson.MAX_CANONICAL_DEPTH,
      maxNodes: dlcCanonicalJson.MAX_CANONICAL_NODES,
      maxStringCodeUnits: dlcCanonicalJson.MAX_CANONICAL_STRING_CODE_UNITS,
      maxJsonBytes: dlcCanonicalJson.MAX_CANONICAL_JSON_BYTES
    }),
    contractInputPolicy: Object.freeze({
      recordsNormalizedBeforeFieldAccess: true,
      transitionRequestsNormalizedBeforeFieldAccess: true,
      receiptArgumentsDescriptorSnapshotted: true,
      callbackBearingInputsAllowed: false,
      durableReadsDeeplyFrozen: true,
      consumersUseCanonicalSnapshots: true,
      snapshotRetainedAcrossExternalCalls: true
    }),
    createContract: dlcContractState.createDlcContract,
    normalizeContract: dlcContractState.normalizeDlcContract,
    validateContract: dlcContractState.validateDlcContract,
    transitionContract: dlcContractState.transitionDlcContract,
    requiredEvidence: dlcContractState.REQUIRED_EVIDENCE,
    StateStore: DlcStateStore,
    OracleEventStore: DlcOracleEventStore,
    SigningAuthorizationStore: DlcSigningAuthorizationStore,
    RefundRecoveryStore: DlcRefundRecoveryStore,
    BroadcastAuthorizationStore: DlcBroadcastAuthorizationStore,
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
    parseCanonicalSignedTaprootTransaction: dlcTransactionValidator.parseCanonicalSignedTaprootTransaction,
    validateTransactionSet: dlcTransactionValidator.validateDlcTransactionSet,
    validateTransactionSetCommitments: dlcTransactionValidator.validateDlcTransactionSetCommitments,
    validateFundingPrebroadcastPolicy: dlcFundingPrebroadcastGuard.validateFundingPrebroadcastPolicy,
    validateExecutionPrebroadcastPolicy: dlcExecutionPrebroadcastGuard.validateExecutionPrebroadcastPolicy,
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
    fundingPrebroadcastPolicy: Object.freeze({
      receiptKind: 'prebroadcast_bitcoin_core_policy',
      policyRpc: 'testmempoolaccept',
      decodeRpc: 'decoderawtransaction',
      exactTxidAndWtxid: true,
      stableTipAndMempoolSequence: true,
      contractAndApprovedPsbtBound: true,
      signingAllowed: false,
      sendRawTransactionAllowed: false
    }),
    executionPrebroadcastPolicy: Object.freeze({
      receiptKinds: Object.freeze([
        'cet_prebroadcast_bitcoin_core_policy',
        'refund_prebroadcast_bitcoin_core_policy'
      ]),
      executionTypes: dlcExecutionPrebroadcastGuard.EXECUTION_TYPES,
      policyRpc: 'testmempoolaccept',
      decodeRpc: 'decoderawtransaction',
      exactTxidAndWtxid: true,
      committedSettlementBound: true,
      executionEvidenceBound: true,
      stableTipAndMempoolSequence: true,
      signingAllowed: false,
      sendRawTransactionAllowed: false
    }),
    broadcastAuthorizationPolicy: Object.freeze({
      maxPolicyTtlSeconds: 30,
      defaultPolicyTtlSeconds: 15,
      maxFutureClockSkewSeconds: 5,
      durableConsumeBeforeBroadcast: true,
      crossProcessSingleConsumer: true,
      transactionBytesRehashedAtConsumption: true,
      transitionSignaturesRevalidatedAtConsumption: true,
      linkedConsumptionRecordsAllowed: false,
      sharedDurableRecordPrimitive: true,
      consumptionParentIdentityBound: true,
      atomicNoReplacePublication: true,
      signingAllowed: false,
      sendRawTransactionAllowed: false,
      raceWorkers: 16,
      exactOneRaceWinner: true
    }),
    durableJournalPolicy: Object.freeze({
      recordReadProtocol: 'lstat-open-fstat-lstat-v2',
      atomicNoReplacePublication: 'link-excl-then-unlink-v1',
      contractStateDirectoryKey: 'sha256-contract-id-v1',
      nonSymlinkDirectoriesRequired: true,
      linkedFinalRecordsAllowed: false,
      identityStableThroughReadRequired: true,
      pathEntryStableThroughReadRequired: true,
      pathEntryStableThroughFinalFlushRequired: true,
      directoryLinkTraversalAllowed: false,
      exactSequenceFilenamesRequired: true,
      externalCheckpointKind: 'utxoref_dlc_journal_checkpoint_v1',
      signedExternalCheckpointKind: 'utxoref_dlc_signed_journal_checkpoint_v1',
      signedCheckpointAlgorithm: 'ed25519',
      signedCheckpointSignerKeyId: 'sha256-spki-der-v1',
      trustedCheckpointKeysPinned: true,
      signedCheckpointRequiredForUntrustedStorage: true,
      unsignedCheckpointStorageRequiresIndependentIntegrity: true,
      verifySignedCheckpointOnAllStores: true,
      signedCheckpointEnvelopeHash: 'sha256-canonical-envelope-v1',
      signedCheckpointExpectedHashRequired: true,
      signedCheckpointReplayProtection: 'caller-held-envelope-hash-v1',
      signedCheckpointPinInsideUntrustedStorageAllowed: false,
      checkpointStores: Object.freeze([
        'contract-state', 'oracle-event', 'peer-session', 'signing-authorization',
        'refund-recovery', 'broadcast-authorization', 'watchtower'
      ]),
      checkpointBindsRecordAtPinnedCount: true,
      longerHistoryMustContainPinnedHead: true,
      checkpointStorageInsideJournalAllowed: false,
      checkpointInputsNormalizedToFrozenPlainData: true,
      readBuffersCleared: true,
      temporaryRecordFsynced: true,
      finalRecordFsynced: true,
      recursiveLockCleanupAllowed: false,
      maxRecordBytes: Object.freeze({
        contractState: 4194304,
        oracleEvent: 1048576,
        peerSession: 131072,
        watchtowerObservation: 4194304
      })
    }),
    testnet4EvaluationPolicy: Object.freeze({
      stableSnapshotProtocol: 'tip-mempool-wallet-outpoints-v1',
      bestBlockHashBracketed: true,
      mempoolSequenceBracketed: true,
      getTxOutTipBound: true,
      walletLastProcessedBlockRequired: true,
      walletScanningRejected: true,
      deterministicUtxoOrdering: true,
      sameHeightForkDistinctEpoch: true,
      callerOwnedProtocolBuffersCopied: true,
      trustedCommitmentsImmutable: true,
      trustedPayoutLeavesImmutable: true,
      exportedHashConstantsDetached: true,
      merkleRootsAndProofsCopiedOnRead: true,
      hostAclPreflightRequiredForUntrustedAgents: true,
      bitcoinCoreBinaryProvenance: 'authenticode-sha256-v1',
      bitcoinCoreSignerThumbprint: '3A31CC9595E7A30096A8EA77F9DA2A6CB63F766F',
      bitcoinCoreDaemonSha256: 'f79eeb94e1379986df9f7be4c78c8fc8e18dc9be64a31cbaa8acad249d3db77a',
      bitcoinCoreCliSha256: 'f6ff1c850fd812c88afd817daac488dfac48b1a12eb99090ce541a663787698b',
      actualRpcListenerLoopbackRequired: true,
      rpcListenerOwnerBinaryPinned: true,
      evidenceRequiresCleanWorktree: true,
      compatibilitySnapshotDirtyTreeAllowed: false,
      scaleSnapshotDirtyTreeAllowed: false,
      evidenceCommitMustRemainStable: true,
      dedicatedSwarmAccountRequired: true,
      swarmAccountMustDifferFromCoordinator: true,
      swarmAccountAdministratorAllowed: false,
      proxyTokenAclRequired: true,
      proxyTokenParentAclRequired: true,
      proxyTokenWritableBySwarmAllowed: false,
      proxyTokenParentWritableBySwarmAllowed: false,
      untrustedAgentWalletPrivateKeysAllowed: false,
      watchOnlySwarmWalletRequired: true,
      watchOnlyWalletProvisioning: 'public-descriptor-import-v1',
      privateDescriptorsAccepted: false,
      exactWatchOnlyUtxoParityRequired: true,
      sourceWalletModified: false,
      watchOnlyEvidenceLiveRevalidated: true,
      watchOnlyEvidenceFileTrusted: false,
      watchOnlyAuditMutationAllowed: false,
      watchOnlyProvisioningSigningAllowed: false,
      watchOnlyProvisioningBroadcastAllowed: false,
      broadcastDefault: false,
      readonlyRpcProxy: 'loopback-capability-firewall-v1',
      readonlyRpcMethods: Object.freeze([
        'decoderawtransaction', 'getbestblockhash', 'getblockchaininfo', 'getblockhash',
        'getblockheader', 'getnetworkinfo', 'getrawmempool', 'gettxout', 'testmempoolaccept'
      ]),
      readonlyRpcMaxConcurrentRequests: 4,
      readonlyRpcMaxAuthenticatedRequestsPerMinute: 120,
      readonlyRpcMaxConnections: 16,
      readonlyRpcTokenFormat: 'lowercase-hex-256-bit',
      readonlyRpcTokenRevalidatedPerRequest: true,
      readonlyRpcTokenRotationRevokesImmediately: true,
      readonlyRpcTokenComparisonBuffersCleared: true,
      readonlyRpcCredentialReadIdentityBound: true,
      readonlyRpcCredentialHardLinksAllowed: false,
      readonlyRpcCredentialReadBuffersCleared: true,
      readonlyRpcMaxRequestBytes: 1048576,
      readonlyRpcMaxResponseBytes: 4194304,
      walletRpcAllowedThroughProxy: false,
      signingRpcAllowedThroughProxy: false,
      broadcastRpcAllowedThroughProxy: false,
      nodeControlRpcAllowedThroughProxy: false,
      networkControlRpcAllowedThroughProxy: false
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
      signingConsumptionIdentityBound: true,
      signingConsumptionParentIdentityBound: true,
      signingConsumptionHardLinksAllowed: false,
      signingConsumptionReadBuffersCleared: true,
      signingConsumptionFinalRecordFsynced: true,
      signingConsumptionAtomicNoReplacePublication: true,
      signingConsumptionMaxRecordBytes: 32768,
      fullySignedRefundRecoveryRequired: true,
      refundRecoveryAppendOnce: true,
      refundRecoveryTaprootWitnessVerified: true,
      refundRecoveryRestoredBeforeFunding: true,
      refundRecoveryReceiptDigestBound: true,
      refundRecoverySharedDurableRecordPrimitive: true,
      refundRecoveryParentIdentityBound: true,
      refundRecoveryReadBuffersCleared: true,
      refundRecoveryAtomicNoReplacePublication: true,
      refundRecoveryRaceWorkers: 16,
      exactOneRefundArtifactRaceWinner: true,
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
      runtimeClosureRejectsHardLinks: true,
      runtimeClosureIdentityBoundReads: 'lstat-open-fstat-lstat-v1',
      runtimeClosureParentIdentityBound: true,
      runtimeClosureReadBuffersCleared: true,
      runtimeClosureCheckedAfterExecution: true,
      maxAuditedExecutableBytes: 134217728,
      maxAuditedCodeFileBytes: 16777216,
      challengeBoundRuntimeIdentity: true,
      boundedProcessIoAndTimeout: true,
      sanitizedProcessEnvironment: true,
      nativeCandidateImplementation: 'rust-k256-v1',
      nativeCandidateProtocol: 'utxoref-dlc-native-signer-process-v2',
      nativeCandidateBinarySha256: '2f0c80cb80229c516d756c8e4f3f9fdb5d4d6c910aadc5c96844cb783b29033b',
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
      crossProcessClockStoreLock: 'windows-file-lock-v1',
      clockStoreLockTimeoutMs: 20000,
      parallelDistinctAuthorizationsTested: 16,
      freshnessCheckedBeforeAuthorizationConsumption: true,
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
    createJournalCheckpoint: dlcJournalCheckpoint.createDlcJournalCheckpoint,
    normalizeJournalCheckpoint: dlcJournalCheckpoint.normalizeDlcJournalCheckpoint,
    validateJournalCheckpoint: dlcJournalCheckpoint.validateDlcJournalCheckpoint,
    signJournalCheckpoint: dlcJournalCheckpoint.signDlcJournalCheckpoint,
    normalizeSignedJournalCheckpoint: dlcJournalCheckpoint.normalizeSignedDlcJournalCheckpoint,
    signedJournalCheckpointHash: dlcJournalCheckpoint.signedDlcJournalCheckpointHash,
    verifySignedJournalCheckpoint: dlcJournalCheckpoint.verifySignedDlcJournalCheckpoint,
    settlementAnchor: dlcAnchorRecoveryGuard.settlementAnchor,
    evaluateAnchorRecovery: dlcAnchorRecoveryGuard.evaluateDlcAnchorRecovery
  })
};
