/-!
# One-shot authorization consumption and deposit replay

Three models at commit `5883e03`.

1. The Rust signer's replay store (`native/dlc-signer/src/main.rs`): `reject_consumed_authorization`
   (:935-945), `consume_authorization` (:947-979) and their use in `run` (:1096-1131). The
   filesystem is a set of marker names, `consumed-authorizations/<digest>.used`; `create_new`
   fails exactly when the name is present (`OpenOptions::create_new`, main.rs:961-971), and no
   code path removes a marker (`grep remove_file main.rs` is empty). `Signer.Step` is one
   transition per source line group of `run`, and `abort` is a failure or a process kill at any
   point. A marker is a single `create_new` system call, which the operating system makes atomic
   (create-if-absent); `consumeOk` and `consumeExists` are therefore single atomic transitions, and
   the interleaving model below is justified by that atomicity: runs of different processes are
   arbitrary interleavings of these transitions.
2. The host store `DlcSigningAuthorizationStore.consume`
   (bitvm3/utxo_referee/dlc_signing_authorization_store.js:112-157), keyed by
   `consumptionKey` (:46-50). The directory is created by `fs.mkdirSync` (:127), which is one
   atomic system call that fails with `EEXIST` when the directory is present; success of
   `consume` is decided by that call alone, the record write that follows (:152) only fills the
   directory.
3. `ReceiptDepositIndexer` (bitvm3/utxo_referee/m1_deposit_indexer.js:62-227; the brief names it
   `M1DepositIndexer`) with the ledger it credits, `ReceiptLedger.applyDeposit` /
   `rollbackDeposit` (m1_receipt_ledger.js:45-143), which is where the funding-outpoint check
   lives.

What the models abstract:
* The cryptographic checks of `verify_request`, the clock guard, the freshness window, the key
  unprotection and the adaptor signature are not modelled; each is a transition that is either taken
  or replaced by `abort`, and the theorems hold for every choice. Marker file contents, fsync and
  paths are not modelled. A digest is an opaque value of a type with decidable equality.
* The authorization digest is `H (auth i)`, the SHA-256 of the canonical JSON (main.rs:913).
  `signer_at_most_one_presignature_per_authorization` needs no collision-resistance hypothesis:
  one authorization has one digest. Collision resistance (axiom 2) matters for the converse only,
  that a marker written for one authorization never blocks a different one (availability).
* Balances, amounts overflow, confirmations and heights in the indexer. Statuses move
  nondeterministically between `observed` and `confirmed` (`sync`), because only the credited and
  rolled-back transitions matter for replay. Any additional failure the real code has (an
  overflowing balance, a missing ledger) is a step that does not happen.
* Outpoints are an opaque key type `K`; the ledger lower-cases the txid before keying (ledger
  :27) and the indexer does not, which only makes the ledger coarser.
* The sorted order of `applyConfirmedDepositsToLedger` (indexer :191) is arbitrary here: the
  model lets `credit` be applied to any confirmed deposit in any order.
-/

set_option autoImplicit false
set_option linter.unusedSectionVars false
set_option linter.deprecated false

namespace UTXORefFormal.OneShot

/-! ## 1. The signer's replay store -/

namespace Signer

variable {D : Type} [DecidableEq D]

/-- Program counter of one signer process (one `run`, main.rs:1055-1167). -/
inductive Pc where
  | init          -- process started
  | verified      -- verify_request returned (:1096)
  | unconsumed    -- reject_consumed_authorization found no marker (:1100)
  | fresh         -- guard_signer_clock and verify_authorization_freshness passed (:1103-1109)
  | consumed      -- consume_authorization: create_new returned Ok (:1110)
  | signed        -- adaptor_sign returned (:1126-1131)
  | output        -- response written (:1162-1165)
  | aborted       -- an Err was returned, or the process died, before create_new
  | abortedPost   -- an Err was returned, or the process died, after create_new succeeded
  deriving DecidableEq, Repr

def Pc.postConsume : Pc → Bool
  | .consumed | .signed | .output | .abortedPost => true
  | _ => false

def Pc.presigned : Pc → Bool
  | .signed | .output => true
  | _ => false

def Pc.terminal : Pc → Bool
  | .output | .aborted | .abortedPost => true
  | _ => false

def Pc.abort (p : Pc) : Pc := if p.postConsume then .abortedPost else .aborted

theorem Pc.abort_post (p : Pc) : p.abort.postConsume = p.postConsume := by
  cases p <;> simp [Pc.abort, Pc.postConsume]

/-- The marker directory and the program counter of every process. -/
structure Sys (D : Type) where
  fs : List D
  pc : Nat → Pc

def Sys.setPc (s : Sys D) (i : Nat) (p : Pc) : Sys D :=
  ⟨s.fs, fun j => if j = i then p else s.pc j⟩

@[simp] theorem Sys.setPc_fs (s : Sys D) (i : Nat) (p : Pc) : (s.setPc i p).fs = s.fs := rfl
@[simp] theorem Sys.setPc_same (s : Sys D) (i : Nat) (p : Pc) : (s.setPc i p).pc i = p := by
  simp [Sys.setPc]
theorem Sys.setPc_other (s : Sys D) (i j : Nat) (p : Pc) (h : j ≠ i) :
    (s.setPc i p).pc j = s.pc j := by simp [Sys.setPc, h]

