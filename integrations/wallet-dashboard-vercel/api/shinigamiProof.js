const path = require('path');
const crypto = require('crypto');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function loadUtxoRefShinigami() {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'bitvm3', 'utxo_referee', 'shinigami_virtual_cet_ark'),
    path.resolve(process.cwd(), '..', '..', 'bitvm3', 'utxo_referee', 'shinigami_virtual_cet_ark')
  ];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      if (err.code !== 'MODULE_NOT_FOUND') throw err;
    }
  }
  return null;
}

function loadUtxoRefAspReserve() {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'bitvm3', 'utxo_referee', 'asp_bitvm_reserve_bond'),
    path.resolve(process.cwd(), '..', '..', 'bitvm3', 'utxo_referee', 'asp_bitvm_reserve_bond')
  ];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      if (err.code !== 'MODULE_NOT_FOUND') throw err;
    }
  }
  return null;
}

function fallbackReserveProjection() {
  const reserveId = sha256Hex('dashboard-fallback-asp-reserve');
  const obligationRoot = sha256Hex('dashboard-fallback-obligation-root');
  const claimId = sha256Hex('dashboard-fallback-reserve-claim');
  const challengeId = sha256Hex('dashboard-fallback-reserve-challenge');
  return {
    title: 'ASP BitVM Reserve',
    headline: 'The ASP posts a Bitcoin reserve bond; Shinigami compresses misbehavior proofs; BitVM decides the slash path.',
    summary: {
      reserveId,
      reserveOutpoint: `${sha256Hex('fallback-reserve-outpoint')}:0`,
      aspId: 'ark-asp-shinigami-demo',
      reserveAmountSats: '1000000',
      obligationCount: 4,
      obligationRoot,
      selectedViolation: 'delivered_below_signed_minimum',
      claimedSlashSats: '60000',
      challengeId,
      receiptId: sha256Hex('dashboard-fallback-reserve-receipt'),
      slashable: true
    },
    flow: [
      { id: 'reserve-lock', label: 'Reserve lock', detail: 'ASP locks a Taproot reserve spendable by cooperative refund or BitVM slash leaf.', commitment: reserveId },
      { id: 'signed-obligations', label: 'Signed obligations', detail: 'Ark roots, LN liquidity promises, virtual CET payout, and exit availability share one obligation root.', commitment: obligationRoot },
      { id: 'zk-fraud-call', label: 'ZK fraud call', detail: 'A compact public claim names the violated obligation and claimed slash amount.', commitment: claimId },
      { id: 'bitvm-slash', label: 'BitVM slash', detail: 'The challenge path pays harmed users and watcher bounty from the reserve.', commitment: challengeId }
    ],
    obligations: [
      { type: 'ark-vtxo-root', subjectId: 'ark-round-shinigami-virtual-cet-1', promisedState: 'root', observedState: 'root', inferredViolation: 'none', maxLossSats: '0' },
      { type: 'ln-liquidity-delivery', subjectId: 'ln-route-graft-batch-1', promisedState: '250000', observedState: '190000', inferredViolation: 'delivered_below_signed_minimum', maxLossSats: '60000' },
      { type: 'virtual-cet-settlement', subjectId: 'virtual-cet', promisedState: 'payout-root', observedState: 'payout-root', inferredViolation: 'none', maxLossSats: '100000' },
      { type: 'exit-availability', subjectId: 'exit-window', promisedState: 'exit-within-144-blocks', observedState: 'exit-within-144-blocks', inferredViolation: 'none', maxLossSats: '100000' }
    ],
    proofStatement: {
      claimId,
      receiptId: sha256Hex('dashboard-fallback-reserve-receipt'),
      publicInputRoot: sha256Hex('dashboard-fallback-reserve-public-input'),
      witnessDigest: sha256Hex('dashboard-fallback-reserve-witness'),
      zkProgram: 'shinigami_asp_reserve_fraud_claim_v1',
      claimedSlashSats: '60000',
      beneficiarySats: '57000',
      watcherBountySats: '3000',
      aspRefundSats: '940000'
    },
    disputeSimulation: {
      simulationId: sha256Hex('dashboard-fallback-dispute-simulation'),
      traceRoot: sha256Hex('dashboard-fallback-verifier-trace'),
      stepCount: 16,
      contestedViolation: 'delivered_below_signed_minimum',
      contestedStepIndex: 8,
      contestedOpcode: 'compare-delivery-shortfall',
      aspCounterclaim: 'observed_sats >= promised_sats; no slash should be paid',
      openedStep: {
        scriptCheck: '190000 250000 OP_LESSTHAN',
        inputs: { observedSats: '190000', promisedSats: '250000' },
        output: { violation: true, violationName: 'delivered_below_signed_minimum' },
        winner: 'challenger'
      },
      bisectionRounds: [
        { round: 1, range: '0-15', midpoint: 7, selectedRange: '8-15', receiptId: sha256Hex('fallback-bisect-1') },
        { round: 2, range: '8-15', midpoint: 11, selectedRange: '8-11', receiptId: sha256Hex('fallback-bisect-2') },
        { round: 3, range: '8-11', midpoint: 9, selectedRange: '8-9', receiptId: sha256Hex('fallback-bisect-3') },
        { round: 4, range: '8-9', midpoint: 8, selectedRange: '8-8', receiptId: sha256Hex('fallback-bisect-4') }
      ],
      receipts: [
        { stage: 'zk-claim-published', receiptId: sha256Hex('fallback-claim-receipt'), result: 'fraud claim is visible to the reserve challenge path' },
        { stage: 'verifier-trace-committed', receiptId: sha256Hex('fallback-trace-receipt'), result: 'challenger commits the claimed ZK-verifier execution trace' },
        { stage: 'asp-dispute-opened', receiptId: sha256Hex('fallback-dispute-receipt'), result: 'ASP contests the verifier result instead of accepting the slash' },
        { stage: 'opened-step-checked', receiptId: sha256Hex('fallback-opened-step-receipt'), result: 'opened step proves underdelivery' },
        { stage: 'reserve-slash-authorized', receiptId: sha256Hex('fallback-slash-receipt'), result: 'reserve slash path wins after the verifier step is opened' }
      ]
    },
    publicInputs: ['reserve_outpoint', 'obligation_root', 'obligation_id', 'public_input_root', 'claimed_slash_sats'],
    caveats: ['The reserve is externally locked Bitcoin collateral, not an ASP database balance.']
  };
}

