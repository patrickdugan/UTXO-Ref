# Lightning + BitVM/DLC Local Testnet Demo

Created: 2026-04-25T18:15:08.841Z

## Live Probes

- Chain RPC: live
- Chain target: litecoin-testnet at http://127.0.0.1:19332
- Chain height: 4690304 / headers 4690304
- Wallet: tl-wallet
- Wallet balance: 0.18437915
- Lightning CLI: unavailable

## Prototype Transcript IDs

- Lightning-funded position open: `bf70aeedf66e72fc915ca551c03f996d650f39b99d187f98315cead31261b925`
- Lightning payout compression root: `33404934587fcfd90459d01b8e0d9be1f8e00df2049ed98e38df317c0b63b2f0`
- Watchtower bounty: `7cbf9c5d5269623e323bfb3b141e4439bc287f1f7b062953e2f6368d91c28065`
- Contract-open API session: `0b3f160c4fdae56bcefe9d6f82247d9efb7bcc986d2b79c46d98efb14ba6adde`
- Lightning-funded rollover root: `f207ab08edb261d1e6c84e9ed253317419d818675b24a8a798acf762c4646166`

## Demo Status

- Deterministic prototype bundle: ok
- LN invoice creation: skipped
- M1 chain demo: attempted
- m1_ltc_testnet_demo: ok
- m1_pipeline_replay: ok

## Latest M1 Artifact Summary

- Funding txid: 2edb992eade4f6fa7c3f9849a7f4390e839522f9b07d7b4e08ee33550a4eb2fe
- Funding broadcasted: false
- Procedural state: SETTLED
- Contract id: ltc-testnet-epoch-1-1777140673550
- Holder address: tltc1qyslh3amjs935nmtexvxh5dzyfg7yczmf56n8vn
- Settlement route: roll
- Funded amount: 0.001539 LTC
- Parallel UTXO tx count: 5
- Fast-roll next contract: n/a

## Documentation Boundary

At least one local daemon was reachable, so the artifact includes live probe evidence.

To force live M1 replay steps after RPC is available, run with `LIVE_DEMO_RUN_M1=1`. To create a real Lightning invoice after `lncli` or `lightning-cli` is configured, run with `LIVE_DEMO_CREATE_LN_INVOICE=1`.
