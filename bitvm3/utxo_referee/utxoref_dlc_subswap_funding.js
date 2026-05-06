const crypto = require('crypto');
const { canonicalStringify } = require('./m1_spec');
const {
  derivePreimageHex,
  derivePaymentHashHex,
  makePrototypeInvoice,
  buildFundingOutputCommitment
} = require('./lightning_integration');

const HEX_32_RE = /^[0-9a-f]{64}$/i;
const DEFAULT_WALLET_NODE_ID = 'zeus-wallet-demo-node';
const DEFAULT_REFUND_ADDRESS = 'tb1qutxorefsubswaprefund0000000000000000000000';

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

function normalizePositiveBigInt(value, fieldName) {
  let bigint;
  try {
    bigint = BigInt(value);
  } catch (_err) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  if (bigint <= 0n) throw new Error(`${fieldName} must be a positive integer`);
  return bigint;
}

function normalizeNonNegativeBigInt(value, fieldName) {
  let bigint;
  try {
    bigint = BigInt(value);
  } catch (_err) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  if (bigint < 0n) throw new Error(`${fieldName} must be a non-negative integer`);
  return bigint;
}

function normalizeHex32(value, fieldName) {
  const normalized = normalizeString(value, fieldName).toLowerCase();
  if (!HEX_32_RE.test(normalized)) {
    throw new Error(`${fieldName} must be a 32-byte hex string`);
  }
  return normalized;
}

function extractDlcCore(dlcBundle) {
  if (!dlcBundle || dlcBundle.kind !== 'lightning_tradelayer_oracle_dlc_bundle') {
    throw new Error('dlcBundle must be a lightning_tradelayer_oracle_dlc_bundle');
  }
  return {
    bundleId: normalizeHex32(dlcBundle.bundleId, 'dlcBundle.bundleId'),
    contractCommitmentId: normalizeHex32(
      dlcBundle.contract.contractCommitmentId,
      'dlcBundle.contract.contractCommitmentId'
    ),
    organizerId: normalizeHex32(dlcBundle.bitvmOrganizer.organizerId, 'dlcBundle.bitvmOrganizer.organizerId'),
    settlementId: normalizeHex32(dlcBundle.settlement.settlementId, 'dlcBundle.settlement.settlementId'),
    contractId: normalizeString(dlcBundle.contract.contractCore.contractId, 'contractId'),
    network: normalizeString(dlcBundle.contract.contractCore.network, 'network'),
    totalCollateralSats: normalizePositiveBigInt(
      dlcBundle.contract.contractCore.totalCollateralSats,
      'totalCollateralSats'
    ),
    longParty: dlcBundle.contract.contractCore.longParty,
    shortParty: dlcBundle.contract.contractCore.shortParty
  };
}

function proofAmountSats(subswapProof) {
  if (!subswapProof || !subswapProof.dlcFunding) return null;
  return normalizePositiveBigInt(subswapProof.dlcFunding.outputAmountSats, 'subswapProof.dlcFunding.outputAmountSats');
}

function proofPaymentHash(subswapProof) {
  return subswapProof && subswapProof.lightning && subswapProof.lightning.paymentHashHex
    ? normalizeHex32(subswapProof.lightning.paymentHashHex, 'subswapProof.lightning.paymentHashHex')
    : null;
}

function proofFundingOutput(subswapProof) {
  return subswapProof && subswapProof.dlcFunding && subswapProof.dlcFunding.fundingOutput
    ? subswapProof.dlcFunding.fundingOutput
    : null;
}

function buildExecutionProof(subswapProof, requestCore) {
  if (!subswapProof) return null;
  const preimageHex = subswapProof.lightning && subswapProof.lightning.paymentPreimageHex;
  const paymentHashHex = proofPaymentHash(subswapProof);
  return {
    kind: 'utxoref_subswap_execution_proof',
    swapFundingTxid: subswapProof.swap && subswapProof.swap.fundingTxid,
    swapFundingVout: subswapProof.swap && subswapProof.swap.fundingVout,
    claimTxid: subswapProof.dlcFunding && subswapProof.dlcFunding.claimTxid,
    claimWtxid: subswapProof.dlcFunding && subswapProof.dlcFunding.claimWtxid,
    refundTxid: subswapProof.refundPath && subswapProof.refundPath.refundTxid,
    dlcOutputVout: subswapProof.dlcFunding && subswapProof.dlcFunding.outputVout,
    dlcOutputAmountSats: subswapProof.dlcFunding && subswapProof.dlcFunding.outputAmountSats,
    dlcCommitmentHash: subswapProof.dlcFunding && subswapProof.dlcFunding.commitmentHash,
    paymentHashHex,
    paymentPreimageHex: preimageHex || null,
    checks: {
      paymentHashMatchesRequest: paymentHashHex === requestCore.submarineSwap.paymentHashHex,
      preimageMatchesPaymentHash: preimageHex ? derivePaymentHashHex(preimageHex) === paymentHashHex : false,
      claimPaysDlcFundingOutput: Boolean(subswapProof.checks && subswapProof.checks.claimPaysDlcFundingOutput),
      dlcOutputCommitsFundingHash: Boolean(subswapProof.checks && subswapProof.checks.dlcOutputCommitsFundingHash),
      successBroadcasted: Boolean(subswapProof.checks && subswapProof.checks.successBroadcasted),
      refundBranchAvailable: Boolean(subswapProof.checks && subswapProof.checks.refundBroadcasted)
    }
  };
}

