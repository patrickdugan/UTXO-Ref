# BitVM TradeLayer Next Ideas

Date: 2026-05-03

## 1. TradeLayer State Checkpoint Referee

Build an optimistic checkpoint referee that verifies a compact transition from
one TradeLayer state root to the next. It should bind the previous state root,
new state root, accepted txids, publisher identity, and fraud path material for
invalid or omitted transactions.

Prototype: `tradelayer_state_checkpoint_referee.js`

## 2. UTXORef Send Transcript Standard

Standardize the cross-domain transcript from TradeLayer tx to UTXO movement:

`TradeLayer tx -> state oracle -> route transcript -> UTXORef payout root -> PSBT/final tx`

The implementation target is one canonical hash that wallet flows, sweep plans,
RPC signing, and watchtowers can all verify.

## 3. TradeLayer Fraud Challenge Pack

Extend the current challenge bundle beyond happy-path accounting. The challenge
surface should include invalid tx type, malformed payload, wrong sender balance,
wrong UTXORef input/output, stale oracle snapshot, wrong DLC registry mapping,
wrong payout root, and wrong final sweep semantics.

## 4. BitVM Watchtower For TradeLayer

Build a lightweight scanner that watches state-oracle updates, route
transcripts, fraud bundles, sweep plans, wallet-flow hashes, and production
policy checks. It should emit challenge-ready reports when any artifact drifts
from the canonical transcript.

## 5. BitVM-Gated TradeLayer Withdrawal Queue

Batch withdrawals through a committed queue. TradeLayer consensus commits to the
queue root, UTXORef pays the batched outputs, and BitVM challenges omissions,
duplicates, amount changes, or destination changes.

Prototype: `tradelayer_withdrawal_queue_referee.js`

## 6. DLC/Perp PNL Settlement Referee

Bind derivative close state to UTXO movement: mark/VWAP source, position state,
close trade, PNL delta, token balance delta, and sweep destination. This keeps
the token accounting and UTXO movement synchronized.

Prototype: `tradelayer_perp_pnl_referee.js`

## 7. BitVM Liquidity Lease For Lightning

Model an enforceable liquidity lease where a provider commits a UTXO, a router
gets temporary routing rights, LN evidence proves usage, and BitVM challenges
wrong release or wrong settlement.

Prototype: `bitvm_liquidity_lease_referee.js`

## 8. Arena-Driven Security Report

Keep using BitVM Arena as a red-team harness. Each iteration should capture the
attack that passed, the protocol fix, the targeted scorer improvement, and the
remaining residual risk.

Prototype: `bitvm_arena_security_report.js`

## 9. Quirk-Indexed UTXORef Route Referee

Bind Jurassic Bitcoin quirk-isomorphism route candidates to live UTXORef reserve
evidence before admitting a BitVM route claim. This is now implemented as a
no-broadcast Bitcoin testnet4 demo.

Prototype:

- `quirk_indexed_route_referee.js`
- `quirk_indexed_route_demo.js`
- `QUIRK_INDEXED_ROUTE_REFEREE.md`

Current evidence:

- Confirmed BTCTEST4 `tlBTC` grant:
  `7dec37bebf56575abd5e3fb48e7fbe1c278cb7d1f78356fe0b2c4113b759464d`
- Live P2TR reserve outpoint:
  `93f953df2c89faf386d14217fb4d3de62d91d3789fee83cc53acfd653882f6a6:0`
- Accepted transcript-alias route claim.
- Accepted namespace-rotated route claim.
- Rejected mutated withdrawal root.
- Rejected unknown route transcript.

## 10. Carrier-Camouflaged Watchtower Cadence

Use the same quirk vocabulary to make watchtower publication cadence
challengeable without forcing every watcher report into an obvious protocol
carrier. The claim should bind an admitted route claim, live reserve witness,
watchtower epoch, expected cadence, semantic alert hash, and ordinary carrier
profile such as wallet sweep, rebalance, or payout batch.

This is now implemented as a no-broadcast demo.

Prototype:

- `camouflaged_watchtower_cadence_referee.js`
- `camouflaged_watchtower_cadence_demo.js`
- `CAMOUFLAGED_WATCHTOWER_CADENCE.md`

Acceptance cases:

- accept a sweep-like checkpoint for a live route claim
- accept a payout-batch checkpoint for the same semantic alert

Challenge cases:

- reject stale cadence checkpoints
- reject alert handles that point to the wrong route claim
- reject changed withdrawal roots or stale reserve evidence

## Current Focus

The immediate product spine is items 2-4 plus items 9-10 as the current
quirk-indexed BTCTEST4 bridge and watchtower cadence layer:

- one canonical transcript hash
- one fraud challenge bundle covering realistic invalid-state classes
- one watchtower report that detects drift and points to the right challenge
- one route-claim gate that binds Jurassic route candidates to live UTXORef
  reserve evidence
- one cadence gate that lets watcher publications use ordinary carrier profiles
  while remaining challengeable
