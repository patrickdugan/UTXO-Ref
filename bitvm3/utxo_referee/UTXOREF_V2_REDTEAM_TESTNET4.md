# UTXORef V2 Testnet4 Red-Team Report

Date: 2026-07-12

## Scope

Three independent review agents covered:

1. BitVM trace, assertion graph, signatures, payouts, and NUMS construction.
2. RBF, CPFP, package policy, propagation, and transaction identity.
3. Watchtower state, trust anchors, reorgs, RPC consistency, and deployment.

Local probes used mocks or isolated regtest where an attack could mutate chain
state. Public testnet4 activity was limited to the already authorized funded
fee-rescue drill and read-only observation after broadcast.

## Live Adversarial Outcome

The public-chain run produced a useful mempool-partition failure:

- Funding: `389307d5195a1fcf8854d469f34b162afc3603fea4b15ac3319df1d224851469`
- Confirmed challenge: `96f52e7120f3ce53e349e9aa51fcf8b1ae36dfc5f5da4b51f3a9a5ff9b8a0482`
- Original CPFP child: `0a4233b97346525188e99f5214e700be0d69b0ffbeb6756f689027afb86b970d`
- Locally accepted replacement child: `5a37264a3becf0fa11872ae5087aa44493518c585322438bfad8da9dda33ce92`

The local full-RBF node accepted the 2,000-sat child replacement. A miner with
the original 500-sat child mined that original instead. Funding, challenge,
and original child confirmed together at height 143,874 in block
`0000000000b062de482e9159dd8f829a3e13d19a1cfbb223520ac4a7e00bbe97`.
The replacement became conflicted with `-5` wallet confirmations.

The pre-fix watcher reported the replacement missing. The remediated watcher
searches replacement history, verifies candidate amount and script against
Core, restores the confirmed winner, and records the losing txid.

## Reproduced Attacks And Controls

| ID | Severity | Attack | Baseline | Control |
|---|---|---|---|---|
| RT-01 | Critical | Empty/vacuous BitVM circuit | Accepted | Require gates, primary inputs, one terminal, no cycles/orphans/duplicate producers |
| RT-02 | High | Equal or cross-wire commitment hashes | Accepted | Require distinct globally unique bit commitments |
| RT-03 | Medium | Spoofed payout request hash | Accepted | Recompute domain-separated hash from request ID |
| RT-04 | High | Fabricated CPFP challenge state | Plan constructed | Reconstruct challenge txid from pinned artifact assertion, fee, amount, sequence, and script |
| RT-05 | High | State/Core output contradiction | Watcher accepted | Bind every observed output amount and script to state |
| RT-06 | Medium | Wallet returns mutated signed CPFP | Could reach sender | Decode and verify exact signed input/output/sequence/txid before broadcast |
| RT-07 | Critical | Artifact nominates its own signer/genesis | Accepted | Separate trust policy pins genesis, signer key, and graph-to-signer mapping |
| RT-08 | High | Checkpoint stale at current tip | Historical freshness passed | Current-tip freshness disables new authority |
| RT-09 | High | Forged graph-only state enables monitoring-only | Accepted | Monitoring-only requires a fully reconstructible challenge transaction |
| RT-10 | Low | Authenticated proxy receives `null`/array/scalar | Dereference hazard | Bounded payload validation and 400/403/413 responses |
| RT-11 | High | Superseded CPFP wins remotely | Watcher lost winner | Replacement-history conflict reconciliation |
| RT-12 | Medium | Mixed sequential RPC chain snapshot | Could record wrong height | Require `gettxout.bestblock` to match tick tip |
| RT-13 | High | Unknown assertion disappearance | Silently suppressed | Alert as `assertion_spent_unresolved` |

## Trust Boundary After Remediation

The public ceremony artifact is data, not a trust root. The separately
installed `utxoref_v2_watchtower_trust_policy.json` pins:

- network and chain genesis;
- trusted Ed25519 public keys;
- each allowed graph hash and its signer.

The service installer refuses activation without this policy. New challenge
or replacement authority also requires a canonical authorization block and a
checkpoint no more than six blocks old at the current tip. An existing fully
bound challenge can remain observable after reorg or staleness, but that mode
cannot authorize a new spend.

## Residual Risks

1. State and alert files are atomic but not MACed or hash-chained; filesystem
   rollback/truncation remains detectable only through external operations.
2. The daemon watches one selected artifact at a time. The trust policy blocks
   unauthorized graph switching, but a multi-graph registry is not built.
3. `assertion_spent_unresolved` now alerts, but the filtered RPC surface does
   not identify a confirmed unknown spender on a pruned node.
4. Fee ladders are bounded absolute fees, not a complete ancestor/descendant,
   eviction-fee, and relay-partition package model.
5. The circuit validates structural completeness, not the full semantics of
   TradeLayer consensus. External facts remain inside the challenger trust
   boundary.
6. NUMS prevents a practical key-path spend under the discrete-log and
   hash-to-curve assumptions; Taproot does not literally disable key-path
   consensus spending.

## Evidence

- Live receipt: `artifacts/live/btc_testnet4_utxoref_v2_fee_rescue_latest.json`
- Machine report: `artifacts/live/btc_testnet4_utxoref_v2_redteam_latest.json`
- Trust policy: `artifacts/live/utxoref_v2_watchtower_trust_policy.json`
- Reorg receipt: `artifacts/live/utxoref_v2_regtest_reorg_latest.json`
- Focused suites: 62 tests across state, trace, graph, watcher, CPFP, RPC proxy,
  and RPC sweep behavior.

This is evidence for a testnet alpha. It is not an external audit or a mainnet
custody approval.
