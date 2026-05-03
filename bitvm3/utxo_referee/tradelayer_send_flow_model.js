const {
  stableStringify,
  sha256Hex,
  buildTradeLayerSendOracleCommitment,
  verifyTradeLayerSendOracleSignature,
  buildTradeLayerSendIntentFromStateOracle,
  buildTradeLayerSendRoutePlan,
  buildTradeLayerPnlCommitment,
  buildTradeLayerSendRouteTranscript,
  verifyTradeLayerSendRouteTranscript,
  verifyTradeLayerSendStateOracleRoute
} = require('./tradelayer_pnl_route_adapter');
const {
  buildTradeLayerSendSweepPlan,
  verifyObservedSweepOutputs
} = require('./tradelayer_send_sweep_psbt');

function outputKind(output) {
  if (!output) return 'unknown';
  if (output.role === 'send-to-dlc-funding-output') return 'dlc-funding-output';
  if (output.role === 'refund-remainder') return 'refund-remainder';
  return 'normal-address';
}

function summarizeOutput(output) {
  return {
    role: output.role || null,
    destinationKind: outputKind(output),
    address: output.address || null,
    sats: String(output.sats),
    amountBps: output.amountBps ?? null,
    oracleAddress: output.oracleAddress || null,
    matchedDlcRef: output.matchedDlcRef || null
  };
}

function stepStatus(ok, plannedStatus) {
  if (ok === false) return 'blocked';
  return plannedStatus || 'ready';
}

function buildFlowHash(flowCore) {
  return sha256Hex(stableStringify(flowCore));
}

function buildTradeLayerSendWalletFlow(stateOracleBlob, options = {}) {
  if (!stateOracleBlob || typeof stateOracleBlob !== 'object') {
    throw new Error('stateOracleBlob must be an object');
  }

  const selectOptions = {
    sendId: options.sendId,
    sendTxid: options.sendTxid,
    sendIndex: options.sendIndex,
    requireOracleSignature: options.requireOracleSignature
  };
  Object.keys(selectOptions).forEach((key) => selectOptions[key] === undefined && delete selectOptions[key]);

  const oracleCommitment = buildTradeLayerSendOracleCommitment(stateOracleBlob, selectOptions);
  const oracleSignature = verifyTradeLayerSendOracleSignature(stateOracleBlob, selectOptions);
  const sendIntent = buildTradeLayerSendIntentFromStateOracle(stateOracleBlob, selectOptions);
  const routePlan = buildTradeLayerSendRoutePlan(sendIntent, selectOptions);
  const commitmentBundle = buildTradeLayerPnlCommitment(routePlan);
  const routeTranscript = options.routeTranscript || buildTradeLayerSendRouteTranscript(routePlan, {
    commitmentBundle
  });
  const routeTranscriptVerification = verifyTradeLayerSendRouteTranscript(routeTranscript, routePlan, {
    commitmentBundle
  });
  const routeVerification = verifyTradeLayerSendStateOracleRoute(stateOracleBlob, selectOptions);
  const sweepPlan = options.sweepPlan || buildTradeLayerSendSweepPlan(routePlan, {
    liveTxid: options.liveTxid,
    signedPsbt: options.signedPsbt,
    routeTranscript
  });
  const observedSweep = options.observedSweep || verifyObservedSweepOutputs(
    routePlan,
    options.observedOutputs || routePlan.outputPlan
  );
  const sendOutput = routePlan.outputPlan.find((output) => output.role === 'send-to-dlc-funding-output' || output.role === 'send-destination') || null;
  const outputs = routePlan.outputPlan.map(summarizeOutput);

  const flowCore = {
    kind: 'tradelayer_send_wallet_flow_v1',
    network: routePlan.network,
    selectedSend: {
      id: oracleCommitment.selectedSendId,
      txid: oracleCommitment.selectedSendTxid,
      hash: oracleCommitment.sendRecordHash
    },
    hashes: {
      stateOracleHash: oracleCommitment.oracleBlobHash,
      selectedSendHash: oracleCommitment.sendRecordHash,
      dlcFunderRegistryHash: oracleCommitment.dlcFunderRegistryHash,
      routePlanHash: routePlan.planHash || null,
      withdrawalRootHex: commitmentBundle.withdrawalRootHex,
      commitmentHashHex: commitmentBundle.commitmentHashHex,
      routeTranscriptHash: routeTranscript.hash,
      fraudChallengeRoot: options.fraudChallengeBundle?.challengeRoot || null,
      fraudChallengeBundleHash: options.fraudChallengeBundle?.bundleHash || null
    },
    routeTranscript,
    amounts: {
      depositSats: String(routePlan.dlcInput.sats),
      sendBps: routePlan.sendBps,
      sendSats: String(routePlan.sendSats),
      feeSats: String(routePlan.feeSats || 0),
      residualSats: String(routePlan.residualSats || 0)
    },
    destination: {
      kind: outputKind(sendOutput),
      tradeLayerRecipient: routePlan.oracleAddress,
      resolvedSweepAddress: routePlan.resolvedDestinationAddress,
      matchedDlcRef: routePlan.matchedDlcRef || null,
      explanation: outputKind(sendOutput) === 'dlc-funding-output'
        ? 'TradeLayer recipient is a DLC funder; sweep routes to the registered DLC funding output.'
        : 'TradeLayer recipient is a normal address; sweep routes directly to that address.'
    },
    outputs,
    live: {
      sweepStatus: sweepPlan.status,
      txid: sweepPlan.liveTxid || null,
      signedPsbtAttached: Boolean(sweepPlan.signedPsbt)
    },
    verifier: {
      routeOk: routeVerification.ok,
      routeReason: routeVerification.reason || null,
      routeTranscriptOk: routeTranscriptVerification.ok,
      routeTranscriptReason: routeTranscriptVerification.reason || null,
      sweepOk: observedSweep.ok,
      sweepReason: observedSweep.reason || null,
      oracleSignatureRequired: !!selectOptions.requireOracleSignature,
      oracleSignatureOk: oracleSignature.ok,
      oracleSignatureReason: oracleSignature.reason || null
    }
  };

  const steps = [
    {
      id: 'tl-send',
      title: 'TradeLayer send',
      status: 'observed',
      txid: oracleCommitment.selectedSendTxid,
      details: {
        selectedSendId: oracleCommitment.selectedSendId,
        selectedSendHash: oracleCommitment.sendRecordHash,
        amountUnits: sendIntent.envelope?.selectedSend?.amountUnits || null
      }
    },
    {
      id: 'state-oracle',
      title: 'State oracle',
      status: stepStatus(
        selectOptions.requireOracleSignature ? oracleSignature.ok : true,
        oracleSignature.ok ? 'signed' : 'unsigned'
      ),
      details: {
        stateOracleHash: oracleCommitment.oracleBlobHash,
        designatedOracleAddress: stateOracleBlob.oracleAddress || null,
        signatureRequired: !!selectOptions.requireOracleSignature,
        signatureOk: oracleSignature.ok,
        signatureReason: oracleSignature.reason || null
      }
    },
    {
      id: 'dlc-mapping',
      title: 'DLC mapping',
      status: routePlan.matchedDlcRef ? 'mapped' : 'direct',
      details: {
        tradeLayerRecipient: routePlan.oracleAddress,
        resolvedSweepAddress: routePlan.resolvedDestinationAddress,
        destinationKind: outputKind(sendOutput),
        matchedDlcRef: routePlan.matchedDlcRef || null,
        registryHash: oracleCommitment.dlcFunderRegistryHash
      }
    },
    {
      id: 'bitvm-utxoref-sweep',
      title: 'BitVM/UTXORef sweep',
      status: routeVerification.ok && observedSweep.ok ? sweepPlan.status : 'blocked',
      details: {
        commitmentHashHex: commitmentBundle.commitmentHashHex,
        withdrawalRootHex: commitmentBundle.withdrawalRootHex,
        routeTranscriptHash: routeTranscript.hash,
        expectedOutputs: outputs,
        liveTxid: sweepPlan.liveTxid || null,
        signedPsbtAttached: Boolean(sweepPlan.signedPsbt)
      }
    }
  ];

  const flow = {
    ...flowCore,
    steps
  };
  flow.flowHash = buildFlowHash(flowCore);
  return flow;
}

