# UTXORef V2 Artifact Ingress And Challenge Survival

This release gate covers two failure boundaries that are separate from the
BitVM predicate itself:

1. An artifact must have exactly one interpretation before it reaches the
   watchtower, CPFP signer, or live staging path.
2. A valid challenge must remain recoverable across mempool divergence,
   parent eviction, fee pressure, conflicting replacements, and shallow
   reorganization.

## Strict Artifact Ingress

`strict_artifact_ingress.js` parses untrusted JSON without first passing it
through `JSON.parse`. The parser rejects:

- duplicate object keys, including escaped aliases;
- non-ASCII schema keys and non-ASCII security identifiers;
- unpaired Unicode surrogates;
- exponent-form numbers and negative zero;
- fractional or unsafe numeric values in integer fields;
- noncanonical integer strings; and
- artifacts that exceed configured byte, depth, node, key, array, string, or
  identifier limits.

The default maximum artifact size is 4 MiB. The parser also requires a regular
file and checks its size before reading it. These checks are now used by:

- `utxoref_v2_watchtower.js` for artifacts, trust policies, and durable state;
- `utxoref_v2_challenge_cpfp.js` for artifacts and trust policies; and
- `btc_testnet4_utxoref_v2_live.js` for staged live artifacts.

Run the focused ingress tests with:

```powershell
node bitvm3\utxo_referee\strict_artifact_ingress.test.js
```

## Deterministic Survival Model

`utxoref_v2_challenge_survival.js` models the watchtower's fee and lifecycle
policy as hash-chained state-transition receipts. It covers:

- parent eviction and exact-parent rebroadcast;
- package pinning and later unpinning;
- isolated fee-reserve consumption;
- bounded monotonic child replacement;
- a superseded conflict becoming the confirmed winner;
- confirmation, reorg rollback, and reconfirmation; and
- challenge-window expiration.

Replacement attempts reserve only the highest currently winning fee. They do
not incorrectly consume the sum of every attempted replacement. Every event
and resulting state is committed into the next receipt, so later mutation or
event substitution breaks verification.

Run the model tests with:

```powershell
node bitvm3\utxo_referee\utxoref_v2_challenge_survival.test.js
```

## Two-Node Bitcoin Core Drill

`utxoref_v2_two_node_survival_drill.js` starts two isolated regtest nodes in
temporary data directories. It then:

1. connects and synchronizes the nodes;
2. partitions them;
3. broadcasts a real challenge-shaped transaction to node A only;
4. verifies that node A has the transaction while node B does not;
5. reconnects and rebroadcasts the exact raw parent to node B;
6. verifies mempool convergence;
7. mines the transaction and observes confirmation through the watchtower;
8. invalidates its block and observes the transaction return to the mempool;
9. reconsiders the same block and observes reconfirmation; and
10. stops both nodes and removes only the temporary drill directories.

Run it with an explicit Core binary:

```powershell
node bitvm3\utxo_referee\utxoref_v2_two_node_survival_drill.js `
  --bitcoind C:\path\to\bitcoind.exe
```

The successful 2026-07-13 run used Bitcoin Core 30.2. It produced divergent
mempools, converged by exact-parent rebroadcast, confirmed transaction
`162ced5e072f9eb128a9181318cd108d04e4fd6879ff7dc7c3b929d91e81cd3b`,
detected the invalidation, and reconfirmed it in block
`6de6aa93a471721ec2eae6f525619bd56109be665d5007b587dac5b3e8f2d301`.
The local receipt is written under ignored `artifacts/tmp/`.

## Remaining Boundary

The two-node drill exercises real Core mempool divergence, rebroadcast, and
reorganization behavior. `UTXOREF_V2_PACKAGE_RESERVE_QUORUM.md` adds a real
Core economic-pinning package, a graph-bound fee-reserve UTXO, signed watcher
quorum receipts, and benchmarked schema limits. A release candidate still
needs multi-implementation relay testing, the exact two-input CPFP reserve
spend, genuinely independent watcher deployments, and deliberately unequal
relay policy. No watchtower can guarantee inclusion; the design can only
preserve valid fee-bumping paths and detect when its challenge margin is no
longer adequate.
