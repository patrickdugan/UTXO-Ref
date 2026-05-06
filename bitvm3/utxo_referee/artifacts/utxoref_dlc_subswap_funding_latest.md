# UTXORef DLC Submarine Swap Funding

Created: 2026-05-04T12:08:47.797Z

## Wallet Interaction

- Status: verified
- Request id: `062c77fe892d7c32e93922942e22c569667ab3493ea58fc26bda90dc2161dd3f`
- Target DLC: `ln-tl-oracle-dlc-1`
- Contract commitment: `934250a8ae80785bd4b6e8e29269514f13ab5d8486b582f6cdd4a6495fb7edd2`
- Namespace handle: `dlc-subswap-ln-tl-oracle-dlc-1-79cdbfa62ea2`
- Invoice amount: 50000 sats
- Requested collateral: 49000 sats
- Payment hash: `79cdbfa62ea28e4177514f55ae3f5d6e7dbdd780254a6aeff6428270cd5d1d3f`
- Funding commitment: `2ae94a2a96423191e3a47dd93dfe715f5f2a53b9657b2482d34ab47a9dbbe5b7`
- Target binding hash: `72294ea469ad0973e24cfd984a38eb5dcefc618e35b40c3b95af29f374128835`

## Flow

1. Wallet requests a UTXORef submarine swap quote for the DLC contract.
2. Wallet pays the Lightning invoice.
3. The revealed preimage lets UTXORef claim the P2WSH HTLC.
4. The claim pays the DLC funding output.
5. The wallet verifies the target binding hash, funding commitment, and execution proof.

## Motif Wrapper

- Transcript aliases: subswap_invoice_request, dlc_funding_claim
- Namespace handle: `dlc-subswap-ln-tl-oracle-dlc-1-79cdbfa62ea2`
- Carrier hints: ln_invoice, p2wsh_htlc, dlc_funding_output

## Execution Proof

- Swap funding txid: `c563776fe8a6d86e7e185529d7e78e43e4066c7221589c8f688b3b63a7939ad6`
- Claim txid: `fd3e97d30b39c04dea7748cd5a7e8b057bf9e0f7656a6be7d9733c413828be43`
- Refund txid: `74d382592edba0efd1967827ba6bafe9e0d638ed4b8e925401cf308ee2a9dc68`
- DLC output amount: 49000 sats
- Proof checks: paymentHashMatchesRequest=ok, preimageMatchesPaymentHash=ok, claimPaysDlcFundingOutput=ok, dlcOutputCommitsFundingHash=ok, successBroadcasted=ok, refundBranchAvailable=ok

## Verification

- ok: true
- reason: n/a
