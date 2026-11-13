# Authenticated PnL batches through funded execution

Date: 2026-11-13

The funded adapter carries the [netting relation](PNL_BATCH_NETTING.md) through
a signed checkpoint, exact Bitcoin transaction bytes and a persistent book.
Execution accepts Bitcoin regtest and testnet4. The beta readiness report keeps
production authorization closed.

The isolated Core harness uses valueless regtest coins. One disposable wallet
owns the funding inputs, and the checkpoint signing keys are local test keys.
It exercises the host's enforcement and Core's transaction validation. Independent
custody, a BitVM challenge path and a ZK proof require separate evidence.

## Modules and API

| Module | Responsibility |
| --- | --- |
| `utxoref_v2_pnl_batch_checkpoint.js` | Authenticate the complete typed snapshot and transaction-policy hash with distinct allowlisted Ed25519 signers. |
| `tradelayer_pnl_batch_transaction.js` | Rebuild exact unsigned bytes and bind a bounded SegWit envelope to them. |
| `tradelayer_pnl_batch_state_store.js` | Open the prior ledger, preserve its policy and collateral, and reserve the book before signing. |
| `utxoref_v2_pnl_batch.js` | Compose authenticated accounting and serialized transaction verification. |
| `utxoref_v2_pnl_batch_execution.js` | Check an independent Core view, invoke the configured signer, broadcast persisted bytes and commit after active-chain confirmation. |

The package exposes `checkpoint`, `transaction`, `state` and `execution` under
`v2.pnlBatch`. Its `v2.settlement` API exports the composition and execution
functions `buildUtxoRefPnlBatchSettlementV2`,
`verifyUtxoRefPnlBatchSettlementV2`, `signPnlBatchSettlementV2`,
`broadcastPnlBatchSettlementV2` and `confirmPnlBatchSettlementV2`. Historical
row-only V2 envelopes retain their separate schema.

Offline building takes `{stateEnvelope, stateVerification, transactionPolicy,
expectedTransactionPolicyHash}`. Verification takes the candidate and the same
context without `stateEnvelope`.

Execution receives `{settlement, trustPolicy, transactionPolicy,
expectedTransactionPolicyHash, executionPolicy, store, expectedHeadHash, rpc}`.
Signing additionally requires a configured `signer` callback. The execution
policy contains `minFundingConfirmations`, `minSettlementConfirmations`,
`maxFeeSats` as a decimal string, and integer `maxFeeRateSatsPerVbyte`.

## Full snapshot authentication

The signed body preserves the entire typed snapshot and its recomputed hash.
It also binds `policyId`, `chainGenesisHash`, `contractId`, the snapshot height
and block hash, and `transactionPolicyHash`. Network is contained in the snapshot.
Signing bytes are `UTXOREF_PNL_BATCH_CHECKPOINT_V2`, a zero byte, and the canonical
JSON body. The legacy row projection is never used for this body.

The independent trust policy requires a threshold and an allowlist of canonical
Ed25519 SPKI keys. Key IDs are SHA256 of their DER encoding. Duplicate keys or
signature IDs fail, and every supplied signature must verify under an allowlisted
key. JSON wire artifacts use decimal strings for large financial integers.

Verification requires the independently expected prior root and epoch, current
height, and an independently obtained active block hash at the checkpoint
height. The execution guard derives the immediate successor epoch from the
persisted ledger and obtains its chain view through configured Core RPC.
A candidate cannot embed a replacement trust policy.

Pricing, liquidation and completeness of the realized-obligation universe remain
the checkpoint authority's responsibility. A future validity proof must establish
those upstream rules as part of its statement.

## Opening the prior state

The durable ledger includes every account's equity, locked amount, beneficiary
script, vault membership and netting domain. It also binds route permissions,
protected reserves, vault change scripts, actual UTXOs, the last settled epoch,
and accumulated consumed-obligation/spent-outpoint sets.

`hashLedgerState(ledger)` supplies the successor snapshot's `previousStateRoot`.
`assertSnapshotContinuesLedger` requires that snapshot to project back to exactly
the stored ledger, with the epoch incremented by one. A fresh signature cannot
reset balances or erase history while retaining a root label.

Current obligations, requested profit payouts and fees may vary each epoch.
Other changes require an explicit future upstream transition. This adapter
rejects added deposits/accounts, ownership changes, altered locks, and route
amendments through the settlement path. Initialize intended payout scripts up
front: an account with a null script can retain PnL but cannot add a direct
payment destination through a later settlement snapshot.

