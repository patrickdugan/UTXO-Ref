# Security Blockers — Pilot Launch Gate

These are launch blockers for any adversarial signet/testnet pilot involving
real or simulated-real value. Each must be closed, mitigated, or explicitly
accepted-with-sign-off before the pilot surface (`docs/PILOT_SURFACE.md`)
touches value that isn't fully recoverable by the operator alone. Ordered
roughly by severity/blast radius, not by convenience of fixing.

Cross-reference: [`CLAIMS_MATRIX.md`](CLAIMS_MATRIX.md) for what is and isn't
proven today; [`docs/ADVERSARIAL_SIGNET_PLAN.md`](docs/ADVERSARIAL_SIGNET_PLAN.md)
for the rehearsal that is meant to close several of these at once.

---

## 1. Hand-rolled BigInt signer, non-constant-time

**Where:** `bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig.js`, `tradelayer_musig2.js`, `tradelayer_taproot.js`

secp256k1 point arithmetic (`pointAdd`, `pointDouble`, `pointMul`) is
hand-written variable-time BigInt code. The file's own header already states
this is "a reference implementation for testnet DLC settlement, not a
constant-time production signer." Variable-time scalar multiplication is a
textbook timing side-channel on the private key; there is no side-channel
hardening anywhere in this signing path.

**Status (2026-07-06): partially fixed, zero new dependencies.** Every point
multiplication in this codebase where the scalar is *secret* (private key,
nonce, oracle secret, adaptor secret) is always a multiplication by the fixed
generator `G` - verified by auditing every `pointMul` call site. That
operation is now routed through Node's built-in `crypto.createECDH('secp256k1')`
(`pointMulGeneratorHardened` in `tradelayer_dlc_adaptor_sig.js`), which uses
OpenSSL's constant-time-ish scalar multiplication for named curves - still
"Node built-ins only," consistent with the repo's zero-dependency design
(an npm-registry check was deliberately not pursued for this reason).
Arbitrary-point multiplication (scalar * P for P != G) remains pure JS and
variable-time, but every such call site multiplies a PUBLIC point by a
PUBLIC scalar (signature-verification math only) - nothing secret to leak
via timing there today. Full regression suite re-run clean after the change
(65/66 suites, the one failure pre-existing and unrelated - see
`RUN_LOG_2026-07-05.md`).

**Residual risk:** if a future change ever introduces a secret scalar times
a non-generator point, that call site would inherit the original variable-time
risk and must be routed through an audited library first - Node has no
built-in for general constant-time arbitrary-point multiplication with a
usable full-point output (only generator multiplication via
`ECDH.getPublicKey`, and X-coordinate-only Diffie-Hellman via
`ECDH.computeSecret`). See [`SIGNER_MIGRATION_PLAN.md`](SIGNER_MIGRATION_PLAN.md)
for the path if/when the zero-dependency constraint is relaxed.

---

## 2. MuSig2 / adaptor nonce-misuse risk

**Where:** `tradelayer_musig2.js` (nonce generation/aggregation), `tradelayer_dlc_adaptor_sig.js` (adaptor offset on aggregate nonce)

MuSig2 security depends entirely on never reusing a nonce for two different
messages/sessions under the same key. A single reused or predictable nonce
leaks the private key outright — this is not a gradual degradation. The
current implementation generates nonces via `crypto.randomBytes` per call
with no session-state tracking, no replay/reuse detection, and no protection
against a caller invoking the signer twice over the same message (e.g. after
a crash/retry).

**Status (2026-07-06): fixed for the MuSig2 partial-signing path.** Audited
first: `tradelayer_dlc_adaptor_sig.js`'s single-party `schnorrSign`/`adaptorSign`
already derive their nonce deterministically from `(secret, message)` per
BIP340, so the same message always re-derives the same (safe) nonce and
different messages get different nonces by hash-randomness - no fix needed
there. The real gap was `tradelayer_musig2.js`'s `partialSign`, which takes a
caller-generated nonce with no reuse protection at all. New
`tradelayer_nonce_journal.js` durably persists a (nonce-fingerprint,
message-fingerprint) pair to disk *before* any signature is computed; a
retry with the same (nonce, message) is a safe idempotent replay, a retry
with the same nonce and a *different* message throws `NonceReuseError`
before signing. New `partialSignGuarded()` in `tradelayer_musig2.js` wraps
the original vector-tested `partialSign()` with this check and is now what
`tradelayer_musig2_dlc_demo.js` (the real value-signing demo) calls instead
of the raw primitive. 6 new tests in `tradelayer_nonce_journal.test.js`
cover first-use, idempotent replay, reuse detection, no-false-positives, and
that the journal never persists raw nonce material. Full regression clean
(66/67, one pre-existing unrelated failure).

