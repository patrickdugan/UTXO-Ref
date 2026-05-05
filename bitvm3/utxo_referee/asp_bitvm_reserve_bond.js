/**
 * ASP BitVM reserve bond prototype.
 *
 * The reserve is a Taproot/BitVM-locked bond posted by an Ark ASP. ASP-signed
 * obligations commit Ark, Lightning, virtual-CET, and exit-availability state.
 * A Shinigami-style deterministic proof receipt compresses a fraud claim, then
 * a BitVM challenge spends/slashes the reserve when the ASP cannot answer.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');
const {
  buildShinigamiVirtualCetBundle,
  verifyShinigamiVirtualCetBundle
} = require('./shinigami_virtual_cet_ark');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts', 'asp_bitvm_reserve');
const SUMMARY_PATH = path.join(ARTIFACTS_DIR, 'asp_bitvm_reserve_latest.json');

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

function normalizeNonNegativeInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return parsed;
}

function buildAspReserveBond(options = {}) {
  const aspId = normalizeString(options.aspId || 'ark-asp-shinigami-demo', 'aspId');
  const reserveAmountSats = normalizeAmountSats(options.reserveAmountSats || 1000000n, 'reserveAmountSats');
  const challengeWindowBlocks = normalizeNonNegativeInteger(options.challengeWindowBlocks ?? 144, 'challengeWindowBlocks');
  const watcherBountyBps = normalizeNonNegativeInteger(options.watcherBountyBps ?? 500, 'watcherBountyBps');
  const reserveCore = {
    version: 1,
    protocol: 'asp_bitvm_reserve_bond',
    aspId,
    reserveOutpoint: normalizeString(
      options.reserveOutpoint || `${sha256Hex(`asp-reserve:${aspId}`)}:0`,
      'reserveOutpoint'
    ),
    reserveScriptTemplate:
      options.reserveScriptTemplate ||
      'p2tr(bitvm_reserve: cooperative_asp_refund | zk_fraud_claim_challenge | timeout_user_exit)',
    aspBondPubkey: normalizeString(options.aspBondPubkey || sha256Hex(`asp-bond-key:${aspId}`), 'aspBondPubkey'),
    userRecoveryScript: normalizeString(
      options.userRecoveryScript || 'tr(user-recovery-aggregate-key)',
      'userRecoveryScript'
    ),
    watcherBountyScript: normalizeString(
      options.watcherBountyScript || 'tr(watcher-bounty-key)',
      'watcherBountyScript'
    ),
    reserveAmountSats: reserveAmountSats.toString(),
    challengeWindowBlocks,
    watcherBountyBps,
    covenantSurface: 'BitVM challenge path over Taproot script leaves'
  };

  return {
    kind: 'asp_bitvm_reserve_bond',
    reserveId: hashCanonical(reserveCore),
    reserveCore
  };
}

function buildDefaultObligations(reserve, shinigamiBundle, options = {}) {
  const promisedInboundSats = normalizeAmountSats(options.promisedInboundSats || 250000n, 'promisedInboundSats');
  const deliveredInboundSats = normalizeAmountSats(options.deliveredInboundSats || 190000n, 'deliveredInboundSats');
  const withdrawalAmountSats = normalizeAmountSats(options.withdrawalAmountSats || 100000n, 'withdrawalAmountSats');
  const exitDelayBlocks = normalizeNonNegativeInteger(options.exitDelayBlocks ?? 144, 'exitDelayBlocks');
  const aspId = reserve.reserveCore.aspId;
  const roundId = shinigamiBundle.arkRoundId;

  return [
    {
      obligationType: 'ark-vtxo-root',
      subjectId: roundId,
      promisedState: shinigamiBundle.arkLeafRoot,
      observedState: shinigamiBundle.arkLeafRoot,
      maxLossSats: '0',
      beneficiaryScript: reserve.reserveCore.userRecoveryScript,
      rule: 'ASP round transition must preserve the committed Ark VTXO root.'
    },
    {
      obligationType: 'ln-liquidity-delivery',
      subjectId: 'ln-route-graft-batch-1',
      promisedState: promisedInboundSats.toString(),
      observedState: deliveredInboundSats.toString(),
      maxLossSats: (promisedInboundSats - deliveredInboundSats > 0n ? promisedInboundSats - deliveredInboundSats : 0n)
        .toString(),
      beneficiaryScript: reserve.reserveCore.userRecoveryScript,
      rule: 'Delivered inbound liquidity must be at least the ASP-signed route minimum.'
    },
    {
      obligationType: 'virtual-cet-settlement',
      subjectId: shinigamiBundle.selectedVirtualCetId,
      promisedState: shinigamiBundle.payoutRoot,
      observedState: options.observedPayoutRoot || shinigamiBundle.payoutRoot,
      maxLossSats: shinigamiBundle.contract.contractCore.totalCollateralSats,
      beneficiaryScript: reserve.reserveCore.userRecoveryScript,
      rule: 'Selected virtual CET payout root must match the oracle-selected DLC outcome.'
    },
    {
      obligationType: 'exit-availability',
      subjectId: `${roundId}:exit-window`,
      promisedState: `exit-within-${exitDelayBlocks}-blocks`,
      observedState: options.exitAvailable === false ? 'exit-withheld' : `exit-within-${exitDelayBlocks}-blocks`,
      maxLossSats: withdrawalAmountSats.toString(),
      beneficiaryScript: reserve.reserveCore.userRecoveryScript,
      rule: 'User exit path must remain available during the signed challenge window.'
    }
  ].map((obligation, index) => {
    const obligationCore = {
      version: 1,
      protocol: 'asp_signed_service_obligation',
      reserveId: reserve.reserveId,
      aspId,
      index,
      ...obligation
    };
    const obligationId = hashCanonical(obligationCore);
    return {
      kind: 'asp_signed_service_obligation',
      obligationId,
      obligationCore,
      aspSignature: sha256Hex(`asp-signature:${aspId}:${obligationId}`)
    };
  });
}

function buildAspObligationSet(options = {}) {
  const reserve = options.reserve || buildAspReserveBond(options);
  const shinigamiBundle = options.shinigamiBundle || buildShinigamiVirtualCetBundle(options);
  const obligations = options.obligations || buildDefaultObligations(reserve, shinigamiBundle, options);
  const obligationSetCore = {
    version: 1,
    protocol: 'asp_obligation_set',
    reserveId: reserve.reserveId,
    aspId: reserve.reserveCore.aspId,
    shinigamiBundleId: shinigamiBundle.bundleId,
    obligationIds: obligations.map(item => item.obligationId),
    obligationSignatureRoot: hashCanonical(obligations.map(item => item.aspSignature))
  };

  return {
    kind: 'asp_obligation_set',
    obligationRoot: hashCanonical(obligationSetCore),
    obligationSetCore,
    obligations
  };
}

function inferViolation(obligation) {
  const core = obligation.obligationCore;
  if (core.obligationType === 'ln-liquidity-delivery') {
    const promised = BigInt(core.promisedState);
    const observed = BigInt(core.observedState);
    if (observed < promised) return 'delivered_below_signed_minimum';
  }
  if (core.obligationType === 'virtual-cet-settlement' && core.observedState !== core.promisedState) {
    return 'wrong_virtual_cet_payout_root';
  }
  if (core.obligationType === 'exit-availability' && core.observedState !== core.promisedState) {
    return 'exit_path_withheld';
  }
  if (core.obligationType === 'ark-vtxo-root' && core.observedState !== core.promisedState) {
    return 'ark_round_root_mismatch';
  }
  return 'none';
}

function computeSlashSats(reserve, obligation, override) {
  if (override !== undefined) {
    return normalizeAmountSats(override, 'claimedSlashSats');
  }
  const core = obligation.obligationCore;
  let claim = 0n;
  if (core.obligationType === 'ln-liquidity-delivery') {
    const promised = BigInt(core.promisedState);
    const observed = BigInt(core.observedState);
    claim = promised > observed ? promised - observed : 0n;
  } else if (core.obligationType === 'virtual-cet-settlement') {
    claim = core.observedState === core.promisedState ? 0n : BigInt(core.maxLossSats);
  } else if (core.obligationType === 'exit-availability') {
    claim = core.observedState === core.promisedState ? 0n : BigInt(core.maxLossSats);
  } else if (core.obligationType === 'ark-vtxo-root') {
    claim = core.observedState === core.promisedState ? 0n : BigInt(core.maxLossSats || 0);
  }
  const reserveAmount = BigInt(reserve.reserveCore.reserveAmountSats);
  return claim > reserveAmount ? reserveAmount : claim;
}

function buildAspMisbehaviorClaim(options = {}) {
  const reserve = options.reserve || buildAspReserveBond(options);
  const shinigamiBundle = options.shinigamiBundle || buildShinigamiVirtualCetBundle(options);
  const obligationSet = options.obligationSet || buildAspObligationSet({ ...options, reserve, shinigamiBundle });
  const selectedObligation =
    options.selectedObligation ||
    obligationSet.obligations.find(item => item.obligationCore.obligationType === (options.obligationType || 'ln-liquidity-delivery')) ||
    obligationSet.obligations[0];
  if (!selectedObligation) throw new Error('selected obligation is required');
  const violation = options.violation || inferViolation(selectedObligation);
  const claimedSlashSats = computeSlashSats(reserve, selectedObligation, options.claimedSlashSats);
  const claimCore = {
    version: 1,
    protocol: 'asp_bitvm_reserve_misbehavior_claim',
    reserveId: reserve.reserveId,
    reserveOutpoint: reserve.reserveCore.reserveOutpoint,
    aspId: reserve.reserveCore.aspId,
    obligationRoot: obligationSet.obligationRoot,
    obligationId: selectedObligation.obligationId,
    obligationType: selectedObligation.obligationCore.obligationType,
    aspSignature: selectedObligation.aspSignature,
    promisedState: selectedObligation.obligationCore.promisedState,
    observedState: selectedObligation.obligationCore.observedState,
    violation,
    claimedSlashSats: claimedSlashSats.toString(),
    beneficiaryScript: selectedObligation.obligationCore.beneficiaryScript,
    watcherBountyScript: reserve.reserveCore.watcherBountyScript,
    publicInputRoot: hashCanonical({
      reserveId: reserve.reserveId,
      obligationRoot: obligationSet.obligationRoot,
      obligationId: selectedObligation.obligationId,
      violation,
      claimedSlashSats: claimedSlashSats.toString()
    }),
    witnessDigest: hashCanonical({
      obligationCore: selectedObligation.obligationCore,
      aspSignature: selectedObligation.aspSignature,
      observedState: selectedObligation.obligationCore.observedState
    }),
    zkProgram: 'shinigami_asp_reserve_fraud_claim_v1'
  };

  return {
    kind: 'asp_bitvm_reserve_misbehavior_claim',
    claimId: hashCanonical(claimCore),
    claimCore,
    publicInputs: [
      'reserve_outpoint',
      'obligation_root',
      'obligation_id',
      'public_input_root',
      'claimed_slash_sats'
    ],
    selectedObligation
  };
}

function buildAspReserveZkReceipt(claim, options = {}) {
  const receiptCore = {
    version: 1,
    protocol: 'asp_reserve_zk_receipt',
    proofSystem: 'shinigami-stwo-placeholder',
    claimId: claim.claimId,
    claimDigest: hashCanonical(claim.claimCore),
    proofTranscriptRoot: hashCanonical({
      claimId: claim.claimId,
      zkProgram: claim.claimCore.zkProgram,
      publicInputRoot: claim.claimCore.publicInputRoot
    }),
    proverExitCode: Number(options.proverExitCode ?? 0),
    verifierExitCode: Number(options.verifierExitCode ?? 0),
    accepted: options.accepted !== undefined ? Boolean(options.accepted) : true
  };

  return {
    kind: 'asp_reserve_zk_receipt',
    receiptId: hashCanonical(receiptCore),
    receiptCore
  };
}

function buildBitvmReserveChallenge(options = {}) {
  const reserve = options.reserve || buildAspReserveBond(options);
  const shinigamiBundle = options.shinigamiBundle || buildShinigamiVirtualCetBundle(options);
  const obligationSet = options.obligationSet || buildAspObligationSet({ ...options, reserve, shinigamiBundle });
  const misbehaviorClaim =
    options.misbehaviorClaim || buildAspMisbehaviorClaim({ ...options, reserve, shinigamiBundle, obligationSet });
  const zkReceipt = options.zkReceipt || buildAspReserveZkReceipt(misbehaviorClaim, options);
  const claimedSlashSats = BigInt(misbehaviorClaim.claimCore.claimedSlashSats);
  const reserveAmountSats = BigInt(reserve.reserveCore.reserveAmountSats);
  const watcherBountySats = (claimedSlashSats * BigInt(reserve.reserveCore.watcherBountyBps)) / 10000n;
  const beneficiarySats = claimedSlashSats > watcherBountySats ? claimedSlashSats - watcherBountySats : 0n;
  const aspRefundSats = reserveAmountSats > claimedSlashSats ? reserveAmountSats - claimedSlashSats : 0n;
  const challengeCore = {
    version: 1,
    protocol: 'bitvm_asp_reserve_challenge',
    reserveId: reserve.reserveId,
    reserveOutpoint: reserve.reserveCore.reserveOutpoint,
    obligationRoot: obligationSet.obligationRoot,
    claimId: misbehaviorClaim.claimId,
    receiptId: zkReceipt.receiptId,
    violation: misbehaviorClaim.claimCore.violation,
    challengeWindowBlocks: reserve.reserveCore.challengeWindowBlocks,
    claimedSlashSats: claimedSlashSats.toString(),
    disbursement: {
      beneficiaryScript: misbehaviorClaim.claimCore.beneficiaryScript,
      beneficiarySats: beneficiarySats.toString(),
      watcherBountyScript: reserve.reserveCore.watcherBountyScript,
      watcherBountySats: watcherBountySats.toString(),
      aspRefundScript: reserve.reserveCore.aspBondPubkey,
      aspRefundSats: aspRefundSats.toString()
    },
    bitvmPath: [
      'publish compressed Shinigami fraud claim',
      'ASP may answer inside the BitVM challenge window',
      'if unanswered or disproved, spend reserve through slash leaf',
      'pay harmed users and watcher bounty, refund only un-slashable remainder'
    ]
  };

  return {
    kind: 'bitvm_asp_reserve_challenge',
    challengeId: hashCanonical(challengeCore),
    challengeCore,
    slashable: misbehaviorClaim.claimCore.violation !== 'none' && claimedSlashSats > 0n
  };
}

function buildAspReserveDashboardProjection(bundle) {
  const reserve = bundle.reserve.reserveCore;
  const claim = bundle.misbehaviorClaim.claimCore;
  const challenge = bundle.bitvmChallenge.challengeCore;
  return {
    title: 'ASP BitVM Reserve',
    headline:
      'The ASP posts a Bitcoin reserve bond; Shinigami compresses misbehavior proofs; BitVM decides the slash path.',
    summary: {
      reserveId: bundle.reserve.reserveId,
      reserveOutpoint: reserve.reserveOutpoint,
      aspId: reserve.aspId,
      reserveAmountSats: reserve.reserveAmountSats,
      obligationCount: bundle.obligationSet.obligations.length,
      obligationRoot: bundle.obligationSet.obligationRoot,
      selectedViolation: claim.violation,
      claimedSlashSats: claim.claimedSlashSats,
      challengeId: bundle.bitvmChallenge.challengeId,
      receiptId: bundle.zkReceipt.receiptId,
      slashable: bundle.bitvmChallenge.slashable
    },
    flow: [
      {
        id: 'reserve-lock',
        label: 'Reserve lock',
        detail: 'ASP locks a Taproot reserve spendable by cooperative refund or BitVM slash leaf.',
        commitment: bundle.reserve.reserveId
      },
      {
        id: 'signed-obligations',
        label: 'Signed obligations',
        detail: 'Ark roots, LN liquidity promises, virtual CET payout, and exit availability share one obligation root.',
        commitment: bundle.obligationSet.obligationRoot
      },
      {
        id: 'zk-fraud-call',
        label: 'ZK fraud call',
        detail: 'A compact public claim names the violated obligation and claimed slash amount.',
        commitment: bundle.misbehaviorClaim.claimId
      },
      {
        id: 'bitvm-slash',
        label: 'BitVM slash',
        detail: 'The challenge path pays harmed users and watcher bounty from the reserve.',
        commitment: bundle.bitvmChallenge.challengeId
      }
    ],
    obligations: bundle.obligationSet.obligations.map(item => ({
      id: item.obligationId,
      type: item.obligationCore.obligationType,
      subjectId: item.obligationCore.subjectId,
      promisedState: item.obligationCore.promisedState,
      observedState: item.obligationCore.observedState,
      inferredViolation: inferViolation(item),
      maxLossSats: item.obligationCore.maxLossSats
    })),
    proofStatement: {
      claimId: bundle.misbehaviorClaim.claimId,
      receiptId: bundle.zkReceipt.receiptId,
      publicInputRoot: claim.publicInputRoot,
      witnessDigest: claim.witnessDigest,
      zkProgram: claim.zkProgram,
      claimedSlashSats: claim.claimedSlashSats,
      beneficiarySats: challenge.disbursement.beneficiarySats,
      watcherBountySats: challenge.disbursement.watcherBountySats,
      aspRefundSats: challenge.disbursement.aspRefundSats
    },
    publicInputs: bundle.misbehaviorClaim.publicInputs,
    caveats: [
      'This is a reserve-bond evidence harness, not a production Bitcoin covenant.',
      'The ZK receipt is deterministic and local; a real Shinigami/STWO verifier remains future work.',
      'The reserve is externally locked Bitcoin collateral, not an ASP database balance.'
    ]
  };
}

function buildAspBitvmReserveBundle(options = {}) {
  const shinigamiBundle = options.shinigamiBundle || buildShinigamiVirtualCetBundle(options);
  const shinigamiVerification = verifyShinigamiVirtualCetBundle(shinigamiBundle);
  if (!shinigamiVerification.ok) {
    throw new Error(`Shinigami virtual-CET bundle failed: ${shinigamiVerification.reason}`);
  }
  const reserve = buildAspReserveBond({
    ...options,
    aspId: options.aspId || shinigamiBundle.contract.contractCore.aspId
  });
  const obligationSet = buildAspObligationSet({ ...options, reserve, shinigamiBundle });
  const misbehaviorClaim = buildAspMisbehaviorClaim({
    ...options,
    reserve,
    shinigamiBundle,
    obligationSet,
    obligationType: options.obligationType || 'ln-liquidity-delivery'
  });
  const zkReceipt = buildAspReserveZkReceipt(misbehaviorClaim, options);
  const bitvmChallenge = buildBitvmReserveChallenge({
    ...options,
    reserve,
    shinigamiBundle,
    obligationSet,
    misbehaviorClaim,
    zkReceipt
  });
  const bundleCore = {
    version: 1,
    protocol: 'asp_bitvm_reserve_bundle',
    shinigamiBundleId: shinigamiBundle.bundleId,
    reserveId: reserve.reserveId,
    obligationRoot: obligationSet.obligationRoot,
    claimId: misbehaviorClaim.claimId,
    receiptId: zkReceipt.receiptId,
    challengeId: bitvmChallenge.challengeId
  };
  const bundle = {
    kind: 'asp_bitvm_reserve_bundle',
    bundleId: hashCanonical(bundleCore),
    bundleCore,
    reserve,
    shinigamiBundle,
    obligationSet,
    misbehaviorClaim,
    zkReceipt,
    bitvmChallenge,
    thesis:
      'Post an ASP reserve bond once, then use ZK-compressed fraud claims and BitVM challenge paths to enforce Ark, Lightning, DLC, and exit obligations.',
    caveats: [
      'Prototype only: not a deployable covenant or production BitVM verifier.',
      'ASP signatures are deterministic commitments in this harness.',
      'Production needs data availability, real signature verification, and real challenge transaction templates.'
    ]
  };
  bundle.dashboardProjection = buildAspReserveDashboardProjection(bundle);
  return bundle;
}

function verifyAspBitvmReserveBundle(bundle) {
  if (!bundle || bundle.kind !== 'asp_bitvm_reserve_bundle') {
    return { ok: false, reason: 'wrong bundle kind' };
  }
  if (bundle.bundleId !== hashCanonical(bundle.bundleCore)) {
    return { ok: false, reason: 'bundle id mismatch' };
  }
  if (bundle.reserve.reserveId !== hashCanonical(bundle.reserve.reserveCore)) {
    return { ok: false, reason: 'reserve id mismatch' };
  }
  if (bundle.obligationSet.obligationRoot !== hashCanonical(bundle.obligationSet.obligationSetCore)) {
    return { ok: false, reason: 'obligation root mismatch' };
  }
  const shinigamiVerification = verifyShinigamiVirtualCetBundle(bundle.shinigamiBundle);
  if (!shinigamiVerification.ok) {
    return { ok: false, reason: `Shinigami bundle failed: ${shinigamiVerification.reason}` };
  }
  if (bundle.bundleCore.shinigamiBundleId !== bundle.shinigamiBundle.bundleId) {
    return { ok: false, reason: 'Shinigami bundle id mismatch' };
  }
  for (const obligation of bundle.obligationSet.obligations) {
    if (obligation.obligationId !== hashCanonical(obligation.obligationCore)) {
      return { ok: false, reason: `obligation id mismatch: ${obligation.obligationCore.obligationType}` };
    }
    const expectedSig = sha256Hex(`asp-signature:${bundle.reserve.reserveCore.aspId}:${obligation.obligationId}`);
    if (obligation.aspSignature !== expectedSig) {
      return { ok: false, reason: `ASP signature mismatch: ${obligation.obligationCore.obligationType}` };
    }
  }
  const selected = bundle.obligationSet.obligations.find(
    item => item.obligationId === bundle.misbehaviorClaim.claimCore.obligationId
  );
  if (!selected) return { ok: false, reason: 'selected obligation not in obligation set' };
  if (inferViolation(selected) !== bundle.misbehaviorClaim.claimCore.violation) {
    return { ok: false, reason: 'claim violation does not match selected obligation' };
  }
  if (bundle.misbehaviorClaim.claimId !== hashCanonical(bundle.misbehaviorClaim.claimCore)) {
    return { ok: false, reason: 'misbehavior claim id mismatch' };
  }
  if (bundle.zkReceipt.receiptId !== hashCanonical(bundle.zkReceipt.receiptCore)) {
    return { ok: false, reason: 'ZK receipt id mismatch' };
  }
  if (bundle.zkReceipt.receiptCore.claimId !== bundle.misbehaviorClaim.claimId) {
    return { ok: false, reason: 'ZK receipt does not bind claim' };
  }
  if (bundle.zkReceipt.receiptCore.proverExitCode !== 0 || bundle.zkReceipt.receiptCore.verifierExitCode !== 0) {
    return { ok: false, reason: 'ZK receipt failed' };
  }
  const claimSlash = BigInt(bundle.misbehaviorClaim.claimCore.claimedSlashSats);
  const reserveAmount = BigInt(bundle.reserve.reserveCore.reserveAmountSats);
  if (claimSlash > reserveAmount) {
    return { ok: false, reason: 'claim exceeds reserve amount' };
  }
  if (bundle.bitvmChallenge.challengeId !== hashCanonical(bundle.bitvmChallenge.challengeCore)) {
    return { ok: false, reason: 'BitVM challenge id mismatch' };
  }
  if (bundle.bitvmChallenge.challengeCore.claimId !== bundle.misbehaviorClaim.claimId) {
    return { ok: false, reason: 'BitVM challenge does not bind claim' };
  }
  const d = bundle.bitvmChallenge.challengeCore.disbursement;
  if (BigInt(d.beneficiarySats) + BigInt(d.watcherBountySats) + BigInt(d.aspRefundSats) !== reserveAmount) {
    return { ok: false, reason: 'reserve disbursement does not conserve sats' };
  }
  if (!bundle.bitvmChallenge.slashable) {
    return { ok: false, reason: 'demo reserve challenge should be slashable' };
  }
  return { ok: true };
}

function buildAspReserveDashboardProof(options = {}) {
  const bundle = buildAspBitvmReserveBundle(options);
  return {
    kind: 'asp_bitvm_reserve_dashboard_proof',
    generatedAt: options.generatedAt || '2026-05-05T00:00:00.000Z',
    source: 'utxoref-asp-bitvm-reserve',
    verification: verifyAspBitvmReserveBundle(bundle),
    bundleId: bundle.bundleId,
    reserveId: bundle.reserve.reserveId,
    claimId: bundle.misbehaviorClaim.claimId,
    challengeId: bundle.bitvmChallenge.challengeId,
    projection: bundle.dashboardProjection,
    bundle
  };
}

function writeAspBitvmReserveBundle(options = {}) {
  const outPath = options.outPath || SUMMARY_PATH;
  const proof = buildAspReserveDashboardProof(options);
  writeJson(outPath, proof);
  return { proof, outPath };
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function runCli() {
  const outPath = argValue('--out', SUMMARY_PATH);
  const { proof } = writeAspBitvmReserveBundle({ outPath });
  console.log(
    stringifyJson({
      outPath,
      bundleId: proof.bundleId,
      reserveId: proof.reserveId,
      claimId: proof.claimId,
      challengeId: proof.challengeId,
      slashable: proof.projection.summary.slashable,
      verification: proof.verification
    })
  );
}

if (require.main === module) {
  try {
    runCli();
  } catch (err) {
    console.error(`asp_bitvm_reserve_bond failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  ARTIFACTS_DIR,
  SUMMARY_PATH,
  buildAspReserveBond,
  buildDefaultObligations,
  buildAspObligationSet,
  buildAspMisbehaviorClaim,
  buildAspReserveZkReceipt,
  buildBitvmReserveChallenge,
  buildAspBitvmReserveBundle,
  verifyAspBitvmReserveBundle,
  buildAspReserveDashboardProof,
  writeAspBitvmReserveBundle
};