The durable `ledgerHash` differs from the kernel's
`statement.nextAccountingStateRoot`. The durable root also covers policy and
concrete residual outpoints. Use the committed `ledgerHash` for the next epoch.
Every selected input is consumed, and each surviving vault output becomes a
UTXO with the verified settlement txid and its actual ordered output index.

## Exact transaction profile

The independent transaction policy has fields `kind`, `network`, `version`,
`locktime` and `inputSequences`, whose entries contain full `txid`, `vout` and
`sequence`. Its kind is `tradelayer_pnl_batch_transaction_policy_v1`. Its hash
must match both the caller's pin and the quorum-signed checkpoint.

The adapter rebuilds complete ordered input and output vectors from the economic
batch. It binds prevout amounts/scripts, every sequence, version, locktime and
the exact fee. Complete outpoints must be unique.

The explicit profile permits Bitcoin networks, version 2 or 3, 1..16 inputs,
1..1,000 outputs and empty scriptSigs. Unsigned bytes are capped at 100,000;
signed bytes at 400,000. Values and aggregate totals obey Bitcoin's money bound.
The underlying parser requires output scripts of at least two bytes. Witness
stack counts and item sizes are bounded too.

`verifyPnlBatchSignedTransaction` checks the canonical SegWit envelope against
the independently rebuilt unsigned bytes. Witness items remain opaque here;
Core must execute the actual scripts. The funded harness includes a structurally
valid envelope whose witness Core rejects.

## Persistent authorization and recovery

One lock and compare-and-swap head cover the complete book. The store's `bookId`
must equal the independently trusted checkpoint contract ID. All workers
authorizing overlapping collateral must use one authoritative journal and
trusted head. Two separately initialized directories can start with the same
book ID and head while remaining independently writable. Such replicas need
external coordination to preserve consumption rules across workers.

| State | Progression |
| --- | --- |
| Ready | Validate the authenticated snapshot, prior ledger, chain and funding; persist a reservation. |
| Reserved before signing | Invoke the signer once. Retain the reservation after failure or ambiguity. |
| Signed | Persist exact signed bytes; validate with Core; allow an exact-byte broadcast or recovery retry. |
| Confirmed | Commit the next ledger after exact active-chain inclusion and the configured confirmation count. |
| Frozen | Preserve pending data and signing tombstones while refusing further authorization. |

Equity remains at its previous committed value while the transaction is pending.
Broadcast failure, timeout or mempool absence never releases a reservation.
There is no automatic second signing attempt.

The book lock covers synchronous head validation and invocation of a signer or
broadcast capability. It releases when that invocation returns a Promise. Later
completion requires a new head check before results are released. A capability
invoked before a freeze can still complete, so its reservation remains necessary.

Every mutation requires an independently pinned `expectedHeadHash`. Journal
records are append-only and linked by hash; reading replays each transition and
compares the reconstructed state. The external pin detects rollback of the
whole directory. A local hash chain alone cannot establish a monotonic head.

The store uses canonical serialization, bounded regular-file reads and file plus
directory fsync. Filesystem links and incomplete publications fail closed. This
execution path requires POSIX directory fsync. Windows construction refuses the
operation before creating authorization state until an equivalent durable
publication primitive is implemented. Linux CI runs the full store/execution
suites; portable checkpoint and transaction tests also run on Windows.

Filesystem commit and Bitcoin consensus remain separate operations. Persistent
reservations cover their interval. A reorg of the last committed settlement
freezes the book before another authorization can proceed. Recovery from a frozen
or ambiguous record requires a reviewed operator procedure, which this adapter
does not automate.

## Independent Core checks

RPC and signer callbacks are separately configured capabilities. Candidate data
is copied and frozen before invocation; the signer receives rebuilt unsigned
bytes and bound metadata. Configure Core with `txindex=1` and let the index
synchronize: this adapter looks up confirmed transactions by txid through
`getrawtransaction` without supplying a block hash. The isolated harness enables
that index explicitly.

Before reservation, Core must report the trusted chain name and genesis. The
guard obtains the active checkpoint block and checks freshness and prior-state
continuity. Every selected input must appear in mempool-aware `gettxout` with
the exact amount/script, sufficient confirmations and mature coinbase funding
where applicable. A stable chain tip and mempool sequence bracket collection.
Three unstable attempts fail closed.

After signing, `testmempoolaccept` must identify the exact txid/wtxid and agree
with local virtual size and fee calculations. Independent absolute-fee and
fee-rate caps apply. Signed bytes are persisted before the only
`sendrawtransaction` call. Recovery can recognize those same bytes already known
to Core without issuing another signature.