**Residual risk:** the journal is local-filesystem-based (fine for a single
operator process, per SECURITY_BLOCKERS #3's self-play framing); a real
multi-process or multi-machine signer would need the journal itself to be
the single source of truth across all signing instances (e.g. a proper
lock/consensus store), not just a local JSON file.

---

## 3. Operator / challenger / oracle self-play

**Where:** Every on-chain demo in `CLAIMS_MATRIX.md` (all `*_demo.js` files)

Every confirmed on-chain dispute — gate disprove, comparator disprove,
CSV timeout reclaim, input-binding disprove, SHA256 disprove — was funded,
asserted, and challenged by the same operator-controlled wallet. This proves
the Bitcoin Script mechanics execute as designed. It proves nothing about
whether an *independent* party would ever notice a real equivocation, be
willing to challenge it, or be able to assemble the challenge in time.

**Status:** Zero adversarial (non-self-play) test runs exist in this repo.

**Required before pilot:** The rehearsal in `docs/ADVERSARIAL_SIGNET_PLAN.md`
with genuinely separate operator/challenger/oracle keys, run by different
processes (ideally different people), is the minimum bar.

---

## 4. Reserve snapshot is not reserve encumbrance

**Where:** `tradelayer_live_reserve_adapter.js`, `tradelayer_reserve_reconciliation_referee.js`, `taproot_reserve_vault.js`, `btc_testnet4_reserve_vault_demo.js`, `tradelayer_bitvm_solvency_referee.js`

The solvency circuit proves that `cap <= reserve` was computed honestly over
the committed inputs. The "reserve" input is a `listunspent` snapshot of
ordinary, fully spendable wallet UTXOs at one point in time. Nothing prevents
the operator from publishing an honest reconciliation and then spending the
underlying UTXOs before, during, or after the challenge window — the circuit
has no visibility into wallet state after the snapshot is taken.

**Status:** This is a proof of an honest *calculation*, not a proof of
reserve availability at withdrawal time. Classic proof-of-reserves gap
(same class of issue as exchange-run PoR without liabilities disclosure or
without a locking mechanism).

**Status (2026-07-06, earlier pass): option (b) implemented - freshness
window, not encumbrance.** The legacy `listunspent` path is still an
ordinary-wallet snapshot. `buildTradeLayerReserveReconciliation` accepts
`observedAtHeight` (the chain height when the reserve snapshot was taken)
and `maxReserveAgeBlocks` (default 6 blocks, ~15 min on Litecoin); a
reserve snapshot older than that window is fail-closed - `solvent` is
forced `false` regardless of the cap<=reserve arithmetic, both at build
time and, critically, again at *verify* time against a freshly-fetched
live height, so a reconciliation that was fresh when built but has since
aged past the window is caught the next time anything checks it, not just
once. Wired into the real live-reserve path
(`tradelayer_live_reserve_demo.js`): fetches the real chain tip once up
front, uses it consistently for both the snapshot's own height math and
the freshness check, then re-fetches the tip immediately before the gate
decision. Fully backward compatible - omitting `observedAtHeight` (as every
prior caller does) leaves staleness unchecked, exactly as before. 13 tests
in `tradelayer_reserve_reconciliation_referee.test.js` (5 new) cover
in-window, out-of-window, went-stale-since-build, and a reorg/bad-input
edge case (`currentHeight` before `observedAtHeight` fails closed rather
than being silently accepted).

**Status (2026-07-06, BTC testnet4 reserve-vault v1): encumbered reserve
evidence now exists for the new path.** `taproot_reserve_vault.js` builds
and verifies a BTC testnet4 P2TR reserve vault manifest with two tapscript
leaves: immediate spend requires both the operator and watchtower guardian
signatures; recovery is operator-only after a CSV delay (default 2016
blocks). `tradelayer_reserve_reconciliation_referee.js` now accepts
`kind: 'taproot-reserve-vault-set'` before legacy `reservedSats` snapshots
and sums only vault UTXOs that are still live on chain, match the manifest
scriptPubKey/amount/outpoint/network, and are safely outside the recovery
risk window. Guardian approval receipts sign only the exact policy-matching
transaction sighash and refuse wrong outputs, excessive fees, stale reserve,
or insolvent caps. This is still not a covenant: the on-chain enforcement is
guardian co-signature plus operational policy, so production safety depends
on independent guardian operation and key separation.

**Bug found and fixed along the way:** wiring the live re-check exposed a
pre-existing issue in `tradelayer_live_reserve_adapter.js` -
`buildLiveReserveFromUnspent`'s synthetic "currentHeight" fallback was
derived from the *highest UTXO confirmation count* (a relative depth), not
the real absolute chain tip. Comparing that against a real tip height
produced a nonsense multi-million-block "age." Fixed by having
`tradelayer_live_reserve_demo.js` fetch the real tip via `getblockcount`
up front and pass it in explicitly, so all height math in that path is now
on one consistent absolute scale.

**Required before pilot:** Use the BTC testnet4 vault evidence path for any
claim that reserves are encumbered. The legacy snapshot mode must remain
documented as weaker demo evidence. For production, validate independent
watchtower operation, separated keys, recovery runbooks, and the recovery
risk margin. A 6-block default freshness window on the legacy snapshot path
is only a starting point, not a validated threat-model number - it should be
revisited against
real operational re-attestation cadence before real value is at stake.

---

## 5. No persistent, independent watchtower

**Where:** `tradelayer_send_watchtower.js`

`buildTradeLayerSendWatchtowerReport` is a pure function: given an input
blob, it returns a report with alerts. There is no polling loop, no chain
subscription, no scheduled invocation, no persistence layer, and no alert
delivery (email/webhook/pager) anywhere in the codebase. If the operator
equivocates today, nothing currently running would notice, let alone act
within a CSV challenge window.

**Status:** The evidence-object plumbing this depends on is real and
tested; the "watchtower" as an operating security control does not exist.

**Status (2026-07-06): partially fixed - a real persistent process now
exists.** New `tradelayer_watchtower_daemon.js`: polls on a fixed interval,
independently re-derives the reserve solvency/freshness invariant every
tick straight from live RPC (`listunspent` + `getblockcount`, not trusting
any artifact the operator produced), and durably logs an alert
(`watchtower_alerts.jsonl`) on any fault. State is persisted to disk on
*every* tick, not just on a graceful SIGTERM/SIGINT handler - this was a
deliberate design choice made after this project's own litecoind background
process was killed twice by the execution harness with zero graceful-
shutdown log line either time. Proven concretely, not just claimed: ran the
daemon continuously, force-killed the OS process abruptly mid-run
(`Stop-Process -Force`, no signal handling possible), and restarted it -
it resumed from the exact last completed tick (`tickCount` continued
16→17, `startedAt` preserved, `restarts` counter incremented), not from
zero. 8 tests in `tradelayer_watchtower_daemon.test.js` (dependency-injected
fake RPC, no live node needed) cover fresh-start, resume-after-restart,
double-resume, atomic-write safety, a solvent/fresh tick producing no
alert, an insolvent tick producing exactly one durable alert, and the
trace-withholding checks described in Blocker #6.

**Residual gap - explicitly not claimed as fixed:** this daemon monitors
and alerts on the reserve-solvency/freshness invariant (Blocker #4's
concern), and it can now check a configured registry of bonded circuit
assertions for trace-withholding faults (Blocker #6). It does **not** yet
automatically construct and broadcast a BitVM circuit disprove transaction
for an arbitrary future bonded assertion (the comparator/SHA256 disprove
trees from Blocks 2-10). A launch runbook must still define how a durable
alert turns into a signed, fee-bumped challenge transaction.

**Required before pilot:** add real alert delivery beyond a local JSONL
file (webhook/pager) once there's an operator distinct from the watchtower
to notify; run this daemon somewhere persistent (a real always-on
host/service) rather than inside an interactive coding session; and wire a
specific disprove broadcaster for the assertion types admitted into the
pilot. The abrupt-kill resumability was proven, but "resumes correctly" is
not the same guarantee as "someone is watching it restart when it needs
to."

---

## 6. No trace / data-availability mechanism

**Where:** BitVM circuit modules (`tradelayer_bitvm_circuit.js`, `tradelayer_bitvm_comparator.js`, `tradelayer_bitvm_sha256.js`)

To localize a single bad gate among (in the SHA256 case) ~447,000
disprove leaves, a challenger needs the operator's full wire-commitment
execution trace. Nothing in this repo specifies where that trace is
published, in what format, for how long, or what happens if the operator
asserts a claim and simply withholds the trace. If withholding is not itself
punishable, an operator can bond a fraudulent claim and let the CSV timeout
expire uncontested by data-starving any would-be challenger.

**Status (2026-07-06): partially fixed.** New
`tradelayer_trace_publication.js` defines the interim trace commitment and
retrieval rule: `publishTrace()` hash-commits the circuit trace,
`retrieveTrace()` rejects missing or substituted traces, and
`checkPublicationFault()` treats non-publication past an SLA in blocks as a
fault. `tradelayer_watchtower_daemon.js` can now load a watched-assertions
registry each tick and durably alert on `TRACE_WITHHOLDING_FAULT`. The
focused suites pass: 7 tests in `tradelayer_trace_publication.test.js` and
8 tests in `tradelayer_watchtower_daemon.test.js`.

**Residual risk:** the current retrieval location is local filesystem
storage under artifacts, standing in for a mirrored DA endpoint. It proves
the commitment/hash/SLA rule but does not yet prove an independent
challenger can retrieve traces without operator cooperation. Retention,
mirroring, authentication, and mapping a DA fault to a specific on-chain
bond/challenge spend remain pilot runbook items.

**Required before pilot:** mirror the trace artifacts somewhere independent
watchtowers can fetch; include the trace hash in the bonded assertion
commitment for each admitted circuit type; define retention and SLA values;
and rehearse the resulting fault path with separated operator/challenger
keys.

---

## 7. No specified bond economics

**Where:** All `*_dispute*`, `*_timeout*` demos

CSV delays used in demos (e.g. 2 blocks) are illustrative test values, not
sized for any real threat model. Bond sizes, challenge-window lengths, and
challenger compensation are all unspecified. Without compensation, a rational
independent challenger has no economic reason to spend engineering effort and
transaction fees monitoring and disproving someone else's claims — the
dispute game is only as strong as someone's willingness to challenge for
free.

**Status:** Not implemented; no economic model exists anywhere in the repo.

**Required before pilot:** A minimum viable bond/reward/window spec, even if
conservative (e.g. operator-funded challenger bounty proportional to the
bonded amount, CSV window sized to realistic worst-case confirmation
latency plus trace-retrieval time).

---

## 8. Single, operator-run oracle

**Where:** All DLC demos (`tradelayer_musig2_dlc_demo.js`, `tradelayer_taproot_dlc_demo.js`, `tradelayer_dlc_cet_oracle_selection.js`)

Every oracle keypair in every demo is generated in-process by the same code
that runs the rest of the pilot. There is no threshold oracle, no external
or independently-operated oracle, and no mechanism to detect-and-punish
oracle equivocation (adaptor signatures make equivocation *extractable*
after the fact, but nothing in this repo consumes that extraction to
penalize the oracle).

**Status:** Architecturally single-point-of-failure/trust for settlement
outcome.

**Required before pilot:** At minimum an n-of-m oracle threshold, or an
oracle operated by a party distinct from the pilot operator, plus a defined
consequence for detected equivocation.

---

## 9. Missing refund path for oracle non-attestation

**Where:** All DLC/CET demos

Every settlement demo assumes the oracle eventually attests some outcome. No
demo, test, or spec shows what happens if the oracle never attests —
collateral in the 2-of-2 has no timeout-based refund/unilateral-recovery
path. This is a fund-lockup risk distinct from the fraud-proof/watchtower
concerns above.

**Status (2026-07-06): mechanism built and confirmed on-chain
(self-play).** `tradelayer_dlc_refund_cet_demo.js` implements a CSV-gated
2-of-2 taproot script-path refund CET with no oracle input; the mechanism
run confirmed on LTCTEST with funding txid
`7c3f7032e4fac551200ee687f07a9fde980bced343efc4bcd14378591c7b1f7d` and
refund spend txid
`04718dd1bb70346b89c1024c677c0c9dbd55989d1c0190fc2cc712eea740ed13`.

**Required before pilot:** rerun the refund path with separated
operator/counterparty/oracle keys and production-sized CSV/fee settings;
the current evidence proves the Script mechanism, not adversarial
operations.

---

## 10. Untested fee bumping, mempool pinning, and reorg behavior

**Where:** Entire live-path stack; explicitly listed as missing in `bitvm3/utxo_referee/UTXOREF_PRODUCTION_GAP_AND_LIVE_PATH.md`

All on-chain evidence was produced on LTCTEST with fixed ~1,000-sat fees in a
benign, low-contention mempool. None of the following have been exercised
even once: fee-rate bumping (RBF/CPFP) under load, an adversary pinning a
disprove/timeout transaction in the mempool to run out the CSV clock, or a
chain reorg invalidating a "confirmed" funding/dispute transaction.
Mempool-pinning attacks against exactly this kind of CSV-timeout dispute game
are a known BitVM-family attack class.

**Status:** Not implemented; not tested; acknowledged as missing in the
repo's own gap doc.

**Required before pilot:** At minimum one rehearsed pinning attempt and one
simulated reorg during an open dispute window (see
`docs/ADVERSARIAL_SIGNET_PLAN.md`), plus a documented fee-bumping strategy
for time-sensitive transactions (disprove, timeout reclaim, CET).

---

## 11. Repo sprawl and unclear audit surface

**Where:** Whole repository

The pilot-relevant code (`bitvm3/utxo_referee/`) sits alongside ~15+ unrelated
prototype tracks (Halal Capital marketplace, Omani Fiqh stablecoin
compliance, "Jurassic" BitVM mechanisms, a separate `civkit/` package tree
with committed `node_modules`, a nested nearly-independent `node-dlc/`
checkout, a TypeScript `DLCAdaptor/` bridge, and chat-session logs under
`codex-chat-sessions/`). None of these are wired into the pilot path (see
`CLAIMS_MATRIX.md`), but an external auditor pointed at the repo root will
price and review all of it unless the surface is explicitly scoped down.

**Status:** Scoping now exists on paper (`docs/PILOT_SURFACE.md`); the
filesystem itself has not been reorganized.

**Required before pilot:** Either physically extract the pilot surface into
its own repository/package for audit, or provide the auditor a hard
allowlist derived from `docs/PILOT_SURFACE.md` and confirm out-of-scope
trees are excluded from the review's billing and findings.

---

## Status addendum — 2026-07-05/06 staged-demos pass

Scope of this pass: stage on-chain demos closing two evidence-tier gaps
(btcUSD collateral leg, oracle-non-attestation refund path). Full detail in
`RUN_LOG_2026-07-05.md` and `CLAIMS_MATRIX.md`.

**#9 (missing refund path) — mechanism built and confirmed on-chain
(self-play).** `tradelayer_dlc_refund_cet_demo.js` implements a CSV-gated
2-of-2 refund CET with no oracle dependency, reusing only already-tested
taproot/Script primitives. After an initial session where the LTCTEST node
was killed mid-restart by the harness (see `RUN_LOG_2026-07-05.md`), a
second restart reached full sync and the demo was run to completion:
funding txid `7c3f7032e4fac551200ee687f07a9fde980bced343efc4bcd14378591c7b1f7d`
(block 4,793,462), refund spend txid
`04718dd1bb70346b89c1024c677c0c9dbd55989d1c0190fc2cc712eea740ed13`
(block 4,793,465, `nSequence=2`). The network accepted and confirmed the
two-signature script-path witness with no oracle input anywhere. **The
NOT_IMPLEMENTED row is now closed in the self-play sense** — the mechanism
exists and executes on real Script. It is **not** closed in the
operationally-trustworthy sense: Scenario E of
`docs/ADVERSARIAL_SIGNET_PLAN.md` (separated operator/challenger/oracle
keys) still has to pass before this is more than "the Script mechanics
work when one wallet controls everything."

**#4, #5, #6, #7 - follow-up hardening.** Reserve freshness checks,
persistent watchtower state, trace-publication fault detection, and the
BTC testnet4 2-signer reserve-vault evidence path now exist at
testnet/self-play level; independent operation, covenant-level guarantees,
automatic disprove broadcast, mirrored DA, and bond economics remain as
described above.

**New, unlisted operational risk surfaced by this pass: node cold-start
time.** The LTCTEST node took over 24 minutes to load its block index after
being offline for ~6 months, and did not finish within this session. A
pilot's watchtower (#5) and any operator recovery runbook must account for
node restart/resync time explicitly — a challenger or operator process that
assumes the node is always warm and RPC-reachable within seconds will
misbehave (or simply be unable to act) during exactly the kind of
after-an-outage restart scenario a real incident would produce. This is not
yet tracked as its own numbered blocker; fold it into the watchtower (#5)
and runbook (repo-sprawl/#11 operational-readiness) work when scoped.

**Net effect:** #9 has a confirmed on-chain mechanism as of 2026-07-06
(self-play tier - see caveat above); #4, #5, and #6 have partial testnet
mitigations; the remaining blockers are still launch-gate items for any
non-trivial value.
