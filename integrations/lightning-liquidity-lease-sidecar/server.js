#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const artifactDir = path.join(repoRoot, 'bitvm3', 'utxo_referee', 'artifacts');
const leasePath = path.join(artifactDir, 'lightning_liquidity_lease_latest.json');
const subswapPath = path.join(artifactDir, 'lightning_subswap_dlc_latest.json');
const stablecoinPath = path.join(artifactDir, 'lightning_taproot_assets_stablecoin_latest.json');
const arkGraftPath = path.join(artifactDir, 'lightning_ark_liquidity_graft_latest.json');
const arkGovernorBenchPath = path.join(artifactDir, 'ark_liquidity_governor_bench_latest.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function walletView(lease, subswap) {
  const bundle = lease.verification ? lease : { ...lease, verification: { ok: true } };
  return {
    kind: 'wallet_liquidity_lease_view',
    status: bundle.verification.ok ? 'verified' : 'needs_attention',
    title: 'Inbound Liquidity Lease',
    subtitle: `${bundle.offer.terms.promisedInboundSats} sats for ${bundle.offer.terms.leaseBlocks} blocks`,
    amountSats: bundle.offer.terms.promisedInboundSats,
    maxFeePpm: bundle.offer.terms.maxFeePpm,
    maxCltvDelta: bundle.offer.terms.maxCltvDelta,
    penaltySats: bundle.offer.terms.penaltySats,
    paymentHashHex: bundle.offer.terms.paymentHashHex,
    leaseOfferId: bundle.offer.offerId,
    successEvidenceId: bundle.successEvidence.evidenceId,
    channelOutpoint: bundle.successEvidence.evidenceCore.channelOutpoint,
    fundingCommitmentHash: bundle.successEvidence.evidenceCore.fundingCommitmentHash,
    htlc: {
      swapFundingTxid: subswap && subswap.swap && subswap.swap.fundingTxid,
      claimTxid: subswap && subswap.dlcFunding && subswap.dlcFunding.claimTxid,
      refundTxid: subswap && subswap.refundPath && subswap.refundPath.refundTxid
    },
    actions: [
      { id: 'verify_success', label: 'Verify lease evidence' },
      { id: 'prepare_challenge', label: 'Prepare challenge' },
      { id: 'show_htlc', label: 'Show HTLC proof' }
    ]
  };
}

function stablecoinWalletView(stablecoin, lease, subswap) {
  const bundle = stablecoin.verification ? stablecoin : { ...stablecoin, verification: { ok: true } };
  const quote = bundle.rfqQuote.quoteCore;
  const asset = bundle.asset.descriptorCore;
  const settlement = bundle.settlementEvidence.settlementCore;
  return {
    kind: 'wallet_taproot_assets_stablecoin_view',
    status: bundle.verification.ok ? 'verified' : 'needs_attention',
    title: `${asset.ticker} Lightning Stablecoin RFQ`,
    subtitle: `${quote.assetAmountUnits} units routes as ${quote.btcRouteSats} sats over Lightning`,
    assetTicker: asset.ticker,
    assetId: asset.assetId,
    assetAmountUnits: quote.assetAmountUnits,
    decimalDisplay: asset.decimalDisplay,
    edgeNodeId: quote.edgeNodeId,
    quoteId: bundle.rfqQuote.quoteId,
    maxSpreadPpm: quote.maxSpreadPpm,
    quotedSpreadPpm: quote.quotedSpreadPpm,
    maxRoutingFeePpm: quote.maxRoutingFeePpm,
    quotedRoutingFeePpm: quote.quotedRoutingFeePpm,
    btcRouteSats: quote.btcRouteSats,
    deliveredBtcSats: settlement.deliveredBtcSats,
    paymentHashHex: quote.paymentHashHex,
    assetProofId: bundle.assetProof.proofId,
    universeRoot: bundle.assetProof.proofCore.universeRoot,
    anchorOutpoint: bundle.assetProof.proofCore.anchorOutpoint,
    liquidityLeaseBundleId: settlement.liquidityLeaseBundleId,
    channelOutpoint: settlement.channelOrSpliceOutpoint,
    htlc: {
      swapFundingTxid: subswap && subswap.swap && subswap.swap.fundingTxid,
      claimTxid: subswap && subswap.dlcFunding && subswap.dlcFunding.claimTxid,
      refundTxid: subswap && subswap.refundPath && subswap.refundPath.refundTxid
    },
    checks: bundle.settlementEvidence.checks,
    actions: [
      { id: 'verify_stablecoin_rfq', label: 'Verify RFQ settlement' },
      { id: 'show_asset_proof', label: 'Show Taproot Asset proof' },
      { id: 'prepare_stablecoin_challenge', label: 'Prepare challenge' }
    ],
    linkedLiquidityLease: walletView(lease, subswap)
  };
}

