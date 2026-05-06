# Ark-Assisted LN Liquidity Graft With BitVM Enforcement

## Thesis

Use Ark VTXOs as fast temporary liquidity grafts for LN edge routes, reducing fee volatility while BitVM/DLC commitments enforce the liquidity lease if the ASP/LSP fails.

The Ark VTXO is used as a fast liquidity graft for an LN edge route. The
existing BitVM/DLC lease remains the challengeable enforcement layer.

## Ark Template

- ASP: ark-asp-regtest
- Template id: ark-template-ln-graft-v1
- Template commitment: `a1a2b593d15f00661331ca6750993b636ba047f8a0542680807b11a1c00d5450`
- Taproot output key: `08f5770abebad01937684b86083f9420fcca3673387bb0f48a5c962d4555a257`
- Leaf roles: batch-settle, user-exit, asp-forfeit
- Exit delay: 144 blocks
- ASP forfeit CSV: 2000

## Ark VTXO Liquidity

- VTXO commitment: `6cb4b0d789dd37bef975e8c941a78d7cf99b2d0481135a86dc21ee2547566430`
- VTXO id: `9b3e83666ca1cd70db1e1b357900be12eca1374c9dc4598841dec8504a181657`
- Amount: 49000 sats
- Round id: ark-round-regtest-liquidity-1
- Connector: `5aa4f53f63183762df39c40c3cf96f3bd969e6cabb9eef36fc6be3931fa3d86b:0`
- Exit txid: `ff3badd5e631b5c5ff7a3664ce3d641e703504fea5e10c9a88590df36f3ec2a2`
- Forfeit txid: `a88d873707d543e669bd74d20d045140d382f896750d882165766e8659c7ca1a`

## LN Graft Quote

- Quote id: `3de7de5c64e3b1c970b098d83b4e21a7482cc9593273b859892748e936c34ba7`
- Promised inbound: 49000 sats
- Lease window: 144 blocks
- Max fee: 1000 ppm
- Max CLTV delta: 40
- Premium: 750 sats
- Payment hash: `79cdbfa62ea28e4177514f55ae3f5d6e7dbdd780254a6aeff6428270cd5d1d3f`

## Settlement Evidence

- Settlement id: `001b7362859f27459fde72601cc97a7fc43172dc6e0579f6bb3c680865c30e20`
- Delivered inbound: 49000 sats
- LN claim txid: `fd3e97d30b39c04dea7748cd5a7e8b057bf9e0f7656a6be7d9733c413828be43`
- Channel/splice outpoint: `fd3e97d30b39c04dea7748cd5a7e8b057bf9e0f7656a6be7d9733c413828be43:0`
- BitVM lease bundle: `6b1278ad5dc15bf6d73f9d0ad40642581c13bd2f5f20926300c32a919dc7624b`
- Verification: ok

## Marginal Cost Model

- Grafts modeled: 24
- Graft amount: 49000 sats
- Fee rate: 25 sat/vB
- Baseline per graft: 13259 sats
- Ark per graft: 473 sats
- Baseline total: 318216 sats
- Ark total: 16352 sats
- Savings: 301864 sats (94.86%)
- Break-even graft count: 1
- Safer marginal cost: true

## Checks

- templateBindsVtxo: true
- vtxoCoversPromisedInbound: true
- deliveredInboundMet: true
- feeCeilingMet: true
- cltvCeilingMet: true
- paymentHashMatched: true
- arkExitPathPresent: true
- arkForfeitPathPresent: true
- bitvmLeaseVerified: true

## Challenge Case

- Challenge id: `c6683623ae12a58ec13858ef5715724a249c3788e957c88c7cea9e3246485831`
- Slashable: true
- Violations: insufficient_ark_grafted_liquidity, fee_ppm_above_graft_quote, cltv_delta_above_graft_quote, missing_ark_forfeit_path

## Caveats

- This validates evidence shape and local regtest settlement references, not a production Ark round.
- Production needs real ASP signatures, VTXO tree proofs, connector tracking, and forfeit/exit validation.
- The BitVM lease remains the external challenge layer; Ark supplies the fast liquidity surface.

## References

- https://ark-protocol.org/intro/vtxos/index.html
- https://ark-protocol.org/intro/connectors/index.html
- https://docs.arklabs.xyz/ark/FAQ/
