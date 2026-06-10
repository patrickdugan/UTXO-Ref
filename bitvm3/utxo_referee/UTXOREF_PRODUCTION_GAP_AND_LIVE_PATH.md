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

## Reserve Reconciliation (added 2026-06-10)

The deposit side and the withdrawal side are now reconciled against each other.
Previously the withdrawal queue committed to a cap that was just the sum of
approved requests, with no check that the tokenized reserve could cover it.

- `tradelayer_reserve_reconciliation_referee.js` enforces the peg invariant
  `sum(payable withdrawals) <= sum(credited deposit reserve)` as a verifiable,
  tamper-evident commitment.
- Reserve can be supplied explicitly, derived from a `ReceiptDepositIndexer`
  snapshot (credited deposits only), or from a `ReceiptLedger` snapshot.
- `buildTradeLayerReserveInsolvencyChallenge` packages a challengeable proof when
  the committed cap exceeds the proven reserve (shortfall > 0).
- The withdrawal queue itself is now fail-closed: only `approved`/`settled`
  statuses are payable (an unknown/pending status no longer becomes a payout),
  and two distinct request ids producing the identical payout leaf are rejected
  as a double-pay, while one send txid may still fan out to distinct recipients.

The reconciliation is now bound into the stack bundle and the production policy
gate: the gate emits `pause_spend` on insolvency, the dashboard flips to
`needs_attention` and lists `reserve_insolvency` as challengeable, and the
reconciliation hash is folded into the stack hash. Evidence still verifies when
insolvent; it is the spend gate that pauses.

### Live reserve (added 2026-06-10, real LTCTEST data)

The reserve is no longer a placeholder. `tradelayer_live_reserve_adapter.js`
turns Litecoin Core `listunspent` output into a credited `ReceiptDepositIndexer`
snapshot, which feeds the reconciliation as the `receipt-deposit-indexer`
source. `tradelayer_live_reserve_demo.js` is a one-command driver:

```powershell
# node running: litecoind -testnet -rpcport=19332 -rpcuser=user -rpcpassword=pass -server -datadir=D:\testnetwallet
node bitvm3/utxo_referee/tradelayer_live_reserve_demo.js `
  --rpc-url http://127.0.0.1:19332 --rpc-user user --rpc-pass pass --wallet tl-wallet
```

Verified live against a fully synced testnet node (tip ~4,761,052):
- `tl-wallet`: 42 real role UTXOs = 17,164,718 sats credited reserve, cap 99,000,
  margin 17,065,718 -> solvent -> `allow_sweep`, dashboard `ready`.
- `funding` (empty wallet): 0 sats reserve, cap 99,000, margin -99,000 ->
  insolvent -> `pause_spend`, dashboard `needs_attention`.

Captured live inputs: `artifacts/live/tl_wallet_unspent.json` (snapshot) and
`artifacts/live/reserve_reconciliation_latest.json` (result).

### Live sweep decode (added 2026-06-10, real Core decoderawtransaction)

The final sweep tx is no longer synthetic either. Using a real funded wallet.dat
UTXO as the DLC funding input, the route plan derives concrete outputs, a raw
sweep tx is built with Core `createrawtransaction`, and the live-path harness
decodes it through Core `decoderawtransaction` and reviews the decoded outputs
against the plan:

```powershell
node bitvm3/utxo_referee/tradelayer_utxoref_live_path_demo.js `
  --input bitvm3/utxo_referee/artifacts/live/live_consensus_input.json `
  --final-hex <raw sweep hex> `
  --rpc-url http://127.0.0.1:19332 --rpc-user user --rpc-pass pass `
  --out bitvm3/utxo_referee/artifacts/live/utxoref_live_path_realtx.json `
  --md  bitvm3/utxo_referee/artifacts/live/utxoref_live_path_realtx.md
```

Verified live (`verification=ok`, `finalOutputReview=ok`):
- Funding outpoint: `ac2518f11bff1c6f229b9431dbc91d0f0d280dcde2b90de7e46c627a8b5dbbae:0`
  (real, 960,560 sats).
- Outputs: 240,140 sats to the DLC funding address (tl-wallet) + 719,420 sats
  refund to the funding address (wallet.dat), fee 1,000.
- `finalTxOutputHash` now comes from a genuine Core decode, not the deterministic
  builder.

The sweep was then signed (`signrawtransactionwithwallet`) and broadcast
(`sendrawtransaction`) — both outputs are wallet-owned, so it is recoverable:

- Broadcast sweep txid:
  `3e8d784efab4a8b65d127267b441bfdf4a28aff7b46fa90c05f21113cfd001d7`
  (141 vB, 1,000 sat fee, `testmempoolaccept` allowed).
- Re-ran the harness with `--final-txid` (the getrawtransaction path); it
  verifies (`verification=ok`, `finalOutputReview=ok`) and produces the same
  `finalTxOutputHash` (`916733...`) as the `--final-hex` round-trip, confirming
  the on-chain tx's outputs are byte-identical to the planned sweep.
- Evidence: `artifacts/live/utxoref_live_path_broadcast.{json,md}`.

The whole deposit->withdraw path now runs on real chain data: a live deposit
reserve (42 credited UTXOs) reconciled against the withdrawal cap, and a real
funded input swept to plan-matching outputs, broadcast, and decoded back through
Core.

Still open here: turn the insolvency + final-output challenges into concrete
BitVM/script constraints rather than evidence only; the broadcast sweep above
sends the DLC-funding output to a wallet address rather than an actual DLC
funding script, so the next refinement is a real DLC/BitVM output script.

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
- or pass `--final-hex` / `--final-txid` so the demo asks Core RPC to decode it
- require the final output review to match every planned sweep output by value
  and script before signer/dashboard acceptance
- attach the resulting final txid to the dashboard
- broadcast only after wallet policy verifies the final output hash
