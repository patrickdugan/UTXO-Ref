const {
  sha256Hex,
  stableStringify,
  addressToScriptPubKey,
  buildTradeLayerSendRouteTranscript
} = require('./tradelayer_pnl_route_adapter');
const {
  buildFinalSpendBinding,
  computeDecodedTxOutputHash
} = require('./tradelayer_send_rpc_sweep');
const {
  buildTradeLayerBitvmStackBundle,
  verifyTradeLayerBitvmStackBundle
} = require('./tradelayer_bitvm_stack');

function coinStringToNumber(value) {
  return Number(value);
}

function scriptType(scriptHex) {
  if (scriptHex.startsWith('0014')) return 'witness_v0_keyhash';
  if (scriptHex.startsWith('0020')) return 'witness_v0_scripthash';
  if (scriptHex.startsWith('5120')) return 'witness_v1_taproot';
  return 'witness_unknown';
}

function buildDecodedFinalTxFromSweepPlan(sweepPlan, options = {}) {
  if (!sweepPlan || typeof sweepPlan !== 'object') throw new Error('sweepPlan must be an object');
  const outputs = Array.isArray(sweepPlan.outputs) ? sweepPlan.outputs : [];
  if (!outputs.length) throw new Error('sweepPlan.outputs must be non-empty');

  const seed = {
    kind: 'utxoref_live_path_decoded_final_tx_seed_v1',
    routeTranscriptHash: sweepPlan.routeTranscriptHash || null,
    input: sweepPlan.input || null,
    outputs
  };
  const txid = options.txid || sha256Hex({ ...seed, id: 'txid' });
  const wtxid = options.wtxid || options.hash || sha256Hex({ ...seed, id: 'wtxid' });
  const network = sweepPlan.network || options.network || 'litecoin-testnet';

  return {
    txid,
    hash: wtxid,
    version: Number(options.version || 2),
    size: Number(options.size || 140),
    vsize: Number(options.vsize || 110),
    weight: Number(options.weight || 440),
    locktime: Number(options.locktime || 0),
    vin: [
      {
        txid: sweepPlan.input?.txid || null,
        vout: sweepPlan.input?.vout ?? null,
        sequence: sweepPlan.input?.sequence ?? 0xfffffffd
      }
    ],
    vout: outputs.map((output, index) => {
      const scriptHex = output.scriptPubKey
        || addressToScriptPubKey(output.address, network).toString('hex');
      return {
        n: index,
        value: coinStringToNumber(output.coinAmount),
        scriptPubKey: {
          asm: '',
          desc: output.address ? `addr(${output.address})` : '',
          hex: scriptHex,
          address: output.address || null,
          type: scriptType(scriptHex)
        }
      };
    })
  };
}

function finalOutputChallengeCore(bundle, finalSpendBinding, options = {}) {
  const expectedFinalTxOutputHash = finalSpendBinding.core.finalTxOutputHash;
  const claimedFinalTxOutputHash = options.claimedFinalTxOutputHash || '00'.repeat(32);
  return {
    kind: 'utxoref_live_path_final_output_challenge_v1',
    stackHash: bundle.stackHash,
    routeTranscriptHash: finalSpendBinding.core.routeTranscriptHash,
    expected: {
      finalTxOutputHash: expectedFinalTxOutputHash,
      txid: finalSpendBinding.core.txid,
      wtxid: finalSpendBinding.core.wtxid
    },
    claimed: {
      finalTxOutputHash: claimedFinalTxOutputHash
    },
    challengeable: claimedFinalTxOutputHash !== expectedFinalTxOutputHash,
    remedy: claimedFinalTxOutputHash !== expectedFinalTxOutputHash
      ? 'reject signer handoff and route to final-output mismatch challenge'
      : 'none'
  };
}

function buildFinalOutputChallenge(bundle, finalSpendBinding, options = {}) {
  const core = finalOutputChallengeCore(bundle, finalSpendBinding, options);
  return {
    kind: 'utxoref_live_path_final_output_challenge',
    challengeHash: sha256Hex(core),
    challengeable: core.challengeable,
    core
  };
}

