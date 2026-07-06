# Demo Metrics Accounting

Reconstructs the `49,000 sats → 36,000 sats delivered` figure quoted in
`DEMO_PACKAGE.md` and the Q2–Q3 progress summary, decomposed against actual
source code and the artifacts that produced it. Read-only investigation —
no code changed for this document. Cross-reference: `CLAIMS_MATRIX.md` rows
added for the btcUSD leg (Task 1) and Ark leg (Task 2).

## Provenance of the 49,000-sat input

The figure does **not** originate on LTCTEST. It traces to
`bitvm3/utxo_referee/artifacts/lightning_subswap_dlc_latest.json`, produced
by `lightning_subswap_dlc_demo.js`, which runs a submarine-swap-shaped HTLC
funding flow against a **local Core Lightning (CLN) regtest sandbox**
(`network: "bitcoin-regtest"`, run directory
`/home/duganist/.local/utxoref-lightning/run/regtest-demo`, generated
`2026-04-25T21:49:30.414Z`). This is a real broadcast on a real, but
private and ephemeral, regtest chain — not the shared, persistent LTCTEST
node (rpcport 19332, `tl-wallet`) that backs the eleven NETWORK_VERIFIED
rows in `CLAIMS_MATRIX.md`. That regtest chain state is not expected to
still exist; the txids below are not independently re-verifiable today.

- Swap (hashlock) funding txid: `c563776fe8a6d86e7e185529d7e78e43e4066c7221589c8f688b3b63a7939ad6`, amount 50,000 sats (`swap.amountSats`)
- DLC-funding claim txid: `fd3e97d30b39c04dea7748cd5a7e8b057bf9e0f7656a6be7d9733c413828be43`, output amount **49,000 sats** (`dlcFunding.outputAmountSats`, `lightning_subswap_dlc_latest.json:31`) — the 1,000-sat gap from the 50,000-sat swap is the regtest claim transaction's fee.

`lnbtc_tlusd_liquidity_patch_demo.js:121-124` reads this artifact's
`dlcFunding.outputAmountSats` as `lnbtcSats`, which is where "LN-BTC input:
49,000 sats" in `DEMO_PACKAGE.md` comes from.

## Decomposition table

| Step | Amount | Source | Basis |
|---|---|---|---|
| LN-BTC input | 49,000 sats | `lightning_subswap_dlc_latest.json` (regtest, see above) | Real regtest broadcast, fee-adjusted from a 50,000-sat swap |
| TLUSD externalized | 49 TLUSD | `lnbtc_tlusd_liquidity_patch.js:52-64`, `usdUnitsFromBtcSats()` | Pure arithmetic: `49000 sats * 1e11 micro-USD/BTC / 1e8 = 49,000,000 micro-units = 49.000000` at the demo's fixed peg (`btcUsdPriceMicros: 100000000000n`, i.e. an implied ~$100k/BTC, ~1,000 sats/TLUSD). No chain interaction — the conversion is a deterministic hash-commitment, not a settlement. |
| **TLUSD staked** | 40 TLUSD | `lnbtc_tlusd_liquidity_patch_demo.js:130`, literal `stakedTlUsdUnits: 40000000n` | **Hardcoded demo input, not derived from the 49-TLUSD conversion by any formula in this codebase.** |
| Routing notional | 40,000 sats | `lnbtc_tlusd_liquidity_patch_demo.js:131`, literal `routingNotionalSats: 40000n` | Hardcoded demo input; numerically consistent with 40 TLUSD only because both literals were chosen to match at the same fixed peg, not because one is computed from the other. |
| Ark patch assigned | 40,000 sats | `ark_liquidity_graft_manager.js:354` (`totals.assignedInboundSats`), from route intents in `lnbtc_tlusd_liquidity_patch_demo.js:134-149` | Sum of `promisedInboundSats` for routes matched to available VTXOs: edge-a-patch 30,000 + edge-b-patch 10,000 sats. Allocation logic at `ark_liquidity_graft_manager.js:241-262`; both routes matched successfully against the demo's VTXO inventory (`[30000n, 10000n, 10000n]` sats) and policy cap (`maxAspExposureSats: 160000n`), so nothing was left unmet. |
| Ark patch delivered | 36,000 sats | `ark_liquidity_graft_manager.js:356` (`totals.deliveredInboundSats`) | Sum of per-route `deliveredInboundSats` — see breakdown below. |

