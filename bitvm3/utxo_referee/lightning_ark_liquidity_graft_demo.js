#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  buildArkLiquidityGraftBundle,
  verifyArkLiquidityGraftBundle
} = require('./lightning_ark_liquidity_graft');

const ARTIFACT_DIR = path.join(__dirname, 'artifacts');
const LEASE_PATH = path.join(ARTIFACT_DIR, 'lightning_liquidity_lease_latest.json');
const SUBSWAP_PATH = path.join(ARTIFACT_DIR, 'lightning_subswap_dlc_latest.json');
const JSON_OUT = path.join(ARTIFACT_DIR, 'lightning_ark_liquidity_graft_latest.json');
const MD_OUT = path.join(ARTIFACT_DIR, 'lightning_ark_liquidity_graft_latest.md');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function renderMarkdown(bundle, verification) {
  const t = bundle.template.templateCore;
  const v = bundle.vtxo.vtxoCore;
  const q = bundle.quote.quoteCore;
  const s = bundle.settlementEvidence.settlementCore;
  const c = bundle.costModel.modelCore;
  return `# Ark-Assisted LN Liquidity Graft With BitVM Enforcement

## Thesis

${bundle.thesis}

The Ark VTXO is used as a fast liquidity graft for an LN edge route. The
existing BitVM/DLC lease remains the challengeable enforcement layer.

## Ark Template

- ASP: ${t.aspId}
- Template id: ${t.templateId}
- Template commitment: \`${bundle.template.templateCommitmentId}\`
- Taproot output key: \`${t.taprootOutputKey}\`
- Leaf roles: ${t.leafRoles.join(', ')}
- Exit delay: ${t.exitDelayBlocks} blocks
- ASP forfeit CSV: ${t.aspForfeitCsv}

## Ark VTXO Liquidity

- VTXO commitment: \`${bundle.vtxo.vtxoCommitmentId}\`
- VTXO id: \`${v.vtxoId}\`
- Amount: ${v.vtxoAmountSats} sats
- Round id: ${v.aspRoundId}
- Connector: \`${v.connectorOutpoint}\`
- Exit txid: \`${v.exitTxid}\`
- Forfeit txid: \`${v.forfeitTxid}\`

## LN Graft Quote

- Quote id: \`${bundle.quote.quoteId}\`
- Promised inbound: ${q.promisedInboundSats} sats
- Lease window: ${q.leaseBlocks} blocks
- Max fee: ${q.maxFeePpm} ppm
- Max CLTV delta: ${q.maxCltvDelta}
- Premium: ${q.graftPremiumSats} sats
- Payment hash: \`${q.paymentHashHex}\`

## Settlement Evidence

- Settlement id: \`${bundle.settlementEvidence.settlementId}\`
- Delivered inbound: ${s.deliveredInboundSats} sats
- LN claim txid: \`${s.lnClaimTxid}\`
- Channel/splice outpoint: \`${s.channelOrSpliceOutpoint}\`
- BitVM lease bundle: \`${s.liquidityLeaseBundleId}\`
- Verification: ${verification.ok ? 'ok' : verification.reason}

## Marginal Cost Model

- Grafts modeled: ${c.graftCount}
- Graft amount: ${c.graftAmountSats} sats
- Fee rate: ${c.feeRateSatVb} sat/vB
- Baseline per graft: ${c.baseline.perGraftSats} sats
- Ark per graft: ${c.ark.perGraftSats} sats
- Baseline total: ${c.baseline.totalSats} sats
- Ark total: ${c.ark.totalSats} sats
- Savings: ${c.comparison.savingsSats} sats (${c.comparison.savingsBps / 100}%)
- Break-even graft count: ${c.comparison.breakEvenGrafts}
- Safer marginal cost: ${c.comparison.saferMarginalCost}

## Checks

${Object.entries(bundle.settlementEvidence.checks)
  .map(([name, ok]) => `- ${name}: ${ok}`)
  .join('\n')}

## Challenge Case

- Challenge id: \`${bundle.challengeEvidence.challengeId}\`
- Slashable: ${bundle.challengeEvidence.slashable}
- Violations: ${bundle.challengeEvidence.challengeCore.violations.join(', ')}

## Caveats

${bundle.caveats.map(item => `- ${item}`).join('\n')}

## References

${bundle.references.map(item => `- ${item}`).join('\n')}
`;
}

function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const liquidityLease = readJson(LEASE_PATH);
  const htlcProof = readJson(SUBSWAP_PATH);
  const paymentHashHex = htlcProof.lightning.paymentHashHex;

  const bundle = buildArkLiquidityGraftBundle({
    aspId: 'ark-asp-regtest',
    templateId: 'ark-template-ln-graft-v1',
    ownerNodeId: 'ldk-edge-liquidity-node',
    aspRoundId: 'ark-round-regtest-liquidity-1',
    vtxoAmountSats: BigInt(htlcProof.dlcFunding.outputAmountSats),
    promisedInboundSats: BigInt(htlcProof.dlcFunding.outputAmountSats),
    deliveredInboundSats: BigInt(htlcProof.dlcFunding.outputAmountSats),
    leaseBlocks: 144,
    maxFeePpm: 1000,
    maxCltvDelta: 40,
    observedFeePpm: 900,
    observedCltvDelta: 34,
    observedBlock: htlcProof.refundPath.chainHeightAtRefund,
    graftPremiumSats: 750n,
    paymentHashHex,
    preimageHex: htlcProof.lightning.paymentPreimageHex,
    htlcProof,
    liquidityLease,
    challengeDeliveredInboundSats: 0n,
    challengeObservedFeePpm: 2500,
    challengeObservedCltvDelta: 80,
    challengeMissingForfeitPath: true,
    graftCount: 24,
    feeRateSatVb: 25,
    rebalanceFeePpm: 1200,
    arkAspFeePpm: 250,
    arkRoundParticipants: 24,
    arkExitProbabilityBps: 50,
    bitvmChallengeReserveSats: 5000n
  });
  const verification = verifyArkLiquidityGraftBundle(bundle);

  fs.writeFileSync(JSON_OUT, `${JSON.stringify({ ...bundle, verification }, null, 2)}\n`);
  fs.writeFileSync(MD_OUT, renderMarkdown(bundle, verification));
  console.log(`Wrote ${JSON_OUT}`);
  console.log(`Wrote ${MD_OUT}`);
}

if (require.main === module) {
  main();
}