function buildDlcSubswapFundingRequest({ dlcBundle, subswapProof = null, options = {} }) {
  const dlc = extractDlcCore(dlcBundle);
  const walletNodeId = normalizeString(options.walletNodeId || DEFAULT_WALLET_NODE_ID, 'walletNodeId');
  const requestedCollateralSats = normalizePositiveBigInt(
    options.requestedCollateralSats || proofAmountSats(subswapProof) || dlc.longParty.collateralSats,
    'requestedCollateralSats'
  );
  const swapFeeSats = normalizeNonNegativeBigInt(options.swapFeeSats || '1000', 'swapFeeSats');
  const invoiceAmountSats = requestedCollateralSats + swapFeeSats;
  const preimageHex = options.preimageHex ||
    (subswapProof && subswapProof.lightning && subswapProof.lightning.paymentPreimageHex) ||
    derivePreimageHex(`utxoref-dlc-subswap:${dlc.contractCommitmentId}:${walletNodeId}:${requestedCollateralSats}`);
  const paymentHashHex = normalizeHex32(
    options.paymentHashHex || proofPaymentHash(subswapProof) || derivePaymentHashHex(preimageHex),
    'paymentHashHex'
  );
  const invoice = options.invoice ||
    (subswapProof && subswapProof.lightning && subswapProof.lightning.bolt11) ||
    makePrototypeInvoice({
      amountSats: invoiceAmountSats,
      paymentHashHex,
      description: `fund DLC ${dlc.contractId} through UTXORef`
    });
  const timeoutBlock = Number(options.timeoutBlock || 144);
  const refundAddress = normalizeString(options.refundAddress || DEFAULT_REFUND_ADDRESS, 'refundAddress');
  const expectedFundingOutput = proofFundingOutput(subswapProof) || buildFundingOutputCommitment({
    epochId: BigInt(options.epochId || 1),
    dlcId: dlc.contractId,
    bitvmCommitmentRoot: dlc.organizerId,
    collateralSats: requestedCollateralSats,
    refundAddress,
    timeoutBlock
  });
  const namespaceHandle = `dlc-subswap-${dlc.contractId}-${paymentHashHex.slice(0, 12)}`;
  const targetBinding = {
    targetDlcBundleId: dlc.bundleId,
    targetContractCommitmentId: dlc.contractCommitmentId,
    targetOrganizerId: dlc.organizerId,
    targetSettlementId: dlc.settlementId,
    subswapFundingCommitmentHash: expectedFundingOutput.commitmentHash,
    paymentHashHex
  };
  const requestCore = {
    version: 1,
    protocol: 'utxoref_dlc_submarine_swap_funding',
    walletNodeId,
    network: dlc.network,
    targetDlc: {
      contractId: dlc.contractId,
      bundleId: dlc.bundleId,
      contractCommitmentId: dlc.contractCommitmentId,
      organizerId: dlc.organizerId,
      settlementId: dlc.settlementId
    },
    submarineSwap: {
      mode: 'ln_invoice_to_p2wsh_claim',
      paymentHashHex,
      invoice,
      invoiceAmountSats: invoiceAmountSats.toString(),
      requestedCollateralSats: requestedCollateralSats.toString(),
      swapFeeSats: swapFeeSats.toString(),
      refundBlocks: Number(options.refundBlocks || 6),
      claimRule: 'UTXORef claims the swap HTLC with the Lightning preimage and pays the DLC funding output.',
      refundRule: 'If the invoice is not paid or the claim path fails, the HTLC refund branch returns the swap funding output after timeout.'
    },
    dlcFundingOutput: expectedFundingOutput,
    jurassicMotifs: {
      transcriptAliases: ['subswap_invoice_request', 'dlc_funding_claim'],
      namespaceHandle,
      carrierHints: ['ln_invoice', 'p2wsh_htlc', 'dlc_funding_output']
    },
    targetBindingHash: hashCanonical(targetBinding)
  };
  const requestId = hashCanonical(requestCore);
  const executionProof = buildExecutionProof(subswapProof, requestCore);

  return {
    kind: 'utxoref_dlc_subswap_funding_request',
    requestId,
    requestCore,
    executionProof,
    walletActions: [
      { id: 'request_quote', label: 'Request UTXORef submarine swap quote' },
      { id: 'pay_invoice', label: 'Pay funding invoice from LN wallet' },
      { id: 'watch_claim_tx', label: 'Watch HTLC claim into DLC funding output' },
      { id: 'verify_dlc_funding', label: 'Verify DLC funding proof' }
    ],
    explanation:
      'The wallet funds a DLC by paying a Lightning invoice. UTXORef uses the revealed preimage to claim a P2WSH submarine-swap output into the DLC funding output, while the request binds the swap to the DLC contract commitment and BitVM organizer.'
  };
}

