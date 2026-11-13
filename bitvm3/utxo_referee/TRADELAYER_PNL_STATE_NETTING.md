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

## Verification contract, 2026-11-13

The verifier requires the caller's independently authenticated source snapshot:

```js
const result = verifyTradeLayerPnlNettingSettlement(candidate, {
  stateOracleBlob: authenticatedSource,
  expectedStateOracleHash: independentlyPinnedHash
});
```

It rebuilds PnL, destinations and the payout commitment from that source.
Verification rejects changed recipients, omitted source rows, duplicate position
IDs, an absent funding outpoint, and altered arithmetic defaults even when the
candidate recomputes its hashes. Challenge builders take the same arguments
under `verifyOptions`. The source epoch now enters payout leaves, so the revised
builder produces new commitment hashes.

Verification snapshots options, source records and candidate fields through a
descriptor-aware plain-data boundary. Accessors, executable `toJSON` hooks and
Proxies are rejected before they run. Payout proof siblings support the
builder's 32-byte Buffers and their plain JSON encodings.

This adapter covers a single fungible satoshi pool and one declared funding
input. Explicit asset, vault or netting-set metadata is rejected here. Its
success result includes `reserveFeasibilityVerified: false`; callers must still
authenticate the source and establish its completeness.

For explicit collateral domains, several funding vaults, retained claims and
recipient eligibility, use `tradelayer_pnl_batch_settlement.js`. Its flow gate
checks every payout and residual vault output against the complete selected
input set. See [PNL batch netting](../../docs/PNL_BATCH_NETTING.md) for the
equations, schema, ZK statement and execution boundary.

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

## Evidence scope

The source-replay tests use local fixtures. They establish deterministic
arithmetic and recipient binding under the supplied snapshot. Funded Bitcoin
execution and cryptographic batch-proof verification require their own adapters.
