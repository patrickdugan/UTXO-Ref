# LN Markets Ãƒâ€” UTXORef prototype

This folder builds a bounded BTC/USD derivative using UTXORef's existing
two-party DLC primitives. It calculates collateral-backed payouts, creates
Bitcoin transaction bytes for every agreed outcome, verifies both parties'
adaptor signatures, and saves a fully signed timeout refund. A separate
process restores the public package and completes settlement after receiving
the oracle attestations.

The default offline demo uses known fixture keys, synthetic prices and a
synthetic funding outpoint. Its artifacts carry `LOCAL_SIMULATION` and
contain candidate transaction bytes. The separate Core rehearsal below
creates fresh regtest wallets and records active-chain confirmation evidence.

## Run it

Use Node.js 24 or later from the repository root. There are no packages to
install.

```sh
node LNMarkets/demo.js
npm --prefix LNMarkets test
```

The demo writes public recovery files under `LNMarkets/artifacts/demo/`,
which is ignored by Git. It starts fresh Node processes for oracle settlement
and timeout refund recovery. Those processes receive the saved package and
the independently supplied digest arguments. The settlement process also
receives two published oracle attestations. Neither process receives party
signing keys or access to an LN Markets session.

`wallet-pins.json` records the plan digest, exact recovery digest and funding
outpoint. In this fixture it sits beside the package for convenience. An
actual wallet must preserve those pins in its own trusted storage before
funding. Copying digests from a replacement package defeats that check.

Generated files:

| File | Contents |
|---|---|
| `recovery-package.json` | Committed plan, authenticated oracle announcements, exact unsigned transactions, both parties' adaptor signatures, and fully signed refund |
| `wallet-pins.json` | Digests and outpoint retained by the demo's wallet role |
| `oracle-attestations.json` | Two public attestations for the selected outcome; the remaining oracle is omitted |
| `settlement.json` | Completed Bitcoin CET bytes and signature-verification result |
| `refund.json` | Independently restored, fully signed refund transaction |
| `summary.json` | Payouts, transaction IDs, and explicit evidence limits |

The reference cryptography performs substantial work during signature and
oracle verification. A fresh run can take a few minutes. Package digests can
change on a later run because signing uses fresh auxiliary randomness.

## Run the Bitcoin Core rehearsal

