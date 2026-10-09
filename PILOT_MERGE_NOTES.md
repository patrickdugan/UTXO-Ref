# Pilot merge notes

Branch `pilot-merge` (local only, not pushed). It starts from `origin/main`
`a8b8aa2`, merges `origin/utxoref-v2-remediation` `58ef456`, and then
addresses each finding of the 2026-10-02 testnet-pilot readiness assessment
(Spiral, `utxoref-testnet-readiness/REPORT.md`). One commit per finding, each
message starting with the finding ID.

Every finding below is **fixed** (commit and covering test), **deferred**
(reason) or **needs decision** (options and a recommendation).

## Acceptance (run at `8b63b0a`, Windows, Node 24.19)

| Check | Result |
|---|---|
| `node bitvm3/utxo_referee/run_utxoref_all.js` (now also runs `legacy/`) | 98/98 suites |
| `node scripts/run_every_test.js` (every `*.test.js` plus the two `test.js` entry points) | 114/114 files |
| `node eval/utxo_referee_eval.js --profile=full --require-perfect` | 1.000, 100/100 |
| `node eval/dlc_security_eval.js --profile=full --require-perfect` | 1.000, 568/568 (4 cases added, none removed) |
| `cargo test --lib --locked` in `native/dlc-signer` (WSL, Rust 1.98.1) | 8/8 (4 signing-target, 4 clock-store) |
| `cargo check --target x86_64-pc-windows-gnu` | passes; binary **not** built (see MAIN-3) |

The first acceptance run was at `f9f397c` (eval 560/560, cargo 4/4). Follow-up
commits after this file was added: `cf08e54` MAIN-4, `54f9cdf` MAIN-3 (oracle
event binding), `ae478f2` BETA-1, `ab5a0b1` MAIN-5, `3a9b762` DLC-8, `62a6085`
WT-2, `86fbd5c` BVM-6, `8b63b0a` BVM-4. The two integration evals that need the
Windows signer binary (`eval/dlc_native_signer_integration.js`,
`eval/dlc_dedicated_account_probe.js`) were syntax-checked only.

### Readiness PoCs against this branch

Run with `UTXOREF_REPO` pointing at this checkout; a PoC exits 0 when its
finding reproduces. The PoCs were not edited. Re-run at `8b63b0a`: same exits
and outcomes as below.

| PoC | Exit | Outcome | In-repo coverage |
|---|---|---|---|
| poc1 adaptor nonce reuse (DLC-1) | 2 | Secure: "no shared nonce in 300 messages" | `tradelayer_dlc_adaptor_sig.test.js`; eval "T and -T cannot reuse an adaptor signing nonce" |
| poc2 MuSig2 journal replay (DLC-2) | 1 | Fails to load: `tradelayer_musig2` moved to `legacy/` | `legacy/tradelayer_nonce_journal.test.js` "partialSignGuarded refuses the same message in a different session" (port of poc2) |
| poc3 DLC-3/4/5 | 1 | Fails to load: requires `tradelayer_musig2` | DLC-3: `dlc_infra_hardening.test.js` "DLC-3: a pre-signature under a non-oracle point is refused…" and the wrong-point signer case; DLC-4: "CET adaptor and refund signatures bind to validated BIP341 sighashes"; DLC-5: `tradelayer_dlc_cet_oracle_selection.test.js` (two new tests) |
| poc4 BitVM unbound predicate (BVM-1/2/3) | 1 | Secure: template refused, "expected inputs must equal the values the verifier derives from the signed state". The BVM-3 half is not reached. | `bitvm_assertion_graph_v2.test.js` BVM-1 and BVM-3 tests |
| poc5 refund key path (DLC-6) | **0** | **Still exits 0, and always will:** it rebuilds the old demo's output inline from curve primitives and never calls the demo or any validator, so it cannot observe a fix. | The demo now funds `dlc_funding_output.js` (NUMS key); `dlc_infra_hardening.test.js` "DLC funding output is a NUMS-keyed two-party Taproot output…" checks no party key yields the output key or a key-path secret |
| poc6 beta rate-limit lockout (BETA-1) | 1 | Secure behaviour, then a PoC crash: 5,000 distinct addresses got no 503, so the PoC's `firstRefusal` stayed null and it dereferenced it | `integrations/utxoref-testnet-beta/test.js` `testRateLimitFloodDoesNotLockOut` |
| poc7 watchtower stale gate (WT-1) | 1 | Secure: `challenge_signature_required` at snapshot+6, +7 and +12 | `utxoref_v2_watchtower.test.js` stale/reorg/tick-failure tests |
| poc8 single-key funding (MAIN-1) | 1 | Secure: the validator refuses the single-key funding output ("partyPubkeyXs must contain exactly two") | `dlc_infra_hardening.test.js` NUMS funding test; eval "funding output is the NUMS-keyed two-party script…" |
| poc9 authorization not bound to CETs (MAIN-3) | 1 | Secure: "bare-sighash signing is not supported" | `dlc_infra_hardening.test.js` signing-authorization test (MAIN-3 cases); `dlc_signing_target.test.js`; eval "signer authorizations name a committed CET…" |
| poc10 red-team items (MAIN-4) | 1 | Secure: constant 1 sets bit 0 only; rewritten claim fails; outpoint replay refused | `m1_redteam_state_regressions.test.js` |
| poc11 reserve internal key (RES-1) | 1 | Secure: "custom internal key is forbidden" | `taproot_reserve_vault.test.js`, `utxoref_v2_guardian_quorum_reserve.test.js`, beta `test.js` |

