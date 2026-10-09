const {
  stableStringify,
  sha256Hex,
  buildTradeLayerSendOracleCommitment,
  buildTradeLayerSendIntentFromStateOracle,
  buildTradeLayerSendRoutePlan,
  buildTradeLayerSendRouteTranscript,
  verifyTradeLayerSendRouteTranscript
} = require('./tradelayer_pnl_route_adapter');
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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function addAlert(alerts, code, message, details = {}, severity = 'block') {
  alerts.push({
    code,
    severity,
    message,
    details
  });
}

function normalizeInput(input, options = {}) {
  const stateOracleBlob = input?.stateOracleBlob || input?.stateOracle || input;
  if (!stateOracleBlob || typeof stateOracleBlob !== 'object' || !Array.isArray(stateOracleBlob.sends)) {
    throw new Error('watchtower input must include a TradeLayer send state oracle blob');
  }

  const selectOptions = {
    sendId: options.sendId,
    sendTxid: options.sendTxid,
    sendIndex: options.sendIndex,
    requireOracleSignature: options.requireOracleSignature
  };
  Object.keys(selectOptions).forEach((key) => selectOptions[key] === undefined && delete selectOptions[key]);

  const oracleCommitment = buildTradeLayerSendOracleCommitment(stateOracleBlob, selectOptions);
  const sendIntent = buildTradeLayerSendIntentFromStateOracle(stateOracleBlob, selectOptions);
  const routePlan = options.routePlan || input.routePlan || buildTradeLayerSendRoutePlan(sendIntent, selectOptions);
  const routeTranscript = options.routeTranscript || input.routeTranscript || buildTradeLayerSendRouteTranscript(routePlan);
  const sweepPlan = options.sweepPlan || input.sweepPlan || input.sweepTx || buildTradeLayerSendSweepPlan(routePlan, {
    routeTranscript,
    liveTxid: options.liveTxid,
    signedPsbt: options.signedPsbt
  });
  const fraudChallenges = options.fraudChallenges || input.fraudChallenges || buildTradeLayerSendFraudChallengeBundle(stateOracleBlob, selectOptions);
  const walletFlow = options.walletFlow || input.walletFlow || buildTradeLayerSendWalletFlow(stateOracleBlob, {
    ...selectOptions,
    sweepPlan,
    fraudChallengeBundle: fraudChallenges
  });
  const productionPolicy = options.productionPolicy || input.productionPolicy || buildTradeLayerSendProductionPolicy(stateOracleBlob, {
    ...selectOptions,
    routePlan,
    observedOutputs: routePlan.outputPlan,
    currentHeight: options.currentHeight,
    policy: options.policy
  });

  return {
    stateOracleBlob,
    oracleCommitment,
    routePlan,
    routeTranscript,
    sweepPlan,
    fraudChallenges,
    walletFlow,
    productionPolicy
  };
}

