# Prototype validation

This document records the original offline baseline. The funded Core run and
its transaction evidence are in [REGTEST_REPORT.md](REGTEST_REPORT.md).

Run on 2026-11-19 against the new `LNMarkets/` folder, based on UTXORef
`0dff29eaa259a2b853f599852aae232092629b78`. Local runtime: Node.js v24.22.3
on Linux. No dependencies were installed.

## Focused tests

```sh
npm --prefix LNMarkets test
```

**37 passed, 0 failed, 0 skipped.** The recorded run took about 18 seconds.

| Suite | Tests | Main checks |
|---|---:|---|
| `test/contract.test.js` | 14 | Inverse PnL, signed rounding, caps, conservation, strict terms, hash binding and immutable restoration |
| `test/market-data.test.js` | 5 | Expiry, timestamp and market identity, public GET request scope, error handling and response limits |
| `test/restore-cli.test.js` | 2 | Required external pins, recovery-mode arguments and bounded public JSON input |
| `test/settlement.test.js` | 16 | Real transaction bytes and signatures, all oracle pairs, refund restoration, missing shares, altered bytes and package substitution |

The settlement suite starts a fresh process that receives only a serialized
public package and two oracle attestations. It verifies the package and
completes a CET. Other checks exercise cached validation after successful
verification, then alter bytes and signature bindings to require rejection.

An independent review identified that a plan digest alone could accept a
second valid package for the same economic terms and another funding
outpoint. Restoration now requires the wallet's original recovery digest
as well. The regression creates both valid packages and proves their pins
cannot be exchanged.

## Complete demo

```sh
node LNMarkets/demo.js
```

**Completed successfully.** The fixture produced nine CETs for the agreed
prices and every two-of-three oracle subset. The demo then started separate
processes for settlement and refund recovery under a stripped environment.

| Observed result | Value |
|---|---|
| Synthetic funding output | 401,330 sats |
| Selected settlement price | $110,000/BTC |
| Trader settlement payout | 290,909 sats |
| Maker settlement payout | 109,091 sats |
| Trader timeout refund | 200,000 sats |
| Maker timeout refund | 200,000 sats |
| Committed exit miner fee | 1,000 sats |
| Committed anchor output | 330 sats |
| Oracle availability during settlement | Two fixture attestations supplied; one omitted |
| Party keys supplied to recovery processes | None |
| Venue connections used during recovery | None |

The saved outputs explicitly report `LOCAL_SIMULATION`,
`fundedExecutionAllowed: false` and `chainMaturityVerified: false`.
The funding outpoint is synthetic. This run verifies serialization and
cryptographic consistency without a Bitcoin Core node or a live chain.

## Public API probes

Both optional read-only commands were attempted:

```sh
node LNMarkets/quote.js --signet
node LNMarkets/quote.js --mainnet
```

Each reached the adapter's five-second timeout in this environment before
returning a usable snapshot. Live connectivity and response compatibility
remain unverified. The adapter's local tests use synthetic responses based
on the official schemas linked in [PROTOCOL.md](PROTOCOL.md).

## Repository CI

The existing `scripts/run_every_test.js` discovers all four new `*.test.js`
files. Its workflow runs them on Windows with Node 24, alongside the existing
referee suites and locked evaluations. Workflow status belongs to the pull
request's checks; the local results above cover this folder's tests and demo.

An external maker, independently operated oracle services, actual funding,
Bitcoin Core policy acceptance and chain-mature spends are the next evidence
steps described in [README.md](README.md).