function buildLivePathCore(bundle, finalSpendBinding, finalRouteTranscript, finalOutputChallenge) {
  return {
    kind: 'utxoref_live_path_evidence_v1',
    network: bundle.network,
    fundingOutpoint: `${bundle.routePlan.dlcInput.txid}:${bundle.routePlan.dlcInput.vout}`,
    selectedSendTxid: bundle.selectedSend.txid,
    stackHash: bundle.stackHash,
    dashboardViewHash: bundle.dashboard.viewHash,
    stateCheckpointHash: bundle.stateCheckpoint.checkpointHash,
    stateOracleHash: bundle.hashes.stateOracleHash,
    selectedSendHash: bundle.hashes.selectedSendHash,
    dlcFunderRegistryHash: bundle.hashes.dlcFunderRegistryHash,
    routePlanHash: bundle.hashes.routePlanHash,
    plannedRouteTranscriptHash: bundle.sweepPlan.routeTranscriptHash,
    finalRouteTranscriptHash: finalRouteTranscript.hash,
    withdrawalRootHex: bundle.hashes.withdrawalRootHex,
    finalTxOutputHash: finalSpendBinding.core.finalTxOutputHash,
    finalSpendBindingHash: finalSpendBinding.bindingHash,
    finalTxid: finalSpendBinding.core.txid,
    finalWtxid: finalSpendBinding.core.wtxid,
    fraudBundleHash: bundle.fraudChallenges.bundleHash,
    checkpointFraudProofHash: bundle.checkpointFraudProof.proofHash,
    finalOutputChallengeHash: finalOutputChallenge.challengeHash,
    challengeableCount: bundle.fraudChallenges.challenges.filter((challenge) => challenge.challengeable).length
      + (bundle.checkpointFraudProof.challengeable ? 1 : 0)
      + (finalOutputChallenge.challengeable ? 1 : 0)
  };
}

function operatorChecklist(run) {
  return [
    {
      step: 'funding_input',
      status: 'ready_for_rpc',
      check: `gettxout ${run.stack.routePlan.dlcInput.txid} ${run.stack.routePlan.dlcInput.vout}`
    },
    {
      step: 'state_oracle',
      status: 'bound',
      check: run.core.stateOracleHash
    },
    {
      step: 'route_transcript',
      status: 'bound',
      check: run.core.plannedRouteTranscriptHash
    },
    {
      step: 'final_outputs',
      status: 'bound',
      check: run.core.finalTxOutputHash
    },
    {
      step: 'dashboard',
      status: run.stack.dashboard.status,
      check: run.core.dashboardViewHash
    }
  ];
}

function buildUtxoRefLivePathEvidence(input = {}) {
  const stack = input.stack || buildTradeLayerBitvmStackBundle(input);
  const decodedFinalTx = input.decodedFinalTx || buildDecodedFinalTxFromSweepPlan(stack.sweepPlan, input.decodedFinalTxOptions);
  const finalSpendBinding = input.finalSpendBinding || buildFinalSpendBinding(stack.sweepPlan, decodedFinalTx);
  const finalRouteTranscript = buildTradeLayerSendRouteTranscript(stack.routePlan, {
    finalTxOutputHash: finalSpendBinding.core.finalTxOutputHash
  });
  const finalOutputChallenge = buildFinalOutputChallenge(stack, finalSpendBinding, input.challengeOptions);
  const core = buildLivePathCore(stack, finalSpendBinding, finalRouteTranscript, finalOutputChallenge);
  const evidence = {
    kind: 'utxoref_live_path_evidence',
    evidenceHash: sha256Hex(core),
    core,
    stack,
    decodedFinalTx,
    finalSpendBinding,
    finalRouteTranscript,
    finalOutputChallenge
  };
  evidence.operatorChecklist = operatorChecklist(evidence);
  evidence.liveSwapPoints = {
    consensusInput: 'replace sample consensus input with TradeLayer parser output',
    decodedFinalTx: 'replace deterministic decodedFinalTx with Core decoderawtransaction output',
    signerPolicy: 'show finalTxOutputHash and routeTranscriptHash before broadcast',
    dashboard: 'display txids and hashes from evidence.core only after verification'
  };
  return evidence;
}

