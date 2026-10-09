# BitVM-Backed Lightning Liquidity Lease

## Thesis

Use BitVM/HTLC funding not to run Lightning, but to make a liquidity promise
enforceable: the LSP earns the lease premium only if the promised channel or
splice liquidity appears with the agreed fee and CLTV limits.

## Lease Offer

- Bundle id: `6b1278ad5dc15bf6d73f9d0ad40642581c13bd2f5f20926300c32a919dc7624b`
- Offer id: `c2f2ebe0c4b1e4eb29c66e5f42e97151d9d58f54af02f1c28d93ffdd763c8467`
- Payment hash: `79cdbfa62ea28e4177514f55ae3f5d6e7dbdd780254a6aeff6428270cd5d1d3f`
- Promised inbound: 49000 sats
- Lease window: 144 blocks
- Max fee: 1000 ppm
- Max CLTV delta: 40
- Penalty: 5000 sats
- Verification: ok

## Success Evidence

- Evidence id: `a6320c602fe759b97cf3cb36503ea3bc356309d22ddc8a525488cd88e9182081`
- Channel/splice outpoint: `fd3e97d30b39c04dea7748cd5a7e8b057bf9e0f7656a6be7d9733c413828be43:0`
- Funding commitment hash: `2ae94a2a96423191e3a47dd93dfe715f5f2a53b9657b2482d34ab47a9dbbe5b7`
- Observed inbound: 49000 sats
- Observed fee: 900 ppm

## Challenge Evidence

- Challenge id: `8cb6a560b5d3ce1a0179298d7b0fc14cdcb9547ceb016fbd645556fee40f811e`
- Slashable: true
- Violations: insufficient_inbound_capacity, fee_ppm_above_ceiling, cltv_delta_above_ceiling, missing_channel_or_splice_outpoint
- Penalty reason: insufficient_inbound_capacity,fee_ppm_above_ceiling,cltv_delta_above_ceiling,missing_channel_or_splice_outpoint

## Routing Use Cases

- LSP JIT inbound channel lease
- splice-in liquidity lease with penalty if unavailable
- route corridor capacity bond
- watchtower-audited route-quality SLA

## Caveats

- This proves committed lease terms and local regtest HTLC funding, not global route availability.
- Production needs privacy-preserving route evidence and LDK-native channel/splice state hooks.
