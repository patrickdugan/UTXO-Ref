# Bitcoin testnet4 red-team swarm report

Date: 2026-09-11

## Scope

The target was the UTXORef JavaScript sweep verifier backed by a synchronized local Bitcoin Core 31.1 testnet4 node. Eight worker agents mutated cloned verifier fixtures while one coordinator performed allowlisted, read-only Core RPC calls. Raw policy candidates stayed unsigned. No transaction was broadcast.

The run used a stable snapshot bracketed by block hash and mempool sequence. Every selected wallet coin was confirmed with `gettxout`, and the starting block was checked again after the run to ensure that it remained canonical.

## Scale result

Command:

```powershell
node bitvm3\utxo_referee\btc_testnet4_stress.js `
  --agents=8 `
  --iterations=11000 `
  --rpc-probes=100 `
  --require-synced `
  --unsigned-mempool-probe `
  --json
```

Observed result:

| Metric | Result |
|---|---:|
| Core height / headers | 151995 / 151995 |
| Worker agents | 8 |
| Verifier cases | 11,000 |
| Adversarial cases | 10,000 |
| Security violations | 6,000 |
| Unhandled crashes | 2,000 |
| Clean adversarial rejection rate | 40% |
| Live `gettxout` probes | 100 / 100 consistent |
| Unsigned Core policy cases | 9 / 9 expected rejections |
| Reorg during run | none observed |
| Broadcasts | 0 |

| Attack family | Cases | Accepted | Rejected | Crashed | Violations |
|---|---:|---:|---:|---:|---:|
| Canonical control | 1,000 | 1,000 | 0 | 0 | 0 |
| Epoch substitution | 1,000 | 0 | 1,000 | 0 | 0 |
| Amount mutation | 1,000 | 0 | 1,000 | 0 | 0 |
| Merkle sibling mutation | 1,000 | 0 | 1,000 | 0 | 0 |
| Duplicate Merkle position | 1,000 | 1,000 | 0 | 0 | 1,000 |
| High-index alias | 1,000 | 1,000 | 0 | 0 | 1,000 |
| Fractional index | 1,000 | 1,000 | 0 | 0 | 1,000 |
| String index | 1,000 | 1,000 | 0 | 0 | 1,000 |
| Malformed siblings | 1,000 | 0 | 0 | 1,000 | 1,000 |
| Negative amount | 1,000 | 0 | 0 | 1,000 | 1,000 |
| Cap overflow control | 1,000 | 0 | 1,000 | 0 | 0 |

Core cleanly rejected the unsigned policy matrix for missing witnesses, duplicate inputs, missing inputs, invalid output indices, non-final locktime, dust and zero outputs, overspending, and empty outputs.

## Independently reproduced gaps

- `verifySweep` does not bind the commitment to an expected anchored hash, raw Bitcoin transaction, input outpoints and values, exact output mapping, fees, dust rules, network, or block anchor.
- A commitment can change after construction through caller-owned `Buffer` aliases, even after `Object.freeze`. A substituted root and payout can then pass verification.
- Mutating a commitment's cap after recording its hash can produce a different accepted commitment because verification receives no expected hash.
- A logical full-cap payout requires a zero-valued residual object and reserves no miner fee. Core rejects the corresponding zero-fee or zero-value-output transaction forms.
- Epoch IDs use block height alone and therefore collide across competing blocks at the same height.
- The logical live probe constructs its commitment, proof, and sweep from the same metadata. It is a consistency check, not evidence of a relayable sweep transaction.

## Harness findings fixed during the run

- Chain and wallet reads previously crossed a moving tip. One scan raced across 21 blocks during initial sync.
- Reorg detection previously missed a reorg followed by extension. The harness now checks whether the recorded block hash still occupies its original height.
- Snapshot capture now brackets `listunspent` and `gettxout` with both the tip hash and mempool sequence, checks the wallet's processed block, and retries drifted snapshots.
- BTC amount conversion now rejects negative, sub-satoshi, and malformed decimal inputs instead of rounding or losing the sign.
- Requested iteration counts are divided exactly across workers, and attack rejection rate excludes canonical-control failures.

## Host isolation finding

The current data directory and wallet files are readable by other local Windows users, and the loaded private-key wallet is not passphrase encrypted. Cookie RPC grants unrestricted methods. Arbitrary same-host agents must not receive shell access to this node. Put them behind an allowlisted read-only RPC proxy or use a dedicated walletless node and Windows account before expanding beyond trusted worker code.

## Release gate

The current verifier is not ready to authorize value. It needs immutable serialized commitments and expected-hash comparison; strict proof types, index ranges, depth, and position uniqueness; clean error returns for malformed values; persistent outpoint/nullifier replay state; and exact Bitcoin transaction, fee, residual, and anchor binding. The same attack matrix should then run with `--require-clean` and produce zero violations or crashes.

The BitAgent control-plane and D-drive replay-corpus assessment is recorded in `BITAGENT_REPO_REVIEW.md`.
