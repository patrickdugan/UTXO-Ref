# Quirk-Indexed UTXORef Route Demo

This no-broadcast demo binds Jurassic quirk route candidates to live Bitcoin testnet4 UTXORef reserve evidence.

## Source

- Import bundle: `C:\projects\BitcoinConsensusObservatory\jurassic-bitcoin\artifacts\bitcoin-testnet4\utxoref-live-import-latest.json`
- Chain: `testnet4`
- Height: `143218`
- Reserve outpoint: `93f953df2c89faf386d14217fb4d3de62d91d3789fee83cc53acfd653882f6a6:0`
- Grant txid: `7dec37bebf56575abd5e3fb48e7fbe1c278cb7d1f78356fe0b2c4113b759464d`

## Scenarios

| scenario | expected | admissible | failed checks | claim |
| --- | --- | --- | --- | --- |
| `accepted_transcript_alias_compact` | `accepted` | `true` | - | `fa3bc1f7bf482f66834f5c4e1c482d058c53509de437cdbeff6de34a6fe2120c` |
| `accepted_identifier_namespace_rotated` | `accepted` | `true` | - | `338f9fed3ba94dca52d4765d9342c031988058d0c2f4f62926d856a1eda1fade` |
| `rejected_mutated_withdrawal_root` | `rejected` | `false` | `withdrawal_root` | `3ccf837c975a79a10cde769aa150f1e0089741e926037e707951b208b0e99e65` |
| `rejected_unknown_route_transcript` | `rejected` | `false` | `route_transcript_candidate` | `113d78bc802af00628cd50ee46e6deecee073a0644c48d18c5dab8f02849756c` |

## Rule

A route transcript candidate is not spend authority. It becomes admissible only when the live reserve witness, withdrawal root, final output vector, semantic grant state, and CSV-safe reserve status all match.
