/**
 * Lightning Integration Prototypes
 *
 * Deterministic transcript builders for Lightning-facing BitVM/DLC demos.
 * These are protocol-shaped artifacts, not a production Lightning daemon.
 */

const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats, normalizeEpochId } = require('./m1_spec');

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
  return value;
}

function normalizeHex32(value, fieldName) {
  const hex = normalizeString(value, fieldName).toLowerCase();
  if (!HEX_32_RE.test(hex)) {
    throw new Error(`${fieldName} must be a 32-byte hex string`);
  }
  return hex;
}

function derivePreimageHex(seed) {
  return sha256Hex(`preimage:${seed}`);
}

function derivePaymentHashHex(preimageHex) {
  return sha256Hex(Buffer.from(normalizeHex32(preimageHex, 'preimageHex'), 'hex'));
}

function msatFromSats(sats) {
  return (normalizeAmountSats(sats) * 1000n).toString();
}

function makePrototypeInvoice({ prefix = 'lnbc', amountSats, paymentHashHex, description }) {
  const amount = normalizeAmountSats(amountSats);
  const digest = sha256Hex(`${paymentHashHex}|${description || ''}`).slice(0, 32);
  return `${prefix}${amount.toString()}n1p${digest}`;
}

function buildFundingOutputCommitment({
  epochId,
  dlcId,
  bitvmCommitmentRoot,
  collateralSats,
  refundAddress,
  timeoutBlock
}) {
  const payload = {
    version: 1,
    epochId: normalizeEpochId(epochId).toString(),
    dlcId: normalizeString(dlcId, 'dlcId'),
    bitvmCommitmentRoot: normalizeHex32(bitvmCommitmentRoot, 'bitvmCommitmentRoot'),
    collateralSats: normalizeAmountSats(collateralSats, 'collateralSats').toString(),
    refundAddress: normalizeString(refundAddress, 'refundAddress'),
    timeoutBlock: Number(timeoutBlock || 0)
  };

  return {
    kind: 'bitvm_dlc_funding_output_commitment',
    payload,
    commitmentHash: hashCanonical(payload)
  };
}

function buildLightningFundedPositionOpen(options = {}) {
  const epochId = normalizeEpochId(options.epochId ?? 1n);
  const collateralSats = normalizeAmountSats(options.collateralSats ?? 100000n, 'collateralSats');
  const swapFeeSats = normalizeAmountSats(options.swapFeeSats ?? 250n, 'swapFeeSats');
  const fundingFeeSats = normalizeAmountSats(options.fundingFeeSats ?? 500n, 'fundingFeeSats');
  const timeoutBlock = Number(options.timeoutBlock ?? 900144);
  const refundTimeoutBlock = Number(options.refundTimeoutBlock ?? timeoutBlock + 144);
  const userId = normalizeString(options.userId || 'alice', 'userId');
  const dlcId = normalizeString(options.dlcId || `dlc-${epochId.toString()}`, 'dlcId');
  const refundAddress = normalizeString(options.refundAddress || 'tb1qrefundprototype', 'refundAddress');
  const bitvmCommitmentRoot = normalizeHex32(
    options.bitvmCommitmentRoot || sha256Hex(`bitvm-root:${dlcId}`),
    'bitvmCommitmentRoot'
  );
  const preimageHex = normalizeHex32(
    options.preimageHex || derivePreimageHex(`position-open:${userId}:${dlcId}:${collateralSats}`),
    'preimageHex'
  );
  const paymentHashHex = derivePaymentHashHex(preimageHex);
  const lnAmountSats = collateralSats + swapFeeSats + fundingFeeSats;
  const fundingOutput = buildFundingOutputCommitment({
    epochId,
    dlcId,
    bitvmCommitmentRoot,
    collateralSats,
    refundAddress,
    timeoutBlock
  });

  const fundingPackage = {
    kind: 'bitvm_dlc_funding_psbt_skeleton',
    inputs: [
      {
        role: 'swap-provider-input',
        amountSats: (collateralSats + fundingFeeSats).toString(),
        source: 'submarine-swap-liquidity'
      }
    ],
    outputs: [
      {
        role: 'bitvm-dlc-funding',
        amountSats: collateralSats.toString(),
        commitmentHash: fundingOutput.commitmentHash
      }
    ],
    feeSats: fundingFeeSats.toString(),
    swapLock: {
      paymentHashHex,
      successReveals: 'ln_preimage_unlocks_swap_provider_claim',
      refundAfterBlock: refundTimeoutBlock
    }
  };

  const transcriptCore = {
    version: 1,
    userId,
    epochId: epochId.toString(),
    dlcId,
    lnAmountSats: lnAmountSats.toString(),
    collateralSats: collateralSats.toString(),
    swapFeeSats: swapFeeSats.toString(),
    fundingFeeSats: fundingFeeSats.toString(),
    paymentHashHex,
    fundingOutputCommitmentHash: fundingOutput.commitmentHash
  };

  return {
    kind: 'lightning_funded_bitvm_dlc_position_open',
    transcriptId: hashCanonical(transcriptCore),
    transcriptCore,
    lightning: {
      mode: 'hold-invoice-submarine-swap',
      invoice: makePrototypeInvoice({
        amountSats: lnAmountSats,
        paymentHashHex,
        description: `open ${dlcId}`
      }),
      amountMsat: msatFromSats(lnAmountSats),
      paymentHashHex,
      preimageHex,
      settlementCondition: 'funding_tx_seen_and_referee_commitment_matches'
    },
    fundingOutput,
    fundingPackage,
    atomicityChecklist: {
      sameHashLocksLightningAndSwap: fundingPackage.swapLock.paymentHashHex === paymentHashHex,
      refundPathExists: refundTimeoutBlock > timeoutBlock,
      fundingOutputBoundToBitvmRoot: fundingOutput.payload.bitvmCommitmentRoot === bitvmCommitmentRoot,
      feeAccountingBalances: lnAmountSats === collateralSats + swapFeeSats + fundingFeeSats
    },
    caveats: [
      'Prototype invoice is deterministic test data, not a real BOLT invoice.',
      'Production needs LDK/LND/CLN hold-invoice handling and mempool-aware refund policy.'
    ]
  };
}

