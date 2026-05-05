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
      caveats: ['Deterministic receipt only: this is not a live STWO proof yet.']
    }
  };
}

function compactProof(proof) {
  return {
    kind: proof.kind,
    generatedAt: proof.generatedAt,
    source: proof.source,
    verification: proof.verification,
    bundleId: proof.bundleId,
    claimId: proof.claimId,
    receiptId: proof.receiptId,
    projection: proof.projection,
    bundleCore: proof.bundle && proof.bundle.bundleCore
  };
}

function buildDashboardShinigamiProof() {
  const helper = loadUtxoRefShinigami();
  if (!helper) return fallbackProjection();
  return compactProof(
    helper.buildShinigamiDashboardProof({
      outcomeCount: 17,
      generatedAt: '2026-05-05T00:00:00.000Z'
    })
  );
}

module.exports = {
  buildDashboardShinigamiProof
};
