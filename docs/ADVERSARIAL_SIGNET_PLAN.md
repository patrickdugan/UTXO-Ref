# Adversarial Signet Plan

Goal: the first non-self-play rehearsal of the dispute game defined in
`docs/PILOT_SURFACE.md`. Every prior on-chain result in `CLAIMS_MATRIX.md`
was produced by one operator-controlled wallet acting as prover and
challenger; this plan exists to find out what happens when that stops being
true. Run on Bitcoin **signet** or Litecoin **testnet**, never mainnet.

This plan does not implement new protocol logic. It specifies a test
procedure against the existing pilot surface, and the process/tooling gaps
that must be filled (marked **BUILD REQUIRED**) before the test can run.

## 1. Roles and key separation

Three keypairs, controlled by three genuinely separate execution contexts
(ideally three separate people/machines; at minimum three separate
processes with no shared key material or shared RPC wallet):

| Role | Controls | Must NOT have access to |
|---|---|---|
| **Operator** | Reserve wallet, asserts solvency claims, builds sweeps/CETs | Challenger's disprove-trigger logic, oracle's attestation key |
| **Challenger** | Watchtower process, disprove-transaction construction/broadcast | Operator's reserve keys, oracle's attestation key |
| **Oracle** | Attestation keypair only | Operator's reserve keys, challenger's watchtower state |

**BUILD REQUIRED:** today all three are the same in-process demo run. Stand
up three separate scripts/processes, each with its own keypair generated
independently and never shared via a common in-memory object.

## 2. Persistent watchtower process

