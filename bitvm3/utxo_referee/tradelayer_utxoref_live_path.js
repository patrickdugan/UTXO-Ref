const {
  sha256Hex,
  stableStringify,
  addressToScriptPubKey,
  buildTradeLayerSendRouteTranscript
} = require('./tradelayer_pnl_route_adapter');
const {
  buildFinalSpendBinding,
  computeDecodedTxOutputHash,
  rpcFactory
} = require('./tradelayer_send_rpc_sweep');
const {
  buildTradeLayerBitvmStackBundle,
  verifyTradeLayerBitvmStackBundle
} = require('./tradelayer_bitvm_stack');

function coinStringToNumber(value) {
  return Number(value);
}

function coinValueToSatsText(value, fieldName = 'coin value') {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${fieldName} must be finite`);
    return BigInt(Math.round(value * 100000000)).toString();
  }
  const text = String(value);
  if (!/^\d+(\.\d{1,8})?$/.test(text)) throw new Error(`${fieldName} must be a coin amount`);
  const [whole, fraction = ''] = text.split('.');
  return (BigInt(whole) * 100000000n + BigInt((fraction + '00000000').slice(0, 8))).toString();
}

function scriptType(scriptHex) {
  if (scriptHex.startsWith('0014')) return 'witness_v0_keyhash';
  if (scriptHex.startsWith('0020')) return 'witness_v0_scripthash';
  if (scriptHex.startsWith('5120')) return 'witness_v1_taproot';
  return 'witness_unknown';
}

async function loadDecodedFinalTxFromRpc(options = {}) {
  const rpc = options.rpc || rpcFactory({
    rpcUrl: options.rpcUrl,
    rpcUser: options.rpcUser,
    rpcPass: options.rpcPass
  });
  const finalHex = options.finalHex || options.rawTxHex || null;
  const finalTxid = options.finalTxid || options.txid || null;

  if (finalHex) {
    return rpc('decoderawtransaction', [finalHex]);
  }
  if (finalTxid) {
    const rawOrDecoded = await rpc('getrawtransaction', [finalTxid, true]);
    if (rawOrDecoded && typeof rawOrDecoded === 'object') return rawOrDecoded;
    if (typeof rawOrDecoded === 'string') return rpc('decoderawtransaction', [rawOrDecoded]);
    throw new Error('getrawtransaction returned no decoded transaction');
  }
  throw new Error('loadDecodedFinalTxFromRpc requires finalHex or finalTxid');
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

function expectedOutputsFromSweepPlan(sweepPlan) {
  const network = sweepPlan.network || 'litecoin-testnet';
  return (sweepPlan.outputs || []).map((output, index) => {
    const scriptPubKeyHex = output.scriptPubKey
      || addressToScriptPubKey(output.address, network).toString('hex');
    return {
      n: index,
      role: output.role || null,
      address: output.address || null,
      sats: String(output.sats),
      scriptPubKeyHex
    };
  });
}

function observedOutputsFromDecodedTx(decodedTx) {
  return (decodedTx?.vout || []).map((output, index) => ({
    n: output.n ?? index,
    address: output.scriptPubKey?.address || null,
    sats: coinValueToSatsText(output.value ?? 0, `decodedTx.vout[${index}].value`),
    scriptPubKeyHex: output.scriptPubKey?.hex || null,
    type: output.scriptPubKey?.type || null
  }));
}

function compareFinalOutputs(expectedOutputs, observedOutputs) {
  const mismatches = [];
  if (expectedOutputs.length !== observedOutputs.length) {
    mismatches.push({
      code: 'output_count_mismatch',
      expected: expectedOutputs.length,
      observed: observedOutputs.length
    });
  }

  const count = Math.min(expectedOutputs.length, observedOutputs.length);
  for (let index = 0; index < count; index++) {
    const expected = expectedOutputs[index];
    const observed = observedOutputs[index];
    if (expected.sats !== observed.sats) {
      mismatches.push({
        code: 'output_value_mismatch',
        index,
        expected: expected.sats,
        observed: observed.sats
      });
    }
    if (expected.scriptPubKeyHex !== observed.scriptPubKeyHex) {
      mismatches.push({
        code: 'output_script_mismatch',
        index,
        expected: expected.scriptPubKeyHex,
        observed: observed.scriptPubKeyHex
      });
    }
    if (expected.address && observed.address && expected.address !== observed.address) {
      mismatches.push({
        code: 'output_address_mismatch',
        index,
        expected: expected.address,
        observed: observed.address
      });
    }
  }
  return mismatches;
}

function buildFinalOutputReview(sweepPlan, decodedTx) {
  const expectedOutputs = expectedOutputsFromSweepPlan(sweepPlan);
  const observedOutputs = observedOutputsFromDecodedTx(decodedTx);
  const mismatches = compareFinalOutputs(expectedOutputs, observedOutputs);
  const expectedInput = sweepPlan.input
    ? {
      txid: sweepPlan.input.txid || null,
      vout: sweepPlan.input.vout ?? null
    }
    : null;
  const observedInput = decodedTx?.vin?.[0]
    ? {
      txid: decodedTx.vin[0].txid || null,
      vout: decodedTx.vin[0].vout ?? null
    }
    : null;
  if (expectedInput && observedInput && (
    expectedInput.txid !== observedInput.txid
    || Number(expectedInput.vout) !== Number(observedInput.vout)
  )) {
    mismatches.push({
      code: 'input_outpoint_mismatch',
      expected: expectedInput,
      observed: observedInput
    });
  }

  const core = {
    kind: 'utxoref_live_path_final_output_review_v1',
    routeTranscriptHash: sweepPlan.routeTranscriptHash || sweepPlan.routeTranscript?.hash || null,
    finalTxOutputHash: computeDecodedTxOutputHash(decodedTx),
    txid: decodedTx?.txid || null,
    wtxid: decodedTx?.hash || null,
    expectedInput,
    observedInput,
    expectedOutputs,
    observedOutputs,
    mismatches
  };
  return {
    kind: 'utxoref_live_path_final_output_review',
    ok: mismatches.length === 0,
    reviewHash: sha256Hex(core),
    mismatchCodes: mismatches.map((item) => item.code),
    core
  };
}

function splitChallengeArgs(finalOutputReviewOrOptions, maybeOptions) {
  if (finalOutputReviewOrOptions?.kind === 'utxoref_live_path_final_output_review') {
    return {
      finalOutputReview: finalOutputReviewOrOptions,
      options: maybeOptions || {}
    };
  }
  return {
    finalOutputReview: null,
    options: finalOutputReviewOrOptions || {}
  };
}

function finalOutputChallengeCore(bundle, finalSpendBinding, finalOutputReviewOrOptions = {}, maybeOptions = {}) {
  const { finalOutputReview, options } = splitChallengeArgs(finalOutputReviewOrOptions, maybeOptions);
  const expectedFinalTxOutputHash = finalSpendBinding.core.finalTxOutputHash;
  const claimedFinalTxOutputHash = options.claimedFinalTxOutputHash || '00'.repeat(32);
  const claimedReviewOk = options.claimedFinalOutputReviewOk ?? false;
  const expectedReviewOk = finalOutputReview ? finalOutputReview.ok : null;
  const challengeable = claimedFinalTxOutputHash !== expectedFinalTxOutputHash
    || (finalOutputReview && !finalOutputReview.ok)
    || (finalOutputReview && claimedReviewOk !== expectedReviewOk);
  return {
    kind: 'utxoref_live_path_final_output_challenge_v1',
    stackHash: bundle.stackHash,
    routeTranscriptHash: finalSpendBinding.core.routeTranscriptHash,
    expected: {
      finalTxOutputHash: expectedFinalTxOutputHash,
      finalOutputReviewHash: finalOutputReview?.reviewHash || null,
      finalOutputReviewOk: expectedReviewOk,
      txid: finalSpendBinding.core.txid,
      wtxid: finalSpendBinding.core.wtxid
    },
    claimed: {
      finalTxOutputHash: claimedFinalTxOutputHash,
      finalOutputReviewOk: claimedReviewOk
    },
    challengeable,
    remedy: challengeable
      ? 'reject signer handoff and route to final-output mismatch challenge'
      : 'none'
  };
}

function buildFinalOutputChallenge(bundle, finalSpendBinding, finalOutputReviewOrOptions = {}, maybeOptions = {}) {
  const core = finalOutputChallengeCore(bundle, finalSpendBinding, finalOutputReviewOrOptions, maybeOptions);
  return {
    kind: 'utxoref_live_path_final_output_challenge',
    challengeHash: sha256Hex(core),
    challengeable: core.challengeable,
    core
  };
}

function buildLivePathCore(bundle, finalSpendBinding, finalRouteTranscript, finalOutputReview, finalOutputChallenge) {
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
    finalOutputReviewHash: finalOutputReview.reviewHash,
    finalOutputReviewOk: finalOutputReview.ok,
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
      status: run.finalOutputReview.ok ? 'bound' : 'mismatch',
      check: run.core.finalOutputReviewHash
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
  const finalOutputReview = buildFinalOutputReview(stack.sweepPlan, decodedFinalTx);
  const finalRouteTranscript = buildTradeLayerSendRouteTranscript(stack.routePlan, {
    finalTxOutputHash: finalSpendBinding.core.finalTxOutputHash
  });
  const finalOutputChallenge = buildFinalOutputChallenge(stack, finalSpendBinding, finalOutputReview, input.challengeOptions);
  const core = buildLivePathCore(stack, finalSpendBinding, finalRouteTranscript, finalOutputReview, finalOutputChallenge);
  const evidence = {
    kind: 'utxoref_live_path_evidence',
    evidenceHash: sha256Hex(core),
    core,
    stack,
    decodedFinalTx,
    finalSpendBinding,
    finalOutputReview,
    finalRouteTranscript,
    finalOutputChallenge
  };
  evidence.operatorChecklist = operatorChecklist(evidence);
  evidence.liveSwapPoints = {
    consensusInput: 'replace sample consensus input with TradeLayer parser output',
    decodedFinalTx: 'replace deterministic decodedFinalTx with Core decoderawtransaction output',
    signerPolicy: 'show finalTxOutputHash, finalOutputReviewHash, and routeTranscriptHash before broadcast',
    dashboard: 'display txids and hashes from evidence.core only after verification'
  };
  return evidence;
}

function verifyFinalOutputChallenge(challenge, bundle, finalSpendBinding, finalOutputReview = null) {
  if (!challenge || challenge.kind !== 'utxoref_live_path_final_output_challenge') {
    return { ok: false, reason: 'wrong final output challenge kind' };
  }
  const core = finalOutputChallengeCore(bundle, finalSpendBinding, finalOutputReview, {
    claimedFinalTxOutputHash: challenge.core?.claimed?.finalTxOutputHash,
    claimedFinalOutputReviewOk: challenge.core?.claimed?.finalOutputReviewOk
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
  const finalOutputReview = buildFinalOutputReview(evidence.stack.sweepPlan, evidence.decodedFinalTx);
  if (finalOutputReview.reviewHash !== evidence.finalOutputReview?.reviewHash) {
    return { ok: false, reason: 'final output review hash mismatch', finalOutputReviewHash: finalOutputReview.reviewHash };
  }
  if (stableStringify(finalOutputReview.core) !== stableStringify(evidence.finalOutputReview.core)) {
    return { ok: false, reason: 'final output review core mismatch' };
  }
  if (!finalOutputReview.ok) {
    return {
      ok: false,
      reason: `final output review failed: ${finalOutputReview.mismatchCodes.join(', ')}`,
      finalOutputReviewHash: finalOutputReview.reviewHash,
      mismatchCodes: finalOutputReview.mismatchCodes
    };
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
    evidence.finalSpendBinding,
    evidence.finalOutputReview
  );
  if (!challengeCheck.ok) return challengeCheck;

  const core = buildLivePathCore(
    evidence.stack,
    evidence.finalSpendBinding,
    evidence.finalRouteTranscript,
    evidence.finalOutputReview,
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
    finalOutputReviewHash: evidence.finalOutputReview.reviewHash,
    finalRouteTranscriptHash: evidence.finalRouteTranscript.hash,
    challengeableCount: evidence.core.challengeableCount
  };
}

module.exports = {
  coinValueToSatsText,
  loadDecodedFinalTxFromRpc,
  buildDecodedFinalTxFromSweepPlan,
  buildFinalOutputReview,
  buildFinalOutputChallenge,
  buildUtxoRefLivePathEvidence,
  verifyUtxoRefLivePathEvidence
};