function arkGraftWalletView(arkGraft, lease, subswap) {
  const bundle = arkGraft.verification ? arkGraft : { ...arkGraft, verification: { ok: true } };
  const template = bundle.template.templateCore;
  const vtxo = bundle.vtxo.vtxoCore;
  const quote = bundle.quote.quoteCore;
  const settlement = bundle.settlementEvidence.settlementCore;
  const cost = bundle.costModel && bundle.costModel.modelCore;
  return {
    kind: 'wallet_ark_liquidity_graft_view',
    status: bundle.verification.ok ? 'verified' : 'needs_attention',
    title: 'Ark LN Liquidity Graft',
    subtitle: `${vtxo.vtxoAmountSats} sats Ark VTXO grafted into ${quote.promisedInboundSats} sats LN inbound`,
    aspId: template.aspId,
    templateId: template.templateId,
    taprootOutputKey: template.taprootOutputKey,
    vtxoId: vtxo.vtxoId,
    vtxoCommitmentId: bundle.vtxo.vtxoCommitmentId,
    vtxoAmountSats: vtxo.vtxoAmountSats,
    aspRoundId: vtxo.aspRoundId,
    connectorOutpoint: vtxo.connectorOutpoint,
    exitTxid: vtxo.exitTxid,
    forfeitTxid: vtxo.forfeitTxid,
    quoteId: bundle.quote.quoteId,
    promisedInboundSats: quote.promisedInboundSats,
    deliveredInboundSats: settlement.deliveredInboundSats,
    maxFeePpm: quote.maxFeePpm,
    maxCltvDelta: quote.maxCltvDelta,
    paymentHashHex: quote.paymentHashHex,
    liquidityLeaseBundleId: settlement.liquidityLeaseBundleId,
    channelOutpoint: settlement.channelOrSpliceOutpoint,
    lnClaimTxid: settlement.lnClaimTxid,
    costModel: cost && {
      graftCount: cost.graftCount,
      graftAmountSats: cost.graftAmountSats,
      feeRateSatVb: cost.feeRateSatVb,
      baselinePerGraftSats: cost.baseline.perGraftSats,
      arkPerGraftSats: cost.ark.perGraftSats,
      baselineTotalSats: cost.baseline.totalSats,
      arkTotalSats: cost.ark.totalSats,
      savingsSats: cost.comparison.savingsSats,
      savingsBps: cost.comparison.savingsBps,
      breakEvenGrafts: cost.comparison.breakEvenGrafts,
      saferMarginalCost: cost.comparison.saferMarginalCost,
      lowerTotalCost: cost.comparison.lowerTotalCost
    },
    htlc: {
      swapFundingTxid: subswap && subswap.swap && subswap.swap.fundingTxid,
      claimTxid: subswap && subswap.dlcFunding && subswap.dlcFunding.claimTxid,
      refundTxid: subswap && subswap.refundPath && subswap.refundPath.refundTxid
    },
    checks: bundle.settlementEvidence.checks,
    actions: [
      { id: 'verify_ark_graft', label: 'Verify Ark graft' },
      { id: 'show_ark_vtxo', label: 'Show Ark VTXO proof' },
      { id: 'prepare_ark_graft_challenge', label: 'Prepare challenge' }
    ],
    linkedLiquidityLease: walletView(lease, subswap)
  };
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { ok: true, service: 'utxoref-liquidity-lease-sidecar' });
    }

    if (req.method === 'GET' && req.url === '/v1/liquidity-lease/latest') {
      return sendJson(res, 200, readJson(leasePath));
    }

    if (req.method === 'GET' && req.url === '/v1/liquidity-lease/wallet-view') {
      return sendJson(res, 200, walletView(readJson(leasePath), readJson(subswapPath)));
    }

    if (req.method === 'GET' && req.url === '/v1/taproot-assets-stablecoin/latest') {
      return sendJson(res, 200, readJson(stablecoinPath));
    }

    if (req.method === 'GET' && req.url === '/v1/taproot-assets-stablecoin/wallet-view') {
      return sendJson(
        res,
        200,
        stablecoinWalletView(readJson(stablecoinPath), readJson(leasePath), readJson(subswapPath))
      );
    }

    if (req.method === 'GET' && req.url === '/v1/ark-liquidity-graft/latest') {
      return sendJson(res, 200, readJson(arkGraftPath));
    }

    if (req.method === 'GET' && req.url === '/v1/ark-liquidity-graft/wallet-view') {
      return sendJson(
        res,
        200,
        arkGraftWalletView(readJson(arkGraftPath), readJson(leasePath), readJson(subswapPath))
      );
    }

    if (req.method === 'GET' && req.url === '/v1/ark-liquidity-graft/governor-bench/latest') {
      return sendJson(res, 200, readJson(arkGovernorBenchPath));
    }

    if (req.method === 'GET' && req.url === '/v1/liquidity-lease/subswap-proof') {
      return sendJson(res, 200, readJson(subswapPath));
    }

    if (req.method === 'POST' && req.url === '/v1/liquidity-lease/quote') {
      const body = await readBody(req);
      const lease = readJson(leasePath);
      return sendJson(res, 200, {
        kind: 'liquidity_lease_quote',
        requestedInboundSats: String(body.requestedInboundSats || lease.offer.terms.promisedInboundSats),
        leaseBlocks: Number(body.leaseBlocks || lease.offer.terms.leaseBlocks),
        maxFeePpm: Number(body.maxFeePpm || lease.offer.terms.maxFeePpm),
        maxCltvDelta: Number(body.maxCltvDelta || lease.offer.terms.maxCltvDelta),
        estimatedPremiumSats: lease.offer.terms.leasePremiumSats,
        penaltySats: lease.offer.terms.penaltySats,
        paymentHashHex: lease.offer.terms.paymentHashHex,
        source: 'latest-regtest-artifact'
      });
    }

    if (req.method === 'POST' && req.url === '/v1/liquidity-lease/verify') {
      const lease = readJson(leasePath);
      return sendJson(res, 200, {
        ok: Boolean(lease.verification && lease.verification.ok),
        reason: lease.verification && lease.verification.reason,
        offerId: lease.offer.offerId,
        successEvidenceId: lease.successEvidence.evidenceId,
        checks: lease.successEvidence.checks
      });
    }

    if (req.method === 'POST' && req.url === '/v1/liquidity-lease/challenge') {
      const lease = readJson(leasePath);
      return sendJson(res, 200, {
        slashable: lease.challengeEvidence.slashable,
        challengeId: lease.challengeEvidence.challengeId,
        penaltyClaim: lease.challengeEvidence.penaltyClaim,
        violations: lease.challengeEvidence.challengeCore.violations
      });
    }

    if (req.method === 'POST' && req.url === '/v1/taproot-assets-stablecoin/verify') {
      const stablecoin = readJson(stablecoinPath);
      return sendJson(res, 200, {
        ok: Boolean(stablecoin.verification && stablecoin.verification.ok),
        reason: stablecoin.verification && stablecoin.verification.reason,
        quoteId: stablecoin.rfqQuote.quoteId,
        settlementId: stablecoin.settlementEvidence.settlementId,
        checks: stablecoin.settlementEvidence.checks
      });
    }

    if (req.method === 'POST' && req.url === '/v1/taproot-assets-stablecoin/challenge') {
      const stablecoin = readJson(stablecoinPath);
      return sendJson(res, 200, {
        slashable: stablecoin.challengeEvidence.slashable,
        challengeId: stablecoin.challengeEvidence.challengeId,
        violations: stablecoin.challengeEvidence.challengeCore.violations
      });
    }

    if (req.method === 'POST' && req.url === '/v1/ark-liquidity-graft/verify') {
      const arkGraft = readJson(arkGraftPath);
      return sendJson(res, 200, {
        ok: Boolean(arkGraft.verification && arkGraft.verification.ok),
        reason: arkGraft.verification && arkGraft.verification.reason,
        quoteId: arkGraft.quote.quoteId,
        settlementId: arkGraft.settlementEvidence.settlementId,
        vtxoCommitmentId: arkGraft.vtxo.vtxoCommitmentId,
        costModelId: arkGraft.costModel && arkGraft.costModel.modelId,
        costComparison: arkGraft.costModel && arkGraft.costModel.modelCore.comparison,
        checks: arkGraft.settlementEvidence.checks
      });
    }

    if (req.method === 'POST' && req.url === '/v1/ark-liquidity-graft/challenge') {
      const arkGraft = readJson(arkGraftPath);
      return sendJson(res, 200, {
        slashable: arkGraft.challengeEvidence.slashable,
        challengeId: arkGraft.challengeEvidence.challengeId,
        violations: arkGraft.challengeEvidence.challengeCore.violations
      });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

const port = Number(process.env.PORT || 8787);
const server = http.createServer((req, res) => {
  handle(req, res);
});

if (require.main === module) {
  server.listen(port, '127.0.0.1', () => {
    console.log(`liquidity lease sidecar listening on http://127.0.0.1:${port}`);
  });
}

module.exports = {
  walletView,
  stablecoinWalletView,
  arkGraftWalletView,
  handle,
  server
};