/-- One step of process `i`, whose authorization digest is `dig i`. -/
inductive Step (dig : Nat → D) : Sys D → Sys D → Prop where
  | verify (s : Sys D) (i : Nat) : s.pc i = .init → Step dig s (s.setPc i .verified)
  /-- `reject_consumed_authorization`: `symlink_metadata` reports NotFound (:942). -/
  | rejectNotFound (s : Sys D) (i : Nat) :
      s.pc i = .verified → dig i ∉ s.fs → Step dig s (s.setPc i .unconsumed)
  /-- `reject_consumed_authorization`: the marker is present (:941). -/
  | rejectFound (s : Sys D) (i : Nat) :
      s.pc i = .verified → dig i ∈ s.fs → Step dig s (s.setPc i .aborted)
  | clockFresh (s : Sys D) (i : Nat) : s.pc i = .unconsumed → Step dig s (s.setPc i .fresh)
  /-- `create_new` succeeds: the name was absent and is now present (:961-964). -/
  | consumeOk (s : Sys D) (i : Nat) :
      s.pc i = .fresh → dig i ∉ s.fs →
      Step dig s ⟨dig i :: s.fs, (s.setPc i .consumed).pc⟩
  /-- `create_new` succeeds and the process dies, or `write_all`/`sync_all` fails (:972-977). -/
  | consumeThenFail (s : Sys D) (i : Nat) :
      s.pc i = .fresh → dig i ∉ s.fs →
      Step dig s ⟨dig i :: s.fs, (s.setPc i .abortedPost).pc⟩
  /-- `create_new` reports AlreadyExists (:966-967). -/
  | consumeExists (s : Sys D) (i : Nat) :
      s.pc i = .fresh → dig i ∈ s.fs → Step dig s (s.setPc i .aborted)
  /-- Key unprotection, key check and `adaptor_sign` (:1111-1131). -/
  | sign (s : Sys D) (i : Nat) : s.pc i = .consumed → Step dig s (s.setPc i .signed)
  | emit (s : Sys D) (i : Nat) : s.pc i = .signed → Step dig s (s.setPc i .output)
  /-- Any `Err` return or process death at any point. -/
  | abort (s : Sys D) (i : Nat) :
      (s.pc i).terminal = false → Step dig s (s.setPc i (s.pc i).abort)

