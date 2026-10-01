#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  buildLiquidityLeaseBundle,
  verifyLiquidityLeaseBundle
} = require('./lightning_liquidity_lease');

const ARTIFACT_DIR = path.join(__dirname, 'artifacts');
const SUBSWAP_PATH = path.join(ARTIFACT_DIR, 'lightning_subswap_dlc_latest.json');
const JSON_OUT = path.join(ARTIFACT_DIR, 'lightning_liquidity_lease_latest.json');
const MD_OUT = path.join(ARTIFACT_DIR, 'lightning_liquidity_lease_latest.md');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function renderMarkdown(bundle, verification) {
  return `# BitVM-Backed Lightning Liquidity Lease

## Thesis

Use BitVM/HTLC funding not to run Lightning, but to make a liquidity promise
enforceable: the LSP earns the lease premium only if the promised channel or
splice liquidity appears with the agreed fee and CLTV limits.

## Lease Offer

- Bundle id: \`${bundle.bundleId}\`
- Offer id: \`${bundle.offer.offerId}\`
- Payment hash: \`${bundle.offer.terms.paymentHashHex}\`
- Promised inbound: ${bundle.offer.terms.promisedInboundSats} sats
- Lease window: ${bundle.offer.terms.leaseBlocks} blocks
- Max fee: ${bundle.offer.terms.maxFeePpm} ppm
- Max CLTV delta: ${bundle.offer.terms.maxCltvDelta}
- Penalty: ${bundle.offer.terms.penaltySats} sats
- Verification: ${verification.ok ? 'ok' : verification.reason}

## Success Evidence

- Evidence id: \`${bundle.successEvidence.evidenceId}\`
- Channel/splice outpoint: \`${bundle.successEvidence.evidenceCore.channelOutpoint}\`
- Funding commitment hash: \`${bundle.successEvidence.evidenceCore.fundingCommitmentHash}\`
- Observed inbound: ${bundle.successEvidence.evidenceCore.observedInboundSats} sats
- Observed fee: ${bundle.successEvidence.evidenceCore.observedFeePpm} ppm

## Challenge Evidence

- Challenge id: \`${bundle.challengeEvidence.challengeId}\`
- Slashable: ${bundle.challengeEvidence.slashable}
- Violations: ${bundle.challengeEvidence.challengeCore.violations.join(', ')}
- Penalty reason: ${bundle.challengeEvidence.penaltyClaim.reason}

## Routing Use Cases

${bundle.routingUseCases.map(item => `- ${item}`).join('\n')}

## Caveats

${bundle.caveats.map(item => `- ${item}`).join('\n')}
`;
}

function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const htlcProof = readJson(SUBSWAP_PATH);
  const bundle = buildLiquidityLeaseBundle({
    htlcProof,
    leaseId: `lease-${htlcProof.lightning.label}`,
    lspNodeId: 'ldk-lsp-regtest',
    clientNodeId: 'utxoref-client-regtest',
    promisedInboundSats: BigInt(htlcProof.dlcFunding.outputAmountSats),
    leaseBlocks: 144,
    maxFeePpm: 1000,
    maxCltvDelta: 40,
    penaltySats: 5000n,
    leasePremiumSats: 1000n,
    observedInboundSats: BigInt(htlcProof.dlcFunding.outputAmountSats),
    observedFeePpm: 900,
    observedCltvDelta: 34,
    observedAtBlock: htlcProof.refundPath.chainHeightAtRefund,
    challengeObservedInboundSats: 0n,
    challengeObservedFeePpm: 2500,
    challengeObservedCltvDelta: 80
  });
  const verification = verifyLiquidityLeaseBundle(bundle);

  fs.writeFileSync(JSON_OUT, `${JSON.stringify({ ...bundle, verification }, null, 2)}\n`);
  fs.writeFileSync(MD_OUT, renderMarkdown(bundle, verification));
  console.log(`Wrote ${JSON_OUT}`);
  console.log(`Wrote ${MD_OUT}`);
}

if (require.main === module) {
  main();
}
