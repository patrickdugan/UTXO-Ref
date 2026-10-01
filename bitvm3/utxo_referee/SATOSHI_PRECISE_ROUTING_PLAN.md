# Satoshi-Precise Routing Plan

## Objective

Make the BitVM settlement path feel 1:1 with native UTXO ownership by enforcing exact satoshi routing for:

- winner payout
- refund / remainder
- fee allocation
- dust carry

The target statement is:

`every routed settlement output is derivable from one exact-satoshi transition state and mechanically verifiable before acceptance`

## Current State

Working now:

- bounded settlement arithmetic is exact and uses `BigInt`
- expiry artifacts carry `settlementBreakdown`
- timeout proof exists on testnet and spends after the expiry height
- wallet explorer and FE both surface the settlement split

Still weak:

- the referee did not have one canonical verifier for exact payout/refund/fee routing

## Plan

1. Canonical routing verifier
- Add one verifier that derives exact output obligations from the transition state.
- Enforce satoshi conservation:
  `winnerSweep + refundRemainder + fee + dustCarry == collateral`

2. Latest-artifact validation
- Validate the latest draft settlement paths.
- Validate the latest expiry artifact against the challenge witness.
- Validate the latest timeout proof against the same routing model.

3. Naming alignment
- Move wallet route naming toward the referee vocabulary:
  `settle-gain`, `settle-loss`, `roll`
- Keep UI aliases only as presentation sugar.

4. Production hardening
- Bind actual recipient commitments for roll paths at the contract-definition layer.
- Keep the SHA256 circuit path bounded and operationally profiled so reporting and artifact generation remain usable.

## Executed In This Pass

- Added `deriveSettlementRouting(...)` and `verifySettlementRouting(...)` in `verify.js`
- Added `m1_routing_verifier.test.js`
- Added `m1_validate_latest_settlement.js`
- Aligned wallet-server route planning to `settle-gain` / `settle-loss` / `roll`
- Added explicit `timeoutRemainderSats` plumbing for roll-path bookkeeping
- Added first-class `winnerAddress` / `refundAddress` / `feeAddress` / `dustAddress` commitments to settlement paths and timeout proofs

## Exit Criteria

The path is acceptable for the current spec when:

- settlement routes are derived from one exact-satoshi state
- payout / refund / fee outputs match the derived obligations exactly
- latest artifacts validate automatically
- timeout recovery and bounded PnL routes share the same verifier semantics

## Remaining Production Gaps

- wallet-side product flows still need to consume the committed recipient map everywhere, not just the timeout proof harness
