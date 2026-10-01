# Taproot Assets Stablecoin Over Lightning With BitVM Liquidity

## Thesis

Use BitVM/DLC commitments to make a Taproot Assets Edge-node RFQ and Lightning liquidity promise externally auditable and challengeable.

This is a prototype evidence bundle for a wallet-facing demo. It does not
replace tapd/litd; it defines what the wallet or watchtower should be able to
verify after an Edge node quotes a Taproot Asset/BTC conversion and routes the
BTC side over Lightning.

## Asset

- Ticker: USDSIM
- Asset id: `c0e97dcfe12b443e3a46f415c1a80fffdc5e9f4a2e83d2f098cc72e10fe1abe3`
- Genesis point: `9f8b49a62ee446919657b21dd77686873972571c16807f8e8293d2393a2cdaff:0`
- Decimal display: 6
- Proof id: `f1401b7ba39a640244f04c6cf442fc577836df46dcc5c0a71961aa42c135da28`
- Universe root: `cd95007a0c95d9c16401418585b49b4ce18fa06e04c2fc2b4ea087830faa33fd`
- Anchor outpoint: `184300f44017c20a5a7c6ff0ae2e83411d3e5b7f479f5c9878a72ac4c8231330:1`

## RFQ / Edge Node Quote

- Quote id: `5f51ebc11f33c12028f25f7086871dc1ce5fd49e0edb8945b1da255ed2b7f4af`
- Edge node: tap-edge-node-regtest
- Asset units: 25000000
- BTC route amount: 49000 sats
- Max spread: 5000 ppm
- Quoted spread: 3000 ppm
- Max routing fee: 1200 ppm
- Quoted routing fee: 900 ppm
- Payment hash: `79cdbfa62ea28e4177514f55ae3f5d6e7dbdd780254a6aeff6428270cd5d1d3f`

## LN Settlement / BitVM Lease Evidence

- Settlement id: `3515540d48862243d873155cbfb7d8d9e5178228749b8116b1f6b066662a29bf`
- Delivered BTC: 49000 sats
- LN claim txid: `fd3e97d30b39c04dea7748cd5a7e8b057bf9e0f7656a6be7d9733c413828be43`
- Channel/splice outpoint: `fd3e97d30b39c04dea7748cd5a7e8b057bf9e0f7656a6be7d9733c413828be43:0`
- Liquidity lease bundle: `6b1278ad5dc15bf6d73f9d0ad40642581c13bd2f5f20926300c32a919dc7624b`
- Verification: ok

## Checks

- assetProofMatchesQuote: true
- deliveredAmountMet: true
- spreadCeilingMet: true
- routingFeeCeilingMet: true
- paymentHashMatched: true
- quoteNotExpired: true
- bitvmLeaseVerified: true

## Challenge Case

- Challenge id: `79f5cdc1ae6af9b61537caf20c7602e533af79a43460610a4c2d80c19a43408f`
- Slashable: true
- Violations: btc_route_amount_shortfall, spread_ppm_above_quote, routing_fee_ppm_above_quote, quote_expired_before_settlement

## Caveats

- The stablecoin issuer remains a separate trust assumption.
- This validates evidence shape and commitments; production would verify tapd proofs and litd RFQ messages directly.
- The edge node still performs the asset/BTC conversion; ordinary BTC Lightning routers do not need asset awareness.

## Primary References

- https://docs.lightning.engineering/the-lightning-network/taproot-assets/taproot-assets-protocol
- https://docs.lightning.engineering/the-lightning-network/taproot-assets/edge-nodes
- https://docs.lightning.engineering/lightning-network-tools/taproot-assets/rfq