function verifyFinalOutputChallenge(challenge, bundle, finalSpendBinding) {
  if (!challenge || challenge.kind !== 'utxoref_live_path_final_output_challenge') {
    return { ok: false, reason: 'wrong final output challenge kind' };
  }
  const core = finalOutputChallengeCore(bundle, finalSpendBinding, {
    claimedFinalTxOutputHash: challenge.core?.claimed?.finalTxOutputHash
  });
  const challengeHash = sha256Hex(core);
  if (challenge.challengeHash !== challengeHash) {
    return { ok: false, reason: 'final output challenge hash mismatch', challengeHash };
  }
  if (stableStringify(challenge.core) !== stableStringify(core)) {
    return { ok: false, reason: 'final output challenge core mismatch' };
  }
  return { ok: true, challengeHash, challengeable: core.challengeable };
}

function verifyUtxoRefLivePathEvidence(evidence) {
  if (!evidence || evidence.kind !== 'utxoref_live_path_evidence') {
    return { ok: false, reason: 'wrong live path evidence kind' };
  }
  const stackCheck = verifyTradeLayerBitvmStackBundle(evidence.stack);
  if (!stackCheck.ok) return { ok: false, reason: `stack failed: ${stackCheck.reason}` };

  const finalTxOutputHash = computeDecodedTxOutputHash(evidence.decodedFinalTx);
  if (finalTxOutputHash !== evidence.finalSpendBinding?.core?.finalTxOutputHash) {
    return { ok: false, reason: 'decoded final output hash mismatch', finalTxOutputHash };
  }
  const rebuiltBinding = buildFinalSpendBinding(evidence.stack.sweepPlan, evidence.decodedFinalTx);
  if (rebuiltBinding.bindingHash !== evidence.finalSpendBinding.bindingHash) {
    return { ok: false, reason: 'final spend binding hash mismatch', bindingHash: rebuiltBinding.bindingHash };
  }
  const finalRouteTranscript = buildTradeLayerSendRouteTranscript(evidence.stack.routePlan, {
    finalTxOutputHash
  });
  if (finalRouteTranscript.hash !== evidence.finalRouteTranscript?.hash) {
    return { ok: false, reason: 'final route transcript hash mismatch', finalRouteTranscriptHash: finalRouteTranscript.hash };
  }
  const challengeCheck = verifyFinalOutputChallenge(
    evidence.finalOutputChallenge,
    evidence.stack,
    evidence.finalSpendBinding
  );
  if (!challengeCheck.ok) return challengeCheck;

  const core = buildLivePathCore(
    evidence.stack,
    evidence.finalSpendBinding,
    evidence.finalRouteTranscript,
    evidence.finalOutputChallenge
  );
  const evidenceHash = sha256Hex(core);
  if (evidence.evidenceHash !== evidenceHash) {
    return { ok: false, reason: 'live path evidence hash mismatch', evidenceHash };
  }
  if (stableStringify(evidence.core) !== stableStringify(core)) {
    return { ok: false, reason: 'live path core mismatch' };
  }

  return {
    ok: true,
    evidenceHash,
    stackHash: evidence.stack.stackHash,
    finalTxOutputHash,
    finalSpendBindingHash: evidence.finalSpendBinding.bindingHash,
    finalRouteTranscriptHash: evidence.finalRouteTranscript.hash,
    challengeableCount: evidence.core.challengeableCount
  };
}

module.exports = {
  buildDecodedFinalTxFromSweepPlan,
  buildFinalOutputChallenge,
  buildUtxoRefLivePathEvidence,
  verifyUtxoRefLivePathEvidence
};
