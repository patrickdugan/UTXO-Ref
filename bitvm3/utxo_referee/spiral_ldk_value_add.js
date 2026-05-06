/**
 * Spiral / LDK Value-Add Prototype
 *
 * Turns the Lightning/BitVM-DLC transcript into an LDK-shaped contribution plan:
 * external funding receipt, LSP touchpoints, VSS persistence, and test vectors.
 */

const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');
const {
  buildLightningFundedPositionOpen,
  derivePaymentHashHex
} = require('./lightning_integration');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value) {
  return sha256Hex(canonicalStringify(value));
}

function parseSatAmount(value, fieldName) {
  if (typeof value === 'bigint' || typeof value === 'number') {
    return normalizeAmountSats(value, fieldName);
  }
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a satoshi amount`);
  }
  const match = value.match(/^([0-9]+)(sat)?$/);
  if (!match) {
    throw new Error(`${fieldName} must look like 500000sat`);
  }
  return normalizeAmountSats(BigInt(match[1]), fieldName);
}

const PUBLIC_COMMIT_EVIDENCE = [
  {
    theme: 'funding_splicing_api',
    repo: 'lightningdevkit/rust-lightning',
    commit: 'b1c3e29',
    subject: 'Introduce FundingBuilder for splice requests',
    url: 'https://github.com/lightningdevkit/rust-lightning/commit/b1c3e29a257a70dbc273eb7080f35c42e87d6615',
    implication: 'Contract funding should enter through funding-contribution and splice-shaped APIs.'
  },
  {
    theme: 'funding_splicing_api',
    repo: 'lightningdevkit/rust-lightning',
    commit: '9f9fe58',
    subject: 'Replace FundingTemplate contribution methods with FundingBuilder',
    url: 'https://github.com/lightningdevkit/rust-lightning/commit/9f9fe58bbefaaf7023980e068230cd79c8626bc9',
    implication: 'A useful prototype should emit deterministic funding-builder test vectors.'
  },
  {
    theme: 'lsps_webhooks',
    repo: 'lightningdevkit/rust-lightning',
    commit: '5237c9a',
    subject: 'Use bitreq::Url for LSPS5 webhook URLs',
    url: 'https://github.com/lightningdevkit/rust-lightning/commit/5237c9a9a7441317b4d8e1ee6f096234792d69ce',
    implication: 'The contract-open receipt can be delivered through LSP webhook/payment lifecycle plumbing.'
  },
  {
    theme: 'node_server_productization',
    repo: 'lightningdevkit/ldk-server',
    commit: '9645cb1',
    subject: 'Add OpenChannel::disable_counterparty_reserve',
    url: 'https://github.com/lightningdevkit/ldk-server/commit/9645cb1f02020a41f0541bafded7be82a2a8470d',
    implication: 'The demo should expose operational knobs through node/server APIs, not only library internals.'
  },
  {
    theme: 'vss_recovery',
    repo: 'lightningdevkit/vss-server',
    commit: 'b6d80c7',
    subject: 'Add configurable request body size with 1GB hard limit',
    url: 'https://github.com/lightningdevkit/vss-server/commit/b6d80c74ba1de4238c53eba43a055e0ad94fce41',
    implication: 'Advanced contract state needs bounded, recoverable storage records.'
  },
  {
    theme: 'gossip_reliability',
    repo: 'lightningdevkit/rapid-gossip-sync-server',
    commit: 'b0c2bca',
    subject: 'Fix deadlock with many peers, few threads, and slow postgres writes',
    url: 'https://github.com/lightningdevkit/rapid-gossip-sync-server/commit/b0c2bcaa185211a852250cdb5ba9aada55795497',
    implication: 'The contribution should include repeatable harnesses and failure-mode tests, not just happy-path demos.'
  }
];

function normalizeLiveClnReceipt(liveClnReceipt) {
  if (!liveClnReceipt) return null;
  const payment = liveClnReceipt.payment || {};
  if (!payment.paymentPreimage || !payment.paymentHash) {
    throw new Error('liveClnReceipt must include payment.paymentPreimage and payment.paymentHash');
  }
  return {
    network: liveClnReceipt.network || 'regtest',
    runDir: liveClnReceipt.runDir || null,
    channelTxid: liveClnReceipt.channel && liveClnReceipt.channel.txid,
    channelAmountSats: liveClnReceipt.channel
      ? parseSatAmount(liveClnReceipt.channel.amount, 'liveClnReceipt.channel.amount').toString()
      : null,
    bolt11: payment.bolt11,
    invoiceAmount: payment.invoiceAmount,
    paymentHashHex: payment.paymentHash,
    paymentPreimageHex: payment.paymentPreimage,
    status: payment.status
  };
}

function buildLdkExternalFundingReceipt(options = {}) {
  const liveReceipt = normalizeLiveClnReceipt(options.liveClnReceipt || null);
  const positionOptions = {
    ...(options.positionOpen || {})
  };
  if (liveReceipt && !positionOptions.preimageHex) {
    positionOptions.preimageHex = liveReceipt.paymentPreimageHex;
  }

  const positionOpen = buildLightningFundedPositionOpen(positionOptions);
  const receiptPreimageHex = liveReceipt ? liveReceipt.paymentPreimageHex : positionOpen.lightning.preimageHex;
  const receiptPaymentHashHex = derivePaymentHashHex(receiptPreimageHex);
  const contributionAmountSats = parseSatAmount(
    options.contributionAmountSats || positionOpen.transcriptCore.collateralSats,
    'contributionAmountSats'
  );

  const ldkContributionCore = {
    version: 1,
    targetSurface: 'LDK FundingBuilder external contribution',
    contractKind: 'lightning_funded_bitvm_dlc_position_open',
    contractTranscriptId: positionOpen.transcriptId,
    contributionAmountSats: contributionAmountSats.toString(),
    fundingOutputCommitmentHash: positionOpen.fundingOutput.commitmentHash,
    lightningPaymentHashHex: receiptPaymentHashHex,
    lspFlow: 'LSPS quote -> hold invoice -> funding contribution -> contract-open receipt',
    persistenceRecordKind: 'vss_contract_open_receipt_v1'
  };

  const vssRecord = {
    kind: 'vss_contract_open_receipt_v1',
    key: `contract-open/${positionOpen.transcriptId}`,
    valueHash: hashCanonical({
      positionOpenTranscriptId: positionOpen.transcriptId,
      paymentHashHex: receiptPaymentHashHex,
      fundingOutputCommitmentHash: positionOpen.fundingOutput.commitmentHash
    }),
    boundedFields: [
      'positionOpenTranscriptId',
      'paymentHashHex',
      'fundingOutputCommitmentHash',
      'channelTxid',
      'receiptStatus'
    ]
  };

  const adapter = {
    kind: 'ldk_external_funding_receipt_adapter',
    adapterId: hashCanonical(ldkContributionCore),
    ldkContributionCore,
    traitSketch: [
      'quote_contract_open_funding(intent) -> lightning_invoice',
      'validate_preimage_receipt(preimage, payment_hash) -> receipt',
      'build_external_funding_contribution(receipt, funding_output_commitment) -> contribution',
      'persist_contract_open_receipt(vss_client, receipt_record) -> storage_version'
    ],
    ldkTouchpoints: [
      'rust-lightning::ln::funding::FundingBuilder',
      'rust-lightning splicing tests',
      'ldk-node payment and HRN resolution surfaces',
      'ldk-server OpenChannel API and gRPC wrapper',
      'vss-client/vss-server recovery records',
      'rapid-gossip-sync repeatable harness metrics'
    ],
    positionOpen,
    liveClnReceipt: liveReceipt,
    vssRecord,
    checks: {
      preimageMatchesReceiptHash: receiptPaymentHashHex === (liveReceipt ? liveReceipt.paymentHashHex : positionOpen.lightning.paymentHashHex),
      fundingOutputBoundToContract: positionOpen.transcriptCore.fundingOutputCommitmentHash === positionOpen.fundingOutput.commitmentHash,
      contributionAmountMatchesCollateral: contributionAmountSats.toString() === positionOpen.transcriptCore.collateralSats,
      evidenceLinksPresent: PUBLIC_COMMIT_EVIDENCE.every(item => item.url.startsWith('https://github.com/lightningdevkit/'))
    }
  };

  return adapter;
}

function verifyLdkExternalFundingReceipt(adapter) {
  if (!adapter || adapter.kind !== 'ldk_external_funding_receipt_adapter') {
    return { ok: false, reason: 'wrong adapter kind' };
  }
  const expectedAdapterId = hashCanonical(adapter.ldkContributionCore);
  if (adapter.adapterId !== expectedAdapterId) {
    return { ok: false, reason: 'adapter id mismatch' };
  }
  for (const [name, passed] of Object.entries(adapter.checks || {})) {
    if (!passed) {
      return { ok: false, reason: `check failed: ${name}` };
    }
  }
  return { ok: true };
}

function buildSpiralLdkValueAddBrief(options = {}) {
  const adapter = buildLdkExternalFundingReceipt(options);
  const verification = verifyLdkExternalFundingReceipt(adapter);

  return {
    kind: 'spiral_ldk_value_add_brief',
    createdAt: options.createdAt || new Date(0).toISOString(),
    thesis: 'Make Lightning-paid advanced contract opens look like normal LDK funding, LSP, and recovery plumbing.',
    evidence: PUBLIC_COMMIT_EVIDENCE,
    adapter,
    proposedMilestones: [
      {
        name: 'M1: LDK-shaped funding receipt vectors',
        deliverable: 'Rust/JS vectors binding invoice preimage, FundingBuilder-style contribution, funding output, and contract transcript.',
        reviewSurface: 'rust-lightning funding/splicing tests'
      },
      {
        name: 'M2: ldk-node / ldk-server demo surface',
        deliverable: 'CLI/API demo for contract-open quote, invoice payment, receipt verification, and replay.',
        reviewSurface: 'ldk-node or ldk-server sample integration'
      },
      {
        name: 'M3: VSS recovery record',
        deliverable: 'Persist/reload contract-open receipt and prove the recovered state verifies against the funding transcript.',
        reviewSurface: 'vss-client-compatible storage record tests'
      }
    ],
    pitchBoundary: [
      'Do not ask Spiral to bless production BitVM semantics.',
      'Present the value as reusable LDK funding, receipt, storage, and test-vector plumbing.',
      'Keep Litecoin/testnet demos as local harness evidence, not the headline.'
    ],
    verification
  };
}

module.exports = {
  PUBLIC_COMMIT_EVIDENCE,
  buildLdkExternalFundingReceipt,
  verifyLdkExternalFundingReceipt,
  buildSpiralLdkValueAddBrief
};
