#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  buildDlcSubswapFundingRequest,
  verifyDlcSubswapFundingRequest,
  buildDlcSubswapFundingWalletView
} = require('./utxoref_dlc_subswap_funding');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const DLC_IN = path.join(ARTIFACTS_DIR, 'lightning_tradelayer_oracle_dlc_latest.json');
const SUBSWAP_IN = path.join(ARTIFACTS_DIR, 'lightning_subswap_dlc_latest.json');
const JSON_OUT = path.join(ARTIFACTS_DIR, 'utxoref_dlc_subswap_funding_latest.json');
const MD_OUT = path.join(ARTIFACTS_DIR, 'utxoref_dlc_subswap_funding_latest.md');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function stringifyJson(value) {
  return JSON.stringify(
    value,
    (_key, current) => (typeof current === 'bigint' ? current.toString() : current),
    2
  );
}

function buildMarkdownReport(bundle) {
  const request = bundle.request;
  const core = request.requestCore;
  const view = bundle.walletView;
  const proof = request.executionProof;
  return `# UTXORef DLC Submarine Swap Funding

Created: ${bundle.createdAt}

## Wallet Interaction

- Status: ${view.status}
- Request id: \`${request.requestId}\`
- Target DLC: \`${core.targetDlc.contractId}\`
- Contract commitment: \`${core.targetDlc.contractCommitmentId}\`
- Namespace handle: \`${core.jurassicMotifs.namespaceHandle}\`
- Invoice amount: ${core.submarineSwap.invoiceAmountSats} sats
- Requested collateral: ${core.submarineSwap.requestedCollateralSats} sats
- Payment hash: \`${core.submarineSwap.paymentHashHex}\`
- Funding commitment: \`${core.dlcFundingOutput.commitmentHash}\`
- Target binding hash: \`${core.targetBindingHash}\`

## Flow

1. Wallet requests a UTXORef submarine swap quote for the DLC contract.
2. Wallet pays the Lightning invoice.
3. The revealed preimage lets UTXORef claim the P2WSH HTLC.
4. The claim pays the DLC funding output.
5. The wallet verifies the target binding hash, funding commitment, and execution proof.

## Motif Wrapper

- Transcript aliases: ${core.jurassicMotifs.transcriptAliases.join(', ')}
- Namespace handle: \`${core.jurassicMotifs.namespaceHandle}\`
- Carrier hints: ${core.jurassicMotifs.carrierHints.join(', ')}

## Execution Proof

${proof ? `- Swap funding txid: \`${proof.swapFundingTxid}\`
- Claim txid: \`${proof.claimTxid}\`
- Refund txid: \`${proof.refundTxid}\`
- DLC output amount: ${proof.dlcOutputAmountSats} sats
- Proof checks: ${Object.entries(proof.checks).map(([name, ok]) => `${name}=${ok ? 'ok' : 'failed'}`).join(', ')}` : '- No execution proof attached; this is a quote/request artifact.'}

## Verification

- ok: ${bundle.verification.ok}
- reason: ${bundle.verification.reason || 'n/a'}
`;
}

function main() {
  const dlcBundle = readJson(DLC_IN);
  const subswapProof = fs.existsSync(SUBSWAP_IN) ? readJson(SUBSWAP_IN) : null;
  const request = buildDlcSubswapFundingRequest({
    dlcBundle,
    subswapProof,
    options: {
      walletNodeId: process.env.UTXOREF_WALLET_NODE_ID || 'zeus-wallet-demo-node',
      swapFeeSats: process.env.UTXOREF_SUBSWAP_FEE_SATS || '1000'
    }
  });
  const verification = verifyDlcSubswapFundingRequest(request);
  const walletView = buildDlcSubswapFundingWalletView(request);
  const bundle = {
    kind: 'utxoref_dlc_subswap_funding_bundle',
    createdAt: new Date().toISOString(),
    request,
    walletView,
    verification
  };

  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(JSON_OUT, `${stringifyJson(bundle)}\n`);
  fs.writeFileSync(MD_OUT, buildMarkdownReport(bundle));
  console.log(`Wrote ${JSON_OUT}`);
  console.log(`Wrote ${MD_OUT}`);
  console.log(`verification=${verification.ok ? 'ok' : verification.reason}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildMarkdownReport
};
