#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  buildTaprootAssetsStablecoinBundle,
  verifyTaprootAssetsStablecoinBundle
} = require('./lightning_taproot_assets_stablecoin');

const ARTIFACT_DIR = path.join(__dirname, 'artifacts');
const LEASE_PATH = path.join(ARTIFACT_DIR, 'lightning_liquidity_lease_latest.json');
const SUBSWAP_PATH = path.join(ARTIFACT_DIR, 'lightning_subswap_dlc_latest.json');
const JSON_OUT = path.join(ARTIFACT_DIR, 'lightning_taproot_assets_stablecoin_latest.json');
const MD_OUT = path.join(ARTIFACT_DIR, 'lightning_taproot_assets_stablecoin_latest.md');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function renderMarkdown(bundle, verification) {
  const q = bundle.rfqQuote.quoteCore;
  const s = bundle.settlementEvidence.settlementCore;
  return `# Taproot Assets Stablecoin Over Lightning With BitVM Liquidity

## Thesis

${bundle.thesis}

This is a prototype evidence bundle for a wallet-facing demo. It does not
replace tapd/litd; it defines what the wallet or watchtower should be able to
verify after an Edge node quotes a Taproot Asset/BTC conversion and routes the
BTC side over Lightning.

## Asset

- Ticker: ${bundle.asset.descriptorCore.ticker}
- Asset id: \`${bundle.asset.descriptorCore.assetId}\`
- Genesis point: \`${bundle.asset.descriptorCore.genesisPoint}\`
- Decimal display: ${bundle.asset.descriptorCore.decimalDisplay}
- Proof id: \`${bundle.assetProof.proofId}\`
- Universe root: \`${bundle.assetProof.proofCore.universeRoot}\`
- Anchor outpoint: \`${bundle.assetProof.proofCore.anchorOutpoint}\`

## RFQ / Edge Node Quote

- Quote id: \`${bundle.rfqQuote.quoteId}\`
- Edge node: ${q.edgeNodeId}
- Asset units: ${q.assetAmountUnits}
- BTC route amount: ${q.btcRouteSats} sats
- Max spread: ${q.maxSpreadPpm} ppm
- Quoted spread: ${q.quotedSpreadPpm} ppm
- Max routing fee: ${q.maxRoutingFeePpm} ppm
- Quoted routing fee: ${q.quotedRoutingFeePpm} ppm
- Payment hash: \`${q.paymentHashHex}\`

## LN Settlement / BitVM Lease Evidence

- Settlement id: \`${bundle.settlementEvidence.settlementId}\`
- Delivered BTC: ${s.deliveredBtcSats} sats
- LN claim txid: \`${s.lnClaimTxid}\`
- Channel/splice outpoint: \`${s.channelOrSpliceOutpoint}\`
- Liquidity lease bundle: \`${s.liquidityLeaseBundleId}\`
- Verification: ${verification.ok ? 'ok' : verification.reason}

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

## Primary References

${bundle.references.map(item => `- ${item}`).join('\n')}
`;
}

function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const liquidityLease = readJson(LEASE_PATH);
  const htlcProof = readJson(SUBSWAP_PATH);
  const paymentHashHex = htlcProof.lightning.paymentHashHex;

  const bundle = buildTaprootAssetsStablecoinBundle({
    ticker: 'USDSIM',
    issuer: 'regtest-stablecoin-issuer',
    amountUnits: 25000000n,
    assetAmountUnits: 25000000n,
    btcRouteSats: BigInt(htlcProof.dlcFunding.outputAmountSats),
    maxSpreadPpm: 5000,
    quotedSpreadPpm: 3000,
    maxRoutingFeePpm: 1200,
    quotedRoutingFeePpm: 900,
    expiryBlock: 300,
    observedBlock: 200,
    paymentHashHex,
    preimageHex: htlcProof.lightning.paymentPreimageHex,
    htlcProof,
    liquidityLease,
    challengeObservedBlock: 301,
    challengeObservedSpreadPpm: 9000,
    challengeObservedRoutingFeePpm: 2500
  });
  const verification = verifyTaprootAssetsStablecoinBundle(bundle);

  fs.writeFileSync(JSON_OUT, `${JSON.stringify({ ...bundle, verification }, null, 2)}\n`);
  fs.writeFileSync(MD_OUT, renderMarkdown(bundle, verification));
  console.log(`Wrote ${JSON_OUT}`);
  console.log(`Wrote ${MD_OUT}`);
}

if (require.main === module) {
  main();
}
