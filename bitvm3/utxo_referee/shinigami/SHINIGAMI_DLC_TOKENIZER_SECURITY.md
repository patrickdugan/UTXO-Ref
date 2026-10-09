# Shinigami DLC Tokenizer Security

Generated: 2026-05-06T22:59:30.450Z

## Thesis

CET compression remains zero-materialization while ASPs stay optional accelerators.

The ASP-backed Ark path is an accelerator: it buys fee efficiency, batching, and
liquidity UX. The direct DLC/BitVM path removes ASP route and reserve assumptions
but gives up those batching and monitoring subsidies.

## CET Compression

| Outcomes | Materialized CETs | Direct fanout CETs | Worst-case direct fee sats | Governed Ark sats | Estimated savings sats |
| --- | ---: | ---: | ---: | ---: | ---: |
| 17 | 0 | 17 | 76500 | 5475 | 71025 |
| 101 | 0 | 101 | 454500 | 5475 | 449025 |
| 1001 | 0 | 1001 | 4504500 | 5475 | 4499025 |
| 5000 | 0 | 5000 | 22500000 | 5475 | 22494525 |

## Prover Metrics

| Outcomes | Verified | Wall time | Max RSS KB | Proof bytes |
| --- | --- | ---: | ---: | ---: |
| 17 | true | 0:09.64 | 12437656 | 9307296 |
| 101 | false | n/a | n/a | n/a |
| 1001 | false | n/a | n/a | n/a |
| 5000 | true | 0:10.24 | 12441100 | 9347438 |

Rows marked false have generated Cairo inputs but were not submitted to
snacksack in this run. The 5000-outcome row is the large-fanout proof target.

Local Cairo prover source used for this run:

- `C:\projects\ark-shinigami\virtual_cet_prover\src\lib.cairo`
- `C:\projects\ark-shinigami\scripts\prove-virtual-cet-snacksack.ps1`

## Security Matrix

| Threat | ASP-backed Ark model | Direct DLC/BitVM model | Stronger |
| --- | --- | --- | --- |
| wrong_payout_root | Shinigami claim binds selected leaf, payout root, and collateral sum; ASP reserve slash pays users if the ASP advances the wrong payout. | Shinigami claim still detects the wrong payout, but the remedy is a direct BitVM challenge against the vault instead of an ASP reserve claim. | tie |
| wrong_oracle_outcome | ASP-signed virtual-CET settlement must match the oracle outcome hash or the route becomes slashable. | Counterparty cannot rely on an ASP route, but the direct vault still depends on oracle publication freshness and challenge liveness. | direct_dlc_bitvm |
| omitted_virtual_cet_leaf | Ark leaf root and virtual-CET set id are public inputs; omission is challenged against ASP round state. | Direct vault commits the virtual-CET set root before funding; omission is challenged against the funding template. | tie |
| asp_route_mismatch | ASP can misroute, but the reserve bond and forfeit path make it economically slashable. | No ASP route exists, so this class disappears; users pay with slower direct coordination. | direct_dlc_bitvm |
| exit_withholding | Exit availability is an ASP-signed obligation with reserve slash and watcher bounty. | No ASP can withhold an Ark exit, but the direct vault must have timeout/refund leaves and both parties must preserve transaction packages. | tie |
| liquidity_liveness | ASP can batch and patch liquidity cheaply; underdelivery is measurable against signed obligations. | No liquidity provider liveness assumption, but no cheap batched liquidity service either. | asp_backed |
| challenge_window_failure | Watcher bounty funds third-party monitoring, and reserve claims define public receipts. | Participants or their watchtowers must monitor directly; no ASP reserve subsidizes monitoring by default. | asp_backed |

## Model Commitments

- ASP-backed model id: `2e874a8cf106aebc77cd6a42b953581c45e4e46b44c47c50fe54c0c31aa153d8`
- Direct model id: `32232383be1fec17e1d4f46ba6e549110a0027631570d1b94a3d7669ee250008`
- Comparison id: `64a498b6ed99a837abe970f3a7be98b561ec64385150678b5c0e4b344f88afb6`
- Proof corpus id: `16ae3cc62b8ba2ae89bd600994737a97f14047868032cbf550e909f67d02e984`
