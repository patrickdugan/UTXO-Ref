# Pilot Surface

The minimal set of files an adversarial signet/testnet pilot and its
auditors need to look at. Everything not listed under "In scope" is
explicitly **out of scope** for the pilot — see the bottom of this doc and
`CLAIMS_MATRIX.md` for what each excluded tree is and why it's excluded.
`civkit/` is out of scope by explicit instruction as well as by the fact
that nothing under `bitvm3/` requires it.

All paths are relative to `bitvm3/utxo_referee/` unless stated otherwise.

## 1. Signer boundary

The only code that touches private key material or produces a signature.
This is the highest-risk surface and the subject of
[`SIGNER_MIGRATION_PLAN.md`](../SIGNER_MIGRATION_PLAN.md) — nothing here
should sign real value until that plan is executed.

- `tradelayer_dlc_adaptor_sig.js` — secp256k1/BIP340 Schnorr + adaptor signatures
- `tradelayer_musig2.js` — MuSig2 (BIP327) key aggregation, nonce handling, partial signing
- `tradelayer_taproot.js` — BIP341 keypath tweak + sighash
- `bip327-*.json`, `bip341-wallet-test-vectors.json` — vendored spec vectors these are checked against

## 2. BitVM referee scripts

The fraud-proof circuit and dispute-game construction. No private keys;
pure Script/circuit logic and the on-chain commitment structure.

- `tradelayer_bitvm_gadgets.js` — bit commitment + equivocation punishment primitive
- `tradelayer_bitvm_circuit.js` — wires + logic gates + disprove leaves
- `tradelayer_bitvm_comparator.js` — `cap<=reserve` as a subtractor circuit
- `tradelayer_bitvm_sha256.js` — SHA256 as a boolean circuit (final-output predicate)
- `tradelayer_bitvm_dispute.js` — disprove-vs-CSV-timeout dispute tree
- `tradelayer_bitvm_solvency_referee.js` — input binding to the reserve reconciliation
- `tradelayer_taproot_script.js` — script-path tapleaf/control-block machinery
- `tradelayer_taproot_tree.js` — multi-leaf taproot tree assembly

## 3. DLC / adaptor settlement

The settlement layer that sits on top of the signer boundary: CET
construction, oracle-gated outcome selection, and the reserve/withdrawal
solvency invariant that the BitVM referee ultimately enforces.

