# UTXORef Claims Matrix

Classifies every major claim made in this repository's own documentation
(`bitvm3/utxo_referee/README.md`, `UTXOREF_SESSION_SUMMARY.md`,
`UTXOREF_PRODUCTION_GAP_AND_LIVE_PATH.md`, commit history) against the
evidence that actually backs it. No new protocol claims are introduced here —
this file only re-labels existing claims by evidence tier.

## Classification definitions

- **NETWORK_VERIFIED** — confirmed by a real transaction on a live network
  (LTCTEST as run so far), with a txid and block height, and the on-chain
  script executed the claimed logic.
- **TESTNET_DEMO** — exercised against a live, synced testnet node via real
  RPC (real data), but does not itself produce a confirmed on-chain
  transaction as evidence.
- **LOCAL_SIMULATION** — runs entirely off-chain against synthetic/sample
  data; no live node or chain data involved.
- **PROTOTYPE_ONLY** — code exists but is not wired into the tested pilot
  path, or is explicitly labeled a prototype/benchmark in its own commit or
  header.
- **NOT_IMPLEMENTED** — described in a roadmap/gap doc as needed, but no
  code implements it today.

All **NETWORK_VERIFIED** rows below were produced by the same operator
wallet acting as both prover and challenger (see
[SECURITY_BLOCKERS.md #3](SECURITY_BLOCKERS.md), self-play). Network
verification here means "the Bitcoin/Litecoin Script mechanics execute as
designed," not "this has survived an adversarial counterparty."

## DLC settlement layer

| Claim | File(s) | Class | Evidence |
|---|---|---|---|
| Sweep decode → broadcast on real LTCTEST | `tradelayer_utxoref_live_path_demo.js` | NETWORK_VERIFIED | txid `3e8d784e…cfd001d7`, block 4,761,067 |
| 2-of-2 DLC fund + cooperative CET | `m1_dlc_psbt_cet.js`, live path demo | NETWORK_VERIFIED | fund `f2f1191b…7ffa101a`, CET `28976fd5…3876e121`, block 4,761,076 |
| Oracle-attested, route-derived CET selection | `tradelayer_dlc_cet_oracle_selection.js` | NETWORK_VERIFIED | fund `9b1d9e48…ad32dc83`, CET `5e232095…e198d442`, block 4,761,083 |
| Schnorr adaptor-signature DLC core (crypto correctness) | `tradelayer_dlc_adaptor_sig.js` | NETWORK_VERIFIED (math) / see [SIGNER_MIGRATION_PLAN.md](SIGNER_MIGRATION_PLAN.md) for production-signer status | 9 unit tests incl. cross-check vs Node libsecp256k1 ECDH; on-chain spend below |
| Single-key taproot adaptor DLC settlement | `tradelayer_taproot.js`, `tradelayer_taproot_dlc_demo.js` | NETWORK_VERIFIED | fund `276b600b…08069045`, spend `ce9e7273…6d3f0366`, block 4,761,191 |
| 2-party MuSig2 adaptor DLC settlement | `tradelayer_musig2.js`, `tradelayer_musig2_dlc_demo.js` | NETWORK_VERIFIED | fund `bfe988a4…9fe9bd37`, spend `8b8d18f4…2cfc9e5463`, block 4,761,258 |
| Oracle refund path if oracle never attests | — | **NOT_IMPLEMENTED** | No refund/timeout CET found in any demo or test |
| Oracle threshold / multi-oracle | — | **NOT_IMPLEMENTED** | All demos use a single in-process oracle keypair |

## BitVM fraud-proof referee (solvency + final-output)

| Claim | File(s) | Class | Evidence |
|---|---|---|---|
| Equivocation-punishment tapscript | `tradelayer_bitvm_gadgets.js`, `tradelayer_bitvm_punishment_demo.js` | NETWORK_VERIFIED | fund `46180ba8…2fd25895`, spend `aa3cd2fc…63c8163a`, block 4,761,263 |
| Single gate disprove (Block 1) | `tradelayer_bitvm_circuit.js`, `tradelayer_bitvm_gate_demo.js` | NETWORK_VERIFIED | fund `985914a4…1a7e1971`, spend `2be77c16…9d3e5d78`, block 4,761,431 |
| `cap<=reserve` comparator circuit, 308 disprove leaves (Blocks 2-5) | `tradelayer_bitvm_comparator.js`, `tradelayer_taproot_tree.js`, `tradelayer_bitvm_circuit_demo.js` | NETWORK_VERIFIED | fund `80151561…a96fee46`, spend `05d9d2b2…ee299d08`, block 4,761,436 |
| Dispute game: disprove-or-CSV-timeout (Blocks 6-7) | `tradelayer_bitvm_dispute.js`, `tradelayer_bitvm_timeout_demo.js` | NETWORK_VERIFIED | timeout fund `935a5690…d2064eea`, reclaim `581020bf…52e1840d`, block 4,761,442 |
| Input-binding to real reconciliation hash (Block 8) | `tradelayer_bitvm_solvency_referee.js`, `tradelayer_bitvm_solvency_demo.js` | NETWORK_VERIFIED | fund `b189825d…763c2565`, disprove `134f2048…31746970`, block 4,761,536 |
| SHA256 circuit, 447k disprove leaves (Blocks 9-10) | `tradelayer_bitvm_sha256.js`, `tradelayer_bitvm_sha256_demo.js` | NETWORK_VERIFIED | fund `4c2962f4…b7a33c9f`, disprove `21d753ce…03f2baf0`, block 4,761,545 |
| "Enforced trustlessly" framing (`UTXOREF_SESSION_SUMMARY.md:17`) | — | **Overclaim** — flagged, see [Language annotations](#dangerous-language-annotations) | The Script mechanics are verified; "trustless" additionally requires an independent, persistent, incentivized challenger, which does not exist (see SECURITY_BLOCKERS #3, #5) |

## Reserve / solvency accounting

| Claim | File(s) | Class | Evidence |
|---|---|---|---|
| Live reserve from real `listunspent` (42 UTXOs, 17,164,718 sats credited) | `tradelayer_live_reserve_adapter.js`, `tradelayer_live_reserve_demo.js` | TESTNET_DEMO | Real RPC against a synced LTCTEST node (tip ~4,761,052); produces an off-chain snapshot, not its own on-chain tx |
| Reserve reconciliation (`cap<=reserve` commitment + insolvency challenge) | `tradelayer_reserve_reconciliation_referee.js` | TESTNET_DEMO (off-chain commitment) feeding a NETWORK_VERIFIED circuit (Block 8) | See Block 8 row above for the on-chain binding |
| Legacy wallet reserve is *encumbered* | `tradelayer_live_reserve_adapter.js`, `tradelayer_live_reserve_demo.js` | WEAKER_DEMO | Still an ordinary `listunspent` snapshot. It has freshness checks, but no on-chain lock. Do not use this row to claim reserve encumbrance. |
| BTC testnet4 reserve UTXO is guardian-encumbered | `taproot_reserve_vault.js`, `btc_testnet4_reserve_vault_demo.js`, `tradelayer_reserve_reconciliation_referee.js` | LOCAL_SIMULATION / TESTNET_READY | New `taproot-reserve-vault-set` source counts only live P2TR vault UTXOs matching the manifest scriptPubKey/amount/outpoint/network and outside the recovery-risk window. Normal spend requires operator + watchtower guardian signatures; guardian policy refuses wrong outputs, excessive fees, stale reserve, or insolvent caps. Not a covenant; depends on independent guardian operation. |
| Full TradeLayer consensus/parser as source of truth for reserve | — | **NOT_IMPLEMENTED** | `UTXOREF_PRODUCTION_GAP_AND_LIVE_PATH.md` explicitly lists this as missing; current inputs are sample/consensus blobs |

## LN-BTC → btcUSD/TLUSD → Ark liquidity patch (wallet demo pipeline)

Added per the staged-demos pass (see `RUN_LOG_2026-07-05.md` and
`DEMO_METRICS_ACCOUNTING.md` for full decomposition). The "before" rows
record what actually produced the `DEMO_PACKAGE.md` headline numbers,
determined by reading the code, prior to any new demo work in this pass.

| Claim | File(s) | Class | Evidence |
|---|---|---|---|
| LN-BTC input provenance (the "49,000 sats" figure) | `lightning_subswap_dlc_demo.js`, `artifacts/lightning_subswap_dlc_latest.json` | TESTNET_DEMO, **not LTCTEST** | Real broadcast via a local CLN regtest sandbox (`network: "bitcoin-regtest"`, generated 2026-04-25). Funding txid `c563776f…7939ad6`, DLC-claim txid `fd3e97d3…828be43`. This is a real, but private and ephemeral, regtest chain — distinct from the persistent LTCTEST node behind every NETWORK_VERIFIED row above. Not independently re-verifiable today. |
| btcUSD/TLUSD conversion + stake (before this pass) | `lnbtc_tlusd_liquidity_patch.js` (`buildLnBtcToTlUsdConversion`, `buildTlUsdLiquidityStake`) | **LOCAL_SIMULATION** | Pure hash-commitment composition (`hashCanonical`); zero RPC calls, zero chain reads. Confirmed by source read: no `http`/`rpc`/RPC import anywhere in this file. The module's own `caveats` array already states: "This is an evidence-shape prototype; it does not mint production Taproot Assets or execute real Ark rounds." |
| **btcUSD collateral stake (after this pass)** | `tradelayer_btcusd_stake_demo.js` (new) | **NETWORK_VERIFIED** (self-play) | Reuses `usdUnitsFromBtcSats()` unmodified; funds a real LTCTEST collateral output: 49,000 sats == 49.000000 btcUSD. fund `f04681b1…a5b2ff99f`, block 4,793,460. See `RUN_LOG_2026-07-05.md` for the node-restart history behind this run. |
| Ark liquidity patch: assigned/delivered inbound | `ark_liquidity_graft_manager.js` (`allocateArkGrafts`) | **LOCAL_SIMULATION** | In-scope pilot-surface file (`bitvm3/utxo_referee/`, not the out-of-scope `integrations/ark-liquidity-governor-bench/`), but zero chain interaction: assigned/delivered totals are computed entirely from hardcoded demo route intents and (for one route) a hardcoded shortfall observation (`buildObservationMap`, `ark_liquidity_graft_manager.js:199-224` — defaults `deliveredInboundSats` to the *promised* amount when no observation override is given, i.e. an assumed value, not a measurement, for any unobserved route). See `DEMO_METRICS_ACCOUNTING.md` for the full 40,000→36,000 decomposition. **Not upgraded to on-chain evidence in this pass** — see the paragraph below for why. |
| Oracle refund path if oracle never attests (before this pass) | — | NOT_IMPLEMENTED | `m1_expiry_redemption.js` was checked and ruled out as a candidate: it is off-chain receipt-ledger bookkeeping for the older M1 bounded-loss "roll" accounting model, not an on-chain CSV/CLTV spend of the adaptor-signature/MuSig2 DLC funding output. No refund/timeout CET exists for the on-chain-proven DLC settlement path. |
| **DLC refund CET, oracle non-attestation (after this pass)** | `tradelayer_dlc_refund_cet_demo.js` (new) | **NETWORK_VERIFIED** (self-play) | CSV-gated 2-of-2 taproot script-path spend, no oracle input anywhere in the script or the driver. Reuses only already-tested primitives (`tradelayer_taproot.js`, `tradelayer_taproot_script.js`, `tradelayer_taproot_tree.js`, existing `tradelayer_dlc_adaptor_sig.js` exports). **Mechanism-proof run** (`--csv 2`, fast test window): 20,000-sat collateral, pre-agreed 50/50 split, fund `7c3f7032…8591c7b1f7d` block 4,793,462, refund spend `04718dd1…712eea740ed13` block 4,793,465, `nSequence=2`, both 9,700-sat shares paid out, no oracle consulted. **Production-cadence run** (default is now 576 blocks / ~24h, not a toy value — see driver header): fund `fb2c6902…1eb914314`, broadcast, CSV matures ~24h after broadcast; the driver now runs as two phases (fund+pre-sign now, separate `--settle <txid>` once matured) since waiting out 576 confirmations cannot happen inline — see `RUN_LOG_2026-07-05.md` for the settle-check output and to be updated with the final refund spend txid once matured. **This does not close Scenario E of `docs/ADVERSARIAL_SIGNET_PLAN.md`** — that requires the separated-keys rehearsal, out of scope for this pass; this demo is the mechanism that scenario will re-run against. |

**Why the Ark leg was not upgraded to on-chain evidence in this pass:**
unlike the DLC/BitVM referee layer, this repo has no real Bitcoin Script or
taproot construction for an actual Ark round anywhere (no VTXO output, no
connector output, no forfeit transaction, no ASP round transaction) — every
Ark-related file in `bitvm3/utxo_referee/` is hash-commitment "evidence
shape" only. Producing a genuine on-chain demonstration would mean
designing and implementing the Ark protocol's on-chain constructions from
scratch, which is materially new protocol engineering (not a same-day
composition of already-proven primitives, unlike Tasks 1 and 4), and would
risk introducing exactly the kind of new, unaudited claim this pass is
supposed to avoid. This is tracked as a distinct, larger follow-up, not
attempted here.

## Watchtower / dispute monitoring

| Claim | File(s) | Class | Evidence |
|---|---|---|---|
| "Watchtower" fraud/challenge evidence builder | `tradelayer_send_watchtower.js` | LOCAL_SIMULATION | Pure function (`buildTradeLayerSendWatchtowerReport`) — no persistence, no polling loop, no chain subscription, no alert delivery. Confirmed by source read: no `setInterval`/reorg/persistence code present |
| Persistent, independent, chain-following watchtower process | — | **NOT_IMPLEMENTED** | See SECURITY_BLOCKERS #5 |
| Trace/wire-commitment data-availability mechanism for challengers | — | **NOT_IMPLEMENTED** | See SECURITY_BLOCKERS #6 |
| Reorg handling, RBF/CPFP, mempool-pinning resistance | — | **NOT_IMPLEMENTED** | Listed as missing in `UTXOREF_PRODUCTION_GAP_AND_LIVE_PATH.md`; no code found |

## Adjacent / prototype tracks (not part of the pilot path)

| Claim | File(s) | Class | Evidence |
|---|---|---|---|
| Shinigami virtual CET proof benchmark | `bitvm3/utxo_referee/shinigami/` | LOCAL_SIMULATION | Benchmark harness, no chain interaction |
| "Simulate BitVM ZK verifier dispute receipts" | commit `c1f93b6` | LOCAL_SIMULATION | Commit message states "Simulate" |
| ASP BitVM reserve bond | `asp_bitvm_reserve_bond.js` | PROTOTYPE_ONLY | Commit message: "Add ASP BitVM reserve bond prototype" |
| rBTC DLC ZK settlement adapter | `rbtc_dlc_zk_settlement_adapter.js` | LOCAL_SIMULATION | Reads a JSON bundle from disk and re-derives a receipt hash; no external ZK prover or chain call involved |
| Wallet stress dashboard (5,000 simulated bots) | `integrations/wallet-demo/run_stress_simulation.js` | LOCAL_SIMULATION | Synthetic scenario generator |
| ZEUS React Native wallet screens | `integrations/zeus/*.tsx` | PROTOTYPE_ONLY | Mock screens, not wired to a real wallet backend |
| Halal Capital / Omani Fiqh compliance modules | `halal_capital_*.js`, `omani_fiqh_stablecoin_compliance.js` | PROTOTYPE_ONLY, **out of pilot scope** | Business-domain prototype unrelated to the UTXO referee; see `docs/PILOT_SURFACE.md` |
| Jurassic BitVM mechanisms | `jurassic_bitvm_mechanisms.js` | PROTOTYPE_ONLY, **out of pilot scope** | Not referenced by any pilot-path module |
| `civkit/` (arbitration agent, nostr agent, p2p platform, bitvm escrow) | `civkit/*` | PROTOTYPE_ONLY, **out of pilot scope** | Separate package tree with its own `package.json`/`node_modules`; not `require()`-d by anything under `bitvm3/` |
| `node-dlc/` nested checkout | `node-dlc/*` | **out of pilot scope** | External library checkout; `handoff.md` explicitly says leave it alone unless folded in |
| `DLCAdaptor/` (TypeScript rBTC/Aurora bridge) | `DLCAdaptor/*` | PROTOTYPE_ONLY, **out of pilot scope** | Separate TS project, no test evidence reviewed, not referenced by `bitvm3/` |

## Dangerous-language annotations

See the inline annotations added to `bitvm3/utxo_referee/README.md` and
`UTXOREF_SESSION_SUMMARY.md` per Task 5. Summary of what was flagged:

| Phrase | File | Disposition |
|---|---|---|
| "enforced trustlessly by BitVM-style fraud proofs" | `UTXOREF_SESSION_SUMMARY.md:17` | Annotated — trustless requires an independent watchtower, which does not exist yet |
| "Launch sequencing for the live custody rail" | `bitvm3/utxo_referee/README.md:40` | Annotated — no custody rail exists; this points at a ship-plan doc, not a running system |
| "reserve proof" (multiple, mostly in Omani Fiqh compliance doc) | `omani_fiqh_stablecoin_compliance.js`, artifacts | Left as-is — these are compliance-checklist *requirements* for a hypothetical future system, not claims about this codebase; out of pilot scope per matrix above |
| "solvency proof" / insolvency proof | `tradelayer_reserve_reconciliation_referee.js` | Left as-is — accurate: it is a challengeable proof of a *computation*, not proof of un-encumbered reserve (see SECURITY_BLOCKERS #4) |
