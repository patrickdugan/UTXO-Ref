# Lightning TradeLayer Oracle DLC

Bundle ID: `16184ea4faa9da25e46ad13a6083a7ccf7b6a376016ad4e74a23655ea6c5047f`
Verification: ok

## Shape

- Bilateral DLC collateral is BTC-only and funded by Lightning hold-invoice receipts.
- No TAP asset path is present.
- TradeLayer tx14 OP_RETURN price publication is the oracle trigger.
- BitVM organizes the dispute path over payload inclusion, price bucket selection, and wrong-CET claims.

## TradeLayer Trigger

- Publish txid: `22accff5ad661d6bc9fcf8d972ef822305965da866f597dade40ac322124fd63`
- Payload: `tle1,aqzr7k`
- OP_RETURN script: `6a0b746c65312c61717a72376b`
- Oracle id: `1`
- Pair/price: `BTCUSD 65000`

## Contract

- Contract: `ln-tl-oracle-dlc-1`
- Long party: `alice-long` / 50000 sats
- Short party: `bob-short` / 50000 sats
- Outcomes root: `bea7c5484aa69b560940bfe03d1302e84591d91e9a439221c2c81c8d73568dc4`

## Settlement

- Selected outcome: `price_at_entry`
- Long payout: 50000 sats
- Short payout: 50000 sats
- Settlement rail: `lightning`

## BitVM Organizer

- Organizer id: `4bdfa8090bbbadfcd1758fffb3808eee31b5d470f585f08462640f0afcb05c14`
- Circuit gates: 680
- Challenge violations in demo: wrong_cet_for_published_price

## Boundary

This is a deterministic protocol artifact. A live build still needs raw transaction inclusion proofs, real Lightning node receipts, real oracle/admin key policy, and production challenge bond accounting.
