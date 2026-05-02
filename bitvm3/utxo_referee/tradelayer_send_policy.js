const {
  stableStringify,
  sha256Hex,
  buildTradeLayerSendOracleCommitment,
  verifyTradeLayerSendOracleSignature,
  buildTradeLayerSendIntentFromStateOracle,
  buildTradeLayerSendRoutePlan,
  verifyTradeLayerSendStateOracleRoute
} = require('./tradelayer_pnl_route_adapter');
const {
  verifyObservedSweepOutputs
} = require('./tradelayer_send_sweep_psbt');

const DEFAULT_POLICY = {
  challengeWindowBlocks: 144,
  minChallengeWindowBlocks: 6,
  dustLimitSats: '546',
  maxFeeSats: '5000',
  maxFeeBpsOfInput: 500,
  maxRegistryAgeBlocks: 2016,
  requireOracleSignature: false,
  allowedOracleAddresses: [],
  allowedOracleKeyIds: [],
  pauseOnFailure: true
};

function toSats(value, fieldName) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${fieldName} must be a safe integer`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`${fieldName} must be an integer sat amount`);
}

function normalizePolicy(options = {}) {
  const source = options.policy || {};
  const policy = { ...DEFAULT_POLICY };
  for (const key of Object.keys(DEFAULT_POLICY)) {
    if (source[key] !== undefined) policy[key] = source[key];
    if (options[key] !== undefined) policy[key] = options[key];
  }

  return {
    challengeWindowBlocks: Number(policy.challengeWindowBlocks),
    minChallengeWindowBlocks: Number(policy.minChallengeWindowBlocks),
    dustLimitSats: toSats(policy.dustLimitSats, 'policy.dustLimitSats').toString(),
    maxFeeSats: toSats(policy.maxFeeSats, 'policy.maxFeeSats').toString(),
    maxFeeBpsOfInput: Number(policy.maxFeeBpsOfInput),
    maxRegistryAgeBlocks: Number(policy.maxRegistryAgeBlocks),
    requireOracleSignature: !!policy.requireOracleSignature,
    allowedOracleAddresses: Array.isArray(policy.allowedOracleAddresses)
      ? policy.allowedOracleAddresses.map(String)
      : [],
    allowedOracleKeyIds: Array.isArray(policy.allowedOracleKeyIds)
      ? policy.allowedOracleKeyIds.map(String)
      : [],
    pauseOnFailure: policy.pauseOnFailure !== false
  };
}

function check(name, ok, details = {}, severity = 'block') {
  return {
    name,
    ok: !!ok,
    severity,
    details
  };
}

function maxFeeByBps(inputSats, maxFeeBpsOfInput) {
  return (inputSats * BigInt(maxFeeBpsOfInput)) / 10000n;
}

function registryHeight(stateOracleBlob) {
  return Number(
    stateOracleBlob.registryHeight
    ?? stateOracleBlob.dlcFunderRegistryHeight
    ?? stateOracleBlob.source?.registryHeight
    ?? stateOracleBlob.snapshotHeight
    ?? 0
  );
}

function buildTradeLayerSendProductionPolicy(stateOracleBlob, options = {}) {
  if (!stateOracleBlob || typeof stateOracleBlob !== 'object') {
    throw new Error('stateOracleBlob must be an object');
  }

  const policy = normalizePolicy(options);
  const selectOptions = {
    sendId: options.sendId,
    sendTxid: options.sendTxid,
    sendIndex: options.sendIndex,
    requireOracleSignature: policy.requireOracleSignature
  };
  Object.keys(selectOptions).forEach((key) => selectOptions[key] === undefined && delete selectOptions[key]);

  const oracleCommitment = buildTradeLayerSendOracleCommitment(stateOracleBlob, selectOptions);
  const oracleSignature = verifyTradeLayerSendOracleSignature(stateOracleBlob, selectOptions);
  const sendIntent = buildTradeLayerSendIntentFromStateOracle(stateOracleBlob, selectOptions);
  const routePlan = options.routePlan || buildTradeLayerSendRoutePlan(sendIntent, selectOptions);
  const routeVerification = verifyTradeLayerSendStateOracleRoute(stateOracleBlob, selectOptions);
  const observedSweep = verifyObservedSweepOutputs(routePlan, options.observedOutputs || routePlan.outputPlan);

  const inputSats = toSats(routePlan.dlcInput.sats, 'routePlan.dlcInput.sats');
  const feeSats = toSats(routePlan.feeSats || 0, 'routePlan.feeSats');
  const maxFeeSats = toSats(policy.maxFeeSats, 'policy.maxFeeSats');
  const maxByBps = maxFeeByBps(inputSats, policy.maxFeeBpsOfInput);
  const effectiveFeeCap = maxFeeSats < maxByBps ? maxFeeSats : maxByBps;
  const dustLimitSats = toSats(policy.dustLimitSats, 'policy.dustLimitSats');
  const currentHeight = Number(options.currentHeight ?? stateOracleBlob.snapshotHeight ?? 0);
  const regHeight = registryHeight(stateOracleBlob);
  const registryAgeBlocks = Math.max(0, currentHeight - regHeight);
  const oracleAddress = String(stateOracleBlob.oracleAddress || '');
  const oracleKeyId = oracleSignature.keyId || stateOracleBlob.oracleKeyId || null;
  const outputs = routePlan.outputPlan || [];

  const checks = [
    check('challenge_window', policy.challengeWindowBlocks >= policy.minChallengeWindowBlocks, {
      challengeWindowBlocks: policy.challengeWindowBlocks,
      minChallengeWindowBlocks: policy.minChallengeWindowBlocks
    }),
    check('fee_cap', feeSats <= effectiveFeeCap, {
      feeSats: feeSats.toString(),
      maxFeeSats: maxFeeSats.toString(),
      maxFeeBpsOfInput: policy.maxFeeBpsOfInput,
      effectiveFeeCapSats: effectiveFeeCap.toString()
    }),
    check('dust_limits', outputs.every((output) => toSats(output.sats, 'output.sats') >= dustLimitSats), {
      dustLimitSats: dustLimitSats.toString(),
      outputs: outputs.map((output) => ({
        role: output.role || null,
        address: output.address || null,
        sats: String(output.sats)
      }))
    }),
    check('registry_freshness', registryAgeBlocks <= policy.maxRegistryAgeBlocks, {
      currentHeight,
      registryHeight: regHeight,
      registryAgeBlocks,
      maxRegistryAgeBlocks: policy.maxRegistryAgeBlocks
    }),
    check('oracle_address_allowed', !policy.allowedOracleAddresses.length || policy.allowedOracleAddresses.includes(oracleAddress), {
      oracleAddress,
      allowedOracleAddresses: policy.allowedOracleAddresses
    }),
    check('oracle_key_allowed', !policy.allowedOracleKeyIds.length || (oracleKeyId && policy.allowedOracleKeyIds.includes(String(oracleKeyId))), {
      oracleKeyId,
      allowedOracleKeyIds: policy.allowedOracleKeyIds
    }),
    check('route_verifier', routeVerification.ok, {
      reason: routeVerification.reason || null,
      planHash: routeVerification.planHash || routePlan.planHash || null
    }),
    check('sweep_verifier', observedSweep.ok, {
      reason: observedSweep.reason || null,
      commitmentHashHex: observedSweep.commitmentHashHex || null,
      withdrawalRootHex: observedSweep.withdrawalRootHex || null
    })
  ];

  if (policy.requireOracleSignature) {
    checks.push(check('oracle_signature', oracleSignature.ok, {
      reason: oracleSignature.reason || null,
      keyId: oracleKeyId,
      payloadHash: oracleSignature.payloadHash || null
    }));
  }

  const failedChecks = checks.filter((item) => !item.ok);
  const policyCore = {
    kind: 'tradelayer_send_production_policy_v1',
    policy,
    binding: {
      oracleBlobHash: oracleCommitment.oracleBlobHash,
      selectedSendHash: oracleCommitment.sendRecordHash,
      dlcFunderRegistryHash: oracleCommitment.dlcFunderRegistryHash,
      routePlanHash: routePlan.planHash || null
    },
    checks
  };

  return {
    kind: 'tradelayer_send_production_policy',
    policy,
    binding: policyCore.binding,
    checks,
    ok: failedChecks.length === 0,
    failedChecks: failedChecks.map((item) => item.name),
    walletAction: failedChecks.length === 0
      ? 'allow_sweep'
      : policy.pauseOnFailure
        ? 'pause_spend'
        : 'warn_only',
    policyHash: sha256Hex(policyCore)
  };
}

function verifyTradeLayerSendProductionPolicy(policyResult) {
  if (!policyResult || typeof policyResult !== 'object') {
    return { ok: false, reason: 'policy result must be an object' };
  }
  if (!policyResult.policy || !policyResult.binding || !Array.isArray(policyResult.checks)) {
    return { ok: false, reason: 'policy result is incomplete' };
  }

  const failedChecks = policyResult.checks.filter((item) => !item.ok).map((item) => item.name);
  const expectedOk = failedChecks.length === 0;
  if (policyResult.ok !== expectedOk) {
    return { ok: false, reason: 'policy ok flag mismatch' };
  }
  if (stableStringify(policyResult.failedChecks || []) !== stableStringify(failedChecks)) {
    return { ok: false, reason: 'policy failedChecks mismatch' };
  }

  const expectedAction = expectedOk
    ? 'allow_sweep'
    : policyResult.policy.pauseOnFailure
      ? 'pause_spend'
      : 'warn_only';
  if (policyResult.walletAction !== expectedAction) {
    return { ok: false, reason: 'policy walletAction mismatch' };
  }

  const policyCore = {
    kind: 'tradelayer_send_production_policy_v1',
    policy: policyResult.policy,
    binding: policyResult.binding,
    checks: policyResult.checks
  };
  const policyHash = sha256Hex(policyCore);
  if (policyResult.policyHash !== policyHash) {
    return { ok: false, reason: 'policy hash mismatch', policyHash };
  }

  return {
    ok: true,
    policyHash,
    walletAction: policyResult.walletAction,
    failedChecks
  };
}

module.exports = {
  DEFAULT_POLICY,
  buildTradeLayerSendProductionPolicy,
  verifyTradeLayerSendProductionPolicy
};
