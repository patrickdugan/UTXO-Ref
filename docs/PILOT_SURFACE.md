# Pilot Surface

The files a Bitcoin testnet4 pilot and its auditors need to look at, as of
the `pilot-merge` branch (the merge of `main`'s DLC hardening with the
BitVM V2, watchtower, fee-rescue and beta-service line). Everything not
listed under "In scope" is out of scope; see the bottom of this document and
[`CLAIMS_MATRIX.md`](../CLAIMS_MATRIX.md). Open findings and decisions are
in [`PILOT_MERGE_NOTES.md`](../PILOT_MERGE_NOTES.md).

All paths are relative to `bitvm3/utxo_referee/` unless stated otherwise.

## 1. Signer boundary

The only code that holds private key material or produces a signature.
Nothing here should sign real value until
[`SIGNER_MIGRATION_PLAN.md`](../SIGNER_MIGRATION_PLAN.md) is executed;
`productionReady` stays false.

- `../../native/dlc-signer/` — isolated Rust signer (Windows, DPAPI keys).
  `src/main.rs` is the process; `src/lib.rs` and `src/signing_target.rs` are
  the platform-independent signing-target derivation, tested with
  `cargo test --lib` against `tests/signing_target_vectors.json`. The binary
  must be rebuilt and re-attested for the current source (no audited digest
  is pinned on this branch).
- `dlc_crypto_provider.js` — authorization creation and the host side of the
  signing session. Authorizations name a committed CET through a signing
  context; a bare sighash or adaptor point is refused.
- `dlc_signing_target.js` — derives the CET-leaf script-path sighash and the
  oracle adaptor point from the validated transaction set and the
  announcements pinned by the contract.
- `dlc_signing_authorization_store.js`, `dlc_native_signer_process_client.js`
  — durable one-shot authorization consumption and the audited process client.
- `tradelayer_dlc_adaptor_sig.js` — secp256k1/BIP340 Schnorr, adaptor
  signatures (`adaptorVerifyForPoint` for an expected oracle point), oracle
  announcements and attestations.
- `tradelayer_taproot.js`, `tradelayer_taproot_script.js`,
  `tradelayer_taproot_tree.js` — BIP341 sighashes, tapleaf/branch hashing,
  control blocks; `bip341-wallet-test-vectors.json`.

## 2. DLC contract and settlement

- `dlc_funding_output.js` — the one two-party funding output: deterministic
  NUMS internal key (no key path), `<A> CHECKSIGVERIFY <B> CHECKSIG` CET
  leaf, CSV-gated 2-of-2 refund leaf on the same output.
- `dlc_transaction_validator.js` — canonical CET/refund set bound to that
  output, the funding outpoint, fee policy (CPFP anchor or TRUC/P2A) and the
  refund CSV sequence.
- `dlc_signature_validator.js` — counterparty adaptor and refund signatures
  over the script-path sighash of the leaf spent; settlement witness
  assembly and verification (both parties, committed leaf).
- `dlc_contract_state.js`, `dlc_state_store.js`, `dlc_journal_checkpoint.js`,
  `dlc_durable_json_store.js`, `dlc_canonical_json.js` — signed state machine
  and append-only persistence.
- `dlc_threshold_oracle.js`, `dlc_oracle_event_store.js` — 2-of-3 threshold
  oracle outcome points and sealed oracle nonce state.
- `dlc_peer_transcript.js`, `dlc_peer_session_store.js` — offer/accept/sign.
- `dlc_refund_recovery_store.js` — fully signed refund persisted and restored
  before funding.
- `dlc_funding_prebroadcast_guard.js`, `dlc_execution_prebroadcast_guard.js`,
  `dlc_broadcast_authorization_store.js`, `dlc_chain_guard.js`,
  `dlc_bitcoin_core_observer.js`, `dlc_anchor_recovery_guard.js`,
  `dlc_watchtower_journal.js` — Core policy checks, chain and anchor guards.
- `m1_dlc_sign_finalize.js` — funding PSBT finalizer (broadcast disabled).
- `tradelayer_dlc_cet_oracle_selection.js` — Ed25519 "oracle selects a
  pre-built CET" path used by `tradelayer_rbtc_hourly_autoroll.js`. It is not
  script-level enforcement; the attestation signs the payout table hash and
  all contract/funding bindings are required.

## 3. BitVM V2 assertion graph

