const {
  stableStringify,
  sha256Hex,
  buildTradeLayerSendOracleCommitment,
  buildTradeLayerSendIntentFromStateOracle,
  buildTradeLayerSendRoutePlan,
  buildTradeLayerPnlCommitment
} = require('./tradelayer_pnl_route_adapter');
const {
  buildTradeLayerSendStateOracleFromConsensus
} = require('./tradelayer_send_oracle_extractor');
const {
  buildTradeLayerSendSweepPlan
} = require('./tradelayer_send_sweep_psbt');
const {
  buildTradeLayerSendFraudChallengeBundle,
  verifyTradeLayerSendFraudChallengeBundle
} = require('./tradelayer_send_fraud_challenges');
const {
  buildTradeLayerSendWalletFlow,
  verifyTradeLayerSendWalletFlow
} = require('./tradelayer_send_flow_model');
const {
  buildTradeLayerSendProductionPolicy,
  verifyTradeLayerSendProductionPolicy
} = require('./tradelayer_send_policy');
const {
  buildTradeLayerSendWatchtowerReport,
  verifyTradeLayerSendWatchtowerReport
} = require('./tradelayer_send_watchtower');
const {
  buildTradeLayerStateCheckpoint,
  verifyTradeLayerStateCheckpoint,
  buildTradeLayerCheckpointFraudProof,
  verifyTradeLayerCheckpointFraudProof
} = require('./tradelayer_state_checkpoint_referee');
const {
  buildTradeLayerWithdrawalQueue,
  verifyTradeLayerWithdrawalQueue
} = require('./tradelayer_withdrawal_queue_referee');
const {
  buildTradeLayerPerpPnlSettlement,
  verifyTradeLayerPerpPnlSettlement
} = require('./tradelayer_perp_pnl_referee');
const {
  buildBitvmLiquidityLease,
  verifyBitvmLiquidityLease
} = require('./bitvm_liquidity_lease_referee');
const {
  buildBitvmArenaSecurityReport,
  verifyBitvmArenaSecurityReport
} = require('./bitvm_arena_security_report');

const DASHBOARD_SCHEMA_VERSION = 'bitvm_tradelayer_dashboard_v1';

const SAMPLE_CONSENSUS_INPUT = {
  chain: 'litecoin-testnet',
  epochId: '77',
  snapshotHeight: 4696000,
  snapshotTxid: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  oracleAddress: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
  depositUnits: '10000',
  feeSats: 1000,
  dlcInputs: {
    'live-send': {
      txid: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      vout: 1,
      address: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
      sats: 100000
    }
  },
  dlcFunderRegistry: {
    tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22: {
      dlcRef: 'dlc-live-77',
      dlcAddress: 'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz'
    }
  },
  transactions: [
    {
      txType: 2,
      id: 'live-send',
      txid: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      blockHeight: 4695999,
      senderAddress: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
      address: 'tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22',
      propertyId: 380,
      amountUnits: '2500',
      valid: true
    }
  ]
};

function stackHashInput(bundle) {
  return {
    kind: bundle.kind,
    network: bundle.network,
    checkpointHash: bundle.stateCheckpoint.checkpointHash,
    stateOracleHash: bundle.hashes.stateOracleHash,
    routeTranscriptHash: bundle.hashes.routeTranscriptHash,
    fraudBundleHash: bundle.fraudChallenges.bundleHash,
    watchtowerReportHash: bundle.watchtower.reportHash,
    withdrawalQueueHash: bundle.withdrawalQueue.queueHash,
    perpSettlementHash: bundle.perpPnl.settlementHash,
    liquidityLeaseHash: bundle.liquidityLease.leaseHash,
    arenaReportHash: bundle.arenaSecurity.reportHash,
    dashboardViewHash: bundle.dashboard.viewHash
  };
}

function buildWithdrawalRequestsFromRoute(routePlan) {
  return routePlan.outputPlan.map((output, index) => ({
    id: `route-output-${index}`,
    txid: routePlan.revealTxid || `${String(index + 1).padStart(2, '0')}`.repeat(32).slice(0, 64),
    address: output.address,
    sats: output.sats,
    propertyId: 0,
    status: 'approved'
  }));
}

