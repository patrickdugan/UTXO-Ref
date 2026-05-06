# UTXORef DLC Submarine Swap Funding

This prototype lets a Lightning wallet fund a DLC through UTXORef without giving
the wallet direct responsibility for the on-chain DLC funding transaction.

## Flow

1. The wallet asks the UTXORef sidecar for a DLC submarine-swap funding quote.
2. The sidecar returns a Lightning invoice, payment hash, target DLC commitment,
   namespace handle, and expected funding-output commitment.
3. The wallet pays the invoice.
4. The revealed preimage lets UTXORef claim the P2WSH submarine-swap HTLC.
5. The claim transaction pays the DLC funding output.
6. The wallet verifies the target binding hash and, if available, the execution
   proof txids/checks.

## Sidecar Endpoints

```text
GET  /v1/dlc-subswap-funding/latest
GET  /v1/dlc-subswap-funding/wallet-view
POST /v1/dlc-subswap-funding/quote
POST /v1/dlc-subswap-funding/verify
```

## Wallet Surface

The ZEUS demo integration lives in:

```text
integrations/zeus/dlcSubswapFundingClient.ts
integrations/zeus/DlcSubswapFundingScreen.tsx
```

The screen is intentionally quote/verify only. It does not auto-pay, mutate
channels, or broadcast transactions. A production wallet integration should add
explicit confirmation before paying the invoice and should watch the swap claim
transaction until the DLC funding output is confirmed.

## Motif Mapping

- Transcript multiplicity: `subswap_invoice_request` and `dlc_funding_claim`.
- Identifier bifurcation: a namespace handle separates wallet quote, swap HTLC,
  DLC contract commitment, and funding-output commitment.
- Carrier camouflage: the funding route uses an ordinary Lightning invoice,
  P2WSH HTLC, and DLC funding output rather than a custom wallet-only primitive.

## Commands

```powershell
node bitvm3\utxo_referee\utxoref_dlc_subswap_funding.test.js
node bitvm3\utxo_referee\utxoref_dlc_subswap_funding_demo.js
node integrations\lightning-liquidity-lease-sidecar\server.js
```