function verifyDlcSubswapFundingRequest(request) {
  if (!request || request.kind !== 'utxoref_dlc_subswap_funding_request') {
    return { ok: false, reason: 'wrong request kind' };
  }
  if (request.requestId !== hashCanonical(request.requestCore)) {
    return { ok: false, reason: 'request id mismatch' };
  }
  const core = request.requestCore;
  if (!HEX_32_RE.test(core.submarineSwap.paymentHashHex)) {
    return { ok: false, reason: 'payment hash must be 32-byte hex' };
  }
  if (BigInt(core.submarineSwap.invoiceAmountSats) < BigInt(core.submarineSwap.requestedCollateralSats)) {
    return { ok: false, reason: 'invoice does not cover requested collateral' };
  }
  if (!core.dlcFundingOutput || !HEX_32_RE.test(core.dlcFundingOutput.commitmentHash)) {
    return { ok: false, reason: 'missing DLC funding commitment hash' };
  }
  const targetBindingHash = hashCanonical({
    targetDlcBundleId: core.targetDlc.bundleId,
    targetContractCommitmentId: core.targetDlc.contractCommitmentId,
    targetOrganizerId: core.targetDlc.organizerId,
    targetSettlementId: core.targetDlc.settlementId,
    subswapFundingCommitmentHash: core.dlcFundingOutput.commitmentHash,
    paymentHashHex: core.submarineSwap.paymentHashHex
  });
  if (targetBindingHash !== core.targetBindingHash) {
    return { ok: false, reason: 'target DLC binding hash mismatch' };
  }
  if (request.executionProof) {
    const proofChecks = request.executionProof.checks || {};
    const failed = Object.entries(proofChecks).find(([_name, ok]) => !ok);
    if (failed) return { ok: false, reason: `execution proof failed: ${failed[0]}` };
  }
  return { ok: true };
}

function buildDlcSubswapFundingWalletView(request) {
  const verification = verifyDlcSubswapFundingRequest(request);
  const core = request.requestCore;
  return {
    kind: 'wallet_dlc_subswap_funding_view',
    status: verification.ok ? 'verified' : 'needs_attention',
    title: 'UTXORef DLC Submarine Swap Funding',
    subtitle: `${core.submarineSwap.requestedCollateralSats} sats into ${core.targetDlc.contractId}`,
    requestId: request.requestId,
    targetContractCommitmentId: core.targetDlc.contractCommitmentId,
    namespaceHandle: core.jurassicMotifs.namespaceHandle,
    invoice: core.submarineSwap.invoice,
    invoiceAmountSats: core.submarineSwap.invoiceAmountSats,
    requestedCollateralSats: core.submarineSwap.requestedCollateralSats,
    paymentHashHex: core.submarineSwap.paymentHashHex,
    fundingCommitmentHash: core.dlcFundingOutput.commitmentHash,
    targetBindingHash: core.targetBindingHash,
    execution: request.executionProof && {
      swapFundingTxid: request.executionProof.swapFundingTxid,
      claimTxid: request.executionProof.claimTxid,
      refundTxid: request.executionProof.refundTxid,
      checks: request.executionProof.checks
    },
    actions: request.walletActions,
    verification
  };
}

module.exports = {
  buildDlcSubswapFundingRequest,
  verifyDlcSubswapFundingRequest,
  buildDlcSubswapFundingWalletView
};