Strictly, "no PoC reproduces" is not met because of poc5; the finding itself
is fixed and covered in-repo.

## Findings

### Main line (section 0 of the report)

| ID | Status | Commit | Tests / notes |
|---|---|---|---|
| MAIN-1 | Fixed | `f0f73d7` | Two-party NUMS-keyed funding output with CET and CSV refund leaves; validators derive it and check script-path signatures for a committed party. `dlc_infra_hardening.test.js` (NUMS funding test, signature test, refund recovery, execution guard); two eval cases. |
| MAIN-2 | Fixed | `a64a1b4` | Merge. `bitagent_compatibility.test.js`, `index_v2_boundary.test.js`. Decision recorded below (top-level sweep verifier exports). |
| MAIN-3 | Fixed (binary not rebuilt) | `54aa33b` | Signing context instead of bare sighash; host and Rust signer derive sighash and oracle point. `dlc_infra_hardening.test.js`, `dlc_signing_target.test.js`, `cargo test --lib`, eval case. The Windows signer binary has not been rebuilt or re-attested: no Rust toolchain on the Windows host, and WSL lacks MinGW import libraries to link it. `index.js` no longer pins a binary digest. |
| MAIN-4 | Fixed (seven state items); circuit items deferred | `5dceb60`, `cf08e54` | `constantBits`, balance-claim binding, deposit replay by outpoint (`5dceb60`); u64 overflow, committed-blob loading, epoch/window monotonicity and code-unit ID ordering (`cf08e54`). `m1_redteam_state_regressions.test.js`. Deferred: the four `REDTEAM_FINDINGS.md` items that need the M1 transition circuit redesigned (SHA-256 vs placeholder hash, unused claim bits and account id, route bits not bound to a payout, no in-circuit `pnlPayoutBps <= 10000`). That circuit is not on today's V2 settlement path, but it is on the roadmap's: M1 state is meant to be served by TradeLayer (on-chain), fraud-provable at the state-oracle level, and these four items are where that proof currently breaks. Also deferred: the sweep verifier's release gate (abstract sweep object, no transaction/fee/network binding) — needs its own design and locked eval stage. |
| MAIN-5 | Fixed (binary not rebuilt) | `ceb6ae1`, follow-up | Consumed authorizations are refused before a clock observation is written. Follow-up: the clock store moved to the platform-independent `src/clock_store.rs` and compacts after each write to the newest 64 observations (the newest is the rollback floor, so it is kept); `cargo test --lib` covers the floor, compaction, a full 4,097-file pre-compaction store, foreign keys and the read cap. `powershell.exe` is resolved through `GetSystemDirectoryW`, not `SystemRoot`/`WINDIR`; that part is type-checked only (`cargo check --target x86_64-pc-windows-gnu`), since the Windows binary cannot be built here. |

### DLC