Addresses [`SECURITY_BLOCKERS.md` #5](../SECURITY_BLOCKERS.md).

**BUILD REQUIRED:** a long-running process, owned by the Challenger role,
that:
1. Polls the signet/testnet node for new blocks and mempool transactions on
   a fixed interval (e.g. every block, or every 10–30s).
2. Re-derives the expected reserve/withdrawal state independently from
   chain data (not from the operator's self-reported reconciliation).
3. On detecting a mismatch, automatically assembles and broadcasts the
   disprove transaction using `tradelayer_bitvm_circuit.js` /
   `tradelayer_bitvm_comparator.js` primitives, well inside the CSV window.
4. Logs every check (pass and fail) to a durable, append-only log
   (file is sufficient for the pilot; no need for a database).
5. Delivers an alert (even just a written-to-disk / stdout alert monitored
   by a human is acceptable for the pilot; a pager/webhook is a nice-to-have,
   not required for pass/fail).

This is the single largest gap between "code exists" and "pilot is safe."

## 3. Published trace commitment and retrieval path

Addresses [`SECURITY_BLOCKERS.md` #6](../SECURITY_BLOCKERS.md).

**BUILD REQUIRED:**
1. When the Operator bonds a circuit assertion (comparator or SHA256
   circuit), the full wire-commitment execution trace must be published to
   a location the Challenger can retrieve without operator cooperation
   (a flat file served over HTTP, a gist, IPFS — any retrievable, mirrored
   location is acceptable for the pilot).
2. The bonded taproot output's commitment must include a hash of that trace,
   so a trace substitution is itself detectable.
3. Define a retrieval SLA (e.g. trace must be available within 1 block of
   the bonding transaction confirming).
4. Define the fault rule: if the Challenger cannot retrieve the trace within
   the SLA window, that is treated as an automatic disprove-equivalent fault
   against the Operator (the rehearsal should test this path explicitly —
   see Scenario D below).

## 4. Malicious operator scenarios

Each scenario below must be run to completion (bond → challenge →
resolution) with the Operator deliberately misbehaving and the Challenger
having no advance knowledge of which misbehavior was chosen.

**Scenario A — Faked input wire.** Operator bonds a solvency assertion with
one reserve/cap input bit flipped (mirrors the existing self-play demo in
`tradelayer_bitvm_solvency_demo.js`, but run with separated keys and the
Challenger discovering the fault independently via the watchtower, not via
foreknowledge).
- **Pass:** Challenger's watchtower detects the mismatch and broadcasts the
  input-binding disprove before CSV expiry, without being told in advance
  which bit was faked.
- **Fail:** Timeout expires with the fraudulent claim unchallenged, or the
  Challenger requires out-of-band knowledge of the fault to construct the
  disprove.

**Scenario B — Inconsistent gate.** Operator bonds a circuit execution with
one internal gate computed incorrectly (mirrors `tradelayer_bitvm_circuit_demo.js`
self-play run).
- **Pass/Fail:** same criteria as Scenario A, for the gate-disprove leaf.

**Scenario C — Reserve spent after honest reconciliation.** Operator
publishes an honest, correct reconciliation, then spends the underlying
reserve UTXOs elsewhere before the withdrawal epoch closes.
- This scenario is expected to **currently fail** — see
  [`SECURITY_BLOCKERS.md` #4](../SECURITY_BLOCKERS.md). Run it anyway and
  record the failure; the point is to produce a concrete, dated
  demonstration of the encumbrance gap, not to pass it. Pilot must not
  proceed past this scenario's fix on real value.

**Scenario D — Trace withholding.** Operator bonds a valid-looking
assertion but does not publish the execution trace within the SLA window
from Section 3.
- **Pass:** the withholding itself triggers the fault rule from Section 3
  (treated as an automatic disprove-equivalent), and this is enforced by
  the watchtower/dispute logic, not just written down as a rule.
- **Fail:** Operator reclaims via CSV timeout despite never having published
  the trace.

**Scenario E — Oracle non-attestation.** Oracle simply never attests any
outcome for a funded DLC.
- This scenario is expected to **currently fail** — see
  [`SECURITY_BLOCKERS.md` #9](../SECURITY_BLOCKERS.md) (no refund path
  exists). Run it anyway to produce a dated demonstration; do not proceed to
  real value until a refund CET closes this.

## 5. Fee bump and mempool pinning rehearsal

Addresses [`SECURITY_BLOCKERS.md` #10](../SECURITY_BLOCKERS.md).

**Procedure:**
1. Fund a dispute-tree output (comparator or SHA256 circuit) as in
   Scenario A/B.
2. Have a third, adversarial actor (can be operator-controlled for this
   rehearsal specifically, since its role here is "network adversary," not
   "protocol participant") flood the signet/testnet mempool with
   low-priority transactions and attempt to keep the Challenger's disprove
   transaction from confirming before CSV expiry (e.g. by broadcasting a
   conflicting low-fee version, or by simple fee-rate competition if the
   test network's mempool policy allows it).
3. Challenger must detect the stuck transaction and fee-bump (RBF or CPFP)
   to get the disprove confirmed inside the window.
- **Pass:** disprove confirms before CSV timeout despite contention.
- **Fail:** disprove is pinned/delayed past the timeout and the Operator's
  fraudulent claim reclaims by default.

**BUILD REQUIRED:** the Challenger process needs a fee-bump strategy (RBF
preferred, CPFP as fallback) — none exists today.

## 6. Reorg handling

**Procedure:**
1. On a regtest/signet setup where reorgs can be manually induced, confirm a
   bonding transaction, begin a challenge, then reorg the chain to a
   pre-bonding state.
2. Verify the Challenger's watchtower correctly detects the reorg (does not
   treat the now-orphaned bonding tx as still active), re-syncs to the new
   chain tip, and does not double-broadcast or lose track of an
   in-flight dispute if the bonding tx reconfirms in the new chain.
- **Pass:** watchtower state stays consistent with the canonical chain
  through the reorg; no funds are lost, no disprove is broadcast against a
  transaction that no longer exists.
- **Fail:** watchtower crashes, broadcasts against a stale UTXO set, or
  loses track of a still-valid dispute.

**BUILD REQUIRED:** the watchtower has no reorg-handling logic today; this
must exist before this scenario can even be attempted, not just before it
can pass.

## 7. Pass/fail criteria for the pilot to proceed to real value

The pilot may proceed beyond signet/testnet rehearsal only when:

- [ ] Roles are genuinely separated (Section 1) for at least one full run.
- [ ] The watchtower runs as a persistent, independent process for the
      duration of the rehearsal (Section 2).
- [ ] Trace publication + retrieval + the withholding fault rule are
      implemented and Scenario D passes (Section 3, Scenario D).
- [ ] Scenarios A and B pass with the Challenger acting on watchtower
      detection alone, no advance knowledge of the fault.
- [ ] Scenario C (reserve encumbrance) and Scenario E (oracle refund) either
      pass, or are explicitly fixed before proceeding — a documented failure
      here is a hard blocker, not an accepted risk, given real value is at
      stake.
- [ ] The fee-bump rehearsal (Section 5) passes at least once under
      simulated contention.
- [ ] The reorg rehearsal (Section 6) passes at least once.
- [ ] All results (txids, logs, timestamps, which role ran on which
      machine/key) are written up and attached as an addendum to this file,
      dated, before any real-value pilot begins.

Until every box above is checked, the pilot surface should be treated as a
demonstrated, network-executing prototype — not a system ready to hold
value it cannot unilaterally recover.