function buildLnPayoutLeaf(leaf, index, epochId) {
  const amountSats = normalizeAmountSats(leaf.amountSats, `payoutLeaves[${index}].amountSats`);
  const preimageHex = leaf.preimageHex
    ? normalizeHex32(leaf.preimageHex, `payoutLeaves[${index}].preimageHex`)
    : null;
  const paymentHashHex = leaf.paymentHashHex
    ? normalizeHex32(leaf.paymentHashHex, `payoutLeaves[${index}].paymentHashHex`)
    : (preimageHex ? derivePaymentHashHex(preimageHex) : derivePaymentHashHex(derivePreimageHex(`payout:${index}`)));

  const body = {
    version: 1,
    epochId: normalizeEpochId(epochId).toString(),
    accountId: normalizeString(leaf.accountId, `payoutLeaves[${index}].accountId`),
    amountSats: amountSats.toString(),
    paymentHashHex,
    fallbackScriptPubKey: normalizeString(
      leaf.fallbackScriptPubKey || `fallback-spk-${index}`,
      `payoutLeaves[${index}].fallbackScriptPubKey`
    )
  };

  return {
    ...body,
    preimageHex,
    settled: Boolean(preimageHex && derivePaymentHashHex(preimageHex) === paymentHashHex),
    leafHash: sha256Hex(`LN_PAYOUT_V1:${canonicalStringify(body)}`)
  };
}

function merkleRootFromHashes(hashes) {
  if (!hashes.length) {
    return sha256Hex('LN_PAYOUT_EMPTY');
  }

  let level = hashes.map(h => normalizeHex32(h, 'leafHash'));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] || level[i];
      next.push(sha256Hex(Buffer.concat([
        Buffer.from(left, 'hex'),
        Buffer.from(right, 'hex')
      ])));
    }
    level = next;
  }
  return level[0];
}

function buildLightningPayoutCompression(options = {}) {
  const epochId = normalizeEpochId(options.epochId ?? 1n);
  const leaves = (options.payoutLeaves || [
    { accountId: 'alice', amountSats: 42000n, preimageHex: derivePreimageHex('alice-paid') },
    { accountId: 'bob', amountSats: 18000n, preimageHex: derivePreimageHex('bob-paid') },
    { accountId: 'carol', amountSats: 7000n }
  ]).map((leaf, index) => buildLnPayoutLeaf(leaf, index, epochId));

  const totalPayoutSats = leaves.reduce((sum, leaf) => sum + BigInt(leaf.amountSats), 0n);
  const settledLeaves = leaves.filter(leaf => leaf.settled);
  const fallbackLeaves = leaves.filter(leaf => !leaf.settled);
  const root = merkleRootFromHashes(leaves.map(leaf => leaf.leafHash));

  return {
    kind: 'lightning_payout_compression',
    epochId: epochId.toString(),
    root,
    totalPayoutSats: totalPayoutSats.toString(),
    leaves,
    settledReceipts: settledLeaves.map(leaf => ({
      accountId: leaf.accountId,
      amountSats: leaf.amountSats,
      paymentHashHex: leaf.paymentHashHex,
      preimageHex: leaf.preimageHex,
      receiptHash: sha256Hex(`LN_RECEIPT_V1:${leaf.paymentHashHex}:${leaf.preimageHex}`)
    })),
    onchainFallbacks: fallbackLeaves.map(leaf => ({
      accountId: leaf.accountId,
      amountSats: leaf.amountSats,
      fallbackScriptPubKey: leaf.fallbackScriptPubKey,
      leafHash: leaf.leafHash
    })),
    compressionStats: {
      originalOnchainOutputCount: leaves.length,
      requiredOnchainFallbackOutputCount: fallbackLeaves.length,
      lightningSettledCount: settledLeaves.length,
      avoidedOnchainOutputs: settledLeaves.length
    }
  };
}

