# UTXORef V2 Package Policy, Fee Reserve, And Watcher Quorum

This stage exercises three operational controls around the BitVM assertion
graph. It does not change the Boolean disprove predicate.

## Real Package-Policy Drill

`utxoref_v2_package_policy_drill.js` starts an isolated Bitcoin Core 30.2
regtest node and constructs three real mempool cases:

1. An unpinned 1,000-sat parent is replaced successfully at 2,500 sats.
2. A deliberately unsafe public P2WSH `OP_TRUE` anchor is spent by an
   11,000-sat child. The same 2,500-sat parent replacement is rejected because
   it cannot pay the 12,000 sats being evicted. A 15,000-sat replacement then
   succeeds.
3. A graph-bound P2TR fee-reserve output rejects the same empty-witness public
   spend and is counted only after confirmation.

Run the drill with:

```powershell
node bitvm3\utxo_referee\utxoref_v2_package_policy_drill.js `
  --bitcoind C:\path\to\bitcoind.exe
```

The 2026-07-13 run produced:

- unpinned replacement:
  `1be1c605fac795d37cd09d95c7ba3039d8d0e111aea11596f6257a76554e7c13`;
- pinned parent:
  `f61e0400fa04a42cbfdb13f27af396a67e6d966ffcf602ae2b9296362ce2feb2`;
- economic-pin child:
  `58c3824f8fe4c4613078f9ce0f0892dacc5985d5a2d2a46bab81a439b412fa69`;
- successful 15,000-sat rescue replacement:
  `b16534acd830ea9f3625b4265a07522aeae2d43a526dced46a759749e9fa0bdd`;
- graph-bound reserve outpoint:
  `f0b41681dd05c488cbc3a9bb13be749b1b3b63f8cdbf949bdd883646608604d9:0`;
  and
- confirmation block:
  `2cce9cb135958c371973ab682af368dc8a2c0398cec2662a3f0d3fac79d6a400`.

These are ephemeral regtest identifiers, not public explorer evidence. The
receipt is written under ignored `artifacts/tmp/`.

The unsafe anchor is an adversarial control case. The current UTXORef
challenge output does not expose an anyone-can-spend descendant output. The
experiment quantifies why adding such an anchor later would require an
explicit package budget.

## Graph-Bound Fee Reserve

`utxoref_v2_fee_reserve.js` extends the existing Taproot reserve-vault policy
without changing old manifest hashes. A new reserve commits the graph hash
inside both leaves:

```text
legacy immediate: <graph-hash> DROP <challenger> CHECKSIGVERIFY <guardian> CHECKSIG
quorum immediate: <graph-hash> DROP <challenger> CHECKSIGVERIFY
                  <g1> CHECKSIG <g2> CHECKSIGADD ... <threshold> NUMEQUAL
recovery:  <graph-hash> DROP <csv-delay> CSV DROP <refund-key> CHECKSIG
```

The live verifier requires:

- an exact reserve hash pinned by the external graph trust policy;
- a unique graph/dispute and funding-outpoint assignment;
- a confirmed Core UTXO at the recorded funding height;
- exact amount and P2TR script matching;
- reserve value at least equal to the policy maximum fee; and
- delayed recovery remaining beyond challenge window, confirmation target,
  and safety margin.

When a graph policy contains `feeReserve`, the watchtower requires
`--fee-reserve <file>` before it grants new challenge authority. It records the
reserve hash and outpoint with a broadcast challenge.

This is a tapscript encumbrance, not a covenant. The quorum leaf still permits
the challenger and a guardian threshold to co-sign another destination, so
guardian policy and key separation remain part of the security boundary. The
transaction-level rescue now narrows that authority operationally:

- `utxoref_v2_fee_reserve_guardian.js` reconstructs and validates an exact
  two-input, one-output plan and emits a signed approval without receiving the
  challenger secret;
- `utxoref_v2_reserve_cpfp.js` accepts one approval for a legacy reserve or a
  distinct threshold set for a quorum reserve, lets the wallet sign only the
  challenge input, adds the challenger signature to the reserve leaf, and
  rejects any input, output, sequence, amount, script, or witness mutation;
- the only output returns the combined challenge and unused reserve value to
  the original challenge script; and
- every replacement spends the same two outpoints, uses a fresh guardian
  approval set, increases the absolute fee, and preserves conflict history.

`utxoref_v2_guardian_quorum_reserve.js` commits a unique ordered guardian set,
threshold, graph hash, challenger, refund key, and recovery delay into a
separate manifest kind. The final witness uses fixed reverse-order guardian
slots, including empty slots for non-signers. Focused tests and the real Core
drill cover insufficient quorum, duplicate approvals, role-key aliasing, set
mutation, initial spend, RBF replacement, and legacy compatibility.

The isolated Core drill is described in `UTXOREF_V2_RESERVE_CPFP.md`.

## Independent Watcher Receipts

`utxoref_v2_watcher_quorum.js` signs a normalized observation containing a
coordinator round id, graph, trust policy, chain tip, authorization block,
assertion outpoint, fraud result, action, and challenge transaction. A quorum
policy binds each Ed25519 key to a watcher id and declared fault domain, and
can reject statements older than its block-age limit.

Aggregation fails closed on:

- duplicate watcher ids;
- reused signing keys;
- signatures from unallowlisted keys;
- a receipt claiming a different fault domain;
- fewer signatures than the threshold;
- fewer independent fault domains than required; or
- any disagreement about the normalized chain statement, including round id.

A watchtower emits its receipt when started with all three options:

```text
--watcher-id <id>
--watcher-fault-domain <domain>
--watcher-round-id <coordinator-round-id>
--watcher-private-key-file <ed25519-private-key.pem>
```

The cryptographic quorum is tested locally. Production independence still
requires deploying keys, nodes, RPC paths, and operators in genuinely
separate failure domains.

## Schema Limits And Benchmark

`strict_artifact_profiles.js` defines separate limits for public graph
artifacts, trust policies, watchtower state, fee reserves, reserve registries,
reserve CPFP guardian approvals, and watcher quorum bundles. The watchtower,
CPFP tools, and live staging path now select the expected profile before deeper
verification.

`strict_artifact_benchmark.js` generates near-limit objects and enforces a
2,000 ms per-profile and 256 MiB heap-growth release gate. On the local
11th-generation i5-11400H with Node 20.20.0, the 1.92 MB public graph profile
completed in 186.764 ms maximum across five measured iterations with
7,770,424 bytes maximum measured heap growth. Smaller profiles completed in
under 2 ms; the new guardian approval profile completed in 0.121 ms maximum.
The machine-readable result is
`artifacts/benchmarks/strict_artifact_profiles_latest.json`.

Timing is a local regression baseline, not a universal deadline guarantee.
CI and minimum production hardware should rerun the benchmark and tighten
the gate after full graph-verification timing is included.