function buildDashboardView(bundleCore) {
  const alerts = bundleCore.watchtower.alerts || [];
  const challengeable = [
    ...bundleCore.fraudChallenges.challenges.filter((challenge) => challenge.challengeable).map((challenge) => challenge.challengeType),
    bundleCore.checkpointFraudProof.challengeable ? bundleCore.checkpointFraudProof.proofType : null
  ].filter(Boolean);
  const hashes = {
    checkpoint: bundleCore.stateCheckpoint.checkpointHash,
    stateOracle: bundleCore.hashes.stateOracleHash,
    selectedSend: bundleCore.hashes.selectedSendHash,
    registry: bundleCore.hashes.dlcFunderRegistryHash,
    routeTranscript: bundleCore.hashes.routeTranscriptHash,
    withdrawalQueue: bundleCore.withdrawalQueue.queueHash,
    perpSettlement: bundleCore.perpPnl.settlementHash,
    liquidityLease: bundleCore.liquidityLease.leaseHash,
    arenaReport: bundleCore.arenaSecurity.reportHash
  };
  const viewCore = {
    schema: DASHBOARD_SCHEMA_VERSION,
    status: alerts.length ? 'needs_attention' : 'ready',
    hashes,
    actions: [
      bundleCore.watchtower.action,
      bundleCore.productionPolicy.walletAction,
      bundleCore.liquidityLease.enforcement.successPath
    ],
    alerts: alerts.map((alert) => ({
      code: alert.code,
      severity: alert.severity,
      message: alert.message
    })),
    challengeable,
    txids: {
      selectedSend: bundleCore.selectedSend.txid,
      fundingInput: bundleCore.routePlan.dlcInput.txid,
      liveSweep: bundleCore.sweepPlan.liveTxid || null
    },
    nextStep: alerts.length
      ? 'pause cooperative sweep and submit watchtower challenge bundle'
      : 'safe to present cooperative sweep and transcript chain'
  };
  return {
    kind: 'bitvm_tradelayer_dashboard_view',
    viewHash: sha256Hex(viewCore),
    ...viewCore
  };
}

function buildTradeLayerBitvmStackBundle(input = {}) {
  const consensusInput = input.consensusInput || SAMPLE_CONSENSUS_INPUT;
  const selectOptions = {
    selectedSendId: input.sendId || 'live-send',
    feeSats: input.feeSats
  };
  Object.keys(selectOptions).forEach((key) => selectOptions[key] === undefined && delete selectOptions[key]);
  const stateOracleBlob = input.stateOracleBlob || buildTradeLayerSendStateOracleFromConsensus(consensusInput, selectOptions);
  const sendOptions = { sendId: input.sendId || stateOracleBlob.selectedSendId };
  const oracleCommitment = buildTradeLayerSendOracleCommitment(stateOracleBlob, sendOptions);
  const sendIntent = buildTradeLayerSendIntentFromStateOracle(stateOracleBlob, sendOptions);
  const routePlan = buildTradeLayerSendRoutePlan(sendIntent, sendOptions);
  const commitmentBundle = buildTradeLayerPnlCommitment(routePlan);
  const sweepPlan = buildTradeLayerSendSweepPlan(routePlan);
  const fraudChallenges = buildTradeLayerSendFraudChallengeBundle(stateOracleBlob, sendOptions);
  const walletFlow = buildTradeLayerSendWalletFlow(stateOracleBlob, {
    ...sendOptions,
    sweepPlan,
    fraudChallengeBundle: fraudChallenges
  });
  const productionPolicy = buildTradeLayerSendProductionPolicy(stateOracleBlob, {
    ...sendOptions,
    routePlan,
    observedOutputs: routePlan.outputPlan,
    currentHeight: input.currentHeight || stateOracleBlob.snapshotHeight
  });
  const watchtower = buildTradeLayerSendWatchtowerReport({
    stateOracleBlob,
    routePlan,
    sweepPlan,
    fraudChallenges,
    walletFlow,
    productionPolicy
  }, sendOptions);
  const stateCheckpoint = buildTradeLayerStateCheckpoint({
    chain: stateOracleBlob.chain,
    epochId: stateOracleBlob.epochId,
    height: stateOracleBlob.snapshotHeight,
    previousStateRoot: input.previousStateRoot || '00'.repeat(32),
    nextStateRoot: stateOracleBlob.source?.stateRoot || sha256Hex(stateOracleBlob.sends),
    acceptedTxids: [oracleCommitment.selectedSendTxid],
    rejectedTxids: []
  });
  const checkpointFraudProof = buildTradeLayerCheckpointFraudProof(stateCheckpoint, {
    proofType: 'state_root_mismatch',
    recomputedNextStateRoot: 'aa'.repeat(32)
  });
  const withdrawalQueue = buildTradeLayerWithdrawalQueue({
    network: routePlan.network,
    epochId: stateOracleBlob.epochId,
    stateRoot: stateCheckpoint.core.nextStateRoot,
    requests: buildWithdrawalRequestsFromRoute(routePlan)
  });
  const perpPnl = buildTradeLayerPerpPnlSettlement({
    network: routePlan.network,
    epochId: stateOracleBlob.epochId,
    position: {
      contractId: 'tl-perp-demo',
      side: 'short',
      entryPrice: 2200,
      quantityUnits: 100,
      collateralSats: 50000,
      traderAddress: routePlan.resolvedDestinationAddress,
      counterpartyAddress: routePlan.dlcInput.address
    },
    close: {
      txid: oracleCommitment.selectedSendTxid,
      price: 2100,
      vwap: { price: 2100, samples: 3 }
    }
  });
  const liquidityLease = buildBitvmLiquidityLease({
    leaseId: 'tl-bitvm-stack-lease',
    promisedCapacitySats: routePlan.sendSats,
    routeEvidence: {
      channelOutpoint: `${routePlan.dlcInput.txid}:0`,
      observedCapacitySats: routePlan.sendSats,
      observedFeePpm: 500,
      observedCltvDelta: 20,
      observedAtHeight: stateOracleBlob.snapshotHeight
    }
  });
  const arenaSecurity = buildBitvmArenaSecurityReport();
  const hashes = {
    stateOracleHash: oracleCommitment.oracleBlobHash,
    selectedSendHash: oracleCommitment.sendRecordHash,
    dlcFunderRegistryHash: oracleCommitment.dlcFunderRegistryHash,
    routePlanHash: routePlan.planHash,
    routeTranscriptHash: sweepPlan.routeTranscriptHash,
    withdrawalRootHex: commitmentBundle.withdrawalRootHex,
    commitmentHashHex: commitmentBundle.commitmentHashHex
  };
  const bundleCore = {
    kind: 'bitvm_tradelayer_stack_bundle_v1',
    network: routePlan.network,
    stateOracleBlob,
    selectedSend: {
      id: oracleCommitment.selectedSendId,
      txid: oracleCommitment.selectedSendTxid
    },
    hashes,
    routePlan,
    commitment: {
      withdrawalRootHex: commitmentBundle.withdrawalRootHex,
      commitmentHashHex: commitmentBundle.commitmentHashHex
    },
    sweepPlan,
    fraudChallenges,
    walletFlow,
    productionPolicy,
    watchtower,
    stateCheckpoint,
    checkpointFraudProof,
    withdrawalQueue,
    perpPnl,
    liquidityLease,
    arenaSecurity
  };
  const dashboard = buildDashboardView(bundleCore);
  const bundle = {
    ...bundleCore,
    kind: 'bitvm_tradelayer_stack_bundle',
    network: routePlan.network,
    dashboard
  };
  bundle.stackHash = sha256Hex(stackHashInput(bundle));
  return bundle;
}

