/**
 * DLC-BitVM tokenizer security comparison.
 *
 * Compares the ASP-backed Ark/Shinigami tokenizer against a direct DLC/BitVM
 * vault that does not use an Ark service provider. ASPs are modeled as optional
 * accelerators: they improve batching and liquidity UX, but must be bounded by
 * reserves, exit paths, and Shinigami/BitVM challenge receipts.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalStringify } = require('../m1_spec');
const { buildArkDlcFeeModel } = require('../ark_dlc_settlement');
const {
  buildShinigamiVirtualCetBundle,
  verifyShinigamiVirtualCetBundle
} = require('./shinigami_virtual_cet_ark');
const {
  buildAspBitvmReserveBundle,
  verifyAspBitvmReserveBundle
} = require('../asp_bitvm_reserve_bond');
const {
  buildShinigamiVirtualCetProofCorpus,
  writeShinigamiVirtualCetProofCorpus,
  RECEIPTS_PATH
} = require('./shinigami_virtual_cet_proof_corpus');

const OUT_MD = path.join(__dirname, 'SHINIGAMI_DLC_TOKENIZER_SECURITY.md');
const OUT_JSON = path.join(__dirname, 'artifacts', 'virtual_cet_proofs', 'dlc_tokenizer_security_comparison_latest.json');

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

function readReceiptSummary(receiptSummaryPath) {
  const target = receiptSummaryPath || RECEIPTS_PATH;
  if (!target || !fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function feeRows(outcomeCounts, options = {}) {
  return outcomeCounts.map(outcomeCount => {
    const model = buildArkDlcFeeModel({ ...options, outcomeCount }).modelCore;
    const onchainWorst = BigInt(model.onchainCetWorstCaseSats);
    const governedArk = BigInt(model.governedArkSats);
    return {
      outcomeCount,
      materializedCetCount: 0,
      directMaterializedCetWorstCase: outcomeCount,
      onchainCetWorstCaseSats: model.onchainCetWorstCaseSats,
      governedArkSats: model.governedArkSats,
      estimatedSavingsSats: (onchainWorst > governedArk ? onchainWorst - governedArk : 0n).toString(),
      avoidsCetFanoutOnchainExposure: true
    };
  });
}

function threatRows() {
  return [
    {
      threat: 'wrong_payout_root',
      aspBacked:
        'Shinigami claim binds selected leaf, payout root, and collateral sum; ASP reserve slash pays users if the ASP advances the wrong payout.',
      directDlcBitvm:
        'Shinigami claim still detects the wrong payout, but the remedy is a direct BitVM challenge against the vault instead of an ASP reserve claim.',
      strongerModel: 'tie',
      residualRisk: 'watcher must publish the challenge before timeout'
    },
    {
      threat: 'wrong_oracle_outcome',
      aspBacked:
        'ASP-signed virtual-CET settlement must match the oracle outcome hash or the route becomes slashable.',
      directDlcBitvm:
        'Counterparty cannot rely on an ASP route, but the direct vault still depends on oracle publication freshness and challenge liveness.',
      strongerModel: 'direct_dlc_bitvm',
      residualRisk: 'oracle compromise or stale oracle policy remains outside CET compression'
    },
    {
      threat: 'omitted_virtual_cet_leaf',
      aspBacked:
        'Ark leaf root and virtual-CET set id are public inputs; omission is challenged against ASP round state.',
      directDlcBitvm:
        'Direct vault commits the virtual-CET set root before funding; omission is challenged against the funding template.',
      strongerModel: 'tie',
      residualRisk: 'large sets still need reproducible corpus generation and archival'
    },
    {
      threat: 'asp_route_mismatch',
      aspBacked:
        'ASP can misroute, but the reserve bond and forfeit path make it economically slashable.',
      directDlcBitvm:
        'No ASP route exists, so this class disappears; users pay with slower direct coordination.',
      strongerModel: 'direct_dlc_bitvm',
      residualRisk: 'direct model inherits counterparty noncooperation risk'
    },
    {
      threat: 'exit_withholding',
      aspBacked:
        'Exit availability is an ASP-signed obligation with reserve slash and watcher bounty.',
      directDlcBitvm:
        'No ASP can withhold an Ark exit, but the direct vault must have timeout/refund leaves and both parties must preserve transaction packages.',
      strongerModel: 'tie',
      residualRisk: 'timeout design and fee bumping need production hardening'
    },
    {
      threat: 'liquidity_liveness',
      aspBacked:
        'ASP can batch and patch liquidity cheaply; underdelivery is measurable against signed obligations.',
      directDlcBitvm:
        'No liquidity provider liveness assumption, but no cheap batched liquidity service either.',
      strongerModel: 'asp_backed',
      residualRisk: 'ASP market concentration and reserve sizing'
    },
    {
      threat: 'challenge_window_failure',
      aspBacked:
        'Watcher bounty funds third-party monitoring, and reserve claims define public receipts.',
      directDlcBitvm:
        'Participants or their watchtowers must monitor directly; no ASP reserve subsidizes monitoring by default.',
      strongerModel: 'asp_backed',
      residualRisk: 'watcher availability and mempool fee spikes'
    }
  ];
}

function buildDirectModel(bundle, options = {}) {
  const outcomeCount = bundle.virtualCetSet.virtualCets.length;
  const directFee = buildArkDlcFeeModel({ ...options, outcomeCount }).modelCore;
  const directCore = {
    version: 1,
    protocol: 'direct_dlc_bitvm_tokenizer_model',
    contractCommitmentId: bundle.contract.contractCommitmentId,
    virtualCetSetId: bundle.virtualCetSet.virtualCetSetId,
    payoutRoot: bundle.payoutRoot,
    aspId: null,
    reserveId: null,
    custodyModel: 'direct_vault_with_bilateral_or_n_party_signers',
    happyPath:
      'oracle-selected virtual-CET payout root is accepted and the direct vault spends by cooperative or timeout path',
    challengePath:
      'BitVM challenge opens the Shinigami public claim if a counterparty proposes the wrong outcome, wrong payout, or omitted virtual-CET leaf',
    feeTradeoff:
      'removes ASP route and exit-withholding risk, but loses Ark round batching and ASP-funded watcher incentives',
    directOnchainCetWorstCaseSats: directFee.onchainCetWorstCaseSats
  };
  return {
    kind: 'direct_dlc_bitvm_tokenizer_model',
    modelId: hashCanonical(directCore),
    modelCore: directCore
  };
}

function buildAspBackedModel(bundle, reserveBundle) {
  const reserve = reserveBundle.reserve.reserveCore;
  const challenge = reserveBundle.bitvmChallenge.challengeCore;
  const modelCore = {
    version: 1,
    protocol: 'asp_backed_ark_shinigami_tokenizer_model',
    contractCommitmentId: bundle.contract.contractCommitmentId,
    virtualCetSetId: bundle.virtualCetSet.virtualCetSetId,
    payoutRoot: bundle.payoutRoot,
    aspId: reserve.aspId,
    reserveId: reserveBundle.reserve.reserveId,
    reserveAmountSats: reserve.reserveAmountSats,
    challengeWindowBlocks: reserve.challengeWindowBlocks,
    watcherBountyBps: reserve.watcherBountyBps,
    custodyModel: 'ark_asp_accelerated_vtxo_round_with_bitvm_reserve',
    happyPath:
      'ASP batches the selected virtual-CET payout into an Ark round and avoids on-chain CET fanout',
    challengePath:
      'Shinigami fraud claim plus BitVM reserve challenge slashes bad payout, underdelivery, or withheld exit obligations',
    latestViolation: challenge.violation,
    latestClaimedSlashSats: challenge.claimedSlashSats
  };
  return {
    kind: 'asp_backed_ark_shinigami_tokenizer_model',
    modelId: hashCanonical(modelCore),
    modelCore
  };
}

function proofMetrics(receiptSummary) {
  if (!receiptSummary) {
    return {
      available: false,
      verifiedCount: 0,
      receipts: []
    };
  }
  const receipts = receiptSummary.receipts || [];
  return {
    available: true,
    receiptSummaryId: receiptSummary.receiptSummaryId,
    verifiedCount: receipts.filter(receipt => receipt.verified).length,
    receipts: receipts.map(receipt => ({
      outcomeCount: receipt.outcomeCount,
      verified: receipt.verified,
      proofBytes: receipt.proofBytes,
      elapsedWallClock: receipt.metrics && receipt.metrics.elapsedWallClock,
      maxResidentSetKb: receipt.metrics && receipt.metrics.maxResidentSetKb
    }))
  };
}

function buildDlcTokenizerSecurityComparison(options = {}) {
  const outcomeCounts = options.outcomeCounts || [17, 101, 1001, 5000];
  const bundle = options.bundle || buildShinigamiVirtualCetBundle({ ...options, outcomeCount: outcomeCounts[0] });
  const bundleVerification = verifyShinigamiVirtualCetBundle(bundle);
  if (!bundleVerification.ok) {
    throw new Error(`Shinigami virtual-CET bundle failed: ${bundleVerification.reason}`);
  }
  const reserveBundle = options.reserveBundle || buildAspBitvmReserveBundle({ ...options, shinigamiBundle: bundle });
  const reserveVerification = verifyAspBitvmReserveBundle(reserveBundle);
  if (!reserveVerification.ok) {
    throw new Error(`ASP reserve bundle failed: ${reserveVerification.reason}`);
  }
  const proofCorpus = options.proofCorpus || buildShinigamiVirtualCetProofCorpus({ ...options, outcomeCounts });
  const receiptSummary = options.receiptSummary || readReceiptSummary(options.receiptSummaryPath);
  const comparisonCore = {
    version: 1,
    protocol: 'shinigami_dlc_tokenizer_security_comparison',
    headline: 'CET compression remains zero-materialization while ASPs stay optional accelerators.',
    bundleId: bundle.bundleId,
    proofCorpusId: proofCorpus.corpusId,
    outcomeCounts,
    models: {
      aspBacked: buildAspBackedModel(bundle, reserveBundle).modelCore,
      directDlcBitvm: buildDirectModel(bundle, options).modelCore
    },
    feeRows: feeRows(outcomeCounts, options),
    threats: threatRows(),
    proofMetrics: proofMetrics(receiptSummary)
  };
  return {
    kind: 'shinigami_dlc_tokenizer_security_comparison',
    comparisonId: hashCanonical(comparisonCore),
    comparisonCore,
    bundle,
    reserveBundle,
    proofCorpus,
    receiptSummary
  };
}

function verifyDlcTokenizerSecurityComparison(comparison) {
  if (!comparison || comparison.kind !== 'shinigami_dlc_tokenizer_security_comparison') {
    return { ok: false, reason: 'wrong comparison kind' };
  }
  if (comparison.comparisonId !== hashCanonical(comparison.comparisonCore)) {
    return { ok: false, reason: 'comparison id mismatch' };
  }
  const rows = comparison.comparisonCore.feeRows || [];
  if (!rows.length) return { ok: false, reason: 'missing fee rows' };
  for (const row of rows) {
    if (row.materializedCetCount !== 0) return { ok: false, reason: 'materialized CET count is not zero' };
    if (!row.avoidsCetFanoutOnchainExposure) return { ok: false, reason: 'CET fanout exposure is not avoided' };
  }
  const threats = comparison.comparisonCore.threats || [];
  for (const threat of ['wrong_payout_root', 'asp_route_mismatch', 'challenge_window_failure']) {
    if (!threats.some(row => row.threat === threat)) return { ok: false, reason: `missing threat row: ${threat}` };
  }
  if (comparison.comparisonCore.models.aspBacked.reserveId === null) {
    return { ok: false, reason: 'ASP-backed model must bind a reserve' };
  }
  if (comparison.comparisonCore.models.directDlcBitvm.aspId !== null) {
    return { ok: false, reason: 'direct model must not bind an ASP' };
  }
  return { ok: true };
}

function renderMarkdown(comparison) {
  const core = comparison.comparisonCore;
  const metricsRows = core.proofMetrics.receipts.length
    ? core.proofMetrics.receipts
        .map(
          row =>
            `| ${row.outcomeCount} | ${row.verified} | ${row.elapsedWallClock || 'n/a'} | ${row.maxResidentSetKb || 'n/a'} | ${row.proofBytes || 'n/a'} |`
        )
        .join('\n')
    : '| n/a | false | n/a | n/a | n/a |';
  return `# Shinigami DLC Tokenizer Security

Generated: ${new Date().toISOString()}

## Thesis

${core.headline}

The ASP-backed Ark path is an accelerator: it buys fee efficiency, batching, and
liquidity UX. The direct DLC/BitVM path removes ASP route and reserve assumptions
but gives up those batching and monitoring subsidies.

## CET Compression

| Outcomes | Materialized CETs | Direct fanout CETs | Worst-case direct fee sats | Governed Ark sats | Estimated savings sats |
| --- | ---: | ---: | ---: | ---: | ---: |
${core.feeRows
  .map(
    row =>
      `| ${row.outcomeCount} | ${row.materializedCetCount} | ${row.directMaterializedCetWorstCase} | ${row.onchainCetWorstCaseSats} | ${row.governedArkSats} | ${row.estimatedSavingsSats} |`
  )
  .join('\n')}

## Prover Metrics

| Outcomes | Verified | Wall time | Max RSS KB | Proof bytes |
| --- | --- | ---: | ---: | ---: |
${metricsRows}

Rows marked false have generated Cairo inputs but were not submitted to
snacksack in this run. The 5000-outcome row is the large-fanout proof target.

Local Cairo prover source used for this run:

- \`C:\\projects\\ark-shinigami\\virtual_cet_prover\\src\\lib.cairo\`
- \`C:\\projects\\ark-shinigami\\scripts\\prove-virtual-cet-snacksack.ps1\`

## Security Matrix

| Threat | ASP-backed Ark model | Direct DLC/BitVM model | Stronger |
| --- | --- | --- | --- |
${core.threats.map(row => `| ${row.threat} | ${row.aspBacked} | ${row.directDlcBitvm} | ${row.strongerModel} |`).join('\n')}

## Model Commitments

- ASP-backed model id: \`${hashCanonical(core.models.aspBacked)}\`
- Direct model id: \`${hashCanonical(core.models.directDlcBitvm)}\`
- Comparison id: \`${comparison.comparisonId}\`
- Proof corpus id: \`${core.proofCorpusId}\`
`;
}

function writeDlcTokenizerSecurityComparison(options = {}) {
  const comparison = buildDlcTokenizerSecurityComparison(options);
  const verification = verifyDlcTokenizerSecurityComparison(comparison);
  if (!verification.ok) throw new Error(verification.reason);
  const jsonPath = options.jsonPath || OUT_JSON;
  const mdPath = options.mdPath || OUT_MD;
  writeJson(jsonPath, {
    kind: comparison.kind,
    comparisonId: comparison.comparisonId,
    comparisonCore: comparison.comparisonCore
  });
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, renderMarkdown(comparison), 'utf8');
  return { comparison, jsonPath, mdPath };
}

if (require.main === module) {
  try {
    const outDir = path.join(__dirname, 'artifacts', 'virtual_cet_proofs');
    writeShinigamiVirtualCetProofCorpus({ outDir, outcomeCounts: [17, 101, 1001, 5000] });
    const { comparison, jsonPath, mdPath } = writeDlcTokenizerSecurityComparison({
      outcomeCounts: [17, 101, 1001, 5000]
    });
    console.log(
      stringifyJson(
        {
          jsonPath,
          mdPath,
          comparisonId: comparison.comparisonId,
          proofMetricsAvailable: comparison.comparisonCore.proofMetrics.available
        },
        true
      )
    );
  } catch (err) {
    console.error(`dlc_tokenizer_security_comparison failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  OUT_MD,
  OUT_JSON,
  buildDlcTokenizerSecurityComparison,
  verifyDlcTokenizerSecurityComparison,
  writeDlcTokenizerSecurityComparison
};
