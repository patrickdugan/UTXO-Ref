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

## Current Focus

The immediate product spine is items 2-4:

- one canonical transcript hash
- one fraud challenge bundle covering realistic invalid-state classes
- one watchtower report that detects drift and points to the right challenge
