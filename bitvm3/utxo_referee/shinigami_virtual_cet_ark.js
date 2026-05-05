/**
 * Shinigami Ark virtual-CET bridge.
 *
 * This prototype compresses a DLC CET set into Ark virtual leaves, then binds
 * the selected outcome to a Shinigami-style public claim and deterministic
 * proof receipt. The receipt is a scaffold for a future real STWO/Shinigami
 * proof, but every public commitment here is recomputable.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');
const {
  buildArkDlcContract,
  buildVirtualCetSet,
  buildArkDlcSettlement,
  buildArkDlcAspChallenge
} = require('./ark_dlc_settlement');
const {
  buildArkTaprootMiniscriptProofManifest,
  verifyArkTaprootMiniscriptProofManifest
} = require('./ark_taproot_miniscript_proof_manifest');
const { buildArkZkMiniscriptClaim } = require('./ark_zk_miniscript_proof');
const {
  buildShinigamiProofPublicationBundle,
  verifyShinigamiProofPublicationBundle
} = require('./shinigami_proof_publication');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts', 'shinigami_virtual_cet');
const SUMMARY_PATH = path.join(ARTIFACTS_DIR, 'shinigami_virtual_cet_latest.json');
const HEX_32_RE = /^[0-9a-f]{64}$/i;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value) {
  return sha256Hex(canonicalStringify(value));
}

function stringifyJson(value, pretty = true) {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v), pretty ? 2 : 0);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${stringifyJson(value, true)}\n`, 'utf8');
}

function normalizeString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function normalizePositiveInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function normalizeHex32(value, fieldName) {
  const normalized = normalizeString(value, fieldName).toLowerCase();
  if (!HEX_32_RE.test(normalized)) {
    throw new Error(`${fieldName} must be a 32-byte hex string`);
  }
  return normalized;
}

function buildDefaultOutcomeSet(options = {}) {
  const totalCollateralSats = normalizeAmountSats(options.totalCollateralSats || 100000n, 'totalCollateralSats');
  const outcomeCount = Math.max(3, normalizePositiveInteger(options.outcomeCount || 17, 'outcomeCount'));
  const entryPrice = normalizePositiveInteger(options.entryPrice || 65000, 'entryPrice');
  const priceStep = normalizePositiveInteger(options.priceStep || 250, 'priceStep');
  const mid = Math.floor(outcomeCount / 2);

  return Array.from({ length: outcomeCount }, (_unused, index) => {
    const price = entryPrice + (index - mid) * priceStep;
    const denominator = BigInt(outcomeCount - 1);
    const offerPayoutSats = (totalCollateralSats * BigInt(outcomeCount - 1 - index)) / denominator;
    const acceptPayoutSats = totalCollateralSats - offerPayoutSats;
    const suffix = index === mid ? 'at_entry' : price < entryPrice ? `down_${entryPrice - price}` : `up_${price - entryPrice}`;
    return {
      outcomeId: `btc_usd_${suffix}`,
      oracleValue: `BTCUSD=${price}`,
      offerPayoutSats: offerPayoutSats.toString(),
      acceptPayoutSats: acceptPayoutSats.toString()
    };
  });
}

function buildArkLeafLayer(contract, virtualCetSet) {
  const leaves = virtualCetSet.virtualCets.map((cet, index) => {
    const leafCore = {
      version: 1,
      protocol: 'ark_vtxo_virtual_cet_leaf',
      index,
      contractCommitmentId: contract.contractCommitmentId,
      virtualCetSetId: virtualCetSet.virtualCetSetId,
      virtualCetId: cet.virtualCetId,
      arkRoundId: contract.contractCore.arkRoundId,
      aspId: contract.contractCore.aspId,
      outcomeId: cet.cetCore.outcomeId,
      oracleValue: cet.cetCore.oracleValue,
      offerPayoutSats: cet.cetCore.offerPayoutSats,
      acceptPayoutSats: cet.cetCore.acceptPayoutSats,
      materializedCetTxid: null,
      carriesVtxoOnly: true
    };
    return {
      kind: 'ark_vtxo_virtual_cet_leaf',
      leafHash: hashCanonical(leafCore),
      leafCore
    };
  });

  const layerCore = {
    version: 1,
    protocol: 'ark_virtual_cet_leaf_layer',
    contractCommitmentId: contract.contractCommitmentId,
    virtualCetSetId: virtualCetSet.virtualCetSetId,
    leafHashes: leaves.map(leaf => leaf.leafHash)
  };

  return {
    kind: 'ark_virtual_cet_leaf_layer',
    arkLeafRoot: hashCanonical(layerCore),
    layerCore,
    leaves
  };
}

function computeOracleOutcomeHash(fields) {
  return hashCanonical({
    protocol: 'shinigami_oracle_outcome_binding',
    oracleEventId: fields.oracleEventId,
    selectedOutcomeId: fields.selectedOutcomeId,
    oracleAttestationHex: fields.oracleAttestationHex,
    oracleAttestationAgeBlocks: fields.oracleAttestationAgeBlocks,
    maxOracleAgeBlocks: fields.maxOracleAgeBlocks
  });
}

function computePayoutRoot(contract, selectedVirtualCet, selectedOutcome) {
  const payoutCore = {
    version: 1,
    protocol: 'shinigami_virtual_cet_payout_root',
    contractCommitmentId: contract.contractCommitmentId,
    selectedVirtualCetId: selectedVirtualCet.virtualCetId,
    selectedOutcomeId: selectedOutcome.outcomeId,
    oracleValue: selectedOutcome.oracleValue,
    totalCollateralSats: contract.contractCore.totalCollateralSats,
    payouts: {
      [contract.contractCore.offerParty.name]: {
        arkAddress: contract.contractCore.offerParty.arkAddress,
        amountSats: selectedOutcome.offerPayoutSats
      },
      [contract.contractCore.acceptParty.name]: {
        arkAddress: contract.contractCore.acceptParty.arkAddress,
        amountSats: selectedOutcome.acceptPayoutSats
      }
    },
    materializedCetCount: 0,
    arkVtxoSettlementOnly: true
  };
  return {
    payoutRoot: hashCanonical(payoutCore),
    payoutCore
  };
}

function buildShinigamiZkClaim(fields) {
  const maxOracleAgeBlocks = normalizePositiveInteger(fields.maxOracleAgeBlocks ?? 144, 'maxOracleAgeBlocks');
  const oracleAttestationAgeBlocks = Number(fields.oracleAttestationAgeBlocks ?? 3);
  if (!Number.isInteger(oracleAttestationAgeBlocks) || oracleAttestationAgeBlocks < 0) {
    throw new Error('oracleAttestationAgeBlocks must be a non-negative integer');
  }
  const oracleAttestationHex = normalizeHex32(fields.oracleAttestationHex, 'oracleAttestationHex');
  const oracleOutcomeHash = computeOracleOutcomeHash({
    oracleEventId: fields.oracleEventId,
    selectedOutcomeId: fields.selectedOutcomeId,
    oracleAttestationHex,
    oracleAttestationAgeBlocks,
    maxOracleAgeBlocks
  });

  const claimCore = {
    version: 1,
    protocol: 'shinigami_ark_virtual_cet_claim',
    contractId: fields.contractId,
    contractCommitmentId: fields.contractCommitmentId,
    oracleEventId: fields.oracleEventId,
    selectedOutcomeId: fields.selectedOutcomeId,
    oracleOutcomeHash,
    oracleAttestationHex,
    oracleAttestationAgeBlocks,
    maxOracleAgeBlocks,
    arkRoundId: fields.arkRoundId,
    virtualCetSetId: fields.virtualCetSetId,
    arkLeafRoot: fields.arkLeafRoot,
    selectedLeafHash: fields.selectedLeafHash,
    selectedVirtualCetId: fields.selectedVirtualCetId,
    payoutRoot: fields.payoutRoot,
    amountSats: fields.amountSats,
    materializedCetCount: 0,
    proofStatement:
      'The selected oracle outcome is a member of the committed Ark virtual-CET leaf set, and its payout root preserves DLC collateral without broadcasting an on-chain CET.'
  };

  return {
    kind: 'shinigami_ark_virtual_cet_claim',
    claimId: hashCanonical(claimCore),
    claimCore,
    publicInputs: [
      'contract_commitment_id',
      'oracle_outcome_hash',
      'ark_leaf_root',
      'selected_leaf_hash',
      'payout_root',
      'amount_sats'
    ],
    cairoProgram: 'ark_shinigami_virtual_cet_membership_v1'
  };
}

function buildDeterministicProofReceipt(zkClaim, options = {}) {
  const receiptCore = {
    version: 1,
    protocol: 'deterministic_shinigami_virtual_cet_receipt',
    proofSystem: 'shinigami-stwo-placeholder',
    verifier: normalizeString(options.verifier || 'utxoref-local-deterministic-harness', 'verifier'),
    status: 'accepted-scaffold',
    claimId: zkClaim.claimId,
    claimDigest: hashCanonical(zkClaim.claimCore),
    proofTranscriptRoot: hashCanonical({
      claimId: zkClaim.claimId,
      proofSystem: 'shinigami-stwo-placeholder',
      cairoProgram: zkClaim.cairoProgram
    }),
    proverExitCode: Number(options.proverExitCode ?? 0),
    verifierExitCode: Number(options.verifierExitCode ?? 0)
  };

  return {
    kind: 'deterministic_shinigami_virtual_cet_receipt',
    receiptId: hashCanonical(receiptCore),
    receiptCore
  };
}

function buildShinigamiFraudCases(bundle) {
  const context = bundle
    ? {
        contractCommitmentId: bundle.contract.contractCommitmentId,
        virtualCetSetId: bundle.virtualCetSet.virtualCetSetId,
        claimId: bundle.zkClaim.claimId,
        receiptId: bundle.proofReceipt.receiptId
      }
    : {};
  const cases = [
    {
      id: 'wrong-outcome',
      label: 'Wrong oracle outcome',
      challengeViolation: 'selected_outcome_not_oracle_attested',
      publicInputs: ['oracle_outcome_hash', 'selected_leaf_hash'],
      witnessCounterexample: 'published oracle attestation hashes to another outcome',
      bitvmRemedy: 'reject Ark transition and route to ASP forfeit path'
    },
    {
      id: 'wrong-payout',
      label: 'Wrong payout root',
      challengeViolation: 'payout_root_does_not_match_selected_leaf',
      publicInputs: ['selected_leaf_hash', 'payout_root', 'amount_sats'],
      witnessCounterexample: 'selected virtual CET leaf recomputes a different payout root',
      bitvmRemedy: 'slash the signer that advanced the bad payout root'
    },
    {
      id: 'omitted-leaf',
      label: 'Omitted Ark leaf',
      challengeViolation: 'ark_leaf_root_omits_committed_virtual_cet',
      publicInputs: ['virtual_cet_set_id', 'ark_leaf_root'],
      witnessCounterexample: 'committed virtual CET id is missing from the Ark VTXO leaf layer',
      bitvmRemedy: 'force exit using the committed DLC outcome set'
    },
    {
      id: 'stale-oracle',
      label: 'Stale oracle claim',
      challengeViolation: 'oracle_attestation_age_exceeds_policy',
      publicInputs: ['oracle_attestation_age_blocks', 'max_oracle_age_blocks'],
      witnessCounterexample: 'attestation age exceeds the DLC policy window',
      bitvmRemedy: 'pause settlement and require a fresh oracle publication'
    },
    {
      id: 'bad-membership',
      label: 'Bad membership proof',
      challengeViolation: 'selected_leaf_not_in_ark_root',
      publicInputs: ['ark_leaf_root', 'selected_leaf_hash'],
      witnessCounterexample: 'Merkle path or leaf fold does not reach the committed Ark root',
      bitvmRemedy: 'open BitVM challenge over the leaf membership circuit'
    },
    {
      id: 'asp-route-mismatch',
      label: 'ASP route mismatch',
      challengeViolation: 'asp_transition_not_selected_virtual_cet',
      publicInputs: ['ark_round_id', 'selected_virtual_cet_id'],
      witnessCounterexample: 'ASP advanced a VTXO transition for a different virtual CET',
      bitvmRemedy: 'slash ASP bond or force unilateral VTXO exit'
    }
  ];

  return cases.map(item => {
    const caseCore = {
      version: 1,
      protocol: 'shinigami_virtual_cet_fraud_case',
      ...context,
      ...item,
      slashable: true
    };
    return {
      ...item,
      caseId: hashCanonical(caseCore),
      caseCore,
      slashable: true
    };
  });
}

function buildDashboardProjection(bundle) {
  const claim = bundle.zkClaim.claimCore;
  const fraudCases = bundle.fraudCases.map(item => ({
    id: item.id,
    label: item.label,
    challengeViolation: item.challengeViolation,
    publicInputs: item.publicInputs,
    witnessCounterexample: item.witnessCounterexample,
    bitvmRemedy: item.bitvmRemedy,
    slashable: item.slashable
  }));

  return {
    title: 'Shinigami Virtual CETs',
    headline: 'Ark carries the CET fanout as virtual leaves; Shinigami proves the selected leaf and payout root.',
    summary: {
      contractId: bundle.contractId,
      bundleId: bundle.bundleId,
      oracleEventId: bundle.oracleEventId,
      arkRoundId: bundle.arkRoundId,
      virtualCetCount: bundle.virtualCetSet.virtualCets.length,
      materializedCetCount: 0,
      selectedOutcomeId: bundle.selectedOutcome.outcomeId,
      proofStatus: bundle.proofReceipt.receiptCore.status
    },
    flow: [
      {
        id: 'dlc-outcomes',
        label: 'DLC outcome grid',
        detail: `${bundle.virtualCetSet.virtualCets.length} possible CET outcomes are committed by hash.`,
        commitment: bundle.contract.contractCore.outcomesRoot
      },
      {
        id: 'ark-virtual-leaves',
        label: 'Ark virtual leaves',
        detail: 'Each outcome becomes a VTXO leaf instead of an on-chain CET transaction.',
        commitment: bundle.arkLeafRoot
      },
      {
        id: 'shinigami-claim',
        label: 'Shinigami claim',
        detail: 'The public claim binds oracle outcome, selected leaf, payout root, and Ark round.',
        commitment: bundle.zkClaim.claimId
      },
      {
        id: 'bitvm-challenge',
        label: 'BitVM/UTXORef challenge',
        detail: 'Fraud cases decide whether the ASP exits cooperatively or gets slashed.',
        commitment: bundle.proofReceipt.receiptId
      }
    ],
    proofStatement: {
      contractId: bundle.contractId,
      oracleEventId: bundle.oracleEventId,
      arkRoundId: bundle.arkRoundId,
      oracleOutcomeHash: claim.oracleOutcomeHash,
      selectedLeafHash: bundle.selectedLeafHash,
      arkLeafRoot: bundle.arkLeafRoot,
      selectedVirtualCetId: bundle.selectedVirtualCetId,
      payoutRoot: bundle.payoutRoot,
      claimId: bundle.zkClaim.claimId,
      receiptId: bundle.proofReceipt.receiptId,
      amountSats: claim.amountSats,
      exitDelayBlocks: bundle.exitDelayBlocks,
      materializedCetCount: 0
    },
    compression: {
      virtualCetCount: bundle.virtualCetSet.virtualCets.length,
      arkLeafCount: bundle.arkLeafLayer.leaves.length,
      materializedCetCount: 0,
      selectedOutcomeId: bundle.selectedOutcome.outcomeId,
      avoidedOnchainCetTxids: bundle.virtualCetSet.virtualCets.length,
      onchainCetTxidsPublished: 0,
      proofReceiptStatus: bundle.proofReceipt.receiptCore.status
    },
    fraudMatrix: fraudCases,
    publicInputs: bundle.zkClaim.publicInputs,
    caveats: [
      'Deterministic receipt only: this is not a live STWO proof yet.',
      'The Ark ASP signatures, VTXO tree proof, and real Shinigami verifier are still integration targets.',
      'The BitVM side checks the public commitments and fraud cases, not full TradeLayer consensus.'
    ]
  };
}

function buildShinigamiVirtualCetBundle(options = {}) {
  const offerCollateralSats = normalizeAmountSats(options.offerCollateralSats || 50000n, 'offerCollateralSats');
  const acceptCollateralSats = normalizeAmountSats(options.acceptCollateralSats || 50000n, 'acceptCollateralSats');
  const totalCollateralSats = offerCollateralSats + acceptCollateralSats;
  const outcomes =
    options.outcomes ||
    buildDefaultOutcomeSet({
      outcomeCount: options.outcomeCount || 17,
      entryPrice: options.entryPrice || 65000,
      priceStep: options.priceStep || 250,
      totalCollateralSats
    });
  const selectedOutcomeId = normalizeString(
    options.selectedOutcomeId || outcomes[Math.floor(outcomes.length / 2)].outcomeId,
    'selectedOutcomeId'
  );
  const contract = buildArkDlcContract({
    ...options,
    contractId: options.contractId || 'shinigami-ark-dlc-btcusd-1',
    aspId: options.aspId || 'ark-asp-shinigami-demo',
    arkRoundId: options.arkRoundId || 'ark-round-shinigami-virtual-cet-1',
    oracleEventId: options.oracleEventId || 'btc-usd-shinigami-expiry-1',
    offerCollateralSats,
    acceptCollateralSats,
    outcomes
  });
  const virtualCetSet = buildVirtualCetSet({ contract });
  const settlementEvidence = buildArkDlcSettlement({
    contract,
    virtualCetSet,
    oracleOutcomeId: selectedOutcomeId,
    oracleAttestationHex: options.oracleAttestationHex
  });
  const selectedVirtualCet = settlementEvidence.selectedCet;
  const selectedOutcome = contract.outcomes.find(outcome => outcome.outcomeId === selectedOutcomeId);
  if (!selectedOutcome) throw new Error(`unknown selected outcome ${selectedOutcomeId}`);

  const arkLeafLayer = buildArkLeafLayer(contract, virtualCetSet);
  const selectedLeaf = arkLeafLayer.leaves.find(leaf => leaf.leafCore.virtualCetId === selectedVirtualCet.virtualCetId);
  if (!selectedLeaf) throw new Error('selected virtual CET is missing from Ark leaf layer');

  const oracleAttestationAgeBlocks = Number(options.oracleAttestationAgeBlocks ?? 3);
  const maxOracleAgeBlocks = normalizePositiveInteger(options.maxOracleAgeBlocks ?? 144, 'maxOracleAgeBlocks');
  const { payoutRoot, payoutCore } = computePayoutRoot(contract, selectedVirtualCet, selectedOutcome);
  const oracleAttestationHex = settlementEvidence.settlementCore.oracleAttestationHex;
  const zkClaim = buildShinigamiZkClaim({
    contractId: contract.contractCore.contractId,
    contractCommitmentId: contract.contractCommitmentId,
    oracleEventId: contract.contractCore.oracleEventId,
    selectedOutcomeId,
    oracleAttestationHex,
    oracleAttestationAgeBlocks,
    maxOracleAgeBlocks,
    arkRoundId: contract.contractCore.arkRoundId,
    virtualCetSetId: virtualCetSet.virtualCetSetId,
    arkLeafRoot: arkLeafLayer.arkLeafRoot,
    selectedLeafHash: selectedLeaf.leafHash,
    selectedVirtualCetId: selectedVirtualCet.virtualCetId,
    payoutRoot,
    amountSats: contract.contractCore.totalCollateralSats
  });
  const proofReceipt = buildDeterministicProofReceipt(zkClaim, options);
  const taprootProofManifest = buildArkTaprootMiniscriptProofManifest({
    ...options,
    aspId: contract.contractCore.aspId,
    templateId: contract.contractCore.templateId,
    arkRoundId: contract.contractCore.arkRoundId,
    selectedLeafRole: 'dlc_virtual_cet_settlement',
    virtualCetSetId: virtualCetSet.virtualCetSetId,
    selectedVirtualCetId: selectedVirtualCet.virtualCetId,
    oracleOutcomeHash: zkClaim.claimCore.oracleOutcomeHash,
    settlementRoot: payoutRoot,
    amountSats: contract.contractCore.totalCollateralSats,
    challengeWindowBlocks: maxOracleAgeBlocks
  });
  const arkZkMiniscriptClaim = buildArkZkMiniscriptClaim(taprootProofManifest, {
    settlementHash: payoutRoot,
    exitDelay: options.exitDelayBlocks || maxOracleAgeBlocks
  });
  const shinigamiProofPublication = buildShinigamiProofPublicationBundle({
    ...options,
    programId: `shinigami-virtual-cet:${contract.contractCore.contractId}`,
    claimAmountSats: contract.contractCore.totalCollateralSats,
    inputStateRoot: arkLeafLayer.arkLeafRoot,
    outputStateRoot: payoutRoot,
    verifierSetRoot: sha256Hex(`verifier-set:${contract.contractCore.contractId}`),
    taprootProofManifest,
    challengeObservedProofRoot: sha256Hex(`bad-proof:${zkClaim.claimId}`)
  });
  const aspChallenge = buildArkDlcAspChallenge({
    contract,
    virtualCetSet,
    honestSettlement: settlementEvidence,
    aspSettledOutcomeId: options.aspSettledOutcomeId || contract.outcomes[0].outcomeId,
    missingForfeitPath: true
  });

  const bundleCore = {
    version: 1,
    protocol: 'shinigami_ark_virtual_cet_bundle',
    contractId: contract.contractCore.contractId,
    contractCommitmentId: contract.contractCommitmentId,
    oracleEventId: contract.contractCore.oracleEventId,
    arkRoundId: contract.contractCore.arkRoundId,
    virtualCetSetId: virtualCetSet.virtualCetSetId,
    arkLeafRoot: arkLeafLayer.arkLeafRoot,
    selectedVirtualCetId: selectedVirtualCet.virtualCetId,
    selectedLeafHash: selectedLeaf.leafHash,
    payoutRoot,
    claimId: zkClaim.claimId,
    receiptId: proofReceipt.receiptId,
    materializedCetCount: 0
  };

  const bundle = {
    kind: 'shinigami_ark_virtual_cet_bundle',
    bundleId: hashCanonical(bundleCore),
    bundleCore,
    contractId: contract.contractCore.contractId,
    oracleEventId: contract.contractCore.oracleEventId,
    arkRoundId: contract.contractCore.arkRoundId,
    selectedVirtualCetId: selectedVirtualCet.virtualCetId,
    selectedLeafHash: selectedLeaf.leafHash,
    arkLeafRoot: arkLeafLayer.arkLeafRoot,
    payoutRoot,
    exitDelayBlocks: maxOracleAgeBlocks,
    contract,
    virtualCetSet,
    selectedOutcome,
    selectedVirtualCet,
    arkLeafLayer,
    settlementEvidence,
    payoutCore,
    oracleAttestationHex,
    oracleAttestationAgeBlocks,
    maxOracleAgeBlocks,
    zkClaim,
    proofReceipt,
    taprootProofManifest,
    arkZkMiniscriptClaim,
    shinigamiProofPublication,
    aspChallenge,
    thesis:
      'Ark virtualizes the DLC CET fanout; Shinigami proves the selected virtual leaf and payout root; BitVM/UTXORef governs fraud exits and ASP misrouting.',
    caveats: [
      'Deterministic proof receipt only; production still needs a real Shinigami/STWO proof.',
      'Ark VTXO signatures and ASP accounting are modeled as public commitments.',
      'BitVM verifies the compressed public claim and fraud cases, not every off-chain implementation detail.'
    ]
  };
  bundle.fraudCases = buildShinigamiFraudCases(bundle);
  bundle.dashboardProjection = buildDashboardProjection(bundle);
  return bundle;
}

function verifyShinigamiVirtualCetBundle(bundle) {
  if (!bundle || bundle.kind !== 'shinigami_ark_virtual_cet_bundle') {
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

  const arkLeafLayer = buildArkLeafLayer(bundle.contract, bundle.virtualCetSet);
  if (arkLeafLayer.arkLeafRoot !== bundle.arkLeafRoot || bundle.bundleCore.arkLeafRoot !== bundle.arkLeafRoot) {
    return { ok: false, reason: 'Ark leaf root mismatch' };
  }
  const selectedOutcome = bundle.selectedOutcome;
  if (!selectedOutcome || !selectedOutcome.outcomeId) {
    return { ok: false, reason: 'missing selected outcome' };
  }
  const selectedVirtualCet = bundle.virtualCetSet.virtualCets.find(
    cet => cet.cetCore.outcomeId === selectedOutcome.outcomeId
  );
  if (!selectedVirtualCet) {
    return { ok: false, reason: 'selected outcome is not in virtual CET set' };
  }
  if (selectedVirtualCet.virtualCetId !== bundle.selectedVirtualCetId) {
    return { ok: false, reason: 'selected virtual CET mismatch' };
  }
  const selectedLeaf = arkLeafLayer.leaves.find(leaf => leaf.leafCore.virtualCetId === selectedVirtualCet.virtualCetId);
  if (!selectedLeaf || selectedLeaf.leafHash !== bundle.selectedLeafHash) {
    return { ok: false, reason: 'selected leaf hash mismatch' };
  }
  if (
    selectedOutcome.offerPayoutSats !== selectedVirtualCet.cetCore.offerPayoutSats ||
    selectedOutcome.acceptPayoutSats !== selectedVirtualCet.cetCore.acceptPayoutSats
  ) {
    return { ok: false, reason: 'selected outcome payout mismatch' };
  }

  const { payoutRoot } = computePayoutRoot(bundle.contract, selectedVirtualCet, selectedOutcome);
  if (payoutRoot !== bundle.payoutRoot || bundle.bundleCore.payoutRoot !== bundle.payoutRoot) {
    return { ok: false, reason: 'payout root mismatch' };
  }
  if (Number(bundle.oracleAttestationAgeBlocks) > Number(bundle.maxOracleAgeBlocks)) {
    return { ok: false, reason: 'oracle attestation is stale' };
  }
  if (bundle.zkClaim.claimId !== hashCanonical(bundle.zkClaim.claimCore)) {
    return { ok: false, reason: 'ZK claim id mismatch' };
  }
  const expectedClaim = buildShinigamiZkClaim({
    contractId: bundle.contract.contractCore.contractId,
    contractCommitmentId: bundle.contract.contractCommitmentId,
    oracleEventId: bundle.contract.contractCore.oracleEventId,
    selectedOutcomeId: selectedOutcome.outcomeId,
    oracleAttestationHex: bundle.oracleAttestationHex,
    oracleAttestationAgeBlocks: bundle.oracleAttestationAgeBlocks,
    maxOracleAgeBlocks: bundle.maxOracleAgeBlocks,
    arkRoundId: bundle.contract.contractCore.arkRoundId,
    virtualCetSetId: bundle.virtualCetSet.virtualCetSetId,
    arkLeafRoot: bundle.arkLeafRoot,
    selectedLeafHash: bundle.selectedLeafHash,
    selectedVirtualCetId: bundle.selectedVirtualCetId,
    payoutRoot: bundle.payoutRoot,
    amountSats: bundle.contract.contractCore.totalCollateralSats
  });
  if (expectedClaim.claimId !== bundle.zkClaim.claimId) {
    return { ok: false, reason: 'ZK claim does not match bundle commitments' };
  }
  if (bundle.proofReceipt.receiptId !== hashCanonical(bundle.proofReceipt.receiptCore)) {
    return { ok: false, reason: 'proof receipt id mismatch' };
  }
  if (bundle.proofReceipt.receiptCore.claimId !== bundle.zkClaim.claimId) {
    return { ok: false, reason: 'proof receipt does not bind claim' };
  }
  if (bundle.proofReceipt.receiptCore.proverExitCode !== 0 || bundle.proofReceipt.receiptCore.verifierExitCode !== 0) {
    return { ok: false, reason: 'deterministic prover receipt failed' };
  }

  const taprootVerification = verifyArkTaprootMiniscriptProofManifest(bundle.taprootProofManifest);
  if (!taprootVerification.ok) {
    return { ok: false, reason: `taproot manifest failed: ${taprootVerification.reason}` };
  }
  if (bundle.taprootProofManifest.manifestCore.virtualCetSetId !== bundle.virtualCetSet.virtualCetSetId) {
    return { ok: false, reason: 'taproot manifest virtual CET binding mismatch' };
  }
  if (bundle.taprootProofManifest.manifestCore.selectedVirtualCetId !== bundle.selectedVirtualCetId) {
    return { ok: false, reason: 'taproot manifest selected CET binding mismatch' };
  }
  if (bundle.taprootProofManifest.manifestCore.settlementRoot !== bundle.payoutRoot) {
    return { ok: false, reason: 'taproot manifest payout root mismatch' };
  }

  const expectedArkClaim = buildArkZkMiniscriptClaim(bundle.taprootProofManifest, {
    settlementHash: bundle.payoutRoot,
    exitDelay: bundle.exitDelayBlocks
  });
  if (expectedArkClaim.claimId !== bundle.arkZkMiniscriptClaim.claimId) {
    return { ok: false, reason: 'Ark ZK miniscript claim mismatch' };
  }
  const publicationVerification = verifyShinigamiProofPublicationBundle(bundle.shinigamiProofPublication);
  if (!publicationVerification.ok) {
    return { ok: false, reason: `Shinigami publication failed: ${publicationVerification.reason}` };
  }
  if (!bundle.aspChallenge.slashable) {
    return { ok: false, reason: 'demo ASP challenge should be slashable' };
  }
  return { ok: true };
}

function buildShinigamiDashboardProof(options = {}) {
  const bundle = buildShinigamiVirtualCetBundle(options);
  const verification = verifyShinigamiVirtualCetBundle(bundle);
  return {
    kind: 'shinigami_virtual_cet_dashboard_proof',
    generatedAt: options.generatedAt || '2026-05-05T00:00:00.000Z',
    source: 'utxoref-shinigami-virtual-cet-ark',
    verification,
    bundleId: bundle.bundleId,
    claimId: bundle.zkClaim.claimId,
    receiptId: bundle.proofReceipt.receiptId,
    projection: bundle.dashboardProjection,
    bundle
  };
}

function writeShinigamiVirtualCetBundle(options = {}) {
  const outPath = options.outPath || SUMMARY_PATH;
  const proof = buildShinigamiDashboardProof(options);
  writeJson(outPath, proof);
  return { proof, outPath };
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function runCli() {
  const outcomeCount = Number(argValue('--outcomes', '17'));
  const outPath = argValue('--out', SUMMARY_PATH);
  const { proof } = writeShinigamiVirtualCetBundle({
    outcomeCount,
    outPath
  });
  console.log(
    stringifyJson(
      {
        outPath,
        bundleId: proof.bundleId,
        claimId: proof.claimId,
        receiptId: proof.receiptId,
        virtualCetCount: proof.projection.summary.virtualCetCount,
        verification: proof.verification
      },
      true
    )
  );
}

if (require.main === module) {
  try {
    runCli();
  } catch (err) {
    console.error(`shinigami_virtual_cet_ark failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  ARTIFACTS_DIR,
  SUMMARY_PATH,
  buildDefaultOutcomeSet,
  buildArkLeafLayer,
  computePayoutRoot,
  buildShinigamiFraudCases,
  buildShinigamiVirtualCetBundle,
  verifyShinigamiVirtualCetBundle,
  buildShinigamiDashboardProof,
  writeShinigamiVirtualCetBundle
};
