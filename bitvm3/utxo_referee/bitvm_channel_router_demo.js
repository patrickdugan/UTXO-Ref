#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  buildBitvmChannelRouterBundle,
  verifyBitvmChannelRouterBundle
} = require('./bitvm_channel_router');

const ARTIFACT_DIR = path.join(__dirname, 'artifacts');
const LEASE_PATH = path.join(ARTIFACT_DIR, 'lightning_liquidity_lease_latest.json');
const ARK_MANAGER_PATH = path.join(ARTIFACT_DIR, 'ark_liquidity_graft_manager_latest.json');
const TLUSD_PATCH_PATH = path.join(ARTIFACT_DIR, 'lnbtc_tlusd_liquidity_patch_latest.json');
const DLC_SUBSWAP_PATH = path.join(ARTIFACT_DIR, 'utxoref_dlc_subswap_funding_latest.json');
const JSON_OUT = path.join(ARTIFACT_DIR, 'bitvm_channel_router_latest.json');
const MD_OUT = path.join(ARTIFACT_DIR, 'bitvm_channel_router_latest.md');

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function renderMarkdown(bundle) {
  const { plan, walletView, verification } = bundle;
  return `# BitVM Channel Router

Created: ${bundle.createdAt}

## Router View

- Status: ${walletView.status}
- Router id: \`${plan.routerId}\`
- Route intent id: \`${walletView.routeIntentId}\`
- Target amount: ${walletView.targetAmountSats} sats
- Assigned amount: ${walletView.assignedSats} sats
- Shortfall: ${walletView.shortfallSats} sats
- Max fee: ${walletView.maxFeePpm} ppm
- Max CLTV delta: ${walletView.maxCltvDelta}
- Verification: ${verification.ok ? 'ok' : verification.reason}

## Selected Shards

${walletView.selectedChannels
  .map(
    channel => `### ${channel.routeId}

- Source: ${channel.sourceType}
- Channel id: \`${channel.channelId}\`
- Assigned: ${channel.assignedSats} sats
- Fee: ${channel.feePpm} ppm
- CLTV delta: ${channel.cltvDelta}
- Status: ${channel.status}
`
  )
  .join('\n')}

## Skipped Slashable Channels

${walletView.skippedSlashable.length
  ? walletView.skippedSlashable
      .map(
        channel => `- ${channel.routeId}: \`${channel.channelId}\` (${channel.challengeRefs.join(', ') || 'no challenge refs'})`
      )
      .join('\n')
  : '- none'}

## Automation Queue

### Preflight

${plan.automation.preflight.map(item => `- ${item}`).join('\n')}

### Execute

${plan.automation.execute
  .map(
    item => `- ${item.action}: ${item.assignedSats} sats on \`${item.routeId}\` via \`${item.channelId}\``
  )
  .join('\n')}

### Monitor

${plan.automation.monitor.map(item => `- ${item}`).join('\n')}

## Jurassic Motif Use

- Transcript multiplicity: ${plan.jurassicMotifRouter.transcriptMultiplicity}
- Identifier bifurcation: ${plan.jurassicMotifRouter.identifierBifurcation}
- Carrier camouflage: ${plan.jurassicMotifRouter.carrierCamouflage}

## What This Automates

The router does not replace Lightning pathfinding. It automates the UTXORef side
of route selection: which BitVM-backed channel, Ark graft, Taproot Asset-backed
patch, or DLC funding rail should be reserved, verified, monitored, and
challenged if the promised route observation fails.
`;
}

function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const sources = {
    liquidityLease: readJsonIfPresent(LEASE_PATH),
    arkManager: readJsonIfPresent(ARK_MANAGER_PATH),
    tlusdPatch: readJsonIfPresent(TLUSD_PATCH_PATH),
    dlcSubswapFunding: readJsonIfPresent(DLC_SUBSWAP_PATH)
  };
  const bundle = buildBitvmChannelRouterBundle({
    sources,
    routeIntent: {
      intentId: 'bitvm-router-demo-120k',
      amountSats: process.env.BITVM_ROUTER_AMOUNT_SATS || '120000',
      maxFeePpm: Number(process.env.BITVM_ROUTER_MAX_FEE_PPM || 1200),
      maxCltvDelta: Number(process.env.BITVM_ROUTER_MAX_CLTV_DELTA || 45),
      destinationNodeId: process.env.BITVM_ROUTER_DESTINATION || 'ldk-router-destination-regtest'
    },
    policy: {
      excludeSlashable: true,
      allowFundingFallback: false,
      minShardSats: process.env.BITVM_ROUTER_MIN_SHARD_SATS || '1000'
    }
  });
  const verification = verifyBitvmChannelRouterBundle(bundle);
  const artifact = { ...bundle, verification };

  fs.writeFileSync(JSON_OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(MD_OUT, renderMarkdown(artifact));
  console.log(`Wrote ${JSON_OUT}`);
  console.log(`Wrote ${MD_OUT}`);
  console.log(`verification=${verification.ok ? 'ok' : verification.reason}`);
}

if (require.main === module) {
  main();
}
