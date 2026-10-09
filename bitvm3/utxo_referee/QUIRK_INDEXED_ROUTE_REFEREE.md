# Quirk-Indexed Route Referee

Date: 2026-07-06

This prototype uses Jurassic Bitcoin quirk motifs as BitVM route-admission
controls for UTXORef. It does not change Bitcoin consensus, the Taproot reserve
vault script, or the guardian spend policy. It is an off-chain referee layer
that decides whether a route claim is admissible before UTXORef treats it as
valid application evidence.

## What It Proves

The demo binds three independent surfaces:

- A confirmed Bitcoin testnet4 `tlBTC` grant transaction.
- A live UTXORef Taproot reserve vault outpoint.
- Quirk-isomorphism route candidates generated from the Jurassic observer.

The key rule is:

```text
route transcript candidate != spend authority
```

A route becomes admissible only after it is bound to:

- `semanticStateHash` from the grant import.
- `liveTraceHash` from the live reserve import.
- `withdrawalRootHex` from the UTXORef withdrawal queue.
- `candidateFinalOutputVectorHash` from the expected payout vector.
- `reserveOutpoint` from live Bitcoin testnet4 chain evidence.
- CSV-safe reserve status from the live import.

## Motifs Used

`transcript_multiplicity`

Compact and full route transcripts can point to the same semantic spend state.
The demo accepts `accepted_transcript_alias_compact` when the alias claim still
matches the live reserve witness.

`identifier_bifurcation`

Public route handles can rotate while the committed state remains fixed. The
demo accepts `accepted_identifier_namespace_rotated` over the same grant state
and reserve outpoint.

`carrier_camouflage`

The visible Bitcoin carriers remain ordinary objects: an OP_RETURN grant
transaction and a P2TR reserve output. The route semantics live in manifests and
referee objects rather than new opcodes.

## Commands

From the Jurassic repo, refresh the Bitcoin testnet4 import:

```powershell
python .\scripts\bitcoin-testnet4\build_utxoref_live_import.py
```

From the UTXORef repo, run the no-broadcast demo:

```powershell
node .\bitvm3\utxo_referee\quirk_indexed_route_referee.test.js
node .\bitvm3\utxo_referee\quirk_indexed_route_demo.js
```

The demo writes:

```text
bitvm3/utxo_referee/artifacts/quirk_indexed_route/quirk_indexed_route_latest.json
bitvm3/utxo_referee/artifacts/quirk_indexed_route/quirk_indexed_route_latest.md
```

## Current Live Evidence

The current demo uses these Bitcoin testnet4 anchors:

- Grant txid: `7dec37bebf56575abd5e3fb48e7fbe1c278cb7d1f78356fe0b2c4113b759464d`
- Reserve outpoint: `93f953df2c89faf386d14217fb4d3de62d91d3789fee83cc53acfd653882f6a6:0`

Expected scenario outcomes:

- `accepted_transcript_alias_compact`: accepted.
- `accepted_identifier_namespace_rotated`: accepted.
- `rejected_mutated_withdrawal_root`: rejected with `withdrawal_root`.
- `rejected_unknown_route_transcript`: rejected with `route_transcript_candidate`.

## Why This Is Useful

This gives UTXORef a controlled way to consume flexible Binohash-style or
Jurassic-style transcript surfaces without confusing flexibility for authority.
The route hash can vary, the public handle can rotate, and the carrier can stay
ordinary, but the referee still requires live reserve evidence and exact payout
commitments before admission.

## Next Utilization Implemented: Carrier-Camouflaged Watchtower Cadence

The follow-up prototype uses carrier camouflage to make watchtower publication
cadence challengeable without forcing every watchtower report into an obvious
protocol-shaped transaction.

Implemented object:

```text
camouflaged_watchtower_cadence_claim_v1
```

It should bind:

- `reserveOutpoint`
- `liveTraceHash`
- `watchtowerEpoch`
- `expectedCadenceBlocks`
- `carrierProfile`
- `publicationHandle`
- `semanticAlertHash`
- `routeClaimHash`

Verifier behavior:

- Accept ordinary-looking carrier profiles such as wallet sweep, rebalance, or
  payout batch hints.
- Require the publication handle to resolve back to the same semantic alert
  hash and reserve witness.
- Reject missing cadence checkpoints, stale reserve evidence, changed payout
  roots, or alert handles that do not bind to the route claim.

Demo shape:

- One accepted watchtower checkpoint with a sweep-like carrier profile.
- One accepted checkpoint with a payout-batch profile.
- One rejected stale checkpoint.
- One rejected alert handle that points to the wrong route claim.

Run it with:

```powershell
node .\bitvm3\utxo_referee\camouflaged_watchtower_cadence_referee.test.js
node .\bitvm3\utxo_referee\camouflaged_watchtower_cadence_demo.js
```

Full note:

```text
bitvm3/utxo_referee/CAMOUFLAGED_WATCHTOWER_CADENCE.md
```

This was the natural next step because the quirk-indexed route referee admits
route claims. The watchtower cadence layer now monitors whether those admitted
claims are published and refreshed in a carrier-camouflaged but challengeable
way.