Freshness governs creation of signing authority. Recovery and confirmation may
verify the persisted authority historically, requiring the same checkpoint,
transaction and policy hashes plus an active checkpoint block and current Core
view. A delayed confirmation therefore does not create fresh authority for an
old epoch.

Confirmation requires exact signed bytes and witness identity, active block
membership, and the configured confirmation count, bracketed by a stable tip.
It commits the next ledger with actual residual output indices. The result can
report `executionVerified: true` within the scope
`trusted-bitcoin-core-confirmed-test-network-batch`; `productionReady` and
`zkProofVerified` remain false. Offline and preconfirmation checks keep
`executionVerified: false`.

## Reproduce the funded exercise

CI pins the official Core 31.1 Linux archive to SHA256:

```text
b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e
```

```sh
BITCOIN_BIN=/path/to/bitcoin-31.1/bin node eval/pnl_batch_regtest.js --out /path/to/receipt.json
```

The harness creates a private datadir, cookie-authenticated loopback RPC and
disposable wallet with peer connections disabled. It funds native SegWit vaults
and authenticates a batch with two checkpoint signatures. The 215,000-sat input
set produces a 4,000-sat payment, residuals of 99,500 and 110,500 sats, and a
1,000-sat fee. The winner's retained equity reaches 106,000 sats.

Adversarial checks include destination substitution before signing, an invalid
witness rejected by Core, pending and confirmed replay, journal restart, and
invalidation of the confirmation block followed by a required freeze. The
harness stops its own node and removes its temporary datadir in `finally`.
CI uploads the receipt as `pnl-batch-regtest-evidence`, including its limited
custody and proof profile. The [recorded local receipt](../bitvm3/utxo_referee/artifacts/pnl_batch_regtest_latest.json)
also includes the Core binary hash and a SHA256 manifest of the harness's 16
source and fixture dependencies. The harness checks that this manifest remains
unchanged throughout execution.

## Validation recorded on 2026-11-13

The final local checks passed on Node v24.22.1 and Linux. The Core receipt pins
the source files loaded by that particular funded exercise.

| Check | Result |
| --- | --- |
| Batch accounting and funding graph | 36 tests passed |
| Full signed checkpoint | 35 tests passed |
| Exact transaction and witness envelope | 24 tests passed |
| Durable ledger and reservation journal | 26 tests passed |
| Signing, broadcast and confirmation guard | 36 tests passed |
| Beta readiness package | 12 tests passed |
| Complete repository runner | 120/120 test files passed |
| Referee full evaluation | 19/19 cases; 100/100 weighted points |
| DLC security full evaluation | 49/49 cases; 568/568 weighted points |
| Core 31.1 funded regtest | Confirmed payout/residuals, one signer call, persisted recovery, rejected replay and reorg freeze |

The execution tests include freezes during awaited signing, policy validation,
known-transaction lookup, broadcast acknowledgement and confirmation. Separate
cases reject executable data fields and Proxy error traps without invoking
them. The Core exercise supplies consensus execution evidence for the native
P2WPKH funding profile; synthetic witness tests cover only their declared parser
and host checks.

## Remaining integration

The host guard must become mandatory for every signing path entrusted with this
collateral. Real custody must bind the same statement through its DLC/CET,
guardian or BitVM spending mechanism. A valid wallet signature leaves those
protocol-specific obligations unproved.

Durable deployment needs an external journal-head pin service and reviewed
recovery. Bounded history arrays and full journal records need authenticated
compaction for sustained operation. rBTC conversion, deposit and ownership
changes need explicit ledger transitions. Proof generation and verification
remain unimplemented for the relation in [PNL_BATCH_NETTING.md](PNL_BATCH_NETTING.md).

## Primary references

- [Official Core 31.1 distribution and checksums](https://bitcoincore.org/bin/bitcoin-core-31.1/).
- [Core gettxout RPC](https://bitcoincore.org/en/doc/26.0.0/rpc/blockchain/gettxout/) describes the mempool-aware UTXO view.
- [Core testmempoolaccept RPC](https://bitcoincore.org/en/doc/25.0.0/rpc/rawtransactions/testmempoolaccept/) describes consensus/policy acceptance and identity fields. The harness tests the actual 31.1 response shape.
- [Core getrawtransaction RPC](https://bitcoincore.org/en/doc/30.0.0/rpc/rawtransactions/getrawtransaction/) describes confirmed transaction lookup with `txindex` or a supplied block hash.