Install [Bitcoin Core 31.1](https://bitcoincore.org/bin/bitcoin-core-31.1/)
and Node.js 24 or later. Pass the directory containing `bitcoind` and
`bitcoin-cli` and choose a fresh output directory.

```sh
node LNMarkets/regtest.js --bitcoin-bin /path/to/bitcoin-31.1/bin --out LNMarkets/artifacts/regtest-01
```

The script starts its own regtest daemon with a new data directory, loopback
RPC and peer connections disabled. Expect a few minutes of work. It stops the
node on exit and retains the journals, both wallets' public recovery copies,
and Core evidence under the output directory. The `core/` subdirectory
contains disposable private wallet data. GitHub Actions uploads only the
public result and contract artifacts.

See [REGTEST_REPORT.md](REGTEST_REPORT.md) for observed transactions, Core
rejections, the recovery drill, and the remaining deployment dependencies.

## Batch proposals and ZK verification

The wallet can export a verified DLC into the pinned companion batch
statement and build a public journal for the proposed transaction. See
[BATCH_VERIFIER.md](BATCH_VERIFIER.md) for the witness, native interoperation,
and SP1 verifier paths.

## What the demo trades

The product is a short-dated, bounded inverse future. It has a fixed maturity
and an enumerated payout table. The prototype accepts up to nine exact
settlement prices; the example contains $90,000, $100,000 and $110,000.
An arbitrary observed price requires a separately agreed rounding or bucket
rule before this can serve a continuous market.

The example takes a $1,000 long at $100,000/BTC. Each party posts 200,000 sats
as collateral. An additional 1,000 sats covers the Bitcoin settlement miner
fee, and a separate 330-sat output provides a committed recovery anchor.
The total funding output would contain 401,330 sats.

| Settlement price | Trader payout | Maker payout |
|---|---:|---:|
| $90,000 | 88,889 sats | 311,111 sats |
| $100,000 | 200,000 sats | 200,000 sats |
| $110,000 | 290,909 sats | 109,091 sats |
| Timeout refund | 200,000 sats | 200,000 sats |

Every exit also pays the same 330-sat anchor, leaving exactly 1,000 sats as
the transaction fee. `settlementFeeSats` means the Bitcoin miner fee. This
prototype has no venue execution fee, financing fee or revenue model. Its
payouts do not establish a reduction in LN Markets' trading costs.

For notional `Q` and prices `P0` and `P1`, all expressed as integer USD cents,
the long's uncapped PnL in satoshis is:

```text
Q * 100000000 * (P1 - P0) / (P0 * P1)
```

Signed division rounds toward zero. A short reverses the sign. PnL is capped
so each payout retains at least the agreed `minimumPayoutSats`, which this
prototype requires to be at least 1,000 sats. The maker receives the
complement of the trader's payout, preserving total collateral exactly.
The test suite covers price moves beyond both loss limits.

In the regtest ceremony the trader supplies the exit fee and anchor budget
and holds the anchor key. Each wallet pays 750 sats of the funding fee.
Both check the proposed inputs, contributions, change outputs, and payout
commitments before signing their own funding input.

## LN Markets connection

`src/market-data.js` contains a read-only adapter for the documented public
`GET /v3/markets` and `GET /v3/perp/ticker` routes. It selects
`inverse_perp/btc_usd`, requires a released market with USD quantity units,
rejects stale or future observations, and truncates the mark to integer USD
cents. Requests have a five-second combined timeout, a response size limit
and redirect rejection.

```sh
node LNMarkets/quote.js --signet
node LNMarkets/quote.js --mainnet
```

The mainnet option reads public market data. All contract and signing
functions in this prototype still require `bitcoin-regtest` plans. The
adapter accepts no credentials and exposes no account, trade or withdrawal
operation.

The mark is an indicative reference. An executable maker quote will need
its own authenticated acceptance protocol. `bindReferenceToTerms` pins the
chosen reference into draft terms and checks expiry. Its unkeyed digest
checks integrity of the saved interpretation; trusted retrieval and a
trusted local clock provide the source context.

The default demo injects an explicitly synthetic ticker through that same
normalizer. See [VALIDATION.md](VALIDATION.md) for the live connectivity probe
and local checks from this change.

LN Markets would need to implement acceptance and accounting for collateral
held in these contracts before this could become a venue product. No public
account API operation in this folder represents externally locked BTC as an
LN Markets balance. There is no partnership or deployment claim.

## Bitcoin construction

The funding script comes from
[`dlc_funding_output.js`](../bitvm3/utxo_referee/dlc_funding_output.js).
Its deterministic NUMS internal key removes a known key-path secret. The
CET leaf requires both parties' signatures. A second leaf requires the
same signatures plus the committed CSV delay.

Both parties provide adaptor signatures for every outcome and every
two-of-three oracle subset before the recovery package is accepted. Each
subset has its own transaction ID while preserving the same payouts for
that outcome. With three prices, the demo creates nine CETs.

The refund is fully signed during setup. Recovering those existing bytes
requires no oracle attestation. The transaction commits an absolute refund
height and the input commits the relative CSV delay; both conditions must
be satisfied on the actual chain. CETs commit their absolute maturity
height. The isolated regtest harness gates broadcast on the existing Core
prebroadcast validators and single-use authorization journal.

Package verification rebuilds every transaction from the plan, outpoint,
oracle announcements and fee policy. It then validates both parties'
signatures. A hash supplied alongside altered bytes cannot authorize a
different payout. Restoration additionally requires the wallet's original
plan digest and exact recovery digest, which binds the funding outpoint,
oracle nonces and signed refund.

The imported primitives are listed in [PROTOCOL.md](PROTOCOL.md). Small,
bounded in-process caches retain successfully verified immutable public
values by the hash of their entire canonical contents. Pins are checked
on every recovery call. A fresh process validates the package from scratch.

## Restore manually

Copy the digest values from the wallet's original pins and the chosen
`outcomeMessage` from its original plan. The following commands output
verified transaction bytes without broadcasting:

```sh
node LNMarkets/restore.js --package LNMarkets/artifacts/demo/recovery-package.json --plan-digest <PLAN_DIGEST> --recovery-digest <RECOVERY_DIGEST> --refund

node LNMarkets/restore.js --package LNMarkets/artifacts/demo/recovery-package.json --plan-digest <PLAN_DIGEST> --recovery-digest <RECOVERY_DIGEST> --outcome <OUTCOME_MESSAGE> --attestations LNMarkets/artifacts/demo/oracle-attestations.json
```

The CLI bounds each JSON file at 1 MiB and accepts only the documented
arguments. The returned `chainMaturityVerified: false` and
`fundedExecutionAllowed: false` fields remain explicit.

## Remaining integration work

| Work | Concrete acceptance condition |
|---|---|
| Oracle product spec | Fix price source, maturity observation, rounding, missing-price handling and disagreement rules; use separately operated keys |
| Native signer | Route committed CET requests through the existing authorization and native-signer boundary; rebuild and attest the current signer candidate |
| Separate hosts | Repeat the ceremony with independent trader, maker and oracle processes; remove the venue and one oracle before recovery |
| Recovery availability | Deliver and restore the public recovery package from independently controlled wallet storage and deploy mirrors and a watchtower |
| Venue acceptance | LN Markets agrees how it accepts quotes and recognizes external collateral; maker obligations remain covered by the committed capital |

The April Lightning/submarine-swap path can supply a later funding adapter
through [`utxoref_dlc_subswap_funding.js`](../bitvm3/utxo_referee/utxoref_dlc_subswap_funding.js).
Its request and wallet view target an earlier Lightning/BitVM bundle.
[REGTEST_REPORT.md](REGTEST_REPORT.md) describes the evidence and outpoint
binding a future adapter for the current DLC would need.

Existing project gates continue to apply:
[`SECURITY_BLOCKERS.md`](../SECURITY_BLOCKERS.md),
[`DLC_SECURITY_ARCHITECTURE_REVIEW.md`](../DLC_SECURITY_ARCHITECTURE_REVIEW.md)
and [`PILOT_MERGE_NOTES.md`](../PILOT_MERGE_NOTES.md).