function fallbackProjection() {
  const bundleId = sha256Hex('dashboard-fallback-shinigami-bundle');
  const claimId = sha256Hex('dashboard-fallback-shinigami-claim');
  const receiptId = sha256Hex('dashboard-fallback-shinigami-receipt');
  const arkLeafRoot = sha256Hex('dashboard-fallback-ark-leaf-root');
  const selectedLeafHash = sha256Hex('dashboard-fallback-selected-leaf');
  const payoutRoot = sha256Hex('dashboard-fallback-payout-root');
  const oracleOutcomeHash = sha256Hex('dashboard-fallback-oracle-outcome');

  return {
    kind: 'shinigami_virtual_cet_dashboard_proof',
    generatedAt: '2026-05-05T00:00:00.000Z',
    source: 'dashboard-fallback-fixture',
    verification: {
      ok: true,
      reason: 'UTXORef helper unavailable in this deployment; serving compact committed dashboard fixture'
    },
    bundleId,
    claimId,
    receiptId,
    projection: {
      title: 'Shinigami Virtual CETs',
      headline: 'Ark carries the CET fanout as virtual leaves; Shinigami proves the selected leaf and payout root.',
      summary: {
        contractId: 'shinigami-ark-dlc-btcusd-1',
        bundleId,
        oracleEventId: 'btc-usd-shinigami-expiry-1',
        arkRoundId: 'ark-round-shinigami-virtual-cet-1',
        virtualCetCount: 17,
        materializedCetCount: 0,
        selectedOutcomeId: 'btc_usd_at_entry',
        proofStatus: 'accepted-scaffold'
      },
      flow: [
        { id: 'dlc-outcomes', label: 'DLC outcome grid', detail: '17 possible CET outcomes are committed by hash.', commitment: sha256Hex('fallback-outcomes') },
        { id: 'ark-virtual-leaves', label: 'Ark virtual leaves', detail: 'Each outcome becomes a VTXO leaf instead of an on-chain CET transaction.', commitment: arkLeafRoot },
        { id: 'shinigami-claim', label: 'Shinigami claim', detail: 'The public claim binds oracle outcome, selected leaf, payout root, and Ark round.', commitment: claimId },
        { id: 'bitvm-challenge', label: 'BitVM/UTXORef challenge', detail: 'Fraud cases decide whether the ASP exits cooperatively or gets slashed.', commitment: receiptId }
      ],
      proofStatement: {
        contractId: 'shinigami-ark-dlc-btcusd-1',
        oracleEventId: 'btc-usd-shinigami-expiry-1',
        arkRoundId: 'ark-round-shinigami-virtual-cet-1',
        oracleOutcomeHash,
        selectedLeafHash,
        arkLeafRoot,
        selectedVirtualCetId: sha256Hex('fallback-selected-vcet'),
        payoutRoot,
        claimId,
        receiptId,
        amountSats: '100000',
        exitDelayBlocks: 144,
        materializedCetCount: 0
      },
      compression: {
        virtualCetCount: 17,
        arkLeafCount: 17,
        materializedCetCount: 0,
        selectedOutcomeId: 'btc_usd_at_entry',
        avoidedOnchainCetTxids: 17,
        onchainCetTxidsPublished: 0,
        proofReceiptStatus: 'accepted-scaffold'
      },
      fraudMatrix: [
        ['wrong-outcome', 'Wrong oracle outcome'],
        ['wrong-payout', 'Wrong payout root'],
        ['omitted-leaf', 'Omitted Ark leaf'],
        ['stale-oracle', 'Stale oracle claim'],
        ['bad-membership', 'Bad membership proof'],
        ['asp-route-mismatch', 'ASP route mismatch']
      ].map(([id, label]) => ({
        id,
        label,
        challengeViolation: id.replace(/-/g, '_'),
        publicInputs: ['ark_leaf_root', 'selected_leaf_hash', 'payout_root'],
        witnessCounterexample: 'deterministic fallback witness placeholder',
        bitvmRemedy: 'open BitVM/UTXORef challenge path',
        slashable: true
      })),
      publicInputs: ['contract_commitment_id', 'oracle_outcome_hash', 'ark_leaf_root', 'selected_leaf_hash', 'payout_root', 'amount_sats'],
      caveats: ['Deterministic receipt only: this is not a live STWO proof yet.'],
      reserveBond: fallbackReserveProjection()
    }
  };
}