- `utxoref_v2.js` — signed state checkpoints and exact settlement outputs.
- `bitvm_trace_v2.js` — public wire commitments, reveals and disprove leaves.
- `bitvm_assertion_graph_v2.js` — NUMS-keyed assertion tree. Primary inputs
  are derived by the verifier from the signed state; the terminal output must
  be 1 and has its own disprove leaf; challenge window of at least 6 blocks;
  graph construction in separate build / challenger-sign / operator-sign
  steps.
- `btc_testnet4_utxoref_v2_live.js` — live testnet4 ceremony driver;
  `--broadcast/--status/--settle` verify against the pinned trust policy.

The V1 BitVM files (`tradelayer_bitvm_*.js`) are reachable only through
`legacyUnsafe.load({ acknowledgeUnsafePrototype: true })` and are out of scope.

## 4. Watchtower, challenge and fee rescue

- `utxoref_v2_watchtower.js` — challenge path independent of state age;
  alerts on tick failure; monitors pre-policy graphs only when the trust
  policy pins them as `legacy-unbound-v2-monitor-only`.
- `artifacts/live/utxoref_v2_watchtower_trust_policy.json` — pinned genesis,
  signer keys and allowed graph hashes.
- `utxoref_v2_rpc_proxy.js` — read-only Core proxy for the watchtower host.
- `utxoref_v2_challenge_cpfp.js`, `utxoref_v2_challenge_survival.js`,
  `utxoref_v2_fee_reserve.js`, `utxoref_v2_fee_reserve_guardian.js`,
  `utxoref_v2_reserve_cpfp.js`, `utxoref_v2_guardian_quorum_reserve.js`,
  `utxoref_v2_watcher_quorum.js`, `taproot_reserve_vault.js` — fee rescue and
  reserves (reserve verifiers derive the NUMS internal key and reject others).
- `tradelayer_send_rpc_sweep.js` — `rpcFactory`, with a per-call deadline.
- `../../deploy/` — watchtower and proxy units.

## 5. Beta service

- `../../integrations/utxoref-testnet-beta/` — invite-gated faucet, stress
  verifier and guardian heartbeats. Uses a restricted `rpcauth` user (cookie
  auth refused); the POST limiter evicts instead of refusing.

## 6. Receipts, state and sweep verifier

- `m1_receipt_ledger.js`, `m1_tally_map.js`, `m1_deposit_indexer.js` —
  receipt accounting; deposits are replay-protected by funding outpoint;
  balance claims are recomputed from account and balance.
- `m1_transition.js`, `m1_transition_circuit.js`, `../circuit.js`,
  `../sha256.js` — transition circuit (64-bit constants use BigInt).
- `types.js`, `merkle.js`, `verify.js` — sweep verifier, scored by the locked
  `eval/utxo_referee_eval.js`. It verifies an abstract sweep object, not a
  Bitcoin transaction (see `PILOT_MERGE_NOTES.md`).

## 7. Tests and evals

- `run_utxoref_all.js` — every suite in this directory and `legacy/`.
- `../../eval/utxo_referee_eval.js`, `../../eval/dlc_security_eval.js` —
  locked evals, run at `--profile=full`.
- `../../.github/workflows/pilot-suites.yml` — runs the suites, every
  `*.test.js`, both evals and the Rust library tests on push.

---

## Out of scope

None of the following is imported by anything listed above:

- `legacy/` — MuSig2 (BIP327) and its nonce journal, kept for vector tests
  and the historical demo; not on the pilot path.
- `tradelayer_bitvm_*.js` and the other V1 BitVM files behind `legacyUnsafe`.
- `tradelayer_taproot_dlc_demo.js` (single-key key-path DLC demo) and
  `legacy/tradelayer_musig2_dlc_demo.js` — historical demos.
- `civkit/` — separate package tree; **excluded by explicit instruction**.
- `node-dlc/`, `DLCAdaptor/` — external or separate projects.
- `halal_capital_*.js`, `omani_fiqh_stablecoin_compliance.js`,
  `jurassic_bitvm_mechanisms.js`, `shinigami/`, `asp_bitvm_reserve_bond.js`,
  `rbtc_dlc_zk_settlement_adapter.js` — prototypes not wired into the pilot.
- `integrations/` other than `utxoref-testnet-beta/` — wallet mocks and
  dashboards.
- `codex-chat-sessions/`, and the prover scripts for the excluded prototypes.

An auditor engaged against this pilot should be scoped to the "In scope"
list, not the repository root.
