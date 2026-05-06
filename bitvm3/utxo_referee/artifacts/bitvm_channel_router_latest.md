# BitVM Channel Router

Created: 2026-05-04T13:54:28.388Z

## Router View

- Status: ready
- Router id: `4a8a63970aa09e201ee067d434b430cb51c3297a971544cd545018291c070676`
- Route intent id: `620a423f6f892c89df6c2b5d6591bc54cfe5fac7b94e40a061cf212beeb4dee2`
- Target amount: 120000 sats
- Assigned amount: 120000 sats
- Shortfall: 0 sats
- Max fee: 1200 ppm
- Max CLTV delta: 45
- Verification: ok

## Selected Shards

### lease:lease-subswap-dlc-1777153762725

- Source: liquidity_lease
- Channel id: `c14d42c8059c1b757913579dec2050aeeecac50a7d19e14b442f67533683800a`
- Assigned: 49000 sats
- Fee: 900 ppm
- CLTV delta: 34
- Status: settled

### ldk-edge-a-inbound

- Source: ark_graft_manager
- Channel id: `c1766ab27e059498c2d7097cee344cbe17a093593fcd858fd547b9bfb118d39e`
- Assigned: 50000 sats
- Fee: 900 ppm
- CLTV delta: 40
- Status: settled

### tlusd-edge-a-patch

- Source: tlusd_liquidity_patch
- Channel id: `75cf01a4f75bc9d8416c63c306fe8c3f6bef5f2a6321663becceb7102f7f650a`
- Assigned: 21000 sats
- Fee: 900 ppm
- CLTV delta: 40
- Status: settled


## Skipped Slashable Channels

- ldk-edge-c-inbound: `7595d5901b14af0b074c6318fd656c6cf10ecbbf16ed6fe3ad2bccde12511238` (3bfd7a70f2c837e8a9b91b54c1e5e5b21cd9adae94a20df5d0506b9015825f46)
- tlusd-edge-b-patch: `a4827c6c7fbfd72b5a1ad823fb25989b7378ac7524c7bb43f0780c22331246c2` (5fbd7d05f498c40ed41f602ad0613287c14b200ce81c2f8031d5286ce631f86d)

## Automation Queue

### Preflight

- verify inventory candidate ids
- filter slashable or over-fee channels
- score eligible BitVM-backed channels
- reserve route shards until the requested amount is covered

### Execute

- reserve_bitvm_channel_shard: 49000 sats on `lease:lease-subswap-dlc-1777153762725` via `c14d42c8059c1b757913579dec2050aeeecac50a7d19e14b442f67533683800a`
- reserve_bitvm_channel_shard: 50000 sats on `ldk-edge-a-inbound` via `c1766ab27e059498c2d7097cee344cbe17a093593fcd858fd547b9bfb118d39e`
- reserve_bitvm_channel_shard: 21000 sats on `tlusd-edge-a-patch` via `75cf01a4f75bc9d8416c63c306fe8c3f6bef5f2a6321663becceb7102f7f650a`

### Monitor

- watch route observations for delivered inbound capacity
- refresh channel/splice, Ark, and Taproot Asset proof refs
- prepare challenge transactions when a selected proof stops matching policy

## Jurassic Motif Use

- Transcript multiplicity: Every shard keeps a public route transcript and a separate proof/challenge transcript.
- Identifier bifurcation: The router id, public channel ids, private proof refs, and challenge refs are independently hashed but cross-bound.
- Carrier camouflage: The selected routes stay inside ordinary LN channel/splice evidence, Ark VTXOs, Taproot Asset proofs, and P2WSH HTLC funding outputs.

## What This Automates

The router does not replace Lightning pathfinding. It automates the UTXORef side
of route selection: which BitVM-backed channel, Ark graft, Taproot Asset-backed
patch, or DLC funding rail should be reserved, verified, monitored, and
challenged if the promised route observation fails.
