# Camouflaged Watchtower Cadence Demo

This no-broadcast demo makes watchtower publication cadence challengeable while allowing ordinary-looking carrier profiles.

## Source

- Import bundle: `C:\projects\BitcoinConsensusObservatory\jurassic-bitcoin\artifacts\bitcoin-testnet4\utxoref-live-import-latest.json`
- Route demo: `C:\projects\UTXORef\UTXO-Ref\bitvm3\utxo_referee\artifacts\quirk_indexed_route\quirk_indexed_route_latest.json`
- Chain: `testnet4`
- Height: `143218`
- Reserve outpoint: `93f953df2c89faf386d14217fb4d3de62d91d3789fee83cc53acfd653882f6a6:0`
- Route claim: `fa3bc1f7bf482f66834f5c4e1c482d058c53509de437cdbeff6de34a6fe2120c`

## Scenarios

| scenario | expected | admissible | failed checks | carrier | claim |
| --- | --- | --- | --- | --- | --- |
| `accepted_sweep_like_checkpoint` | `accepted` | `true` | - | `wallet_sweep_checkpoint` | `23d07563823edc857a43828685d6aa6c1a301e5bd936868b73dc4fc4a12309d3` |
| `accepted_payout_batch_checkpoint` | `accepted` | `true` | - | `payout_batch_checkpoint` | `a438a6fd09de7e6640c9b9b9bfb06899465e9446f610ef90b54d3ea72b304384` |
| `rejected_stale_checkpoint` | `rejected` | `false` | `cadence_freshness` | `wallet_sweep_checkpoint` | `0bcc65f5713c78297ea3df6ed09d81ec727338fb448858a311da9844a286289b` |
| `rejected_wrong_alert_handle_route` | `rejected` | `false` | `publication_handle_binding` | `wallet_sweep_checkpoint` | `934feb699b25ab64b3fac286e84a9ea9846995b199c0c1a4dcf80476cde244c1` |

## Rule

Carrier camouflage is allowed for watchtower cadence only when the checkpoint references an admitted route claim, a live reserve witness, a bound publication handle, and a fresh cadence window.