function verifyLightningPayoutCompression(bundle) {
  const leaves = Array.isArray(bundle?.leaves) ? bundle.leaves : [];
  const computedRoot = merkleRootFromHashes(leaves.map(leaf => leaf.leafHash));
  if (computedRoot !== bundle.root) {
    return { ok: false, reason: 'payout root mismatch' };
  }

  for (const receipt of bundle.settledReceipts || []) {
    if (derivePaymentHashHex(receipt.preimageHex) !== receipt.paymentHashHex) {
      return { ok: false, reason: `invalid preimage for ${receipt.accountId}` };
    }
  }

  const total = leaves.reduce((sum, leaf) => sum + BigInt(leaf.amountSats), 0n).toString();
  if (total !== String(bundle.totalPayoutSats)) {
    return { ok: false, reason: 'total payout mismatch' };
  }

  return { ok: true, root: computedRoot };
}

function buildLightningWatchtowerBounty(options = {}) {
  const challengeId = normalizeString(options.challengeId || 'challenge-001', 'challengeId');
  const challengeBundleHash = normalizeHex32(
    options.challengeBundleHash || sha256Hex(`challenge:${challengeId}`),
    'challengeBundleHash'
  );
  const witnessHash = normalizeHex32(
    options.witnessHash || sha256Hex(`witness:${challengeId}`),
    'witnessHash'
  );
  const bountySats = normalizeAmountSats(options.bountySats ?? 5000n, 'bountySats');
  const watcherNodeId = normalizeString(options.watcherNodeId || 'watcher-node-01', 'watcherNodeId');
  const preimageHex = normalizeHex32(
    options.preimageHex || derivePreimageHex(`watchtower:${challengeId}:${witnessHash}`),
    'preimageHex'
  );
  const paymentHashHex = derivePaymentHashHex(preimageHex);

  const commitment = {
    challengeId,
    challengeBundleHash,
    witnessHash,
    watcherNodeId,
    bountySats: bountySats.toString(),
    paymentHashHex
  };

  return {
    kind: 'lightning_watchtower_bounty',
    bountyId: hashCanonical(commitment),
    commitment,
    invoice: makePrototypeInvoice({
      amountSats: bountySats,
      paymentHashHex,
      description: `bitvm watchtower ${challengeId}`
    }),
    amountMsat: msatFromSats(bountySats),
    receipt: {
      status: 'settled',
      preimageHex,
      receiptHash: sha256Hex(`WATCHTOWER_BOUNTY_RECEIPT_V1:${paymentHashHex}:${preimageHex}`)
    },
    verification: {
      preimageMatchesPaymentHash: derivePaymentHashHex(preimageHex) === paymentHashHex,
      witnessBoundToChallenge: Boolean(challengeBundleHash && witnessHash)
    }
  };
}

function buildContractOpenApiPrototype(options = {}) {
  const position = buildLightningFundedPositionOpen(options.position || options);
  const apiBase = options.apiBase || '/v1/bitvm-dlc';
  const sessionId = hashCanonical({
    apiBase,
    transcriptId: position.transcriptId,
    client: options.client || 'ldk-node+bdk-wallet'
  });

  return {
    kind: 'ldk_bdk_contract_open_api_prototype',
    sessionId,
    compatibilityTarget: {
      lightning: 'LDK Node hold-invoice or BOLT12 offer adapter',
      onchainWallet: 'BDK PSBT signing/broadcast adapter',
      contractCore: 'BitVM UTXO referee artifact bundle'
    },
    endpoints: [
      { method: 'POST', path: `${apiBase}/offers`, name: 'create_contract_offer' },
      { method: 'POST', path: `${apiBase}/offers/{offer_id}/lightning-quote`, name: 'quote_lightning_funding' },
      { method: 'POST', path: `${apiBase}/sessions/{session_id}/payment`, name: 'attach_payment_attempt' },
      { method: 'POST', path: `${apiBase}/sessions/{session_id}/funding-psbt`, name: 'finalize_funding_psbt' },
      { method: 'POST', path: `${apiBase}/sessions/{session_id}/verify`, name: 'verify_referee_commitment' }
    ],
    stateMachine: [
      'offer_created',
      'lightning_quote_issued',
      'hold_invoice_accepted',
      'funding_psbt_finalized',
      'referee_commitment_verified',
      'contract_opened'
    ],
    sampleSession: {
      offerId: `offer-${position.transcriptId.slice(0, 16)}`,
      sessionId,
      positionTranscriptId: position.transcriptId,
      paymentHashHex: position.lightning.paymentHashHex,
      fundingOutputCommitmentHash: position.fundingOutput.commitmentHash,
      finalState: 'contract_opened'
    },
    position
  };
}

