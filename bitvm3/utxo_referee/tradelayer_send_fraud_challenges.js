const {
  stableStringify,
  sha256Hex,
  buildTradeLayerSendOracleCommitment,
  buildTradeLayerSendIntentFromStateOracle,
  buildTradeLayerSendRoutePlan,
  buildTradeLayerPnlCommitment
} = require('./tradelayer_pnl_route_adapter');

const CHALLENGE_TYPES = [
  'bad_send_inclusion',
  'invalid_send_omission',
  'bad_dlc_funder_mapping',
  'bad_ratio_arithmetic',
  'wrong_destination',
  'wrong_fee',
  'wrong_refund_remainder'
];

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function toSatsText(value, fieldName) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${fieldName} must be a safe integer`);
    return String(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
  throw new Error(`${fieldName} must be an integer sat amount`);
}

function findOutput(routePlan, role) {
  return (routePlan.outputPlan || []).find((output) => output.role === role) || null;
}

function outputSummary(output) {
  if (!output) return null;
  return {
    role: output.role || null,
    address: output.address || null,
    sats: toSatsText(output.sats, 'output.sats'),
    amountBps: output.amountBps ?? null,
    oracleAddress: output.oracleAddress || null,
    matchedDlcRef: output.matchedDlcRef || null
  };
}

function resolveSkippedInvalidSend(stateOracleBlob, options = {}) {
  if (options.invalidSendRecord) return options.invalidSendRecord;
  const skipped = stateOracleBlob?.source?.skipped || [];
  return skipped.find((entry) => /invalid|insufficient|rejected|failed|consensus/i.test(String(entry.reason || ''))) || null;
}

function wrongDestinationFor(routePlan) {
  const expected = routePlan.resolvedDestinationAddress;
  const oracleAddress = routePlan.oracleAddress;
  const refund = findOutput(routePlan, 'refund-remainder');
  const candidates = [
    oracleAddress,
    routePlan.dlcInput?.address,
    refund?.address
  ].filter(Boolean);
  return candidates.find((address) => address !== expected) || `${expected}:wrong`;
}

function buildBinding(stateOracleBlob, routePlan, commitmentBundle, options = {}) {
  const oracleCommitment = buildTradeLayerSendOracleCommitment(stateOracleBlob, options);
  return {
    oracleBlobHash: oracleCommitment.oracleBlobHash,
    selectedSendHash: oracleCommitment.sendRecordHash,
    dlcFunderRegistryHash: oracleCommitment.dlcFunderRegistryHash,
    selectedSendId: oracleCommitment.selectedSendId,
    selectedSendTxid: oracleCommitment.selectedSendTxid,
    routePlanHash: routePlan.planHash || null,
    withdrawalRootHex: commitmentBundle.withdrawalRootHex,
    commitmentHashHex: commitmentBundle.commitmentHashHex
  };
}

function evaluateChallengeCore(core) {
  const expected = core.expected || {};
  const claimed = core.claimed || {};

  switch (core.challengeType) {
    case 'bad_send_inclusion':
      return claimed.sourceValid === false || Boolean(claimed.consensusRejectReason);
    case 'invalid_send_omission':
      return claimed.omittedSendHash === expected.selectedSendHash
        || claimed.omittedSendId === expected.selectedSendId
        || claimed.omittedSendTxid === expected.selectedSendTxid;
    case 'bad_dlc_funder_mapping':
      return claimed.oracleAddress === expected.oracleAddress
        && claimed.resolvedDestinationAddress !== expected.resolvedDestinationAddress;
    case 'bad_ratio_arithmetic':
      return String(claimed.sendBps) !== String(expected.sendBps)
        || toSatsText(claimed.sendSats, 'claimed.sendSats') !== toSatsText(expected.sendSats, 'expected.sendSats');
    case 'wrong_destination':
      return claimed.output?.address !== expected.output?.address
        || toSatsText(claimed.output?.sats, 'claimed.output.sats') !== toSatsText(expected.output?.sats, 'expected.output.sats');
    case 'wrong_fee':
      return toSatsText(claimed.feeSats, 'claimed.feeSats') !== toSatsText(expected.feeSats, 'expected.feeSats');
    case 'wrong_refund_remainder':
      return !expected.output
        ? claimed.output !== null
        : (
          !claimed.output
          || claimed.output.address !== expected.output.address
          || toSatsText(claimed.output.sats, 'claimed.output.sats') !== toSatsText(expected.output.sats, 'expected.output.sats')
        );
    default:
      return false;
  }
}

function makeChallenge(challengeType, binding, expected, claimed, evidence = {}) {
  if (!CHALLENGE_TYPES.includes(challengeType)) {
    throw new Error(`unsupported TradeLayer send fraud challenge: ${challengeType}`);
  }

  const core = {
    kind: 'tradelayer_send_bitvm_fraud_challenge_v1',
    challengeType,
    binding,
    expected,
    claimed,
    evidence
  };
  const challengeable = evaluateChallengeCore(core);
  const challengeCore = {
    ...core,
    challengeable,
    remedy: challengeable
      ? 'pause cooperative sweep and route to BitVM/UTXORef fraud challenge path'
      : 'none'
  };

  return {
    kind: 'tradelayer_send_bitvm_fraud_challenge',
    challengeType,
    challengeId: sha256Hex(challengeCore),
    challengeable,
    challengeCore
  };
}

function buildChallengeEntries(stateOracleBlob, routePlan, binding, options = {}) {
  const sendOutput = findOutput(routePlan, 'send-to-dlc-funding-output') || findOutput(routePlan, 'send-destination');
  const refundOutput = findOutput(routePlan, 'refund-remainder');
  const badSend = resolveSkippedInvalidSend(stateOracleBlob, options);
  const wrongDestination = wrongDestinationFor(routePlan);
  const sendSats = toSatsText(routePlan.sendSats, 'routePlan.sendSats');
  const feeSats = toSatsText(routePlan.feeSats || 0, 'routePlan.feeSats');
  const residualSats = toSatsText(routePlan.residualSats || 0, 'routePlan.residualSats');
  const wrongFeeSats = (BigInt(feeSats) + 1n).toString();
  const wrongRefundSats = refundOutput ? (BigInt(refundOutput.sats) + 1n).toString() : '1';
  const wrongSendBps = routePlan.sendBps === 10000 ? 9999 : routePlan.sendBps + 1;
  const wrongSendSats = (BigInt(sendSats) + 1n).toString();

  return [
    makeChallenge(
      'bad_send_inclusion',
      binding,
      {
        rule: 'state oracle may include only consensus-valid TradeLayer sends',
        selectedSendHash: binding.selectedSendHash
      },
      {
        includedSendId: badSend?.id || badSend?.sendId || null,
        includedSendTxid: badSend?.txid || null,
        sourceValid: badSend ? false : null,
        consensusRejectReason: badSend?.reason || null
      },
      {
        source: badSend ? 'stateOracleBlob.source.skipped' : 'template',
        note: badSend ? 'Consensus extractor recorded this send as skipped/invalid.' : 'No invalid skipped send was present in this blob.'
      }
    ),
    makeChallenge(
      'invalid_send_omission',
      binding,
      {
        rule: 'selected consensus-valid send must be included in the route set',
        selectedSendId: binding.selectedSendId,
        selectedSendTxid: binding.selectedSendTxid,
        selectedSendHash: binding.selectedSendHash
      },
      {
        omittedSendId: binding.selectedSendId,
        omittedSendTxid: binding.selectedSendTxid,
        omittedSendHash: binding.selectedSendHash
      },
      {
        source: 'selected send membership'
      }
    ),
    makeChallenge(
      'bad_dlc_funder_mapping',
      binding,
      {
        oracleAddress: routePlan.oracleAddress,
        resolvedDestinationAddress: routePlan.resolvedDestinationAddress,
        matchedDlcRef: routePlan.matchedDlcRef || null,
        dlcFunderRegistryHash: binding.dlcFunderRegistryHash
      },
      {
        oracleAddress: routePlan.oracleAddress,
        resolvedDestinationAddress: wrongDestination,
        matchedDlcRef: routePlan.matchedDlcRef || null
      },
      {
        source: 'dlcFunderRegistry commitment'
      }
    ),
    makeChallenge(
      'bad_ratio_arithmetic',
      binding,
      {
        depositSats: toSatsText(routePlan.dlcInput.sats, 'routePlan.dlcInput.sats'),
        sendBps: routePlan.sendBps,
        sendSats,
        residualSats,
        feeSats
      },
      {
        depositSats: toSatsText(routePlan.dlcInput.sats, 'routePlan.dlcInput.sats'),
        sendBps: wrongSendBps,
        sendSats: wrongSendSats,
        residualSats,
        feeSats
      },
      {
        formula: 'sendSats = floor(depositSats * sendBps / 10000)'
      }
    ),
    makeChallenge(
      'wrong_destination',
      binding,
      {
        output: outputSummary(sendOutput)
      },
      {
        output: {
          ...outputSummary(sendOutput),
          address: wrongDestination
        }
      },
      {
        source: 'observed sweep output'
      }
    ),
    makeChallenge(
      'wrong_fee',
      binding,
      {
        inputSats: toSatsText(routePlan.dlcInput.sats, 'routePlan.dlcInput.sats'),
        payoutTotalSats: (BigInt(toSatsText(routePlan.dlcInput.sats, 'routePlan.dlcInput.sats')) - BigInt(feeSats)).toString(),
        feeSats
      },
      {
        inputSats: toSatsText(routePlan.dlcInput.sats, 'routePlan.dlcInput.sats'),
        payoutTotalSats: (BigInt(toSatsText(routePlan.dlcInput.sats, 'routePlan.dlcInput.sats')) - BigInt(wrongFeeSats)).toString(),
        feeSats: wrongFeeSats
      },
      {
        formula: 'inputSats = payoutTotalSats + feeSats'
      }
    ),
    makeChallenge(
      'wrong_refund_remainder',
      binding,
      {
        output: outputSummary(refundOutput)
      },
      {
        output: refundOutput
          ? {
            ...outputSummary(refundOutput),
            sats: wrongRefundSats
          }
          : {
            role: 'refund-remainder',
            address: routePlan.dlcInput.address || null,
            sats: wrongRefundSats
          }
      },
      {
        formula: 'refundSats = depositSats - sendSats - feeSats'
      }
    )
  ];
}

function buildTradeLayerSendFraudChallengeBundle(stateOracleBlob, options = {}) {
  if (!stateOracleBlob || typeof stateOracleBlob !== 'object') {
    throw new Error('stateOracleBlob must be an object');
  }

  const oracleCommitment = buildTradeLayerSendOracleCommitment(stateOracleBlob, options);
  const sendIntent = buildTradeLayerSendIntentFromStateOracle(stateOracleBlob, options);
  const routePlan = buildTradeLayerSendRoutePlan(sendIntent, options);
  const commitmentBundle = buildTradeLayerPnlCommitment(routePlan);
  const binding = buildBinding(stateOracleBlob, routePlan, commitmentBundle, options);
  const challenges = buildChallengeEntries(stateOracleBlob, routePlan, binding, options);
  const challengeRoot = sha256Hex(challenges.map((challenge) => challenge.challengeId));

  const bundleCore = {
    kind: 'tradelayer_send_bitvm_fraud_challenge_bundle_v1',
    binding,
    challengeTypes: CHALLENGE_TYPES,
    challengeRoot
  };

  return {
    kind: 'tradelayer_send_bitvm_fraud_challenge_bundle',
    binding,
    oracle: {
      stateOracleHash: oracleCommitment.oracleBlobHash,
      selectedSendHash: oracleCommitment.sendRecordHash,
      dlcFunderRegistryHash: oracleCommitment.dlcFunderRegistryHash
    },
    challenges,
    challengeRoot,
    bundleHash: sha256Hex(bundleCore)
  };
}

function verifyTradeLayerSendFraudChallengeBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    return { ok: false, reason: 'bundle must be an object' };
  }
  if (!bundle.binding || typeof bundle.binding !== 'object') {
    return { ok: false, reason: 'bundle binding is missing' };
  }
  if (!Array.isArray(bundle.challenges)) {
    return { ok: false, reason: 'bundle challenges must be an array' };
  }

  const seenTypes = new Set();
  for (const challenge of bundle.challenges) {
    if (!challenge || typeof challenge !== 'object') {
      return { ok: false, reason: 'challenge must be an object' };
    }
    const core = challenge.challengeCore;
    if (!core || typeof core !== 'object') {
      return { ok: false, reason: `challenge core missing for ${challenge.challengeType || 'unknown'}` };
    }
    if (!CHALLENGE_TYPES.includes(challenge.challengeType)) {
      return { ok: false, reason: `unknown challenge type: ${challenge.challengeType}` };
    }
    if (stableStringify(core.binding) !== stableStringify(bundle.binding)) {
      return { ok: false, reason: `challenge binding mismatch: ${challenge.challengeType}` };
    }
    if (challenge.challengeId !== sha256Hex(core)) {
      return { ok: false, reason: `challenge id mismatch: ${challenge.challengeType}` };
    }
    if (challenge.challengeable !== evaluateChallengeCore(core)) {
      return { ok: false, reason: `challenge predicate mismatch: ${challenge.challengeType}` };
    }
    seenTypes.add(challenge.challengeType);
  }

  for (const type of CHALLENGE_TYPES) {
    if (!seenTypes.has(type)) return { ok: false, reason: `missing challenge type: ${type}` };
  }

  const challengeRoot = sha256Hex(bundle.challenges.map((challenge) => challenge.challengeId));
  if (bundle.challengeRoot !== challengeRoot) {
    return { ok: false, reason: 'challenge root mismatch' };
  }

  const bundleCore = {
    kind: 'tradelayer_send_bitvm_fraud_challenge_bundle_v1',
    binding: bundle.binding,
    challengeTypes: CHALLENGE_TYPES,
    challengeRoot
  };
  if (bundle.bundleHash !== sha256Hex(bundleCore)) {
    return { ok: false, reason: 'bundle hash mismatch' };
  }

  return {
    ok: true,
    challengeRoot,
    bundleHash: bundle.bundleHash,
    challengeableCount: bundle.challenges.filter((challenge) => challenge.challengeable).length
  };
}

module.exports = {
  CHALLENGE_TYPES: cloneJson(CHALLENGE_TYPES),
  buildTradeLayerSendFraudChallengeBundle,
  verifyTradeLayerSendFraudChallengeBundle
};