- `tradelayer_dlc_cet_oracle_selection.js` — per-outcome CET derivation + oracle-attestation gating
- `m1_dlc_bootstrap.js`, `m1_dlc_psbt_cet.js`, `m1_dlc_sign_finalize.js` — funding/CET PSBT lifecycle
- `tradelayer_reserve_reconciliation_referee.js` — `cap<=reserve` solvency commitment + insolvency challenge
- `tradelayer_withdrawal_queue_referee.js` — fail-closed withdrawal queue
- `tradelayer_live_reserve_adapter.js` — live `listunspent` → credited reserve (real RPC data)
- `tradelayer_btcusd_stake_demo.js` — on-chain LTCTEST funding tx backing a btcUSD-denominated collateral figure (added: closes the btcUSD-leg evidence gap in `CLAIMS_MATRIX.md`; reuses `usdUnitsFromBtcSats()` unmodified)
- `tradelayer_dlc_refund_cet_demo.js` — on-chain CSV-gated 2-of-2 refund CET, no oracle input (added: closes SECURITY_BLOCKERS.md #9 / the oracle-non-attestation NOT_IMPLEMENTED row)

## 4. Watchtower / challenger

See [`SECURITY_BLOCKERS.md` #5](../SECURITY_BLOCKERS.md) and
[`docs/ADVERSARIAL_SIGNET_PLAN.md`](ADVERSARIAL_SIGNET_PLAN.md).

- `tradelayer_send_watchtower.js` — evidence-object / alert-report builder (pure function, not a running process)
- `tradelayer_send_fraud_challenges.js` — fraud challenge bundle construction
- `tradelayer_watchtower_daemon.js` (new) — a real, continuously-running, disk-persisted-state process: independently re-derives reserve solvency/freshness every tick straight from live RPC and durably alerts on fault. Proven to resume correctly across an abrupt process kill (not just a graceful stop) — see `RUN_LOG_2026-07-05.md`.
- `tradelayer_trace_publication.js` (new) - hash-committed trace publication/retrieval plus the SLA rule that trace withholding is itself a fault.
- **Still missing, required for pilot:** this daemon checks a configured watched-assertions registry for trace withholding, but it does not yet automatically construct/broadcast the BitVM circuit disprove transaction for an arbitrary future bonded assertion; trace artifacts also need an independently reachable mirrored DA endpoint, not just local artifact paths.

## 5. Oracle interface

- `tradelayer_dlc_adaptor_sig.js` (`buildDlcOracle`, `dlcOutcomePoint`, `dlcAttest`) — oracle commitment/attestation primitives
- `tradelayer_dlc_refund_cet_demo.js` (new) - CSV-gated refund CET mechanism for oracle non-attestation, confirmed on-chain in self-play.
- **Missing, required for pilot:** an oracle process independent of the pilot operator, plus a separated-keys rehearsal of the refund path (Blockers #8, #9)

## 6. Test harnesses / evidence generation

Live-path drivers used to produce on-chain evidence and the reproducibility
harness referenced in `CLAIMS_MATRIX.md`.

- `tradelayer_utxoref_live_path.js` / `.test.js` / `_demo.js` — live-path evidence harness
- `tradelayer_live_reserve_demo.js` — live reserve reconciliation driver
- `tradelayer_musig2_dlc_demo.js`, `tradelayer_taproot_dlc_demo.js` — on-chain DLC settlement demos
- `tradelayer_bitvm_gate_demo.js`, `tradelayer_bitvm_circuit_demo.js`, `tradelayer_bitvm_timeout_demo.js`, `tradelayer_bitvm_solvency_demo.js`, `tradelayer_bitvm_sha256_demo.js` — on-chain BitVM dispute demos
- `run_utxoref_all.js` — one-command regression runner
- `tests/stress_test_bitvm.js` (repo root `tests/`) — stress harness

## 7. Shared infrastructure (imported by the above)

- `m1_spec.js` — canonical stringify / shared spec helpers
- `merkle.js` — payout Merkle tree
- `types.js` — shared data structures
- `verify.js` — off-chain sweep verification

---

## Out of scope (explicitly excluded from pilot review and audit surface)

Per `CLAIMS_MATRIX.md`, none of the following are imported by anything
listed above:

- `civkit/` — separate package tree (arbitration agent, nostr agent, p2p
  platform, bitvm escrow); **excluded by explicit instruction**
- `node-dlc/` — external library checkout, not folded into the pilot flow
- `DLCAdaptor/` — separate TypeScript rBTC/Aurora bridge project
- `bitvm3/utxo_referee/halal_capital_*.js`, `omani_fiqh_stablecoin_compliance.js` — unrelated business-domain compliance prototype
- `bitvm3/utxo_referee/jurassic_bitvm_mechanisms.js` — unreferenced prototype
- `bitvm3/utxo_referee/shinigami/` — proof benchmark, no chain interaction
- `bitvm3/utxo_referee/asp_bitvm_reserve_bond.js`, `rbtc_dlc_zk_settlement_adapter.js` — prototype/simulation, not wired into the pilot path
- `integrations/zeus/`, `integrations/wallet-demo/`, `integrations/wallet-dashboard-vercel/`, `integrations/ldk-server/`, `integrations/ark-liquidity-governor-bench/`, `integrations/lightning-liquidity-lease-sidecar/` — wallet UI mocks and stress dashboards, no signing or settlement logic
- `codex-chat-sessions/` — session logs, not code
- `scripts/prove_ark_zk_miniscript_snacksack.ps1`, `scripts/prove_shinigami_virtual_cet_snacksack.ps1` — drivers for out-of-scope prototypes

An auditor engaged against this pilot should be scoped to the file list
above under "In scope," not the repository root.