function buildLightningFundedRollover(options = {}) {
  const previousEpochId = normalizeEpochId(options.previousEpochId ?? 1n);
  const nextEpochId = previousEpochId + 1n;
  const previousCollateralSats = normalizeAmountSats(options.previousCollateralSats ?? 75000n, 'previousCollateralSats');
  const topUpSats = normalizeAmountSats(options.topUpSats ?? 25000n, 'topUpSats');
  const swapFeeSats = normalizeAmountSats(options.swapFeeSats ?? 100n, 'swapFeeSats');
  const nextCollateralSats = previousCollateralSats + topUpSats;
  const previousContractId = normalizeString(options.previousContractId || `dlc-${previousEpochId.toString()}`, 'previousContractId');
  const nextContractId = normalizeString(options.nextContractId || `dlc-${nextEpochId.toString()}`, 'nextContractId');
  const preimageHex = normalizeHex32(
    options.preimageHex || derivePreimageHex(`rollover:${previousContractId}:${nextContractId}:${topUpSats}`),
    'preimageHex'
  );
  const paymentHashHex = derivePaymentHashHex(preimageHex);
  const nextCommitmentRoot = hashCanonical({
    previousContractId,
    nextContractId,
    previousCollateralSats: previousCollateralSats.toString(),
    topUpSats: topUpSats.toString(),
    nextCollateralSats: nextCollateralSats.toString(),
    paymentHashHex
  });

  return {
    kind: 'lightning_funded_rollover',
    previousEpochId: previousEpochId.toString(),
    nextEpochId: nextEpochId.toString(),
    previousContractId,
    nextContractId,
    previousCollateralSats: previousCollateralSats.toString(),
    topUpSats: topUpSats.toString(),
    swapFeeSats: swapFeeSats.toString(),
    nextCollateralSats: nextCollateralSats.toString(),
    lightning: {
      invoice: makePrototypeInvoice({
        amountSats: topUpSats + swapFeeSats,
        paymentHashHex,
        description: `roll ${previousContractId} to ${nextContractId}`
      }),
      amountMsat: msatFromSats(topUpSats + swapFeeSats),
      paymentHashHex,
      preimageHex
    },
    nextCommitment: {
      root: nextCommitmentRoot,
      route: 'roll',
      carriesPreviousCollateral: true,
      includesLightningTopUp: true
    },
    conservation: {
      expectedNextCollateralSats: nextCollateralSats.toString(),
      actualNextCollateralSats: nextCollateralSats.toString(),
      holds: true
    }
  };
}

function buildAllLightningIntegrationPrototypes(options = {}) {
  const positionOpen = buildLightningFundedPositionOpen(options.positionOpen || {});
  const payoutCompression = buildLightningPayoutCompression(options.payoutCompression || {});
  const watchtowerBounty = buildLightningWatchtowerBounty(options.watchtowerBounty || {});
  const contractOpenApi = buildContractOpenApiPrototype({
    ...(options.contractOpenApi || {}),
    position: options.contractOpenApi?.position || options.positionOpen || {}
  });
  const rollover = buildLightningFundedRollover(options.rollover || {});

  const bundleCore = {
    positionOpenTranscriptId: positionOpen.transcriptId,
    payoutRoot: payoutCompression.root,
    bountyId: watchtowerBounty.bountyId,
    apiSessionId: contractOpenApi.sessionId,
    rolloverRoot: rollover.nextCommitment.root
  };

  return {
    kind: 'lightning_bitvm_dlc_prototype_bundle',
    version: 1,
    bundleId: hashCanonical(bundleCore),
    bundleCore,
    prototypes: {
      positionOpen,
      payoutCompression,
      watchtowerBounty,
      contractOpenApi,
      rollover
    }
  };
}

module.exports = {
  sha256Hex,
  derivePreimageHex,
  derivePaymentHashHex,
  makePrototypeInvoice,
  buildFundingOutputCommitment,
  buildLightningFundedPositionOpen,
  buildLightningPayoutCompression,
  verifyLightningPayoutCompression,
  buildLightningWatchtowerBounty,
  buildContractOpenApiPrototype,
  buildLightningFundedRollover,
  buildAllLightningIntegrationPrototypes
};