function compactProof(proof, reserveProof = null) {
  return {
    kind: proof.kind,
    generatedAt: proof.generatedAt,
    source: proof.source,
    verification: proof.verification,
    bundleId: proof.bundleId,
    claimId: proof.claimId,
    receiptId: proof.receiptId,
    projection: {
      ...proof.projection,
      reserveBond: reserveProof ? reserveProof.projection : fallbackReserveProjection()
    },
    reserveProof: reserveProof && {
      kind: reserveProof.kind,
      source: reserveProof.source,
      verification: reserveProof.verification,
      bundleId: reserveProof.bundleId,
      reserveId: reserveProof.reserveId,
      claimId: reserveProof.claimId,
      challengeId: reserveProof.challengeId
    },
    bundleCore: proof.bundle && proof.bundle.bundleCore
  };
}

function buildDashboardShinigamiProof() {
  const helper = loadUtxoRefShinigami();
  if (!helper) return fallbackProjection();
  const reserveHelper = loadUtxoRefAspReserve();
  const reserveProof = reserveHelper
    ? reserveHelper.buildAspReserveDashboardProof({
        outcomeCount: 17,
        generatedAt: '2026-05-05T00:00:00.000Z'
      })
    : null;
  return compactProof(
    helper.buildShinigamiDashboardProof({
      outcomeCount: 17,
      generatedAt: '2026-05-05T00:00:00.000Z'
    }),
    reserveProof
  );
}

module.exports = {
  buildDashboardShinigamiProof
};