### Delivered-inbound breakdown (40,000 → 36,000)

| Route | Promised | Delivered | Source | Note |
|---|---|---|---|---|
| edge-a-patch | 30,000 sats | 30,000 sats | `ark_liquidity_graft_manager.js:199-224`, `buildObservationMap` default (`route.requestedInboundSats` used when no override is supplied) | **This is an assumed value, not a measurement.** `lnbtc_tlusd_liquidity_patch_demo.js`'s `routeObservations` array supplies no entry for edge-a-patch, so the code defaults to "fully delivered." Nothing in the demo actually observes or verifies this route's delivery. |
| edge-b-patch | 10,000 sats | 6,000 sats | `lnbtc_tlusd_liquidity_patch_demo.js:150-157`, explicit `routeObservations` entry (`deliveredInboundSats: 6000n`, `missingForfeitPath: true`) | Explicit, intentional shortfall in the demo data. This is what the demo's "slashable route failures: 1" refers to — `ark_liquidity_graft_manager.js:324` sets `status: 'slashable'` for this assignment because `missingForfeitPath` is true. |
| **Total** | 40,000 | **36,000** | sum | Matches `DEMO_PACKAGE.md`'s "delivered liquidity: 36,000 sats." |

## Full 13,000-sat gap, decomposed

```
49,000 (LN-BTC input, regtest)
- 9,000  <- 49 TLUSD externalized but only 40 TLUSD staked (UNRECONSTRUCTABLE, see below)
= 40,000 (staked / routing notional / Ark assigned — all three hardcoded to the same figure)
-  4,000 <- edge-b-patch under-delivery (10,000 promised, 6,000 observed; explicit, intentional)
= 36,000 (delivered liquidity)
```

9,000 + 4,000 = 13,000, matching the full gap between the quoted LN-BTC
input and delivered-liquidity figures.

## What cannot be reconstructed

**The 9,000-sat (49 → 40 TLUSD) gap has no derivation anywhere in source.**
`stakedTlUsdUnits: 40000000n` in `lnbtc_tlusd_liquidity_patch_demo.js:130`
is an independent literal, not a function of `conversionCore.tlusdUnits`
(the 49-TLUSD figure). There is no fee model, reserve-buffer calculation,
slippage allowance, or comment anywhere in `lnbtc_tlusd_liquidity_patch.js`
or its demo driver that explains why 9 of the 49 externalized TLUSD are not
staked. The only code-level check related to this gap is
`stakeDoesNotExceedTlUsdBalance` (`lnbtc_tlusd_liquidity_patch.js:176`),
which merely asserts `staked <= externalized` — it does not require or
explain a specific unstaked remainder. Per this task's instruction not to
balance the table by assumption: this portion is reported as an
**unexplained demo-parameter gap**, not attrition, fees, or a reserve hold,
because nothing in the code computes or documents it as such.

The remaining 4,000-sat gap (edge-b-patch shortfall) is fully
reconstructable and is not attrition either — it is a deliberately
authored "one route under-delivers and gets flagged slashable" scenario in
the demo data, not a cost of the LN-BTC→TLUSD→Ark pipeline itself.

## Bottom line

None of the 13,000-sat "loss" implied by the headline numbers is fee
attrition, protocol overhead, or reserve encumbrance. It is: (a) an
unexplained gap between two independently hardcoded demo parameters
(9,000 sats), and (b) one deliberately-scripted under-delivery scenario
used to exercise the slashable-assignment code path (4,000 sats). The
LN-BTC input itself is also not LTCTEST evidence — it is a regtest artifact
from a separate, ephemeral chain. Anyone citing "49,000 sats in → 36,000
sats delivered" as a yield/efficiency number for the pilot should not do
so; it is demo-fixture arithmetic, not a measured cost of the system.
