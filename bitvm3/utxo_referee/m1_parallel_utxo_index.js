/**
 * Milestone 1 - Parallel UTXO Artifact Index
 *
 * Builds a normalized transaction graph from the latest referee artifacts so
 * wallet/runtime tooling can inspect funding, settlement, roll, and timeout
 * spends without re-parsing each artifact independently.
 *
 * Run:
 *   node bitvm3/utxo_referee/m1_parallel_utxo_index.js
 *
 * Optional env:
 *   M1_PARALLEL_UTXO_INDEX_OUT_PATH=C:\path\to\m1_parallel_utxo_index_latest.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const FUNDING_PSBT_PATH = path.join(ARTIFACTS_DIR, 'm1_funding_psbt_latest.json');
const FUNDING_FINAL_PATH = path.join(ARTIFACTS_DIR, 'm1_funding_finalized_latest.json');
const CET_PATH = path.join(ARTIFACTS_DIR, 'm1_cet_skeletons_latest.json');
const EXPIRY_PATH = path.join(ARTIFACTS_DIR, 'm1_expiry_redemption_latest.json');
const TIMEOUT_PROOF_PATH = path.join(ARTIFACTS_DIR, 'm1_expiry_timeout_testnet_proof.json');
const OUT_PATH = path.join(ARTIFACTS_DIR, 'm1_parallel_utxo_index_latest.json');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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

function compactOutputRef(txid, vout, valueSats, address, role) {
  return {
    txid: txid || null,
    vout: vout ?? null,
    valueSats: valueSats != null ? String(valueSats) : null,
    address: address || null,
    role: role || null
  };
}

function buildSettlementOutputs(pathRecord) {
  const outputs = [];
  if (pathRecord.actualPayoutSats != null || pathRecord.payoutSats != null) {
    outputs.push(compactOutputRef(
      pathRecord.txid || null,
      null,
      pathRecord.actualPayoutSats ?? pathRecord.payoutSats,
      pathRecord.winnerAddress || null,
      'winner-sweep'
    ));
  }
  if (pathRecord.refundSats != null || pathRecord.residualSats != null) {
    outputs.push(compactOutputRef(
      pathRecord.txid || null,
      null,
      pathRecord.refundSats ?? pathRecord.residualSats,
      pathRecord.refundAddress || null,
      'refund-remainder'
    ));
  }
  if (pathRecord.feeSats != null) {
    outputs.push(compactOutputRef(
      pathRecord.txid || null,
      null,
      pathRecord.feeSats,
      pathRecord.feeAddress || null,
      'fee'
    ));
  }
  if (pathRecord.dustCarrySats != null) {
    outputs.push(compactOutputRef(
      pathRecord.txid || null,
      null,
      pathRecord.dustCarrySats,
      pathRecord.dustAddress || null,
      'dust-carry'
    ));
  }

  return outputs.filter(output => output.valueSats !== '0' && output.valueSats !== null);
}

function buildRollOutputs(rollRecord) {
  const payouts = rollRecord?.payouts || {};
  return [
    compactOutputRef(rollRecord?.txid || null, null, payouts.rolloverCollateralSats, payouts.winnerAddress, 'winner-sweep'),
    compactOutputRef(rollRecord?.txid || null, null, payouts.timeoutRemainderSats, payouts.refundAddress, 'refund-remainder'),
    compactOutputRef(rollRecord?.txid || null, null, payouts.dustCarrySats, payouts.dustAddress, 'dust-carry')
  ].filter(output => output.valueSats !== '0' && output.valueSats !== null);
}

function buildTimeoutOutputs(timeoutProof) {
  const spend = timeoutProof?.timeoutSpend || {};
  const routing = timeoutProof?.committedRouting || {};
  return [
    compactOutputRef(spend.txid || null, null, spend.recipientSats, routing.winnerAddress, 'winner-sweep'),
    compactOutputRef(spend.txid || null, null, spend.residualSats, routing.refundAddress, 'refund-remainder'),
    compactOutputRef(spend.txid || null, null, spend.feeSats, routing.feeAddress, 'fee'),
    compactOutputRef(spend.txid || null, null, spend.dustCarrySats, routing.dustAddress, 'dust-carry')
  ].filter(output => output.valueSats !== '0' && output.valueSats !== null);
}

function inferChainIdFromLegacyChain(chain) {
  const network = String(chain?.network || chain?.chain || '').toLowerCase();
  const rpcUrl = String(chain?.rpcUrl || '');

  if (chain?.chainId) {
    return chain.chainId;
  }
  if (rpcUrl.includes(':19332') || network === 'test') {
    return 'litecoin-testnet';
  }
  if (rpcUrl.includes(':9332') || network === 'main') {
    return 'litecoin-mainnet';
  }
  if (rpcUrl.includes(':18332')) {
    return 'bitcoin-testnet';
  }
  if (rpcUrl.includes(':8332')) {
    return 'bitcoin-mainnet';
  }
  return null;
}

function inferChain(inputs) {
  return inputs.fundingPsbt?.chain
    || inputs.fundingFinal?.chain
    || inputs.expiryArtifact?.chain
    || null;
}

function buildParallelUtxoIndex(inputs) {
  const chain = inferChain(inputs);
  const transactions = [];
  const semanticRefs = [];

  if (inputs.fundingFinal) {
    transactions.push({
      txRole: 'funding',
      kind: 'broadcast',
      txid: inputs.fundingFinal.txid || null,
      wtxid: inputs.fundingFinal.wtxid || null,
      locktime: inputs.fundingFinal.locktime ?? null,
      inputs: Array.isArray(inputs.fundingPsbt?.funding?.selectedInputs)
        ? inputs.fundingPsbt.funding.selectedInputs.map(input => compactOutputRef(input.txid, input.vout, null, null, 'funding-input'))
        : [],
      outputs: inputs.fundingPsbt?.funding?.fundingOutpoint
        ? [
            compactOutputRef(
              inputs.fundingPsbt.funding.fundingOutpoint.txid,
              inputs.fundingPsbt.funding.fundingOutpoint.vout,
              inputs.fundingPsbt.funding.fundingOutpoint.valueSats,
              inputs.fundingPsbt.funding.fundingAddress || null,
              'funding-output'
            )
          ]
        : [],
      sourceArtifactKinds: ['m1_funding_psbt', 'm1_funding_finalized']
    });
  }

  const settlementContainer = inputs.cetSkeletons?.settlement || inputs.fundingPsbt?.settlement || null;
  if (settlementContainer) {
    for (const pathRecord of settlementContainer.paths || []) {
      transactions.push({
        txRole: pathRecord.pathId,
        kind: 'candidate-settlement',
        txid: pathRecord.txid || null,
        wtxid: null,
        locktime: pathRecord.locktime ?? null,
        spendsOutpoint: compactOutputRef(pathRecord.input?.txid, pathRecord.input?.vout, null, null, 'funding-output'),
        outputs: buildSettlementOutputs(pathRecord),
        sourceArtifactKinds: ['m1_cet_skeletons', 'm1_funding_psbt']
      });
    }

    if (settlementContainer.roll) {
      transactions.push({
        txRole: 'roll',
        kind: 'candidate-timeout',
        txid: settlementContainer.roll.txid || null,
        wtxid: null,
        locktime: settlementContainer.roll.locktime ?? null,
        spendsOutpoint: compactOutputRef(
          settlementContainer.roll.input?.txid,
          settlementContainer.roll.input?.vout,
          null,
          null,
          'funding-output'
        ),
        outputs: buildRollOutputs(settlementContainer.roll),
        sourceArtifactKinds: ['m1_cet_skeletons', 'm1_funding_psbt']
      });
    }
  }

  if (inputs.timeoutProof?.timeoutSpend?.txid) {
    transactions.push({
      txRole: 'timeout-proof-spend',
      kind: 'observed-timeout-spend',
      txid: inputs.timeoutProof.timeoutSpend.txid || null,
      wtxid: null,
      locktime: inputs.timeoutProof.timeoutSpend.locktime ?? null,
      spendsOutpoint: compactOutputRef(
        inputs.timeoutProof.fundingOutpoint?.fundingTxid,
        inputs.timeoutProof.fundingOutpoint?.fundingVout,
        inputs.timeoutProof.fundingOutpoint?.fundingValueSats,
        null,
        'funding-output'
      ),
      outputs: buildTimeoutOutputs(inputs.timeoutProof),
      sourceArtifactKinds: ['m1_expiry_timeout_testnet_proof']
    });
  }

  if (inputs.expiryArtifact?.deposit?.txid) {
    semanticRefs.push({
      refRole: 'expiry-deposit',
      txid: inputs.expiryArtifact.deposit.txid,
      amountSats: String(inputs.expiryArtifact.deposit.amountSats || ''),
      artifactKind: 'm1_expiry_redemption'
    });
  }
  if (inputs.expiryArtifact?.redemption) {
    semanticRefs.push({
      refRole: 'expiry-redemption-ledger',
      txid: inputs.expiryArtifact.redemption.txid || null,
      amountSats: String(inputs.expiryArtifact.redemption.amountSats || ''),
      settlementKind: inputs.expiryArtifact.redemption.settlementKind || null,
      artifactKind: 'm1_expiry_redemption'
    });
  }

  const index = {
    kind: 'm1_parallel_utxo_index',
    createdAt: new Date().toISOString(),
    chain: chain
      ? {
          chainId: inferChainIdFromLegacyChain(chain),
          network: chain.network || chain.chain || null,
          rpcUrl: chain.rpcUrl || null
        }
      : null,
    anchors: {
      fundingTxid: inputs.fundingFinal?.txid || inputs.fundingPsbt?.funding?.fundingOutpoint?.txid || null,
      fundingOutpoint: inputs.fundingPsbt?.funding?.fundingOutpoint || inputs.cetSkeletons?.fundingOutpoint || null,
      timeoutSpendTxid: inputs.timeoutProof?.timeoutSpend?.txid || null
    },
    transactions,
    semanticRefs,
    sourceArtifacts: {
      fundingPsbt: artifactMeta(FUNDING_PSBT_PATH, inputs.fundingPsbt),
      fundingFinal: artifactMeta(FUNDING_FINAL_PATH, inputs.fundingFinal),
      cetSkeletons: artifactMeta(CET_PATH, inputs.cetSkeletons),
      expiryRedemption: artifactMeta(EXPIRY_PATH, inputs.expiryArtifact),
      timeoutProof: artifactMeta(TIMEOUT_PROOF_PATH, inputs.timeoutProof)
    },
    artifactHash: null
  };

  index.artifactHash = sha256Hex(stringifyJson({
    ...index,
    artifactHash: null
  }));
  return index;
}

function loadLatestParallelUtxoIndexInputs() {
  return {
    fundingPsbt: loadJsonIfExists(FUNDING_PSBT_PATH),
    fundingFinal: loadJsonIfExists(FUNDING_FINAL_PATH),
    cetSkeletons: loadJsonIfExists(CET_PATH),
    expiryArtifact: loadJsonIfExists(EXPIRY_PATH),
    timeoutProof: loadJsonIfExists(TIMEOUT_PROOF_PATH)
  };
}

function writeParallelUtxoIndex(index, outPath = process.env.M1_PARALLEL_UTXO_INDEX_OUT_PATH || OUT_PATH) {
  fs.writeFileSync(outPath, stringifyJson(index, true));
  return outPath;
}

function run() {
  const inputs = loadLatestParallelUtxoIndexInputs();
  const index = buildParallelUtxoIndex(inputs);
  const outPath = writeParallelUtxoIndex(index);

  console.log('=== M1 Parallel UTXO Index ===');
  console.log(`chainId=${index.chain?.chainId || null}`);
  console.log(`transactions=${index.transactions.length}`);
  console.log(`semanticRefs=${index.semanticRefs.length}`);
  console.log(`fundingTxid=${index.anchors.fundingTxid}`);
  console.log(`timeoutSpendTxid=${index.anchors.timeoutSpendTxid}`);
  console.log(`artifactHash=${index.artifactHash}`);
  console.log(`artifactPath=${outPath}`);
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error('Parallel UTXO index generation failed:', err.message);
    process.exit(1);
  }
}

module.exports = {
  buildParallelUtxoIndex,
  loadLatestParallelUtxoIndexInputs,
  writeParallelUtxoIndex
};
