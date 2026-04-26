#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  buildLnBtcTlUsdLiquidityPatchBundle,
  verifyLnBtcTlUsdLiquidityPatchBundle
} = require('./lnbtc_tlusd_liquidity_patch');

const ARTIFACT_DIR = path.join(__dirname, 'artifacts');
const LEASE_PATH = path.join(ARTIFACT_DIR, 'lightning_liquidity_lease_latest.json');
const SUBSWAP_PATH = path.join(ARTIFACT_DIR, 'lightning_subswap_dlc_latest.json');
const JSON_OUT = path.join(ARTIFACT_DIR, 'lnbtc_tlusd_liquidity_patch_latest.json');
const MD_OUT = path.join(ARTIFACT_DIR, 'lnbtc_tlusd_liquidity_patch_latest.md');

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function renderMarkdown(bundle, verification) {
  const conversion = bundle.conversion.conversionCore;
  const asset = bundle.conversion.stablecoin.asset.descriptorCore;
  const stake = bundle.stake.stakeCore;
  const manager = bundle.mandate.manager;
  const totals = manager.allocation.totals;
  const challenge = manager.challengeEvidence;
  const cost = manager.costModel.modelCore;
  return `# LN-BTC to tlUSD Liquidity Patch

## Thesis

${bundle.thesis}

This is the end-to-end story: a wallet starts with LN-BTC, funds UTXORef through
the submarine-swap-shaped proof, externalizes the position as BTC-based tlUSD,
then stakes that tlUSD into an Ark-managed Lightning liquidity patching pool.
BitVM/UTXORef remains the enforcement layer if the ASP/LSP path fails.

## LN-BTC to tlUSD

- Conversion id: \`${bundle.conversion.conversionId}\`
- LN-BTC input: ${conversion.lnbtcSats} sats
- BTC/USD oracle price: ${conversion.btcUsdPriceMicros} micro-USD/BTC
- tlUSD units: ${conversion.tlusdUnits}
- Asset ticker: ${asset.ticker}
- Asset id: \`${asset.assetId}\`
- RFQ quote: \`${conversion.rfqQuoteId}\`
- Settlement: \`${conversion.settlementId}\`
- Subswap funding txid: \`${conversion.subswapFundingTxid}\`
- DLC/UTXORef funding txid: \`${conversion.dlcFundingTxid}\`

## tlUSD Stake

- Stake commitment: \`${bundle.stake.stakeCommitmentId}\`
- Pool: ${stake.poolId}
- Owner node: ${stake.ownerNodeId}
- Staked tlUSD units: ${stake.stakedTlUsdUnits}
- Routing notional: ${stake.routingNotionalSats} sats
- Lock: ${stake.lockBlocks} blocks
- Target yield: ${stake.targetYieldPpm} ppm
- Slash reserve: ${stake.slashReserveUnits} tlUSD units
- Reward source: ${stake.rewardSource}

## Ark Liquidity Patch Manager

- Manager bundle: \`${manager.bundleId}\`
- Policy id: \`${manager.policy.policyId}\`
- Allocation id: \`${manager.allocation.allocationId}\`
- Requested inbound: ${totals.requestedInboundSats} sats
- Assigned inbound: ${totals.assignedInboundSats} sats
- Delivered inbound: ${totals.deliveredInboundSats} sats
- Settled assignments: ${totals.settledAssignments}
- Slashable assignments: ${totals.slashableAssignments}

${manager.allocation.assignments
  .map(
    assignment => `### ${assignment.assignmentCore.routeId}

- Status: ${assignment.assignmentCore.status}
- Promised inbound: ${assignment.assignmentCore.promisedInboundSats} sats
- Delivered inbound: ${assignment.assignmentCore.deliveredInboundSats} sats
- Quote: \`${assignment.quote.quoteId}\`
- Challengeable: ${assignment.challengeEvidence.slashable}
- Violations: ${assignment.challengeEvidence.challengeCore.violations.join(', ') || 'none'}
`
  )
  .join('\n')}

## Enforcement

- Manager challenge: \`${challenge.challengeId}\`
- Slashable: ${challenge.slashable}
- Violations: ${challenge.challengeCore.violations.join(', ') || 'none'}
- Remedy: ${challenge.remedy}

## Marginal Routing Cost

- Baseline per graft: ${cost.baseline.perGraftSats} sats
- Ark per graft: ${cost.ark.perGraftSats} sats
- Baseline total: ${cost.baseline.totalSats} sats
- Ark total: ${cost.ark.totalSats} sats
- Savings: ${cost.comparison.savingsSats} sats
- Safer marginal cost: ${cost.comparison.saferMarginalCost}

## Verification

- Result: ${verification.ok ? 'ok' : verification.reason}

## Caveats

${bundle.caveats.map(item => `- ${item}`).join('\n')}
`;
}

function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const liquidityLease = readJsonIfPresent(LEASE_PATH);
  const htlcProof = readJsonIfPresent(SUBSWAP_PATH);

  const lnbtcSats =
    htlcProof && htlcProof.dlcFunding && htlcProof.dlcFunding.outputAmountSats
      ? BigInt(htlcProof.dlcFunding.outputAmountSats)
      : 50000n;
  const bundle = buildLnBtcTlUsdLiquidityPatchBundle({
    htlcProof,
    liquidityLease,
    lnbtcSats,
    btcUsdPriceMicros: 100000000000n,
    stakedTlUsdUnits: 40000000n,
    routingNotionalSats: 40000n,
    lockBlocks: 1008,
    targetYieldPpm: 4200,
    routeIntents: [
      {
        routeId: 'tlusd-edge-a-patch',
        edgeNodeId: 'ldk-tlusd-edge-a',
        requestedInboundSats: 30000n,
        priority: 3,
        maxFeePpm: 900
      },
      {
        routeId: 'tlusd-edge-b-patch',
        edgeNodeId: 'ldk-tlusd-edge-b',
        requestedInboundSats: 10000n,
        priority: 2,
        maxFeePpm: 1000
      }
    ],
    routeObservations: [
      {
        routeId: 'tlusd-edge-b-patch',
        deliveredInboundSats: 6000n,
        observedFeePpm: 1500,
        observedCltvDelta: 60,
        missingForfeitPath: true
      }
    ],
    vtxoAmountsSats: [30000n, 10000n, 10000n],
    maxAspExposureSats: 160000n,
    bitvmChallengeReserveSats: 25000n
  });
  const verification = verifyLnBtcTlUsdLiquidityPatchBundle(bundle);
  const artifact = { ...bundle, verification };

  fs.writeFileSync(JSON_OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(MD_OUT, renderMarkdown(bundle, verification));
  console.log(`Wrote ${JSON_OUT}`);
  console.log(`Wrote ${MD_OUT}`);
}

if (require.main === module) {
  main();
}
