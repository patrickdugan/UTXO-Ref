# Lightning TradeLayer Oracle DLC

Bundle ID: `9ed10293bf4ffc0ea09253a806b77e77747a1043931345fca31b825f080ca50b`
Verification: ok

## Shape

- Bilateral DLC collateral is BTC-only and funded by Lightning hold-invoice receipts.
- No TAP asset path is present.
- TradeLayer tx14 OP_RETURN price publication is the oracle trigger.
- BitVM organizes the dispute path over payload inclusion, designated oracle provenance, the 5% solvency band, price bucket selection, and wrong-CET claims.

## TradeLayer Trigger

- Publish txid: `22accff5ad661d6bc9fcf8d972ef822305965da866f597dade40ac322124fd63`
- Payload: `tle1,aqzr7k`
- OP_RETURN script: `6a0b746c65312c61717a72376b`
- Oracle id: `1`
- Pair/price: `BTCUSD 65000`
- Designated publisher: `tb1qn75cnly6zn4540k7824rmw02eeylaygcpj49rs`
- Previous accepted mark: `64000`
- Max deviation: 500 bps
- Observed deviation: 156 bps (inside band)

## Contract

- Contract: `ln-tl-oracle-dlc-1`
- Oracle policy: designated address hash `87018922fc0036f87edff0e91f95a895f06b9031a3b7928a890b24fba9704673`, max move 500 bps
- Long party: `alice-long` / 50000 sats
- Short party: `bob-short` / 50000 sats
- Outcomes root: `bea7c5484aa69b560940bfe03d1302e84591d91e9a439221c2c81c8d73568dc4`

## Settlement

- Selected outcome: `price_at_entry`
- Long payout: 50000 sats
- Short payout: 50000 sats
- Settlement rail: `lightning`

## BitVM Organizer

- Organizer id: `d5f2a5da32d0b0f930ae98beb19dc701e7b9da2ad37e9b7b573ea5fce2aaced8`
- Circuit gates: 888
- Challenge violations in demo: wrong_cet_for_published_price

## Boundary

This is a deterministic protocol artifact. It does not validate all TradeLayer state; the in-protocol BitVM boundary is the designated oracle address plus a 5% maximum move from the previous accepted BTC/USD mark. A live build still needs raw transaction inclusion proofs, real Lightning node receipts, real oracle/admin key policy, and production challenge bond accounting.