| ID | Status | Commit | Tests / notes |
|---|---|---|---|
| DLC-1 | Fixed on `main` before the merge | `a64a1b4` (inherited) | `tradelayer_dlc_adaptor_sig.test.js`; poc1 exits 2. |
| DLC-2 | Fixed | `15f1b42` | Journal bound to the whole MuSig2 session; MuSig2 moved to `legacy/` (not on the pilot path). `legacy/tradelayer_nonce_journal.test.js`. |
| DLC-3 | Fixed | `bd3d5c4` | `adaptorVerifyForPoint`; the provider checks the derived oracle point. `dlc_infra_hardening.test.js` DLC-3 test and wrong-point signer case. |
| DLC-4 | Fixed | `0cf4c3a` | No MuSig2 shares: each party's full adaptor signature is verified under its own key before funding. `dlc_infra_hardening.test.js` signature test. |
| DLC-5 | Fixed | `fe76905` | Bindings required; attestation signs `outcomesHash`. `tradelayer_dlc_cet_oracle_selection.test.js`. |
| DLC-6 | Fixed | `c995b05` | Refund leaf on the NUMS-keyed DLC output; demo rebuilt on it. `dlc_infra_hardening.test.js` NUMS test. See poc5 above. |
| DLC-7 | Fixed on `main` before the merge | `a64a1b4` (inherited) | Funding broadcast disabled and gated by the state machine; eval "funding broadcast request fails before artifacts or RPC" and "funding finalizer contains no transaction broadcast RPC". The old M1 CET skeleton artifacts (zero miner fee, single wallet) belong to `m1_dlc_psbt_cet.js`, which is no longer on the pilot surface. |
| DLC-8 | Fixed | `a64a1b4` (inherited), follow-up | `schnorrVerify`/parsing fail closed on `main`. Follow-up: `schnorrSign` verifies its own output before returning (BIP340); legacy MuSig2 `sessionValues` refuses an adaptor nonce at infinity instead of crashing, and `partialSign` applies the BIP327 Sign checks (nonce and key range, secnonce key match, signer in the key set). `legacy/tradelayer_musig2.test.js` runs the BIP327 sign-error vectors and the infinity case. |

### BitVM

