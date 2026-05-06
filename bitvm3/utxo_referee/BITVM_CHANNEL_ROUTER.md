# BitVM Channel Router

This prototype turns the existing UTXORef examples into an automated routing
surface for BitVM-backed Lightning capacity.

It does not replace Lightning pathfinding. It sits beside a wallet/node/LSP and
answers a narrower question:

> Which UTXORef-backed channel shard should be reserved, verified, monitored,
> and challenged if the promised route observation fails?

## Inputs

The router normalizes these examples into channel candidates:

- `lightning_liquidity_lease_latest.json`: direct channel/splice liquidity proof.
- `ark_liquidity_graft_manager_latest.json`: Ark VTXO graft assignments.
- `lnbtc_tlusd_liquidity_patch_latest.json`: Taproot Asset-backed liquidity patch assignments.
- `utxoref_dlc_subswap_funding_latest.json`: DLC submarine-swap funding rail.

Each candidate becomes a canonical `bitvm_channel_router_candidate` with:

- available sats
- fee ppm
- CLTV delta
- source type
- proof refs
- challenge refs
- carrier hint
- Jurassic namespace/transcript metadata

## Router Behavior

`buildBitvmChannelRouterBundle()` builds a deterministic route plan:

1. Verify candidate IDs and inventory ID.
2. Filter channels that are slashable, over fee, over CLTV, or not usable for
   the requested purpose.
3. Score eligible channels by source preference, priority, settled status,
   fee, CLTV, and useful capacity.
4. Split the requested amount across the best candidates.
5. Emit an automation queue for reservation, monitoring, and challenge prep.

The demo target is 120,000 sats. With the current artifacts, the router selects:

- 49,000 sats from the direct liquidity lease
- 50,000 sats from an Ark graft assignment
- 21,000 sats from a tlUSD liquidity patch assignment

Slashable Ark/tlUSD assignments are skipped but retained as challenge refs.

## Jurassic Motifs

- Transcript multiplicity: route plan, proof transcript, and challenge
  transcript are separate but cross-bound.
- Identifier bifurcation: router ID, channel ID, proof refs, and challenge refs
  are distinct hashes.
- Carrier camouflage: the route remains ordinary Lightning/Ark/Taproot/P2WSH
  material instead of a new consensus primitive.

## Commands

```powershell
node bitvm3\utxo_referee\bitvm_channel_router.test.js
node bitvm3\utxo_referee\bitvm_channel_router_demo.js
```

Artifacts:

- `bitvm3/utxo_referee/artifacts/bitvm_channel_router_latest.json`
- `bitvm3/utxo_referee/artifacts/bitvm_channel_router_latest.md`

Sidecar endpoints:

```text
GET  /v1/bitvm-channel-router/latest
GET  /v1/bitvm-channel-router/wallet-view
POST /v1/bitvm-channel-router/quote
POST /v1/bitvm-channel-router/verify
```

## Production Gap

This is still an evidence-shape router. A live router would need wallet/node
hooks that:

- lock selected liquidity shards before a payment attempt
- subscribe to real LDK/LND/CLN channel and route events
- refresh Ark/Taproot/DLC proof refs after each route observation
- construct real challenge transactions when a selected channel violates policy