function buildTradeLayerSendWatchtowerReport(input, options = {}) {
  const normalized = normalizeInput(input, options);
  const alerts = [];

  const transcriptCheck = verifyTradeLayerSendRouteTranscript(
    normalized.routeTranscript,
    normalized.routePlan
  );
  if (!transcriptCheck.ok) {
    addAlert(alerts, 'route_transcript_invalid', transcriptCheck.reason, {
      expectedHash: transcriptCheck.expectedHash || null,
      actualHash: transcriptCheck.actualHash || normalized.routeTranscript?.hash || null,
      recomputedHash: transcriptCheck.recomputedHash || null
    });
  }

  const sweepTranscriptHash = normalized.sweepPlan.routeTranscriptHash || normalized.sweepPlan.routeTranscript?.hash || null;
  if (sweepTranscriptHash !== normalized.routeTranscript.hash) {
    addAlert(alerts, 'sweep_transcript_mismatch', 'sweep plan is not bound to the canonical route transcript', {
      expectedRouteTranscriptHash: normalized.routeTranscript.hash,
      sweepRouteTranscriptHash: sweepTranscriptHash
    });
  }

  const fraudCheck = verifyTradeLayerSendFraudChallengeBundle(normalized.fraudChallenges);
  if (!fraudCheck.ok) {
    addAlert(alerts, 'fraud_bundle_invalid', fraudCheck.reason, {
      challengeRoot: normalized.fraudChallenges?.challengeRoot || null,
      bundleHash: normalized.fraudChallenges?.bundleHash || null
    });
  }

  if (normalized.fraudChallenges?.binding?.routeTranscriptHash !== normalized.routeTranscript.hash) {
    addAlert(alerts, 'fraud_bundle_transcript_mismatch', 'fraud bundle is not bound to the canonical route transcript', {
      expectedRouteTranscriptHash: normalized.routeTranscript.hash,
      bundleRouteTranscriptHash: normalized.fraudChallenges?.binding?.routeTranscriptHash || null
    });
  }

  const flowCheck = verifyTradeLayerSendWalletFlow(normalized.walletFlow);
  if (!flowCheck.ok) {
    addAlert(alerts, 'wallet_flow_invalid', flowCheck.reason, {
      flowHash: normalized.walletFlow?.flowHash || null
    });
  }

  if (normalized.walletFlow?.hashes?.routeTranscriptHash !== normalized.routeTranscript.hash) {
    addAlert(alerts, 'wallet_flow_transcript_mismatch', 'wallet flow is not bound to the canonical route transcript', {
      expectedRouteTranscriptHash: normalized.routeTranscript.hash,
      walletFlowRouteTranscriptHash: normalized.walletFlow?.hashes?.routeTranscriptHash || null
    });
  }

  const policyCheck = verifyTradeLayerSendProductionPolicy(normalized.productionPolicy);
  if (!policyCheck.ok) {
    addAlert(alerts, 'production_policy_invalid', policyCheck.reason, {
      policyHash: normalized.productionPolicy?.policyHash || null
    });
  } else if (!normalized.productionPolicy.ok) {
    addAlert(alerts, 'production_policy_failed', 'production policy requires wallet pause', {
      walletAction: normalized.productionPolicy.walletAction,
      failedChecks: normalized.productionPolicy.failedChecks
    });
  }

  if (options.expectedStateOracleHash && options.expectedStateOracleHash !== normalized.oracleCommitment.oracleBlobHash) {
    addAlert(alerts, 'state_oracle_hash_mismatch', 'state oracle hash differs from expected watchtower subscription', {
      expectedStateOracleHash: options.expectedStateOracleHash,
      actualStateOracleHash: normalized.oracleCommitment.oracleBlobHash
    });
  }

  const challengeRecommended = alerts.some((alert) => alert.severity === 'block');
  const reportCore = {
    kind: 'tradelayer_send_watchtower_report_v1',
    observedAtHeight: options.observedAtHeight ?? options.currentHeight ?? normalized.stateOracleBlob.snapshotHeight ?? null,
    stateOracleHash: normalized.oracleCommitment.oracleBlobHash,
    selectedSendHash: normalized.oracleCommitment.sendRecordHash,
    dlcFunderRegistryHash: normalized.oracleCommitment.dlcFunderRegistryHash,
    routePlanHash: normalized.routePlan.planHash || null,
    routeTranscriptHash: normalized.routeTranscript.hash,
    sweepRouteTranscriptHash: sweepTranscriptHash,
    fraudChallengeRoot: normalized.fraudChallenges.challengeRoot || null,
    fraudChallengeBundleHash: normalized.fraudChallenges.bundleHash || null,
    walletFlowHash: normalized.walletFlow.flowHash || null,
    productionPolicyHash: normalized.productionPolicy.policyHash || null,
    alerts
  };

  return {
    kind: 'tradelayer_send_watchtower_report',
    ok: alerts.length === 0,
    challengeRecommended,
    action: challengeRecommended ? 'pause_and_challenge' : 'allow_cooperative_sweep',
    reportHash: sha256Hex(reportCore),
    reportCore,
    alerts,
    challengeBundle: challengeRecommended ? cloneJson(normalized.fraudChallenges) : null
  };
}

function verifyTradeLayerSendWatchtowerReport(report) {
  if (!report || typeof report !== 'object') return { ok: false, reason: 'report must be an object' };
  if (!report.reportCore || !Array.isArray(report.alerts)) return { ok: false, reason: 'report is incomplete' };
  if (stableStringify(report.reportCore.alerts) !== stableStringify(report.alerts)) {
    return { ok: false, reason: 'report alert list mismatch' };
  }
  const reportHash = sha256Hex(report.reportCore);
  if (report.reportHash !== reportHash) return { ok: false, reason: 'report hash mismatch', reportHash };
  const challengeRecommended = report.alerts.some((alert) => alert.severity === 'block');
  if (report.challengeRecommended !== challengeRecommended) return { ok: false, reason: 'challenge flag mismatch' };
  const expectedAction = challengeRecommended ? 'pause_and_challenge' : 'allow_cooperative_sweep';
  if (report.action !== expectedAction) return { ok: false, reason: 'watchtower action mismatch' };
  if (challengeRecommended && !report.challengeBundle) return { ok: false, reason: 'challenge bundle missing' };
  return {
    ok: true,
    reportHash,
    action: report.action,
    alertCount: report.alerts.length
  };
}

module.exports = {
  buildTradeLayerSendWatchtowerReport,
  verifyTradeLayerSendWatchtowerReport
};
