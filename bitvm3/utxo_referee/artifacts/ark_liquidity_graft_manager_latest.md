# Ark Liquidity Graft Manager With BitVM Enforcement

## Thesis

A manager can graft Ark VTXO liquidity onto Lightning edge routes while BitVM/UTXORef governs ASP pathing power and turns under-delivery into slashable evidence.

The manager is the operator-facing layer: it chooses Ark VTXOs, binds each to
a Lightning route quote, records settlement observations, and emits BitVM
challenge evidence when the ASP/LSP path fails.

## Inventory

- ASP: ark-asp-regtest
- Inventory id: `784f9d75b865489cecc44793078abad8dea70907bfab8f3b2769363b279582cd`
- Template commitment: `4716b2bdb61b84f225b94c4a77a8b5df580c46061cd8f682b99886e3bb566444`
- VTXOs available: 4
- Total VTXO sats: 350000

## BitVM Policy

- Policy id: `0b3d5de3a21a8c80a4b3479d67445aed0688e9e0f9fc767c4ea7fd712d34dfc6`
- Governor circuit: utxoref-ark-asp-pathing-v1
- ASP bond outpoint: `05af29075f6a5f32c382e795010b5c0805913070cbf0fbbb3342a2fb2ed75a38:0`
- Max ASP exposure: 400000 sats
- Slash reserve: 25000 sats
- Challenge window: 144 blocks
- Requires exit path: true
- Requires forfeit path: true

## Allocation

- Allocation id: `9c29824d2826da8c3141f365d5d5dc212b37dfda4641e7166305a2883148200c`
- Requested inbound: 225000 sats
- Assigned inbound: 225000 sats
- Delivered inbound: 190000 sats
- Settled assignments: 2
- Slashable assignments: 1
- Unmet routes: 0

### ldk-edge-a-inbound

- Status: settled
- Assignment id: `909e39ace1e0d6d3dc9235f405595cb1149c48728745c8d468348cf6cd5fc502`
- VTXO commitment: `6eee3e4f74288d45aa25505e07afe3b2c4a500150605885759a8a875eba92e4d`
- Quote id: `dd28aeff3e279337ba71b5b1bad68409e5637f9a7017533dab47a0f4430d84da`
- Promised inbound: 50000 sats
- Delivered inbound: 50000 sats
- Settlement id: `4817edc177d97aaf7d6cb34141ea25690948efdb302457ae8f0a758742755f63`
- Challenge id: `4d433456727a45066a2bb5afde32529d5d3510a8f2dc4512ad082395518ec473`
- Challengeable: false
- Violations: none

### ldk-edge-b-inbound

- Status: settled
- Assignment id: `61cc42b2f7da42dfe4fae6d20febf50e7de6086c4d64de4559f57c6223b0f79d`
- VTXO commitment: `839fa01db0833fd7ad1a8751a132c7fb7ba080db3a8c3a844fd0bd7c0abc8e33`
- Quote id: `71929c14e6b46dd797d122afb810e7b422939d2f05bea6b225fc34db1db4bdcc`
- Promised inbound: 75000 sats
- Delivered inbound: 75000 sats
- Settlement id: `9e8b5458ed38ba482fde2c339443f6f7a3206056cc21bae05551ab9f81d5e02e`
- Challenge id: `44bca32a6278ac09572eb3ffd46a0e3a15876843d01e168bc3d889b83e7128ce`
- Challengeable: false
- Violations: none

### ldk-edge-c-inbound

- Status: slashable
- Assignment id: `26dd24d430d19aab25b703c172c6c568ff936b4788830a4820137b8fbbe5284e`
- VTXO commitment: `e42e0bfeb1f57f02b3eabb6c28a0036debad77ff967200999c24f8da3229ffe2`
- Quote id: `de351fc5d905bb6df91bfadca214f3e98de87901b95a2e3c945ab12fe6eaae83`
- Promised inbound: 100000 sats
- Delivered inbound: 65000 sats
- Settlement id: `773d5f0a11ae25df6470e2f23a53f909da9b6bcc94d6e87c4aedb904d2e45f35`
- Challenge id: `3bfd7a70f2c837e8a9b91b54c1e5e5b21cd9adae94a20df5d0506b9015825f46`
- Challengeable: true
- Violations: insufficient_ark_grafted_liquidity, fee_ppm_above_graft_quote, cltv_delta_above_graft_quote, missing_ark_forfeit_path


## Manager Challenge

- Challenge id: `ed3242b13370c882d124b4777a827d9ba06d1e69e9b164658a901fe4cd7b250c`
- Slashable: true
- Violations: assignment_liquidity_obligation_failed
- Remedy: slash ASP bond or force Ark exit/forfeit path through UTXORef challenge

## Cost Model

- Grafts modeled: 3
- Average graft amount: 75000 sats
- Baseline per graft: 13290 sats
- Ark per graft: 370 sats
- Baseline total: 39870 sats
- Ark total: 26110 sats
- Savings: 13760 sats
- Lower total cost: true

## Verification

- Result: ok

## Caveats

- This is a deterministic evidence-shape prototype, not a live ASP integration.
- Production needs real Ark round signatures, VTXO membership proofs, LDK/LND route observations, and BitVM challenge transaction construction.
- The manager optimizes fee surface and enforcement, but it does not create net liquidity; it reallocates pledged liquidity with stronger failure handling.