function verifyTradeLayerSendWalletFlow(flow) {
  if (!flow || typeof flow !== 'object') return { ok: false, reason: 'flow must be an object' };
  if (!Array.isArray(flow.steps) || flow.steps.length !== 4) {
    return { ok: false, reason: 'flow must include four steps' };
  }

  const expectedStepIds = ['tl-send', 'state-oracle', 'dlc-mapping', 'bitvm-utxoref-sweep'];
  for (let i = 0; i < expectedStepIds.length; i++) {
    if (flow.steps[i].id !== expectedStepIds[i]) {
      return { ok: false, reason: `step ${i} must be ${expectedStepIds[i]}` };
    }
  }
  if (!flow.hashes?.stateOracleHash || !flow.hashes?.dlcFunderRegistryHash || !flow.hashes?.commitmentHashHex || !flow.hashes?.routeTranscriptHash) {
    return { ok: false, reason: 'flow hashes are incomplete' };
  }
  const transcriptCheck = verifyTradeLayerSendRouteTranscript(flow.routeTranscript);
  if (!transcriptCheck.ok) {
    return { ok: false, reason: transcriptCheck.reason, recomputedRouteTranscriptHash: transcriptCheck.recomputedHash };
  }
  if (flow.routeTranscript.hash !== flow.hashes.routeTranscriptHash) {
    return { ok: false, reason: 'flow route transcript hash mismatch' };
  }
  if (!flow.destination?.kind || !flow.destination?.resolvedSweepAddress) {
    return { ok: false, reason: 'flow destination is incomplete' };
  }
  if (!Array.isArray(flow.outputs) || !flow.outputs.length) {
    return { ok: false, reason: 'flow outputs are missing' };
  }
  if (!flow.verifier?.routeOk || !flow.verifier?.routeTranscriptOk || !flow.verifier?.sweepOk) {
    return { ok: false, reason: flow.verifier?.routeReason || flow.verifier?.routeTranscriptReason || flow.verifier?.sweepReason || 'flow verifier is not ok' };
  }

  const flowCore = {
    kind: flow.kind,
    network: flow.network,
    selectedSend: flow.selectedSend,
    hashes: flow.hashes,
    routeTranscript: flow.routeTranscript,
    amounts: flow.amounts,
    destination: flow.destination,
    outputs: flow.outputs,
    live: flow.live,
    verifier: flow.verifier
  };
  const recomputedFlowHash = buildFlowHash(flowCore);
  if (flow.flowHash !== recomputedFlowHash) {
    return { ok: false, reason: 'flow hash mismatch', recomputedFlowHash };
  }

  return {
    ok: true,
    flowHash: flow.flowHash,
    destinationKind: flow.destination.kind,
    sweepStatus: flow.live.sweepStatus
  };
}

module.exports = {
  buildTradeLayerSendWalletFlow,
  verifyTradeLayerSendWalletFlow
};