| ID | Status | Commit | Tests / notes |
|---|---|---|---|
| BVM-1 | Fixed | `2924b5b` | Verifier-derived inputs, terminal output 1 with a 0-reveal disprove leaf. `bitvm_assertion_graph_v2.test.js` BVM-1 tests. Decision recorded below (funded pre-policy graphs). |
| BVM-2 | **Needs decision** (revised recommendation) | — | See below: the trace is checked by the challenger before funding, so option B adds little; A for the pilot, C before mainnet. |
| BVM-3 | Fixed | `da0881e` | 6-block minimum window (caller can raise). `bitvm_assertion_graph_v2.test.js` BVM-3 test. Window sizing remains open (blocker #7). |
| BVM-4 | Fixed (API and live driver) | `db377e6`, follow-up | Build-unsigned / challenger-sign / operator-sign. `bitvm_assertion_graph_v2.test.js` BVM-4 tests. Follow-up: the live driver uses the split steps; `--challenger-xonly` stages an unsigned graph with no challenger secret on the operator host, `--challenger-sign` runs on the challenger's host from the pinned trust policy (no RPC, refuses fraud unless `--allow-fraudulent-trace`), `--operator-sign` completes it. `btc_testnet4_utxoref_v2_live.test.js` BVM-4 tests. No separated-host testnet4 run yet. |
| BVM-5 | Fixed | `63cf358` | Live driver loads the pinned trust policy. `btc_testnet4_utxoref_v2_live.test.js`. |
| BVM-6 | Partly fixed; mirror publication needs decision | follow-up | The watchtower alerts `settlement_due` / `recovery_imminent` and, with `--broadcast-settlement`, sends exactly the committed settlement without a key. `utxoref_v2_watchtower.test.js` BVM-6 tests. Mirror publication before funding: see below. |

### Watchtower, reserves, beta, docs

| ID | Status | Commit | Tests / notes |
|---|---|---|---|
| WT-1 | Fixed | `2b29445` | `utxoref_v2_watchtower.test.js`; poc7 secure. |
| WT-2 | Fixed (settlement broadcast, alert delivery, dead-man heartbeat); not deployed | follow-ups | The deployed proxy (`utxoref_v2_rpc_proxy.js`) relays `sendrawtransaction` only for settlements it derives from the pinned trust policy and artifact; the swarm proxy (`btc_testnet4_readonly_rpc_proxy.js`) takes an allowlist file. `utxoref_v2_alert_notifier.js` delivers email/webhook alerts with escalation and acknowledgement; a heartbeat URL is pinged after every healthy tick. The unit runs `--broadcast-settlement`. `utxoref_v2_alert_notifier.test.js`, `utxoref_v2_watchtower.test.js`, `btc_testnet4_readonly_rpc_proxy.test.js`. See below. |
| WT-3 | Fixed | `ecfb651` | `tradelayer_send_rpc_sweep.test.js` timeout tests. The other hand-rolled RPC clients in M1-era demos were not changed; they are not on the pilot path. |
| RES-1 | Fixed | `ca932f9` | Reserve verifiers and the beta loader derive the NUMS key. |
| BETA-1 | Fixed | `46d7b8d`, follow-up | Evict instead of refuse; heartbeats not IP-throttled. Follow-up: counters moved off the state file into an in-memory limiter with its own file (flushed at most once a second and on close), so unauthenticated POSTs no longer take the state lock or rewrite the journal. `integrations/utxoref-testnet-beta/test.js` (flood leaves the state file byte-identical; pre-split counters carry over). |
| BETA-2 | Fixed (code); operator action required | `0230948` | Cookie auth refused; startup check that `rpcwhitelist` is in force. The running beta uses the cookie, so a restricted `rpcauth` user must be provisioned before this branch is deployed. |
| DOC-1 | Fixed | `f9f397c` | `docs/PILOT_SURFACE.md`, `CLAIMS_MATRIX.md`, `SECURITY_BLOCKERS.md`, `.github/workflows/pilot-suites.yml`. The workflow has not run (nothing pushed). |

## Decisions needed

### What a V2 graph protects before funding (applies to BVM-2, BVM-6, WT-2)

Checked in code on this branch, and it changes the analysis behind the three
items below:

- The public trace reveals the chosen preimage of every wire
  (`buildPublicTraceV2`), and the taproot tree commits its root. Every
  provable fraud is therefore visible when the graph is built.
- `challengerSignBitvmAssertionGraphV2` refuses to pre-sign a trace that
  contains a provable fraud (drills must pass `allowFraudulentTrace`).
- The live driver finalizes the graph (both signatures) before it builds the
  funding transaction.

So a fraudulent trace is refused before coins are at stake, and the disprove
leaves only matter for a graph someone funded despite a fraud (the drills).
After funding, what can go wrong on an honest graph is that nobody broadcasts
the pre-signed settlement before the operator's recovery leaf matures
(2,016 blocks), and that the operator and the challenger together can settle
any trace.

### BVM-2: settlement does not depend on the circuit

The settlement leaf is `<csv> CSV DROP <operator> CHECKSIGVERIFY <challenger>
CHECKSIG`. Security is a pre-signed 2-of-2 with one named challenger, who
checks the whole trace before signing.

- **A. Describe it honestly and keep it.** Already done in
  `CLAIMS_MATRIX.md` and `PILOT_SURFACE.md`.
- **B. Make settlement reveal the terminal bit** (`OP_SHA256 <hash1(terminal)>
  OP_EQUALVERIFY` in the settlement leaf). Given the section above, this
  re-checks a bit the challenger already verified before signing, at the cost
  of changing every graph address. It does not remove the trust in the
  challenger.
- **C. Permissionless challengers** (BitVM2-style connector outputs or an
  N-of-N pre-signed challenge set), so no single named party can co-sign a
  bad settlement.

Recommendation (revised): **A for the testnet pilot**, **C before mainnet**.
B is not worth an address change.

### BVM-6 and blocker #6: payees depend on data the operator holds

Settlement is broadcastable by anyone with the signed package; if nobody
broadcasts within 2,016 blocks the operator's recovery leaf takes the output.

**Partly done on this branch (follow-up commit).** The watchtower now treats
the pre-signed settlement as its post-funding duty on an honest graph:

- it alerts `settlement_due` once the challenge window has passed and
  `recovery_imminent` when the recovery leaf is 144 blocks or less from
  maturing;
- with `--broadcast-settlement` it sends exactly the committed settlement
  (checked by txid in `testmempoolaccept` and in the broadcast result). No key
  is involved. It never does so for a fraudulent, reorged, stale-at-
  authorization or monitor-only graph.

Still open:

- **A.** Require publication of the graph package to two or more independent
  mirrors, and delivery to each payee, before the live driver will fund.
- **B.** Lengthen the recovery delay relative to the challenge window.
- **C.** Give payees their own pre-signed claim path (per-payee leaves).

Recommendation: **A** next (gate funding on mirror receipts), with **B** as a
cheap complement. A watchtower holding the package is one copy, not
availability.

### WT-2: the deployed watchtower can detect but not act

No challenger key on the host, and the read-only proxy blocked
`sendrawtransaction`.

Given the section above, the action that matters after funding is broadcasting
the fully signed settlement, which needs no key. **Done on this branch
(follow-up commits):**

- The deployed path is VPS watchtower -> reverse SSH tunnel ->
  `utxoref_v2_rpc_proxy.js` on the operator host -> Core. That proxy now relays
  `sendrawtransaction` only for the committed settlement of a graph that
  verifies against the pinned trust policy, is honest and is predicate-bound;
  it derives that set itself from `--trust-policy` and `--settlement-artifact`
  (the bridge script passes both), so nothing the VPS sends can widen it.
- The swarm-worker proxy (`btc_testnet4_readonly_rpc_proxy.js`) takes
  `--broadcast-allowlist-file` instead; the watchtower's
  `--write-settlement-allowlist` writes it after verification.
- Option C is implemented: `utxoref_v2_alert_notifier.js` sends email
  (Postmark, Resend, SendGrid, Mailgun HTTP APIs) and/or webhooks (generic,
  Slack, Discord, ntfy). Critical alerts repeat every 30 minutes until
  acknowledged (`--ack-alert`), warnings once, a `resolved` notice on recovery,
  three consecutive failed ticks escalate, undelivered alerts retry, 20 per
  hour cap with critical exempt. A dead-man heartbeat URL is fetched only after
  healthy ticks, so a push monitor alerts on silence.
- The unit runs `--broadcast-settlement`; a refused broadcast is the critical
  alert `settlement_broadcast_failed`, not a failed tick. Alert settings live
  in `/etc/utxoref-v2-watchtower-alerts.env`, which the bridge never rewrites.

Not deployed: the VPS unit, the bridge and the alert env file need to be
reinstalled, and an email provider key and heartbeat monitor provisioned.

Still open: **A.** A challenger key on the watchtower host (hot key) for
disprove transactions. Not recommended; with the pre-funding refusal it would
only serve graphs funded despite a fraud. Keyless fee bumping of a stuck
settlement needs an anchor output (pay-to-anchor) on the settlement, which
changes graph addresses: needs decision.

### Funded pre-policy testnet4 graphs (from BVM-1)

The two graphs in the trust policy (`34dfe4a3…`, `e98272fd…`) were funded
before the bound-predicate policy. The verifier refuses them unless the
pinned trust policy marks them `legacy-unbound-v2-monitor-only`, which this
branch does so the funded outputs stay monitored; they are reported with
`predicateBound: false`.

- **A.** Keep monitoring them as legacy until they settle, then remove the
  entries.
- **B.** Re-issue a bound-predicate graph on testnet4 and move the beta to it
  (requires a broadcast, not done here, and an update to the uptime monitor's
  expected graph hash).

Recommendation: **B**, then drop the legacy entries.

### Oracle announcement pinning (from MAIN-3)

The contract's `oracle_policy` receipt pins the exact announcement set, and
the signer derives adaptor points only from those announcements, which must
be signed by the pinned oracle keys. On its own that let the validator key pin
announcements of a different event by the same oracles.

- **A.** Add the event id (and outcome list) to the contract.
- **B.** Leave it to the validator's review of the `oracle_policy` receipt.

**Done (A), follow-up commit on this branch.** The contract oracle policy now
takes `eventId` and the ordered `outcomeMessages`. Adaptor signing refuses a
contract whose policy does not name them, and refuses announcements for any
other event or outcome list even when the receipt pins them. The derived
`oracleEventId` is in the validator-signed payload, and the Rust signer
checks it against the announcements it verified. Policies without an event
stay valid for state tracking, so existing journals still load.

### Signing-request size

Native requests are capped at 32 KiB by the process client and 64 KiB by the
named-pipe broker. A signing context is about 5 KiB for two CETs, so the cap
allows a few dozen CETs. Contracts with many outcomes need either a larger
cap or a Merkle commitment to the CET set with a per-CET inclusion proof.
Recommendation: Merkle commitment before contracts with large outcome sets.

### Top-level sweep-verifier exports (from MAIN-2)

`types`, `merkle`, `verify` and their classes stay importable from the
package root because the locked `eval/utxo_referee_eval.js` imports them
there; they are also listed under `legacyUnsafe`. They verify an abstract
sweep object, not a Bitcoin transaction. Options: keep (current), or move
them behind `legacyUnsafe` and update the eval import in a separately
reviewed eval change. Recommendation: keep until the sweep verifier is
rebuilt on real transactions (MAIN-4 residual).

## Other notes

- `fraudCount` from `verifyBitvmAssertionGraphV2` now includes input- and
  output-binding frauds; `gateFraudCount`, `inputBindingFraudCount` and
  `outputBindingFraudCount` are reported separately.
- `dlc_signing_fixture.js` is test support only (it builds signable
  fixtures for tests, evals and the Rust vectors).
- Nothing was pushed, no pull request was opened, nothing was broadcast, and
  the deployed beta was not contacted.