/-- Reachable systems: every process starts at `init`, over an initial directory `fs0`. -/
inductive Reach (dig : Nat → D) (fs0 : List D) : Sys D → Prop where
  | init : Reach dig fs0 ⟨fs0, fun _ => .init⟩
  | step {s s' : Sys D} : Reach dig fs0 s → Step dig s s' → Reach dig fs0 s'

structure Inv (fs0 : List D) (dig : Nat → D) (s : Sys D) : Prop where
  marker : ∀ i, (s.pc i).postConsume = true → dig i ∈ s.fs
  fresh : ∀ i, (s.pc i).postConsume = true → dig i ∉ fs0
  distinct : ∀ i j, i ≠ j → (s.pc i).postConsume = true → (s.pc j).postConsume = true →
    dig i ≠ dig j
  mono : ∀ x ∈ fs0, x ∈ s.fs

theorem inv_setPc_same_post {fs0 : List D} {dig : Nat → D} {s : Sys D} (h : Inv fs0 dig s)
    (i : Nat) (p : Pc) (hp : p.postConsume = (s.pc i).postConsume) : Inv fs0 dig (s.setPc i p) := by
  refine ⟨?_, ?_, ?_, ?_⟩
  · intro j hj
    by_cases hji : j = i
    · subst hji
      rw [Sys.setPc_same, hp] at hj
      exact h.marker j hj
    · rw [Sys.setPc_other _ _ _ _ hji] at hj
      exact h.marker j hj
  · intro j hj
    by_cases hji : j = i
    · subst hji
      rw [Sys.setPc_same, hp] at hj
      exact h.fresh j hj
    · rw [Sys.setPc_other _ _ _ _ hji] at hj
      exact h.fresh j hj
  · intro a b hab ha hb
    have key : ∀ j, (( s.setPc i p).pc j).postConsume = (s.pc j).postConsume := by
      intro j
      by_cases hji : j = i
      · subst hji; rw [Sys.setPc_same, hp]
      · rw [Sys.setPc_other _ _ _ _ hji]
    rw [key] at ha hb
    exact h.distinct a b hab ha hb
  · intro x hx
    exact h.mono x hx

theorem inv_consume {fs0 : List D} {dig : Nat → D} {s : Sys D} (h : Inv fs0 dig s)
    (i : Nat) (p : Pc) (hpre : (s.pc i).postConsume = false) (hnot : dig i ∉ s.fs) :
    Inv fs0 dig ⟨dig i :: s.fs, (s.setPc i p).pc⟩ := by
  have key : ∀ j, (((s.setPc i p).pc j).postConsume = true) →
      (j = i ∨ (s.pc j).postConsume = true) := by
    intro j hj
    by_cases hji : j = i
    · exact Or.inl hji
    · rw [Sys.setPc_other _ _ _ _ hji] at hj
      exact Or.inr hj
  refine ⟨?_, ?_, ?_, ?_⟩
  · intro j hj
    rcases key j hj with rfl | hold
    · exact List.mem_cons_self
    · exact List.mem_cons_of_mem _ (h.marker j hold)
  · intro j hj
    rcases key j hj with rfl | hold
    · intro hin
      exact hnot (h.mono _ hin)
    · exact h.fresh j hold
  · intro a b hab ha hb
    rcases key a ha with rfl | hola
    · rcases key b hb with rfl | holb
      · exact absurd rfl hab
      · intro e
        exact hnot (e ▸ h.marker b holb)
    · rcases key b hb with rfl | holb
      · intro e
        exact hnot (e ▸ h.marker a hola)
      · exact h.distinct a b hab hola holb
  · intro x hx
    exact List.mem_cons_of_mem _ (h.mono x hx)

theorem reach_inv {dig : Nat → D} {fs0 : List D} {s : Sys D} (h : Reach dig fs0 s) :
    Inv fs0 dig s := by
  induction h with
  | init =>
    refine ⟨?_, ?_, ?_, fun x hx => hx⟩ <;> intros <;> simp_all [Pc.postConsume]
  | step _ hs ih =>
    cases hs with
    | verify i h => exact inv_setPc_same_post ih i _ (by simp [h, Pc.postConsume])
    | rejectNotFound i h _ => exact inv_setPc_same_post ih i _ (by simp [h, Pc.postConsume])
    | rejectFound i h _ => exact inv_setPc_same_post ih i _ (by simp [h, Pc.postConsume])
    | clockFresh i h => exact inv_setPc_same_post ih i _ (by simp [h, Pc.postConsume])
    | consumeOk i h hnot =>
      exact inv_consume ih i _ (by simp [h, Pc.postConsume]) hnot
    | consumeThenFail i h hnot =>
      exact inv_consume ih i _ (by simp [h, Pc.postConsume]) hnot
    | consumeExists i h _ => exact inv_setPc_same_post ih i _ (by simp [h, Pc.postConsume])
    | sign i h => exact inv_setPc_same_post ih i _ (by simp [h, Pc.postConsume])
    | emit i h => exact inv_setPc_same_post ih i _ (by simp [h, Pc.postConsume])
    | abort i _ => exact inv_setPc_same_post ih i _ (Pc.abort_post _)

/-- Markers are never removed: every step only adds a name. -/
theorem step_marker_permanent {dig : Nat → D} {s s' : Sys D} (h : Step dig s s') :
    ∀ x ∈ s.fs, x ∈ s'.fs := by
  cases h <;> intro x hx <;> simp_all

/-- A process that has signed (or is about to emit) left its digest's marker present. -/
theorem signer_marker_present_when_signing {dig : Nat → D} {fs0 : List D} {s : Sys D}
    (h : Reach dig fs0 s) (i : Nat) (hs : (s.pc i).presigned = true) : dig i ∈ s.fs := by
  apply (reach_inv h).marker
  revert hs
  cases s.pc i <;> simp [Pc.presigned, Pc.postConsume]

/-- The marker is present in every reachable state in which a process is at `consumed`, the
state from which `adaptor_sign` is entered: `consume_authorization` returned Ok before the
signing key is even unprotected (main.rs:1110 precedes :1111). -/
theorem signer_marker_present_before_sign {dig : Nat → D} {fs0 : List D} {s : Sys D}
    (h : Reach dig fs0 s) (i : Nat) (hc : s.pc i = .consumed) : dig i ∈ s.fs := by
  apply (reach_inv h).marker
  simp [hc, Pc.postConsume]

/-- Over any interleaving of any number of runs, with failures and kills at any point, two
processes that have produced a presignature have different authorization digests. -/
theorem signer_at_most_one_presignature_per_digest {dig : Nat → D} {fs0 : List D} {s : Sys D}
    (h : Reach dig fs0 s) (i j : Nat) (hi : (s.pc i).presigned = true)
    (hj : (s.pc j).presigned = true) (hd : dig i = dig j) : i = j := by
  refine Classical.byContradiction fun hne => ?_
  have hpost : ∀ k, (s.pc k).presigned = true → (s.pc k).postConsume = true := by
    intro k hk; revert hk; cases s.pc k <;> simp [Pc.presigned, Pc.postConsume]
  exact (reach_inv h).distinct i j hne (hpost i hi) (hpost j hj) hd

/-- A digest already in the directory at the start (consumed by an earlier run) is never
consumed, hence never signed, by any later run. -/
theorem signer_consumed_digest_never_signs {dig : Nat → D} {fs0 : List D} {s : Sys D}
    (h : Reach dig fs0 s) (i : Nat) (hin : dig i ∈ fs0) : (s.pc i).postConsume = false := by
  refine Classical.byContradiction fun hc => ?_
  have hc' : (s.pc i).postConsume = true := by simpa using hc
  exact (reach_inv h).fresh i hc' hin

/-- Corollary: at most one presignature per authorization. `auth i` is the authorization process
`i` was given and `H` its digest (SHA-256 of its canonical JSON, main.rs:913). No collision
resistance is needed for this direction: one authorization has one digest. -/
theorem signer_at_most_one_presignature_per_authorization {A : Type} (H : A → D)
    (auth : Nat → A) {fs0 : List D} {s : Sys D}
    (h : Reach (fun i => H (auth i)) fs0 s) (i j : Nat) (hi : (s.pc i).presigned = true)
    (hj : (s.pc j).presigned = true) (ha : auth i = auth j) : i = j :=
  signer_at_most_one_presignature_per_digest h i j hi hj (by simp [ha])

/-! ### The same property for a sequential list of `run`s -/

structure Flags where
  verifyOk : Bool      -- verify_request returns Ok (:1096)
  clockOk : Bool       -- guard_signer_clock and freshness return Ok (:1103-1109)
  persistOk : Bool     -- write_all and sync_all after create_new return Ok (:972-977)
  keyOk : Bool         -- key unprotect, scalar and public-key check (:1111-1125)
  emitOk : Bool        -- the process lives to write its output (:1162)

inductive Outcome where
  | rejectedVerify
  | rejectedConsumed
  | rejectedClock
  | persistFailed
  | failedAfterConsume
  | signedNoOutput     -- killed after adaptor_sign, before output
  | signedEmitted
  deriving DecidableEq, Repr

/-- Whether a presignature value was computed. -/
def Outcome.signs : Outcome → Bool
  | .signedNoOutput | .signedEmitted => true
  | _ => false

/-- One sequential `run` over the directory `fs` for digest `d`. -/
def run (fs : List D) (d : D) (fl : Flags) : List D × Outcome :=
  if fl.verifyOk = false then (fs, .rejectedVerify)
  else if d ∈ fs then (fs, .rejectedConsumed)
  else if fl.clockOk = false then (fs, .rejectedClock)
  else
    (d :: fs,
      if fl.persistOk = false then .persistFailed
      else if fl.keyOk = false then .failedAfterConsume
      else if fl.emitOk = false then .signedNoOutput
      else .signedEmitted)

theorem run_mono (fs : List D) (d : D) (fl : Flags) : ∀ x ∈ fs, x ∈ (run fs d fl).1 := by
  intro x hx
  unfold run
  by_cases h1 : fl.verifyOk = false
  · simp [h1, hx]
  · by_cases h2 : d ∈ fs
    · simp [h1, h2, hx]
    · by_cases h3 : fl.clockOk = false
      · simp [h1, h2, h3, hx]
      · simp [h1, h2, h3, hx]

/-- A run that signs found the marker absent and leaves it present. -/
theorem run_signs_marks_digest (fs : List D) (d : D) (fl : Flags)
    (h : (run fs d fl).2.signs = true) : d ∉ fs ∧ d ∈ (run fs d fl).1 := by
  unfold run at h ⊢
  by_cases h1 : fl.verifyOk = false
  · simp [h1, Outcome.signs] at h
  · by_cases h2 : d ∈ fs
    · simp [h1, h2, Outcome.signs] at h
    · by_cases h3 : fl.clockOk = false
      · simp [h1, h2, h3, Outcome.signs] at h
      · simp [h1, h2, h3]

/-- A digest in the directory is never signed by a run. -/
theorem run_consumed_never_signs (fs : List D) (d : D) (fl : Flags) (hin : d ∈ fs) :
    (run fs d fl).2.signs = false := by
  unfold run
  by_cases h1 : fl.verifyOk = false
  · simp [h1, Outcome.signs]
  · simp [h1, hin, Outcome.signs]

/-- Every run, whatever it does, leaves a digest that reached `create_new` in the directory. -/
def runAll : List D → List (D × Flags) → List D × List Outcome
  | fs, [] => (fs, [])
  | fs, (d, fl) :: rest =>
    let r := run fs d fl
    let t := runAll r.1 rest
    (t.1, r.2 :: t.2)

/-- Number of outcomes in a list of runs that computed a presignature for `d`. -/
def signCount (d : D) : List (D × Flags) → List Outcome → Nat
  | (d', _) :: ls, o :: os => (if d' = d ∧ o.signs = true then 1 else 0) + signCount d ls os
  | _, _ => 0

theorem signCount_zero_of_mem (d : D) :
    ∀ (ls : List (D × Flags)) (fs : List D), d ∈ fs → signCount d ls (runAll fs ls).2 = 0
  | [], fs, _ => by simp [signCount]
  | (d', fl) :: ls, fs, hd => by
    simp only [runAll, signCount]
    have hmono := run_mono fs d' fl d hd
    have ih := signCount_zero_of_mem d ls (run fs d' fl).1 hmono
    have : ¬ (d' = d ∧ (run fs d' fl).2.signs = true) := by
      rintro ⟨rfl, hs⟩
      have := run_consumed_never_signs fs d' fl hd
      simp_all
    simp [this, ih]

/-- Over any sequence of runs (including ones that fail or are killed at any step), at most one
run computes a presignature for a given digest. -/
theorem signer_run_sequence_at_most_one_presignature (d : D) :
    ∀ (ls : List (D × Flags)) (fs : List D), signCount d ls (runAll fs ls).2 ≤ 1
  | [], fs => by simp [signCount]
  | (d', fl) :: ls, fs => by
    simp only [runAll, signCount]
    by_cases hsame : d' = d ∧ (run fs d' fl).2.signs = true
    · obtain ⟨rfl, hs⟩ := hsame
      have hm := run_signs_marks_digest fs d' fl hs
      have := signCount_zero_of_mem d' ls (run fs d' fl).1 hm.2
      simp [hs, this]
    · have ih := signer_run_sequence_at_most_one_presignature d ls (run fs d' fl).1
      simp [hsame, ih]

/-! ### Vectors -/

def okFlags : Flags := ⟨true, true, true, true, true⟩

example : run ([] : List Nat) 7 okFlags = ([7], .signedEmitted) := by decide
/-- A second run for the same digest is refused at `reject_consumed_authorization`. -/
example : run [7] 7 okFlags = ([7], .rejectedConsumed) := by decide
/-- A run killed after `adaptor_sign` has consumed the digest; the retry is refused. -/
example : run ([] : List Nat) 7 { okFlags with emitOk := false } = ([7], .signedNoOutput) := by
  decide
/-- A run whose key check fails after `create_new` still leaves the marker. -/
example : run ([] : List Nat) 7 { okFlags with keyOk := false } = ([7], .failedAfterConsume) := by
  decide
/-- A run that fails the freshness check before `create_new` leaves no marker. -/
example : run ([] : List Nat) 7 { okFlags with clockOk := false } = ([], .rejectedClock) := by
  decide
example : (runAll ([] : List Nat) [(7, okFlags), (7, okFlags), (8, okFlags)]).2 =
    [.signedEmitted, .rejectedConsumed, .signedEmitted] := by decide

end Signer

/-! ## 2. The host store -/

namespace Host

variable {K : Type} [DecidableEq K]

/-- The string hashed by `consumptionKey` (:49). -/
def keyString (contractId authorizationId : String) : String :=
  contractId ++ ":" ++ authorizationId

inductive Result where
  | ok            -- mkdirSync succeeded and the record was written
  | persistFailed -- mkdirSync succeeded, the record write failed (:153-154): directory remains
  | refused       -- mkdirSync raised EEXIST (:129-135): an Error is thrown
  deriving DecidableEq, Repr

/-- `consume`: `H` is SHA-256. The store is the set of directory names. -/
def consume (H : String → K) (store : List K) (contractId authorizationId : String)
    (writeOk : Bool) : List K × Result :=
  if H (keyString contractId authorizationId) ∈ store then (store, .refused)
  else (H (keyString contractId authorizationId) :: store, if writeOk then .ok else .persistFailed)

structure Call where
  contractId : String
  authorizationId : String
  writeOk : Bool

def Call.key (H : String → K) (c : Call) : K := H (keyString c.contractId c.authorizationId)

/-- The store after a sequence of calls and the list of keys of the calls that returned `ok`. -/
def runCalls (H : String → K) : List K → List Call → List K × List K
  | store, [] => (store, [])
  | store, c :: cs =>
    let r := consume H store c.contractId c.authorizationId c.writeOk
    let t := runCalls H r.1 cs
    (t.1, (if r.2 = .ok then [c.key H] else []) ++ t.2)

theorem consume_mono (H : String → K) (store : List K) (c a : String) (w : Bool) :
    ∀ x ∈ store, x ∈ (consume H store c a w).1 := by
  intro x hx
  unfold consume
  split <;> simp [hx]

theorem consume_ok_iff (H : String → K) (store : List K) (c a : String) (w : Bool) :
    (consume H store c a w).2 = .ok ↔ H (keyString c a) ∉ store ∧ w = true := by
  unfold consume
  by_cases h : H (keyString c a) ∈ store <;> cases w <;> simp [h]

/-- A consume call that created the directory leaves it in the store, so any later call for the
same `(contractId, authorizationId)` is refused. -/
theorem consume_after_created_refused (H : String → K) (store : List K) (c a : String)
    (w w' : Bool) (hnot : H (keyString c a) ∉ store) :
    (consume H (consume H store c a w).1 c a w').2 = .refused := by
  unfold consume
  simp [hnot]

theorem runCalls_ok_nodup (H : String → K) :
    ∀ (cs : List Call) (store : List K),
      (runCalls H store cs).2.Nodup ∧ ∀ k ∈ (runCalls H store cs).2, k ∉ store
  | [], store => by simp [runCalls]
  | c :: cs, store => by
    obtain ⟨ih1, ih2⟩ := runCalls_ok_nodup H cs
      (consume H store c.contractId c.authorizationId c.writeOk).1
    unfold runCalls
    by_cases hok : (consume H store c.contractId c.authorizationId c.writeOk).2 = .ok
    · have hk := (consume_ok_iff H store c.contractId c.authorizationId c.writeOk).mp hok
      have hstore : (consume H store c.contractId c.authorizationId c.writeOk).1 =
          H (keyString c.contractId c.authorizationId) :: store := by
        unfold consume; simp [hk.1]
      refine ⟨?_, ?_⟩
      · simp only [hok, if_true, List.singleton_append, List.nodup_cons]
        refine ⟨?_, ih1⟩
        intro hmem
        have := ih2 _ hmem
        rw [hstore] at this
        exact this List.mem_cons_self
      · intro k hk'
        simp only [hok, if_true, List.singleton_append, List.mem_cons] at hk'
        rcases hk' with rfl | hk'
        · exact hk.1
        · have := ih2 k hk'
          rw [hstore] at this
          exact fun hs => this (List.mem_cons_of_mem _ hs)
    · simp only [hok, if_false, List.nil_append]
      refine ⟨ih1, fun k hk' hs => ih2 k hk' (consume_mono H store _ _ _ k hs)⟩

/-- Over any sequence of calls, no key is consumed with `ok` twice. The key is a function of the
pair `(contractId, authorizationId)`, so the same pair is never consumed twice. -/
theorem host_never_consumes_same_pair_twice (H : String → K) (cs : List Call) (store : List K) :
    (runCalls H store cs).2.Nodup := (runCalls_ok_nodup H cs store).1

/-- A key already present in the store is never consumed. -/
theorem host_consumed_key_never_consumed_again (H : String → K) (cs : List Call)
    (store : List K) : ∀ k ∈ (runCalls H store cs).2, k ∉ store :=
  (runCalls_ok_nodup H cs store).2

/-- FINDING (dlc_signing_authorization_store.js:49): both ids can contain `:` (:40 permits it), so
distinct pairs hash the same string. The second pair is refused although it was never consumed
(a fail-closed refusal, not a double consumption). -/
theorem consumption_key_string_collision :
    keyString "a:b" "c" = keyString "a" "b:c" ∧ ("a:b", "c") ≠ ("a", "b:c") := by
  decide

theorem distinct_pairs_with_colon_collide_in_store (H : String → K) (store : List K) :
    (consume H (consume H store "a:b" "c" true).1 "a" "b:c" true).2 = .refused ∨
      H (keyString "a:b" "c") ∈ store := by
  by_cases h : H (keyString "a:b" "c") ∈ store
  · exact Or.inr h
  · left
    have e : keyString "a" "b:c" = keyString "a:b" "c" := consumption_key_string_collision.1.symm
    unfold consume
    simp [e, h]

end Host

/-! ## 3. Deposit indexer and ledger -/

namespace Indexer

variable {D K : Type} [DecidableEq D] [DecidableEq K]

def upd {α β : Type} [DecidableEq α] (f : α → β) (a : α) (b : β) : α → β :=
  fun x => if x = a then b else f x

@[simp] theorem upd_same {α β : Type} [DecidableEq α] (f : α → β) (a : α) (b : β) :
    upd f a b a = b := by simp [upd]
theorem upd_other {α β : Type} [DecidableEq α] (f : α → β) (a : α) (b : β) (x : α) (h : x ≠ a) :
    upd f a b x = f x := by simp [upd, h]

/-- One ledger deposit event (`depositEvents` entry); `live` is `status = 'credited'`. -/
structure Ev (K : Type) where
  key : K
  live : Bool

/-- `ReceiptLedger`: `depositEvents` (keyed by depositId) and `depositOutpoints`
(outpoint key to depositId). -/
structure Ledger (D K : Type) where
  evs : D → Option (Ev K)
  ops : K → Option D

def Ledger.empty : Ledger D K := ⟨fun _ => none, fun _ => none⟩

/-- `applyDeposit` (m1_receipt_ledger.js:45-80): duplicate depositId (:53-55), outpoint already
credited (:56-59), then the credit. -/
def Ledger.apply (l : Ledger D K) (id : D) (k : K) : Option (Ledger D K) :=
  match l.evs id, l.ops k with
  | none, none => some ⟨upd l.evs id (some ⟨k, true⟩), upd l.ops k (some id)⟩
  | _, _ => none

/-- `rollbackDeposit` (:120-153): unknown id, already rolled back, then the debit; the outpoint
entry is deleted when it names this depositId (:141-142). -/
def Ledger.rollback (l : Ledger D K) (id : D) : Option (Ledger D K) :=
  match l.evs id with
  | none => none
  | some e =>
    if e.live = false then none
    else some ⟨upd l.evs id (some ⟨e.key, false⟩),
               fun k' => if k' = e.key ∧ l.ops k' = some id then none else l.ops k'⟩

structure LedgerInv (l : Ledger D K) : Prop where
  liveHasOp : ∀ id e, l.evs id = some e → e.live = true → l.ops e.key = some id
  opHasLive : ∀ k id, l.ops k = some id → ∃ e, l.evs id = some e ∧ e.live = true ∧ e.key = k

theorem ledgerInv_empty : LedgerInv (Ledger.empty : Ledger D K) :=
  ⟨by simp [Ledger.empty], by simp [Ledger.empty]⟩

theorem ledgerInv_apply {l l' : Ledger D K} {id : D} {k : K} (h : LedgerInv l)
    (hl : l.apply id k = some l') : LedgerInv l' := by
  unfold Ledger.apply at hl
  split at hl
  · rename_i h1 h2
    simp only [Option.some.injEq] at hl
    subst hl
    refine ⟨?_, ?_⟩
    · intro id' e he hlive
      by_cases hid : id' = id
      · subst hid
        simp only [upd_same, Option.some.injEq] at he
        subst he
        simp
      · simp only [upd_other _ _ _ _ hid] at he
        have := h.liveHasOp id' e he hlive
        have hk : e.key ≠ k := by
          intro hk; rw [hk, h2] at this; simp at this
        simp only [upd_other _ _ _ _ hk]
        exact this
    · intro k' id' hk'
      by_cases hk : k' = k
      · subst hk
        simp only [upd_same, Option.some.injEq] at hk'
        subst hk'
        exact ⟨⟨k', true⟩, by simp, rfl, rfl⟩
      · simp only [upd_other _ _ _ _ hk] at hk'
        obtain ⟨e, he, hlive, hkey⟩ := h.opHasLive k' id' hk'
        have hid : id' ≠ id := by
          intro hid; subst hid; rw [h1] at he; simp at he
        exact ⟨e, by simp only [upd_other _ _ _ _ hid]; exact he, hlive, hkey⟩
  · simp at hl

theorem ledgerInv_rollback {l l' : Ledger D K} {id : D} (h : LedgerInv l)
    (hl : l.rollback id = some l') : LedgerInv l' := by
  unfold Ledger.rollback at hl
  split at hl
  · simp at hl
  · rename_i e he
    split at hl
    · simp at hl
    · rename_i hlive
      simp only [Option.some.injEq] at hl
      subst hl
      have hlive' : e.live = true := by simpa using hlive
      refine ⟨?_, ?_⟩
      · intro id' e' he' hl'
        by_cases hid : id' = id
        · subst hid
          simp only [upd_same, Option.some.injEq] at he'
          subst he'
          simp at hl'
        · simp only [upd_other _ _ _ _ hid] at he'
          have hop := h.liveHasOp id' e' he' hl'
          have : ¬ (e'.key = e.key ∧ l.ops e'.key = some id) := by
            rintro ⟨_, h2⟩
            rw [hop] at h2
            exact hid (Option.some.inj h2)
          show (if e'.key = e.key ∧ l.ops e'.key = some id then none else l.ops e'.key) = some id'
          rw [if_neg this]; exact hop
      · intro k' id' hk'
        have hk0 : (if k' = e.key ∧ l.ops k' = some id then none else l.ops k') = some id' := hk'
        by_cases hdel : k' = e.key ∧ l.ops k' = some id
        · rw [if_pos hdel] at hk0
          simp at hk0
        · rw [if_neg hdel] at hk0
          obtain ⟨e', he', hl', hkey⟩ := h.opHasLive k' id' hk0
          by_cases hid : id' = id
          · subst hid
            rw [he] at he'
            simp only [Option.some.injEq] at he'
            subst he'
            exact absurd ⟨hkey.symm, hk0⟩ hdel
          · exact ⟨e', by simp only [upd_other _ _ _ _ hid]; exact he', hl', hkey⟩

/-- At most one live credit per funding outpoint: two live events with the same key are the
same depositId. -/
theorem ledger_live_credit_unique {l : Ledger D K} (h : LedgerInv l) (a b : D) (ea eb : Ev K)
    (ha : l.evs a = some ea) (hb : l.evs b = some eb) (la : ea.live = true) (lb : eb.live = true)
    (hk : ea.key = eb.key) : a = b := by
  have h1 := h.liveHasOp a ea ha la
  have h2 := h.liveHasOp b eb hb lb
  rw [hk] at h1
  rw [h1] at h2
  exact Option.some.inj h2

/-- `applyDeposit` refuses an outpoint that already has a live credit (:56-59). -/
theorem ledger_apply_refuses_credited_outpoint (l : Ledger D K) (id : D) (k : K) (d : D)
    (h : l.ops k = some d) : l.apply id k = none := by
  unfold Ledger.apply
  split <;> simp_all

/-- Rolling back a live credit frees its outpoint (:141-142). -/
theorem ledger_rollback_frees_outpoint {l l' : Ledger D K} {id : D} {e : Ev K}
    (hl : l.rollback id = some l') (he : l.evs id = some e) (hlive : e.live = true)
    (h : LedgerInv l) : l'.ops e.key = none := by
  unfold Ledger.rollback at hl
  rw [he] at hl
  simp only [hlive, Bool.true_eq_false, if_false, Option.some.injEq] at hl
  subst hl
  have := h.liveHasOp id e he hlive
  simp [this]

/-- After a rollback the same outpoint can be credited again under a different depositId, and
the rolled-back depositId can never be credited again (:53-55 keeps rolled-back events). -/
theorem ledger_recredit_after_rollback {l l' : Ledger D K} {id id' : D} {e : Ev K}
    (hl : l.rollback id = some l') (he : l.evs id = some e) (hlive : e.live = true)
    (h : LedgerInv l) (hnew : l'.evs id' = none) :
    (l'.apply id' e.key).isSome = true := by
  have hf := ledger_rollback_frees_outpoint hl he hlive h
  unfold Ledger.apply
  rw [hnew, hf]
  simp

theorem ledger_rolled_back_id_never_credited_again {l l' : Ledger D K} {id : D}
    (hl : l.rollback id = some l') (k : K) : l'.apply id k = none := by
  unfold Ledger.rollback at hl
  split at hl
  · simp at hl
  · rename_i e he
    split at hl
    · simp at hl
    · simp only [Option.some.injEq] at hl
      subst hl
      unfold Ledger.apply
      simp

/-! ### The indexer -/

inductive Status where
  | observed
  | confirmed
  | credited
  | rolledBack
  deriving DecidableEq, Repr

/-- One indexer record (`deposits` entry, keyed by depositId). `key` is `(txid, vout)`. -/
structure Rec (K : Type) where
  acct : Nat
  amount : Nat
  key : K
  status : Status
  deriving DecidableEq, Repr

structure World (D K : Type) where
  recs : D → Option (Rec K)
  led : Ledger D K

def World.empty : World D K := ⟨fun _ => none, Ledger.empty⟩

/-- `observeDeposit` (m1_deposit_indexer.js:74-126). `conf` abstracts the confirmation count
reaching `minConfirmations`. `none` is a thrown error. -/
def observe (w : World D K) (id : D) (acct amount : Nat) (k : K) (conf : Bool) :
    Option (World D K) :=
  match w.recs id with
  | some r =>
    if r.acct ≠ acct ∨ r.key ≠ k ∨ r.amount ≠ amount then none
    else if r.status = .rolledBack then none
    else
      some ⟨upd w.recs id (some { r with status :=
        if r.status = .credited then .credited else if conf then .confirmed else .observed }),
        w.led⟩
  | none =>
    some ⟨upd w.recs id (some ⟨acct, amount, k, if conf then .confirmed else .observed⟩), w.led⟩

/-- `syncConfirmations` (:132-142). -/
def sync (w : World D K) (cf : D → Bool) : World D K :=
  ⟨fun id => (w.recs id).map (fun r =>
      if r.status = .rolledBack ∨ r.status = .credited then r
      else { r with status := if cf id then .confirmed else .observed }), w.led⟩

/-- One iteration of `applyConfirmedDepositsToLedger` (:191-203): a confirmed record is credited
through `ledger.applyDeposit`, which can throw; on success the record becomes credited. -/
def credit (w : World D K) (id : D) : Option (World D K) :=
  match w.recs id with
  | some r =>
    if r.status = .confirmed then
      match w.led.apply id r.key with
      | none => none
      | some l' => some ⟨upd w.recs id (some { r with status := .credited }), l'⟩
    else none
  | none => none

/-- `rollbackDeposit` (:208-227). -/
def rollbackOp (w : World D K) (id : D) : Option (World D K) :=
  match w.recs id with
  | none => none
  | some r =>
    if r.status = .rolledBack then none
    else if r.status = .credited then
      match w.led.rollback id with
      | none => none
      | some l' => some ⟨upd w.recs id (some { r with status := .rolledBack }), l'⟩
    else some ⟨upd w.recs id (some { r with status := .rolledBack }), w.led⟩

inductive Op (D K : Type) where
  | observe (id : D) (acct amount : Nat) (k : K) (conf : Bool)
  | sync (cf : D → Bool)
  | credit (id : D)
  | rollback (id : D)

/-- A failing operation (thrown error) leaves the world unchanged. -/
def stepWorld (w : World D K) : Op D K → World D K
  | .observe id a m k c => (observe w id a m k c).getD w
  | .sync cf => sync w cf
  | .credit id => (credit w id).getD w
  | .rollback id => (rollbackOp w id).getD w

def runOps (w : World D K) (ops : List (Op D K)) : World D K := ops.foldl stepWorld w

structure WInv (w : World D K) : Prop where
  led : LedgerInv w.led
  credited : ∀ id r, w.recs id = some r → r.status = .credited →
    ∃ e, w.led.evs id = some e ∧ e.live = true ∧ e.key = r.key

theorem winv_empty : WInv (World.empty : World D K) :=
  ⟨ledgerInv_empty, by simp [World.empty]⟩

theorem winv_observe {w w' : World D K} {id : D} {a m : Nat} {k : K} {c : Bool}
    (h : WInv w) (ho : observe w id a m k c = some w') : WInv w' := by
  unfold observe at ho
  split at ho
  · rename_i r hr
    split at ho
    · simp at ho
    · split at ho
      · simp at ho
      · simp only [Option.some.injEq] at ho
        subst ho
        refine ⟨h.led, ?_⟩
        intro id' r' hr' hc'
        by_cases hid : id' = id
        · subst hid
          simp only [upd_same, Option.some.injEq] at hr'
          subst hr'
          have hcr : r.status = .credited := by
            revert hc'; simp only
            by_cases hs : r.status = .credited
            · intro _; exact hs
            · simp only [hs, if_false]; cases c <;> simp
          exact h.credited id' r hr hcr
        · simp only [upd_other _ _ _ _ hid] at hr'
          exact h.credited id' r' hr' hc'
  · simp only [Option.some.injEq] at ho
    subst ho
    refine ⟨h.led, ?_⟩
    intro id' r' hr' hc'
    by_cases hid : id' = id
    · subst hid
      simp only [upd_same, Option.some.injEq] at hr'
      subst hr'
      split at hc' <;> simp at hc'
    · simp only [upd_other _ _ _ _ hid] at hr'
      exact h.credited id' r' hr' hc'

theorem winv_sync {w : World D K} (cf : D → Bool) (h : WInv w) : WInv (sync w cf) := by
  refine ⟨h.led, ?_⟩
  intro id r hr hc
  simp only [sync] at hr
  cases hw : w.recs id with
  | none => rw [hw] at hr; simp at hr
  | some r0 =>
    rw [hw] at hr
    simp only [Option.map_some, Option.some.injEq] at hr
    have hcr : r0.status = .credited := by
      by_cases hcond : r0.status = .rolledBack ∨ r0.status = .credited
      · rw [if_pos hcond] at hr
        subst hr
        rcases hcond with h1 | h1
        · rw [h1] at hc; cases hc
        · exact h1
      · rw [if_neg hcond] at hr
        subst hr
        exfalso
        revert hc
        show (if cf id = true then Status.confirmed else Status.observed) = Status.credited → False
        by_cases hb : cf id = true <;> simp [hb]
    have hr' : r = r0 := by
      rw [if_pos (Or.inr hcr)] at hr
      exact hr.symm
    subst hr'
    exact h.credited id r hw hcr

theorem winv_credit {w w' : World D K} {id : D} (h : WInv w) (hc : credit w id = some w') :
    WInv w' := by
  unfold credit at hc
  split at hc
  · rename_i r hr
    split at hc
    · split at hc
      · simp at hc
      · rename_i l' hl'
        simp only [Option.some.injEq] at hc
        subst hc
        have hled := ledgerInv_apply h.led hl'
        refine ⟨hled, ?_⟩
        intro id' r' hr' hc'
        by_cases hid : id' = id
        · subst hid
          simp only [upd_same, Option.some.injEq] at hr'
          subst hr'
          unfold Ledger.apply at hl'
          split at hl'
          · simp only [Option.some.injEq] at hl'
            subst hl'
            exact ⟨⟨r.key, true⟩, by simp, rfl, rfl⟩
          · simp at hl'
        · simp only [upd_other _ _ _ _ hid] at hr'
          obtain ⟨e, he, hl, hk⟩ := h.credited id' r' hr' hc'
          unfold Ledger.apply at hl'
          split at hl'
          · simp only [Option.some.injEq] at hl'
            subst hl'
            exact ⟨e, by simp only [upd_other _ _ _ _ hid]; exact he, hl, hk⟩
          · simp at hl'
    · simp at hc
  · simp at hc

theorem winv_rollback {w w' : World D K} {id : D} (h : WInv w) (hr : rollbackOp w id = some w') :
    WInv w' := by
  unfold rollbackOp at hr
  split at hr
  · simp at hr
  · rename_i r hrec
    split at hr
    · simp at hr
    · split at hr
      · rename_i hcr
        split at hr
        · simp at hr
        · rename_i l' hl'
          simp only [Option.some.injEq] at hr
          subst hr
          have hled := ledgerInv_rollback h.led hl'
          refine ⟨hled, ?_⟩
          intro id' r' hr' hc'
          by_cases hid : id' = id
          · subst hid
            simp only [upd_same, Option.some.injEq] at hr'
            subst hr'
            simp at hc'
          · simp only [upd_other _ _ _ _ hid] at hr'
            obtain ⟨e, he, hl, hk⟩ := h.credited id' r' hr' hc'
            unfold Ledger.rollback at hl'
            rw [(h.credited id r hrec hcr).choose_spec.1] at hl'
            simp only at hl'
            split at hl'
            · simp at hl'
            · simp only [Option.some.injEq] at hl'
              subst hl'
              exact ⟨e, by simp only [upd_other _ _ _ _ hid]; exact he, hl, hk⟩
      · simp only [Option.some.injEq] at hr
        subst hr
        refine ⟨h.led, ?_⟩
        intro id' r' hr' hc'
        by_cases hid : id' = id
        · subst hid
          simp only [upd_same, Option.some.injEq] at hr'
          subst hr'
          simp at hc'
        · simp only [upd_other _ _ _ _ hid] at hr'
          exact h.credited id' r' hr' hc'

theorem winv_step {w : World D K} (op : Op D K) (h : WInv w) : WInv (stepWorld w op) := by
  cases op with
  | observe id a m k c =>
    simp only [stepWorld]
    cases ho : observe w id a m k c with
    | none => simpa using h
    | some w' => simpa using winv_observe h ho
  | sync cf => exact winv_sync cf h
  | credit id =>
    simp only [stepWorld]
    cases ho : credit w id with
    | none => simpa using h
    | some w' => simpa using winv_credit h ho
  | rollback id =>
    simp only [stepWorld]
    cases ho : rollbackOp w id with
    | none => simpa using h
    | some w' => simpa using winv_rollback h ho

theorem winv_runOps (ops : List (Op D K)) : ∀ (w : World D K), WInv w → WInv (runOps w ops) := by
  induction ops with
  | nil => intro w h; exact h
  | cons op ops ih => intro w h; exact ih _ (winv_step op h)

/-- After any sequence of indexer operations from an empty indexer and ledger, at most one
indexer record is in the `credited` state for any funding outpoint: two credited records with
the same outpoint key are the same depositId. The enforcement point is the ledger's outpoint
map; the indexer's own map is keyed by depositId. -/
theorem indexer_credits_each_outpoint_at_most_once (ops : List (Op D K)) (a b : D)
    (ra rb : Rec K) (ha : (runOps World.empty ops).recs a = some ra)
    (hb : (runOps World.empty ops).recs b = some rb) (ca : ra.status = .credited)
    (cb : rb.status = .credited) (hk : ra.key = rb.key) : a = b := by
  have h := winv_runOps ops World.empty winv_empty
  obtain ⟨ea, hea, la, ka⟩ := h.credited a ra ha ca
  obtain ⟨eb, heb, lb, kb⟩ := h.credited b rb hb cb
  exact ledger_live_credit_unique h.led a b ea eb hea heb la lb (by rw [ka, kb, hk])

/-- Re-observing a depositId never creates a second record, never changes its account, amount
or outpoint, and is refused after rollback (:87-97). -/
theorem observe_existing_keeps_identity {w w' : World D K} {id : D} {a m : Nat} {k : K}
    {c : Bool} {r : Rec K} (hr : w.recs id = some r) (ho : observe w id a m k c = some w') :
    ∃ r', w'.recs id = some r' ∧ r'.acct = r.acct ∧ r'.amount = r.amount ∧ r'.key = r.key ∧
      r.status ≠ .rolledBack ∧ (∀ id', id' ≠ id → w'.recs id' = w.recs id') ∧ w'.led = w.led := by
  unfold observe at ho
  rw [hr] at ho
  simp only at ho
  split at ho
  · simp at ho
  · rename_i hc
    split at ho
    · simp at ho
    · rename_i hrb
      simp only [Option.some.injEq] at ho
      subst ho
      exact ⟨{ r with status := if r.status = .credited then .credited else if c then .confirmed else .observed }, by simp, rfl, rfl, rfl, hrb, fun id' hid => upd_other _ _ _ _ hid, rfl⟩

theorem observe_conflict_refused {w : World D K} {id : D} {a m : Nat} {k : K} {c : Bool}
    {r : Rec K} (hr : w.recs id = some r) (hconf : r.acct ≠ a ∨ r.key ≠ k ∨ r.amount ≠ m) :
    observe w id a m k c = none := by
  unfold observe
  rw [hr]
  simp [hconf]

/-! ### Findings: what the indexer itself does not do -/

section Findings

def mk (id : Nat) (acct : Nat) (k : Nat) : Op Nat Nat := .observe id acct 100 k true

/-- A world with deposit 1 and deposit 2 observed for the same outpoint 7. -/
def w2 : World Nat Nat := runOps World.empty [mk 1 1 7, mk 2 2 7]

/-- FINDING (m1_deposit_indexer.js:85-107): the indexer's map is keyed by depositId, so two
depositIds for the same funding outpoint are both recorded (and both `confirmed`). -/
theorem indexer_records_same_outpoint_under_two_deposit_ids :
    (w2.recs 1).map (·.key) = some 7 ∧ (w2.recs 2).map (·.key) = some 7 ∧
    (w2.recs 1).map (·.status) = some .confirmed ∧ (w2.recs 2).map (·.status) = some .confirmed := by
  decide

/-- The second credit is refused by the ledger (m1_receipt_ledger.js:56-59); the record stays
`confirmed`, and `applyConfirmedDepositsToLedger` (indexer :191-203) propagates the throw. -/
theorem second_credit_for_same_outpoint_refused :
    (credit w2 1).isSome = true ∧
    ((credit w2 1).bind (fun w => credit w 2)).isNone = true := by
  decide

/-- A credited deposit rolled back through the indexer frees its outpoint; the same outpoint is
then creditable under a new depositId, and the old depositId stays rolled back (:95-97). -/
theorem rollback_then_new_deposit_id_credits_again :
    let w := runOps World.empty [mk 1 1 7, .credit 1, .rollback 1, mk 2 1 7, .credit 2]
    (w.recs 1).map (·.status) = some .rolledBack ∧ (w.recs 2).map (·.status) = some .credited := by
  decide

theorem rolled_back_deposit_id_cannot_be_reobserved :
    (observe (runOps World.empty [mk 1 1 7, .credit 1, .rollback 1]) 1 1 100 7 true).isNone =
      true := by decide

end Findings

end Indexer

end UTXORefFormal.OneShot