function verifyTradeLayerBitvmStackBundle(bundle) {
  if (!bundle || bundle.kind !== 'bitvm_tradelayer_stack_bundle') {
    return { ok: false, reason: 'wrong stack bundle kind' };
  }
  const checks = [
    ['fraudChallenges', verifyTradeLayerSendFraudChallengeBundle(bundle.fraudChallenges)],
    ['walletFlow', verifyTradeLayerSendWalletFlow(bundle.walletFlow)],
    ['productionPolicy', verifyTradeLayerSendProductionPolicy(bundle.productionPolicy)],
    ['watchtower', verifyTradeLayerSendWatchtowerReport(bundle.watchtower)],
    ['stateCheckpoint', verifyTradeLayerStateCheckpoint(bundle.stateCheckpoint)],
    ['checkpointFraudProof', verifyTradeLayerCheckpointFraudProof(bundle.checkpointFraudProof, bundle.stateCheckpoint)],
    ['withdrawalQueue', verifyTradeLayerWithdrawalQueue(bundle.withdrawalQueue)],
    ['perpPnl', verifyTradeLayerPerpPnlSettlement(bundle.perpPnl)],
    ['liquidityLease', verifyBitvmLiquidityLease(bundle.liquidityLease)],
    ['arenaSecurity', verifyBitvmArenaSecurityReport(bundle.arenaSecurity)]
  ];
  const failed = checks.filter(([, result]) => !result.ok);
  if (failed.length) {
    return {
      ok: false,
      reason: `${failed[0][0]} failed: ${failed[0][1].reason}`,
      failedChecks: failed.map(([name]) => name)
    };
  }
  const dashboard = buildDashboardView(bundle);
  if (dashboard.viewHash !== bundle.dashboard.viewHash) {
    return { ok: false, reason: 'dashboard view hash mismatch', dashboardViewHash: dashboard.viewHash };
  }
  const stackHash = sha256Hex(stackHashInput(bundle));
  if (stackHash !== bundle.stackHash) {
    return { ok: false, reason: 'stack hash mismatch', stackHash };
  }
  return {
    ok: true,
    stackHash,
    dashboardViewHash: bundle.dashboard.viewHash,
    status: bundle.dashboard.status,
    failedChecks: []
  };
}

function dashboardJsonSchema() {
  return {
    schema: DASHBOARD_SCHEMA_VERSION,
    requiredFields: [
      'status',
      'hashes',
      'actions',
      'alerts',
      'challengeable',
      'txids',
      'nextStep'
    ]
  };
}

module.exports = {
  DASHBOARD_SCHEMA_VERSION,
  SAMPLE_CONSENSUS_INPUT,
  buildTradeLayerBitvmStackBundle,
  verifyTradeLayerBitvmStackBundle,
  buildDashboardView,
  dashboardJsonSchema
};
