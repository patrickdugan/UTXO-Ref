/**
 * Milestone 1 - Procedural Sync Summary
 *
 * Emits a wallet-facing summary from the latest BitVM referee artifacts so
 * downstream runtimes can reconcile the current receipt-contract state without
 * parsing each artifact independently.
 *
 * Run:
 *   node bitvm3/utxo_referee/m1_procedural_sync.js
 *
 * Optional env:
 *   BITVM_PROCEDURAL_PROPERTY_ID=380
 *   BITVM_HOLDER_ADDRESS=tltc1q...
 *   BITVM_PROCEDURAL_STATE=SETTLED|FUNDED|DRAFT
 *   BITVM_PROCEDURAL_DB_ROOT=D:\tradelayer-wallet-state\nedb-data\ltc-test
 *   BITVM_PROCEDURAL_OUT_PATH=C:\path\to\bitvm_procedural_sync_latest.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const DRAFT_PATH = path.join(ARTIFACTS_DIR, 'm1_dlc_draft_latest.json');
const FUNDING_PSBT_PATH = path.join(ARTIFACTS_DIR, 'm1_funding_psbt_latest.json');
const FUNDING_FINAL_PATH = path.join(ARTIFACTS_DIR, 'm1_funding_finalized_latest.json');
const BUNDLE_PATH = path.join(ARTIFACTS_DIR, 'm1_challenge_bundle_latest.json');
const WITNESS_PATH = path.join(ARTIFACTS_DIR, 'm1_challenge_witness_latest.json');
const EXPIRY_PATH = path.join(ARTIFACTS_DIR, 'm1_expiry_redemption_latest.json');
const PARALLEL_UTXO_INDEX_PATH = path.join(ARTIFACTS_DIR, 'm1_parallel_utxo_index_latest.json');
const DEFAULT_OUT_PATH = path.join(ARTIFACTS_DIR, 'bitvm_procedural_sync_latest.json');
const DEFAULT_PROPERTY_ID = 380;

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function stringifyJson(value, pretty = false) {
  return JSON.stringify(
    value,
    (_key, current) => (typeof current === 'bigint' ? current.toString() : current),
    pretty ? 2 : 0
  );
}

function loadJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function toBigInt(value, fallback = 0n) {
  if (value === null || value === undefined || value === '') {
    return BigInt(fallback);
  }
  return typeof value === 'bigint' ? value : BigInt(value);
}

function satsToLtcNumber(value) {
  const sats = toBigInt(value, 0n);
  const negative = sats < 0n;
  const abs = negative ? -sats : sats;
  const whole = abs / 100000000n;
  const frac = abs % 100000000n;
  const rendered = `${negative ? '-' : ''}${whole.toString()}.${frac.toString().padStart(8, '0')}`;
  return Number(rendered);
}

function artifactMeta(filePath, artifact) {
  if (!artifact || !fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return {
    path: filePath,
    kind: artifact.kind || null,
    hash: sha256Hex(raw)
  };
}

function resolveState({ explicitState, expiryArtifact, fundingFinal, witnessArtifact, fundingPsbt }) {
  if (explicitState) {
    return String(explicitState).trim().toUpperCase();
  }
  if (expiryArtifact && expiryArtifact.redemption && expiryArtifact.redemption.amountSats != null) {
    return 'SETTLED';
  }
  if (fundingFinal || witnessArtifact || fundingPsbt) {
    return 'FUNDED';
  }
  return 'DRAFT';
}

function resolveFundingTxid({ expiryArtifact, fundingFinal, challengeBundle, fundingPsbt }) {
  return expiryArtifact?.deposit?.txid
    || fundingFinal?.txid
    || challengeBundle?.binding?.fundingTxidFinalized
    || fundingPsbt?.funding?.fundingOutpoint?.txid
    || null;
}

function resolveFundingOutpoint({ fundingPsbt, challengeBundle }) {
  const fundingOutpoint = fundingPsbt?.funding?.fundingOutpoint
    || challengeBundle?.binding?.fundingOutpoint
    || null;
  if (!fundingOutpoint) {
    return null;
  }
  return {
    txid: fundingOutpoint.txid || null,
    vout: fundingOutpoint.vout ?? null,
    valueSats: fundingOutpoint.valueSats != null ? String(fundingOutpoint.valueSats) : null
  };
}

function resolveFundedAmountSats({ state, expiryArtifact, fundingPsbt, draft }) {
  if (state === 'SETTLED') {
    return toBigInt(
      expiryArtifact?.redemption?.amountSats
      ?? expiryArtifact?.settlementBreakdown?.winnerSweepSats
      ?? expiryArtifact?.deposit?.amountSats
      ?? fundingPsbt?.funding?.effectiveCollateralSats
      ?? draft?.contract?.collateralSats
      ?? 0n
    );
  }

  return toBigInt(
    fundingPsbt?.funding?.effectiveCollateralSats
    ?? draft?.contract?.collateralSats
    ?? expiryArtifact?.deposit?.amountSats
    ?? 0n
  );
}

function resolveHolderAddress({ explicitHolderAddress, draft }) {
  return String(
    explicitHolderAddress
    || process.env.BITVM_HOLDER_ADDRESS
    || draft?.roleSet?.addresses?.alice
    || ''
  ).trim();
}

function loadLatestProceduralSyncInputs() {
  const draft = loadJsonIfExists(DRAFT_PATH);
  if (!draft) {
    throw new Error(`Missing required artifact: ${DRAFT_PATH}`);
  }

  const fundingPsbt = loadJsonIfExists(FUNDING_PSBT_PATH);
  const fundingFinal = loadJsonIfExists(FUNDING_FINAL_PATH);
  const challengeBundle = loadJsonIfExists(BUNDLE_PATH);
  const witnessArtifact = loadJsonIfExists(WITNESS_PATH);
  const expiryArtifact = loadJsonIfExists(EXPIRY_PATH);
  const parallelUtxoIndex = loadJsonIfExists(PARALLEL_UTXO_INDEX_PATH);

  return {
    draft,
    fundingPsbt,
    fundingFinal,
    challengeBundle,
    witnessArtifact,
    expiryArtifact,
    parallelUtxoIndex,
    sourceArtifacts: {
      draft: artifactMeta(DRAFT_PATH, draft),
      fundingPsbt: artifactMeta(FUNDING_PSBT_PATH, fundingPsbt),
      fundingFinal: artifactMeta(FUNDING_FINAL_PATH, fundingFinal),
      challengeBundle: artifactMeta(BUNDLE_PATH, challengeBundle),
      challengeWitness: artifactMeta(WITNESS_PATH, witnessArtifact),
      expiryRedemption: artifactMeta(EXPIRY_PATH, expiryArtifact),
      parallelUtxoIndex: artifactMeta(PARALLEL_UTXO_INDEX_PATH, parallelUtxoIndex)
    }
  };
}

function buildProceduralSyncSummary(inputs, options = {}) {
  if (!inputs || !inputs.draft) {
    throw new Error('inputs.draft is required');
  }

  const holderAddress = resolveHolderAddress({
    explicitHolderAddress: options.holderAddress,
    draft: inputs.draft
  });
  if (!holderAddress) {
    throw new Error('holderAddress is required');
  }

  const propertyId = Number(
    options.propertyId
    ?? process.env.BITVM_PROCEDURAL_PROPERTY_ID
    ?? DEFAULT_PROPERTY_ID
  );
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw new Error('propertyId must be a positive integer');
  }

  const state = resolveState({
    explicitState: options.state ?? process.env.BITVM_PROCEDURAL_STATE,
    expiryArtifact: inputs.expiryArtifact,
    fundingFinal: inputs.fundingFinal,
    witnessArtifact: inputs.witnessArtifact,
    fundingPsbt: inputs.fundingPsbt
  });
  const fundedAmountSats = resolveFundedAmountSats({
    state,
    expiryArtifact: inputs.expiryArtifact,
    fundingPsbt: inputs.fundingPsbt,
    draft: inputs.draft
  });
  const fundingOutpoint = resolveFundingOutpoint({
    fundingPsbt: inputs.fundingPsbt,
    challengeBundle: inputs.challengeBundle
  });
  const settlementBreakdown = inputs.expiryArtifact?.settlementBreakdown
    || inputs.expiryArtifact?.deltas?.settlementBreakdown
    || null;
  const settlementRoute = inputs.witnessArtifact?.route
    || inputs.witnessArtifact?.witness?.route
    || inputs.expiryArtifact?.deltas?.route
    || null;
  const collateralSats = toBigInt(
    inputs.fundingPsbt?.funding?.effectiveCollateralSats
    ?? fundingOutpoint?.valueSats
    ?? inputs.draft?.contract?.collateralSats
    ?? 0n
  );

  const summary = {
    kind: 'bitvm_procedural_sync',
    createdAt: new Date().toISOString(),
    propertyId,
    holderAddress,
    operatorAddress: inputs.draft?.roleSet?.addresses?.operator || null,
    oracleAddress: inputs.draft?.roleSet?.addresses?.oracle || null,
    residualAddress: inputs.draft?.roleSet?.addresses?.residual || null,
    templateId: inputs.draft?.template?.templateId || null,
    templateHash: inputs.draft?.template?.templateHash || null,
    contractId: inputs.draft?.contract?.eventId || null,
    fundingTxid: resolveFundingTxid({
      expiryArtifact: inputs.expiryArtifact,
      fundingFinal: inputs.fundingFinal,
      challengeBundle: inputs.challengeBundle,
      fundingPsbt: inputs.fundingPsbt
    }),
    fundedAmountLtc: satsToLtcNumber(fundedAmountSats),
    state,
    dbRoot: options.dbRoot ?? process.env.BITVM_PROCEDURAL_DB_ROOT ?? null,
    chain: {
      network: inputs.draft?.chain?.network || inputs.expiryArtifact?.chain?.chain || null,
      blockHeight: inputs.draft?.chain?.blockHeight ?? inputs.expiryArtifact?.chain?.height ?? null,
      mode: inputs.expiryArtifact?.chain?.mode || null
    },
    funding: {
      collateralSats: collateralSats.toString(),
      fundedAmountSats: fundedAmountSats.toString(),
      fundingOutpoint
    },
    settlement: {
      route: settlementRoute,
      settlementKind: settlementBreakdown?.settlementKind
        || inputs.expiryArtifact?.redemption?.settlementKind
        || null,
      redeemedSats: inputs.expiryArtifact?.redemption?.amountSats
        ? String(inputs.expiryArtifact.redemption.amountSats)
        : null,
      winnerSweepSats: settlementBreakdown?.winnerSweepSats != null
        ? String(settlementBreakdown.winnerSweepSats)
        : null,
      refundSats: settlementBreakdown?.refundSats != null
        ? String(settlementBreakdown.refundSats)
        : (settlementBreakdown?.residualSats != null ? String(settlementBreakdown.residualSats) : null),
      dustCarrySats: settlementBreakdown?.dustCarrySats != null
        ? String(settlementBreakdown.dustCarrySats)
        : (inputs.expiryArtifact?.redemption?.dustCarrySats != null
          ? String(inputs.expiryArtifact.redemption.dustCarrySats)
          : null)
    },
    parallelUtxoIndex: inputs.parallelUtxoIndex
      ? {
          chainId: inputs.parallelUtxoIndex.chain?.chainId || null,
          fundingTxid: inputs.parallelUtxoIndex.anchors?.fundingTxid || null,
          timeoutSpendTxid: inputs.parallelUtxoIndex.anchors?.timeoutSpendTxid || null,
          transactionCount: Array.isArray(inputs.parallelUtxoIndex.transactions)
            ? inputs.parallelUtxoIndex.transactions.length
            : null,
          semanticRefCount: Array.isArray(inputs.parallelUtxoIndex.semanticRefs)
            ? inputs.parallelUtxoIndex.semanticRefs.length
            : null,
          artifactHash: inputs.parallelUtxoIndex.artifactHash || null
        }
      : null,
    sourceArtifacts: inputs.sourceArtifacts || null,
    artifactHash: null
  };

  summary.artifactHash = sha256Hex(
    stringifyJson({
      ...summary,
      artifactHash: null
    })
  );

  return summary;
}

function writeProceduralSyncSummary(inputs, options = {}) {
  const outPath = options.outPath
    || process.env.BITVM_PROCEDURAL_OUT_PATH
    || DEFAULT_OUT_PATH;
  const summary = buildProceduralSyncSummary(inputs, options);
  fs.writeFileSync(outPath, stringifyJson(summary, true));
  return { outPath, summary };
}

function run() {
  const inputs = loadLatestProceduralSyncInputs();
  const { outPath, summary } = writeProceduralSyncSummary(inputs);

  console.log('=== M1 Procedural Sync ===');
  console.log(`state=${summary.state}`);
  console.log(`propertyId=${summary.propertyId}`);
  console.log(`holderAddress=${summary.holderAddress}`);
  console.log(`contractId=${summary.contractId}`);
  console.log(`fundingTxid=${summary.fundingTxid}`);
  console.log(`fundedAmountLtc=${summary.fundedAmountLtc.toFixed(8)}`);
  console.log(`settlementRoute=${summary.settlement.route}`);
  console.log(`parallelUtxoTxs=${summary.parallelUtxoIndex?.transactionCount || null}`);
  console.log(`artifactHash=${summary.artifactHash}`);
  console.log(`artifactPath=${outPath}`);
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error('Procedural sync generation failed:', err.message);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_PROPERTY_ID,
  loadLatestProceduralSyncInputs,
  buildProceduralSyncSummary,
  writeProceduralSyncSummary
};
