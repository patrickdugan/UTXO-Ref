# Camouflaged Watchtower Cadence Referee

Date: 2026-07-06

This prototype makes watchtower checkpoint cadence challengeable while allowing
ordinary-looking publication profiles. It builds on the quirk-indexed route
referee: a watchtower cadence claim is not admissible unless it references an
already-admitted route claim and the same live Bitcoin testnet4 reserve witness.

## What It Proves

Carrier camouflage can be used as a watchtower publication surface without
turning camouflage into authority.

The accepted checkpoint must bind:

- `routeClaimHash` from an admitted quirk-indexed route claim.
- `reserveOutpoint` from the live UTXORef vault.
- `liveTraceHash` from the current live import.
- `watchtowerEpoch`.
- `expectedCadenceBlocks`.
- `publicationHeight`.
- `carrierProfile`.
- `publicationHandle`.
- `semanticAlertHash`.

The semantic alert hash is independent of the carrier handle:

```text
semanticAlertHash = hash(routeClaimHash, reserveOutpoint, watchtowerEpoch)
```

That lets the publication handle rotate between ordinary-looking carrier
profiles while the alert core stays fixed.

## Carrier Profiles

The first implementation admits:

- `wallet_sweep_checkpoint`
- `payout_batch_checkpoint`
- `rebalance_checkpoint`

These are labels for the publication surface. The verifier does not claim that
the carrier transaction itself enforces watchtower semantics. The semantics are
enforced by the referee object and its challenge evidence.

## Commands

Refresh the route artifact first:

```powershell
node .\bitvm3\utxo_referee\quirk_indexed_route_demo.js
```

Run the cadence test and demo:

```powershell
node .\bitvm3\utxo_referee\camouflaged_watchtower_cadence_referee.test.js
node .\bitvm3\utxo_referee\camouflaged_watchtower_cadence_demo.js
```

The demo writes:

```text
bitvm3/utxo_referee/artifacts/camouflaged_watchtower_cadence/camouflaged_watchtower_cadence_latest.json
bitvm3/utxo_referee/artifacts/camouflaged_watchtower_cadence/camouflaged_watchtower_cadence_latest.md
```

## Demo Outcomes

Expected accepted cases:

- `accepted_sweep_like_checkpoint`
- `accepted_payout_batch_checkpoint`

Expected rejected cases:

- `rejected_stale_checkpoint` with `cadence_freshness`.
- `rejected_wrong_alert_handle_route` with `publication_handle_binding`.

The unit test also covers:

- non-admitted route claims;
- stale or non-countable reserve evidence;
- challenge evidence generation for rejected checkpoints.

## Why This Is The Next Utilization

The quirk-indexed route referee answers whether a flexible route transcript is
admissible. The cadence referee answers whether watchers are publishing timely,
bound observations of that admitted route while preserving carrier camouflage.

Together they form a two-stage BitVM/UTXORef pattern:

```text
quirk route candidate -> live reserve-bound route claim -> camouflaged watchtower cadence claim
```

This is useful for any UTXORef deployment that wants watcher reports to be
auditable and challengeable without forcing every report into an obvious
protocol-shaped carrier.
