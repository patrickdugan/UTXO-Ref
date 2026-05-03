# UTXORef Production Gap And Live Path

Date: 2026-05-03

## Current Position

We have enough to demonstrate the UTXORef architecture credibly, but not enough
to call it production-complete.

The strongest current slice is:

- TradeLayer consensus/state data is compressed into a state oracle blob.
- A selected send resolves through a DLC-funder registry.
- The resolved route becomes deterministic UTXORef payout leaves.
- RPC preflight checks the funding input before a signer builds a sweep.
- The decoded final sweep output vector is hash-bound after finalization.
- Fraud, checkpoint, withdrawal queue, PNL, lease, watchtower, and dashboard
  artifacts verify deterministically.
- BitVMArena now has round-2 pressure tests against the integrated stack.

## What Is Still Missing

Production UTXORef still needs the hard edges:

- Bitcoin Script or BitVM circuit implementations for the JS referee predicates.
- Live happy-path and challenge-path spends for every route.
- Full TradeLayer parser/consensus state as the source of truth, not sample blobs.
- Wallet policy that shows and verifies route, final outputs, and future recovery.
- Watchtower persistence, reorg handling, retries, and alert delivery.
- Fee, dust, mempool, RBF/CPFP, timeout, and challenge-bond hardening.
- Operator recovery runbooks for challenge, timeout, sweep, and replay cases.

## Path To Make Real First

The next slice should be one narrow live path:

1. Fund a DLC/BitVM UTXORef input.
2. Publish or ingest a TradeLayer send state oracle.
3. Resolve the recipient through the DLC-funder registry.
4. Build the UTXORef sweep plan.
5. Decode the final transaction and bind its output vector to the route.
6. Emit dashboard-ready evidence with txids, hashes, and fraud challenge handles.
7. Keep every step replaceable with real RPC/testnet data.

## Acceptance Gate

This path is useful when one command can emit:

- funding outpoint
- selected TradeLayer send txid
- state oracle hash
- registry hash
- route transcript hash
- UTXORef withdrawal root
- final transaction output hash
- final spend binding hash
- stack hash
- dashboard view hash
- challengeable fraud proof ids

The proof object must fail verification if any final output, route transcript,
component hash, or challenge binding is tampered with.

## Work Started

This repo now adds a live-path evidence harness:

- `tradelayer_utxoref_live_path.js`
- `tradelayer_utxoref_live_path.test.js`
- `tradelayer_utxoref_live_path_demo.js`
- `artifacts/utxoref_live_path_latest.json`
- `artifacts/utxoref_live_path_latest.md`

The demo is deterministic today. The intended live swap points are:

- replace `SAMPLE_CONSENSUS_INPUT` with parser output
- replace the synthetic decoded transaction with `decoderawtransaction`
- attach the resulting final txid to the dashboard
- broadcast only after wallet policy verifies the final output hash
