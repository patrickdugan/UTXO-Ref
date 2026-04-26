# Ark DLC Settlement With BitVM ASP Governor

## Thesis

Settle DLC outcomes by Ark VTXO transfer in the happy path, avoiding on-chain CET broadcast. BitVM/UTXORef remains the governor against ASP misrouting or withheld exit/forfeit paths.

## Contract

- Contract: ark-dlc-btc-usd-demo
- ASP: ark-asp-regtest
- Oracle event: btc-usd-2026-06-30
- Total collateral: 100000 sats
- Outcomes: 3
- Contract commitment: `8d432de48e143fc656937dfe42d4c6f4dc2310ecc39b08ebbe701f0e47b9cf71`
- Virtual CET set: `4f9680b7c325560df4828d9973fc16f63c0ef20fd7975d1970eb6e8f64e83529`

## Happy-Path Settlement

- Settlement id: `8b0f7dff81e2e785679e59fc4208e0bbe6fd5e0a8e5fcdc9ce047e7488d04e2a`
- Oracle outcome: btc_up
- Selected virtual CET: `2b1f28769c29533b59c8ef0734747f67b566474816fd83f756bbb9891503dde5`
- Ark transition: `09b4f32c2979cf2b2f522240b01c5df3c8f6284b47a7bfe5936898255ba7e112`
- No on-chain CET broadcast: true
- Avoided on-chain CET txid: `787d99ffbc701c85e6003a9b18b0149a792d5d56487abcc7a1591d91ba690568`
- Verification: ok

## Payouts

- offer: 0 sats to ark1-offer
- accept: 100000 sats to ark1-accept

## ASP Challenge Case

- Challenge id: `ffa6475642278dba63d2507e8980023b125e00b050414a3de30b8f01c5b4c28e`
- Slashable: true
- Violations: asp_settled_wrong_oracle_outcome, missing_asp_forfeit_path

## Fee Model

- Outcomes modeled: 5000
- Fee rate: 25 sat/vB
- On-chain happy path CET: 4500 sats
- On-chain CET fanout exposure: 22500000 sats
- Ark happy path: 475 sats
- Governed Ark with challenge reserve: 5475 sats
- Avoids on-chain CET happy path: true
- Avoids CET fanout on-chain exposure: true

## Caveats

- This is an evidence-shape prototype, not a production Ark ASP implementation.
- Production needs real Ark round signatures, VTXO tree proofs, ASP bond accounting, and oracle signature verification.
- The virtual CET set is committed for audit/challenge; only the selected outcome becomes an Ark transition.
