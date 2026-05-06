# Lightning Submarine Swap Into DLC Funding Demo

Created: 2026-04-25T21:49:30.414Z

## Live Flow

- Network: bitcoin-regtest
- Invoice amount: 50000000msat msat
- Payment hash: `79cdbfa62ea28e4177514f55ae3f5d6e7dbdd780254a6aeff6428270cd5d1d3f`
- Payment preimage: `7dddd7c50c3cb35c735afeedb34c2b2562f9df785d6c01f3ad3846e01d1d288e`
- LN payment status: complete

## Swap Output

- Swap funding txid: `c563776fe8a6d86e7e185529d7e78e43e4066c7221589c8f688b3b63a7939ad6`
- Swap funding vout: 0
- Swap address: `bcrt1q0c9e52dn6rmrhx8mwhz0gseagdruttap6ammqwxapcugqdlgwe4shzztav`
- Swap amount: 50000 sats
- Refund locktime: 124
- Claim pubkey: `033279ef252ff9d8007ca47add690f17af8a35230d931f739c70f10f4d148d1489`
- Refund pubkey: `024ff528c2393806e86d4e854eb2dfae924e271d23dd5c5a5fa416959e18ff6d4a`
- Swap witness script: `63a82079cdbfa62ea28e4177514f55ae3f5d6e7dbdd780254a6aeff6428270cd5d1d3f8821033279ef252ff9d8007ca47add690f17af8a35230d931f739c70f10f4d148d1489ac67017cb17521024ff528c2393806e86d4e854eb2dfae924e271d23dd5c5a5fa416959e18ff6d4aac68`

## DLC Funding Spend

- Claim/funding txid: `fd3e97d30b39c04dea7748cd5a7e8b057bf9e0f7656a6be7d9733c413828be43`
- Claim/funding wtxid: `7ec7d7b1cfc863839e73e60000be77e1be4d3ab1834b411a39a791c2bd4b1809`
- DLC output vout: 0
- DLC output amount: 49000 sats
- DLC commitment hash: `2ae94a2a96423191e3a47dd93dfe715f5f2a53b9657b2482d34ab47a9dbbe5b7`
- DLC witness script: `0063202ae94a2a96423191e3a47dd93dfe715f5f2a53b9657b2482d34ab47a9dbbe5b7682103d645b21ccdfb1d983920fd4d7dd8c4b18de8ebc9cba1a18dea9bd6a7dd3f3b61ac`

## Refund Branch Proof

- Refund funding txid: `2c9c246d0f561a4480b65d69ae64453b8a421c6cc0ecb1477d927d7352d6ad14`
- Refund funding vout: 1
- Refund txid: `74d382592edba0efd1967827ba6bafe9e0d638ed4b8e925401cf308ee2a9dc68`
- Refund wtxid: `32a75a586f0dad67ebb169bd5b870715ecac6b0328bb42f50f2211160138f9c5`
- Refund locktime: 124
- Chain height at refund: 124
- Refund destination: `bcrt1qe2ymxmuh7q2f9tzvnl9q5j55euketyjrwm82tu`
- Refund amount: 29000 sats

## Checks

- invoiceHashMatchesPreimage: ok
- swapScriptUsesInvoiceHash: ok
- swapScriptHasSuccessSignatureBranch: ok
- swapScriptHasRefundTimeoutBranch: ok
- claimSpendsSwapFundingTx: ok
- claimWitnessRevealsPreimage: ok
- claimWitnessSelectsSuccessBranch: ok
- claimPaysDlcFundingOutput: ok
- dlcOutputCommitsFundingHash: ok
- successBroadcasted: ok
- refundLocktimeReached: ok
- refundSpendsSecondHtlcOutput: ok
- refundWitnessSelectsRefundBranch: ok
- refundBroadcasted: ok
