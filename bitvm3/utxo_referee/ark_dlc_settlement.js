/**
 * Ark-backed DLC settlement prototype.
 *
 * The model: DLC outcomes are committed as "virtual CETs", but the happy path
 * settles inside an Ark round by transferring VTXO value. No on-chain CET is
 * broadcast in the normal case. UTXORef/BitVM is the governor that checks ASP
 * pathing power if the ASP signs the wrong Ark transition or withholds exit /
 * forfeit paths.
 */

const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');

const HEX_32_RE = /^[0-9a-f]{64}$/i;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value) {
  return sha256Hex(canonicalStringify(value));
}

function normalizeString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeHex32(value, fieldName) {
  const normalized = normalizeString(value, fieldName).toLowerCase();
  if (!HEX_32_RE.test(normalized)) {
    throw new Error(`${fieldName} must be a 32-byte hex string`);
  }
  return normalized;
}

function normalizeParty(party, fallbackName, fallbackCollateral) {
  const name = normalizeString((party && party.name) || fallbackName, `${fallbackName}.name`);
  const arkAddress = normalizeString(
    (party && party.arkAddress) || `ark1-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
    `${fallbackName}.arkAddress`
  );
  const collateralSats = normalizeAmountSats(
    (party && party.collateralSats) || fallbackCollateral,
    `${fallbackName}.collateralSats`
  );
  return {
    name,
    arkAddress,
    collateralSats: collateralSats.toString()
  };
}

function normalizeOutcome(outcome, totalCollateralSats) {
  const outcomeId = normalizeString(outcome.outcomeId, 'outcomeId');
  const oracleValue = String(outcome.oracleValue ?? outcomeId);
  const offerPayoutSats = normalizeAmountSats(outcome.offerPayoutSats, 'offerPayoutSats');
  const acceptPayoutSats = normalizeAmountSats(outcome.acceptPayoutSats, 'acceptPayoutSats');
  if (offerPayoutSats + acceptPayoutSats !== totalCollateralSats) {
    throw new Error(`outcome ${outcomeId} payouts must sum to total collateral`);
  }
  return {
    outcomeId,
    oracleValue,
    offerPayoutSats: offerPayoutSats.toString(),
    acceptPayoutSats: acceptPayoutSats.toString()
  };
}

function defaultOutcomes(totalCollateralSats) {
  return [
    {
      outcomeId: 'btc_down',
      oracleValue: 'price_lt_100000',
      offerPayoutSats: totalCollateralSats.toString(),
      acceptPayoutSats: '0'
    },
    {
      outcomeId: 'btc_flat',
      oracleValue: 'price_eq_100000',
      offerPayoutSats: (totalCollateralSats / 2n).toString(),
      acceptPayoutSats: (totalCollateralSats - totalCollateralSats / 2n).toString()
    },
    {
      outcomeId: 'btc_up',
      oracleValue: 'price_gt_100000',
      offerPayoutSats: '0',
      acceptPayoutSats: totalCollateralSats.toString()
    }
  ];
}

function buildArkDlcContract(options = {}) {
  const contractId = normalizeString(options.contractId || 'ark-dlc-regtest-1', 'contractId');
  const aspId = normalizeString(options.aspId || 'ark-asp-regtest', 'aspId');
  const oracleEventId = normalizeString(options.oracleEventId || 'btc-usd-expiry-regtest', 'oracleEventId');
  const oraclePubkeyHex = normalizeHex32(options.oraclePubkeyHex || sha256Hex(`oracle:${oracleEventId}`), 'oraclePubkeyHex');
  const arkRoundId = normalizeString(options.arkRoundId || 'ark-round-dlc-settlement-1', 'arkRoundId');
  const templateId = normalizeString(options.templateId || `ark-dlc-template-${aspId}`, 'templateId');
  const offerParty = normalizeParty(options.offerParty, 'offer', options.offerCollateralSats || 50000n);
  const acceptParty = normalizeParty(options.acceptParty, 'accept', options.acceptCollateralSats || 50000n);
  const totalCollateralSats = BigInt(offerParty.collateralSats) + BigInt(acceptParty.collateralSats);
  const outcomes = (options.outcomes || defaultOutcomes(totalCollateralSats)).map(outcome =>
    normalizeOutcome(outcome, totalCollateralSats)
  );

  const contractCore = {
    version: 1,
    protocol: 'ark_dlc_virtual_cet_contract',
    contractId,
    aspId,
    templateId,
    arkRoundId,
    oracleEventId,
    oraclePubkeyHex,
    offerParty,
    acceptParty,
    totalCollateralSats: totalCollateralSats.toString(),
    outcomeCount: outcomes.length,
    outcomesRoot: hashCanonical(outcomes)
  };

  return {
    kind: 'ark_dlc_contract_commitment',
    contractCommitmentId: hashCanonical(contractCore),
    contractCore,
    outcomes
  };
}

function buildVirtualCetSet(options = {}) {
  const contract = options.contract || buildArkDlcContract(options);
  const core = contract.contractCore;
  const virtualCets = contract.outcomes.map((outcome, index) => {
    const cetCore = {
      version: 1,
      protocol: 'ark_virtual_cet',
      contractCommitmentId: contract.contractCommitmentId,
      index,
      outcomeId: outcome.outcomeId,
      oracleValue: outcome.oracleValue,
      offerPayoutSats: outcome.offerPayoutSats,
      acceptPayoutSats: outcome.acceptPayoutSats,
      arkRoundId: core.arkRoundId,
      aspId: core.aspId,
      noOnchainCet: true
    };
    const virtualCetId = hashCanonical(cetCore);
    return {
      kind: 'ark_virtual_cet',
      virtualCetId,
      cetCore,
      arkTransitionId: sha256Hex(`ark-transition:${virtualCetId}`),
      hypotheticalOnchainCetTxid: sha256Hex(`onchain-cet-not-broadcast:${virtualCetId}`)
    };
  });

  const virtualCetSetCore = {
    version: 1,
    contractCommitmentId: contract.contractCommitmentId,
    virtualCetIds: virtualCets.map(cet => cet.virtualCetId),
    noOnchainCet: true
  };

  return {
    kind: 'ark_virtual_cet_set',
    virtualCetSetId: hashCanonical(virtualCetSetCore),
    virtualCetSetCore,
    virtualCets
  };
}

function buildArkDlcSettlement(options = {}) {
  const contract = options.contract || buildArkDlcContract(options);
  const virtualCetSet = options.virtualCetSet || buildVirtualCetSet({ contract });
  const oracleOutcomeId = normalizeString(options.oracleOutcomeId || contract.outcomes[1].outcomeId, 'oracleOutcomeId');
  const oracleAttestationHex = normalizeHex32(
    options.oracleAttestationHex || sha256Hex(`attestation:${contract.contractCore.oracleEventId}:${oracleOutcomeId}`),
    'oracleAttestationHex'
  );
  const selectedCet = virtualCetSet.virtualCets.find(cet => cet.cetCore.outcomeId === oracleOutcomeId);
  if (!selectedCet) throw new Error(`unknown oracle outcome ${oracleOutcomeId}`);

  const settlementCore = {
    version: 1,
    protocol: 'ark_dlc_virtual_cet_settlement',
    contractCommitmentId: contract.contractCommitmentId,
    virtualCetSetId: virtualCetSet.virtualCetSetId,
    selectedVirtualCetId: selectedCet.virtualCetId,
    oracleEventId: contract.contractCore.oracleEventId,
    oracleOutcomeId,
    oracleAttestationHex,
    aspId: contract.contractCore.aspId,
    arkRoundId: contract.contractCore.arkRoundId,
    arkTransitionId: selectedCet.arkTransitionId,
    payouts: {
      [contract.contractCore.offerParty.name]: {
        arkAddress: contract.contractCore.offerParty.arkAddress,
        amountSats: selectedCet.cetCore.offerPayoutSats
      },
      [contract.contractCore.acceptParty.name]: {
        arkAddress: contract.contractCore.acceptParty.arkAddress,
        amountSats: selectedCet.cetCore.acceptPayoutSats
      }
    },
    noOnchainCetBroadcast: true,
    avoidedOnchainCetTxid: selectedCet.hypotheticalOnchainCetTxid
  };

  return {
    kind: 'ark_dlc_settlement_evidence',
    settlementId: hashCanonical(settlementCore),
    settlementCore,
    selectedCet,
    checks: {
      selectedCetInCommittedSet: virtualCetSet.virtualCetSetCore.virtualCetIds.includes(selectedCet.virtualCetId),
      attestationBindsOutcome: oracleAttestationHex.length === 64 && selectedCet.cetCore.outcomeId === oracleOutcomeId,
      payoutSumPreservesCollateral:
        BigInt(selectedCet.cetCore.offerPayoutSats) + BigInt(selectedCet.cetCore.acceptPayoutSats) ===
        BigInt(contract.contractCore.totalCollateralSats),
      arkTransitionPresent: Boolean(selectedCet.arkTransitionId),
      noOnchainCetBroadcast: true
    }
  };
}

function buildArkDlcAspChallenge(options = {}) {
  const contract = options.contract || buildArkDlcContract(options);
  const virtualCetSet = options.virtualCetSet || buildVirtualCetSet({ contract });
  const honestSettlement = options.honestSettlement || buildArkDlcSettlement({ contract, virtualCetSet, ...options });
  const aspSettledOutcomeId = normalizeString(
    options.aspSettledOutcomeId || contract.outcomes[0].outcomeId,
    'aspSettledOutcomeId'
  );
  const missingExitPath = Boolean(options.missingExitPath);
  const missingForfeitPath = Boolean(options.missingForfeitPath);
  const aspSettledCet = virtualCetSet.virtualCets.find(cet => cet.cetCore.outcomeId === aspSettledOutcomeId);

  const violations = [];
  if (!aspSettledCet) violations.push('asp_settled_unknown_outcome');
  if (aspSettledOutcomeId !== honestSettlement.settlementCore.oracleOutcomeId) {
    violations.push('asp_settled_wrong_oracle_outcome');
  }
  if (aspSettledCet && !virtualCetSet.virtualCetSetCore.virtualCetIds.includes(aspSettledCet.virtualCetId)) {
    violations.push('asp_transition_not_in_committed_virtual_cet_set');
  }
  if (missingExitPath) violations.push('missing_user_exit_path');
  if (missingForfeitPath) violations.push('missing_asp_forfeit_path');

  const challengeCore = {
    version: 1,
    protocol: 'ark_dlc_asp_governor_challenge',
    contractCommitmentId: contract.contractCommitmentId,
    virtualCetSetId: virtualCetSet.virtualCetSetId,
    honestSettlementId: honestSettlement.settlementId,
    oracleOutcomeId: honestSettlement.settlementCore.oracleOutcomeId,
    aspSettledOutcomeId,
    aspSettledVirtualCetId: aspSettledCet && aspSettledCet.virtualCetId,
    missingExitPath,
    missingForfeitPath,
    violations
  };

  return {
    kind: 'ark_dlc_asp_governor_challenge',
    challengeId: hashCanonical(challengeCore),
    challengeCore,
    slashable: violations.length > 0,
    remedy:
      'BitVM/UTXORef challenge proves the ASP signed or routed a transition outside the oracle-selected virtual CET, enabling bond slash or forced exit.'
  };
}

function buildArkDlcFeeModel(options = {}) {
  const outcomeCount = Number(options.outcomeCount || 5000);
  const feeRateSatVb = Number(options.feeRateSatVb ?? 25);
  const cetVbytes = Number(options.cetVbytes ?? 180);
  const arkRoundVbytes = Number(options.arkRoundVbytes ?? 450);
  const arkRoundParticipants = Math.max(1, Number(options.arkRoundParticipants ?? 50));
  const aspFeeSats = normalizeAmountSats(options.aspFeeSats ?? 250n, 'aspFeeSats');
  const bitvmChallengeReserveSats = normalizeAmountSats(
    options.bitvmChallengeReserveSats ?? 5000n,
    'bitvmChallengeReserveSats'
  );
  const onchainCetWorstCaseSats = BigInt(outcomeCount) * BigInt(Math.ceil(feeRateSatVb * cetVbytes));
  const onchainHappyPathSats = BigInt(Math.ceil(feeRateSatVb * cetVbytes));
  const arkRoundShareSats = BigInt(Math.ceil((feeRateSatVb * arkRoundVbytes) / arkRoundParticipants));
  const arkHappyPathSats = arkRoundShareSats + aspFeeSats;
  const governedArkSats = arkHappyPathSats + bitvmChallengeReserveSats;

  const modelCore = {
    version: 1,
    protocol: 'ark_dlc_fee_model',
    outcomeCount,
    feeRateSatVb,
    cetVbytes,
    onchainHappyPathSats: onchainHappyPathSats.toString(),
    onchainCetWorstCaseSats: onchainCetWorstCaseSats.toString(),
    arkRoundVbytes,
    arkRoundParticipants,
    arkRoundShareSats: arkRoundShareSats.toString(),
    aspFeeSats: aspFeeSats.toString(),
    bitvmChallengeReserveSats: bitvmChallengeReserveSats.toString(),
    arkHappyPathSats: arkHappyPathSats.toString(),
    governedArkSats: governedArkSats.toString(),
    avoidsOnchainCetHappyPath: arkHappyPathSats < onchainHappyPathSats,
    avoidsCetFanoutOnchainExposure: true
  };

  return {
    kind: 'ark_dlc_fee_model',
    modelId: hashCanonical(modelCore),
    modelCore
  };
}

function buildArkDlcSettlementBundle(options = {}) {
  const contract = buildArkDlcContract(options);
  const virtualCetSet = buildVirtualCetSet({ contract });
  const settlementEvidence = buildArkDlcSettlement({ contract, virtualCetSet, ...options });
  const challengeEvidence = buildArkDlcAspChallenge({
    contract,
    virtualCetSet,
    honestSettlement: settlementEvidence,
    aspSettledOutcomeId: options.aspSettledOutcomeId,
    missingExitPath: options.challengeMissingExitPath ?? false,
    missingForfeitPath: options.challengeMissingForfeitPath ?? true
  });
  const feeModel = buildArkDlcFeeModel({
    ...options,
    outcomeCount: options.outcomeCount || virtualCetSet.virtualCets.length
  });

  const bundleCore = {
    contractCommitmentId: contract.contractCommitmentId,
    virtualCetSetId: virtualCetSet.virtualCetSetId,
    settlementId: settlementEvidence.settlementId,
    challengeId: challengeEvidence.challengeId,
    feeModelId: feeModel.modelId
  };

  return {
    kind: 'ark_dlc_settlement_bundle',
    bundleId: hashCanonical(bundleCore),
    bundleCore,
    contract,
    virtualCetSet,
    settlementEvidence,
    challengeEvidence,
    feeModel,
    thesis:
      'Settle DLC outcomes by Ark VTXO transfer in the happy path, avoiding on-chain CET broadcast. BitVM/UTXORef remains the governor against ASP misrouting or withheld exit/forfeit paths.',
    caveats: [
      'This is an evidence-shape prototype, not a production Ark ASP implementation.',
      'Production needs real Ark round signatures, VTXO tree proofs, ASP bond accounting, and oracle signature verification.',
      'The virtual CET set is committed for audit/challenge; only the selected outcome becomes an Ark transition.'
    ]
  };
}

function verifyArkDlcSettlementBundle(bundle) {
  if (!bundle || bundle.kind !== 'ark_dlc_settlement_bundle') {
    return { ok: false, reason: 'wrong bundle kind' };
  }
  if (bundle.bundleId !== hashCanonical(bundle.bundleCore)) {
    return { ok: false, reason: 'bundle id mismatch' };
  }
  if (bundle.contract.contractCommitmentId !== hashCanonical(bundle.contract.contractCore)) {
    return { ok: false, reason: 'contract commitment mismatch' };
  }
  if (bundle.virtualCetSet.virtualCetSetId !== hashCanonical(bundle.virtualCetSet.virtualCetSetCore)) {
    return { ok: false, reason: 'virtual CET set mismatch' };
  }
  for (const [name, passed] of Object.entries(bundle.settlementEvidence.checks || {})) {
    if (!passed) return { ok: false, reason: `settlement evidence failed: ${name}` };
  }
  if (!bundle.settlementEvidence.settlementCore.noOnchainCetBroadcast) {
    return { ok: false, reason: 'settlement must avoid on-chain CET in happy path' };
  }
  if (!bundle.challengeEvidence.slashable) {
    return { ok: false, reason: 'demo challenge should be slashable' };
  }
  if (bundle.feeModel.modelId !== hashCanonical(bundle.feeModel.modelCore)) {
    return { ok: false, reason: 'fee model mismatch' };
  }
  return { ok: true };
}

module.exports = {
  buildArkDlcContract,
  buildVirtualCetSet,
  buildArkDlcSettlement,
  buildArkDlcAspChallenge,
  buildArkDlcFeeModel,
  buildArkDlcSettlementBundle,
  verifyArkDlcSettlementBundle
};
