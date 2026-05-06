#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  buildWalletIntegrationManifest,
  verifyWalletIntegrationManifest
} = require('./lightning_wallet_integration');

const ARTIFACT_DIR = path.join(__dirname, 'artifacts');
const LEASE_PATH = path.join(ARTIFACT_DIR, 'lightning_liquidity_lease_latest.json');
const SUBSWAP_PATH = path.join(ARTIFACT_DIR, 'lightning_subswap_dlc_latest.json');
const JSON_OUT = path.join(ARTIFACT_DIR, 'lightning_wallet_integration_latest.json');
const MD_OUT = path.join(ARTIFACT_DIR, 'lightning_wallet_integration_latest.md');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function renderMarkdown(manifest, verification) {
  return `# Wallet Integration Manifest

## Status

- Manifest id: \`${manifest.manifestId}\`
- Verification: ${verification.ok ? 'ok' : verification.reason}
- Wallet status: ${manifest.walletView.status}
- Inbound liquidity: ${manifest.walletView.amountSats} sats
- Channel/splice outpoint: \`${manifest.walletView.channelOutpoint}\`
- Payment hash: \`${manifest.walletView.paymentHashHex}\`

## LDK Server Target

- Target repo: ${manifest.ldkServer.target}
- Mode: ${manifest.ldkServer.integrationMode}
- Proto: \`${manifest.ldkServer.protoFile}\`
- Methods: ${manifest.ldkServer.methods.join(', ')}

## ZEUS Target

- Target repo: ${manifest.zeus.target}
- Mode: ${manifest.zeus.integrationMode}
- Screen: \`${manifest.zeus.screenFile}\`
- Client: \`${manifest.zeus.clientFile}\`

## Sidecar

Run:

\`\`\`bash
node integrations/lightning-liquidity-lease-sidecar/server.js
\`\`\`

Then open:

\`\`\`text
http://127.0.0.1:8787/v1/liquidity-lease/wallet-view
\`\`\`
`;
}

function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const leaseBundle = readJson(LEASE_PATH);
  const subswapProof = readJson(SUBSWAP_PATH);
  const manifest = buildWalletIntegrationManifest({ leaseBundle, subswapProof });
  const verification = verifyWalletIntegrationManifest(manifest);

  fs.writeFileSync(JSON_OUT, `${JSON.stringify({ ...manifest, verification }, null, 2)}\n`);
  fs.writeFileSync(MD_OUT, renderMarkdown(manifest, verification));
  console.log(`Wrote ${JSON_OUT}`);
  console.log(`Wrote ${MD_OUT}`);
}

if (require.main === module) {
  main();
}
