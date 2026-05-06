#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { buildSpiralLdkValueAddBrief } = require('./spiral_ldk_value_add');

const ARTIFACT_DIR = path.join(__dirname, 'artifacts');
const CLN_RECEIPT_PATH = path.join(ARTIFACT_DIR, 'cln_regtest_demo_latest.json');
const JSON_PATH = path.join(ARTIFACT_DIR, 'spiral_ldk_value_add_latest.json');
const MD_PATH = path.join(ARTIFACT_DIR, 'spiral_ldk_value_add_latest.md');

function maybeLoadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function renderMarkdown(brief) {
  const adapter = brief.adapter;
  const live = adapter.liveClnReceipt;
  return `# Spiral / LDK Value-Add Brief

Created: ${brief.createdAt}

## Thesis

${brief.thesis}

## Prototype Adapter

- Adapter id: \`${adapter.adapterId}\`
- Target surface: ${adapter.ldkContributionCore.targetSurface}
- Contract transcript id: \`${adapter.ldkContributionCore.contractTranscriptId}\`
- Funding output commitment: \`${adapter.ldkContributionCore.fundingOutputCommitmentHash}\`
- Lightning payment hash: \`${adapter.ldkContributionCore.lightningPaymentHashHex}\`
- VSS key: \`${adapter.vssRecord.key}\`
- Verification: ${brief.verification.ok ? 'ok' : brief.verification.reason}

${live ? `## Bound Live CLN Receipt

- Network: ${live.network}
- Channel txid: \`${live.channelTxid}\`
- Channel amount: ${live.channelAmountSats} sats
- Invoice amount: ${live.invoiceAmount}
- Payment status: ${live.status}
- Payment preimage: \`${live.paymentPreimageHex}\`
` : `## Bound Live CLN Receipt

- No live CLN receipt artifact was found; using deterministic prototype receipt data.
`}

## Public Commit Evidence

${brief.evidence.map(item => `- ${item.repo} ${item.commit}: [${item.subject}](${item.url})`).join('\n')}

## Proposed Milestones

${brief.proposedMilestones.map(item => `- ${item.name}: ${item.deliverable}`).join('\n')}

## Boundary

${brief.pitchBoundary.map(item => `- ${item}`).join('\n')}
`;
}

function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const liveClnReceipt = maybeLoadJson(CLN_RECEIPT_PATH);
  const brief = buildSpiralLdkValueAddBrief({
    createdAt: new Date().toISOString(),
    liveClnReceipt
  });

  fs.writeFileSync(JSON_PATH, `${JSON.stringify(brief, null, 2)}\n`);
  fs.writeFileSync(MD_PATH, renderMarkdown(brief));
  console.log(`Wrote ${JSON_PATH}`);
  console.log(`Wrote ${MD_PATH}`);
}

if (require.main === module) {
  main();
}
