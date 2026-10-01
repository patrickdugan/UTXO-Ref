# TradeLayer PNL State Netting

This is the v1 bridge between a TradeLayer state-oracle update and the
UTXORef/BitVM payout path.

## Current Flow

```text
TradeLayer state oracle update
  -> recomputed bilateral PNL rows
  -> gross loser-to-winner transfer graph
  -> netted counterparty graph
  -> final payable output plan
  -> UTXORef payout root
  -> BitVM/referee fraud challenge surface
```

The implementation is in `tradelayer_pnl_state_netting.js`.

The module does not replay all TradeLayer consensus. It assumes the state oracle
has already selected consensus-valid positions and marks. It then recomputes the
PNL arithmetic deterministically and folds the graph into final payable outputs.

## What It Handles

- Bilateral perp PNL rows from one state-oracle update.
- Long/short arithmetic with collateral caps.
- Gross directed edges from loser to winner.
- Counterparty netting into final payers and receivers.
- Optional live-payee filtering.
- Optional account-to-settlement-address mapping.
- UTXORef payout commitment generation using the existing route adapter.
- Challenge records for omitted rows, invalid rows, wrong arithmetic, wrong
  netting edges, wrong final recipients, and wrong oracle hashes.

## What Remains Outside The Module

- Full TradeLayer consensus replay.
- Proof that the oracle included every valid position unless challengers supply
  an omitted-row witness.
- Real signing policy for the state oracle.
- Multi-input transaction construction for pulling collateral from many DLC
  UTXOs.
- Production bond/slash accounting for the BitVM challenge game.

## Demo Claim

The demo can now honestly say that UTXORef supports a deterministic PNL netting
layer: a state oracle publishes valid PNL rows, the referee recomputes bilateral
losses and gains, folds them into a smaller final payment set, and binds that
payment set into a UTXORef payout root that can be challenged if the route is
wrong.
