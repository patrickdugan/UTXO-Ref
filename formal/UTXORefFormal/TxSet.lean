/-!
# DLC transaction set validation

Model of `validateDlcTransactionSet` (bitvm3/utxo_referee/dlc_transaction_validator.js:355-462)
and the functions it calls at commit `5883e03`: `normalizeFunding` / `deriveFundingOutput`
(:209-236), `normalizeFeePolicy` (:252-296), `validateSpend` (:311-339) with
`validateExpectedOutputs` (:238-250) and `validateAnchor` (:298-309), and the post-parse
conditions of `parseCanonicalUnsignedTransaction` (:75-123).

What the model keeps: every check, in the code's order, with the code's constants (MAX_MONEY,
the 1..4096 CET count, the 1..0xffff CSV range, the 330..10000 sat CPFP anchor range, the TRUC
10000-byte bound, version 2 or 3, 16 inputs, 1000 outputs); the per-CET identity scan
(:367-378) as a left-to-right scan with a `seen` list; the refund-after-CET locktime rule
(:410); the unique-txid rule (:413-415).

What the model abstracts:
* Byte parsing. Transactions arrive parsed (`Tx`, with `TxIn` = outpoint + sequence and `TxOut`
  = value + script). `parsedOk` restates the checks `parseCanonicalUnsignedTransaction` makes on
  the parsed fields. Hex and script bytes are `Bytes := Nat`, an opaque stand-in compared only
  by equality; the lowercase-hex regexes are the parameters `hex32` / `hexAny`.
* Hashing and serialization: `txidOf` (the double SHA-256 of the raw bytes) and `sizeOf` (the raw
  byte length) are parameters. Distinct-txid conclusions are about the value `txidOf` returns.
* Taproot construction: `buildDlcFundingOutput` (dlc_funding_output.js:123-160) is the parameter
  `fundingScript keys csv`; only its CSV range check (`normalizeRefundCsvBlocks`,
  dlc_funding_output.js:85-90) is modelled, in `deriveFundingOutput`.
* The CPFP anchor-script regex (:283) is the parameter `anchorScriptOk`; the P2A constant
  (:8) is `p2aScript`.
* The JS `sort` on the validated CETs (:394) is `sortCets` with the field `sort_perm` (it is a
  permutation of its input). The order only affects the digest, not acceptance.
* Canonical-JSON digests of the output (:417-461) and `validateNormalizedDlcTransactionSetCommitments`
  (:464-498) are not modelled.
* The identity string `outcome:key1:key2..` (:376) is the pair `(outcome, keys)`; the string is
  injective in that pair because every field is validated to a fixed 64 hex characters.
* Byte order of oracle keys: JS `.sort()` on equal-length lowercase hex is the numeric order, so
  keys are `Nat` with `≤`.

Nothing in this file depends on a cryptographic assumption except the optional corollary
`accepted_refund_csv_is_unique_commitment`, whose hypothesis `CsvBinding` follows from
collision resistance of the tagged SHA-256 hashes in the Taproot tweak (axiom 2).
-/

set_option autoImplicit false

namespace UTXORefFormal.TxSet

abbrev Bytes := Nat

/-- `MAX_MONEY` (:7). -/
def MAX_MONEY : Nat := 21000000 * 100000000
/-- `0xffffffff`. -/
def MAX_U32 : Nat := 0xffffffff
/-- `TRUC_VERSION` (:9). -/
def TRUC_VERSION : Nat := 3
/-- `TRUC_MAX_VSIZE` (:10). -/
def TRUC_MAX_VSIZE : Nat := 10000
/-- `MAX_REFUND_CSV_BLOCKS` (dlc_funding_output.js:31). -/
def MAX_REFUND_CSV : Nat := 0xffff

structure TxIn where
  prevTxid : Bytes
  vout : Nat
  sequence : Nat
  deriving DecidableEq, Repr

structure TxOut where
  value : Nat
  script : Bytes
  deriving DecidableEq, Repr

structure Tx where
  version : Nat
  inputs : List TxIn
  outputs : List TxOut
  locktime : Nat
  deriving DecidableEq, Repr

def TxIn.outpoint (i : TxIn) : Bytes × Nat := (i.prevTxid, i.vout)

/-- Post-parse conditions of `parseCanonicalUnsignedTransaction`: version 2 or 3 (:83), 1..16
inputs (:86-87), 1..1000 outputs (:98-99), output value at most MAX_MONEY (:103), u32 sequences
and locktime, and a nonzero locktime is not disabled by all-final sequences (:111). -/
def parsedOk (t : Tx) : Bool :=
  (t.version == 2 || t.version == 3) &&
  decide (1 ≤ t.inputs.length ∧ t.inputs.length ≤ 16) &&
  decide (1 ≤ t.outputs.length ∧ t.outputs.length ≤ 1000) &&
  t.inputs.all (fun i => decide (i.sequence ≤ MAX_U32)) &&
  t.outputs.all (fun o => decide (o.value ≤ MAX_MONEY)) &&
  decide (t.locktime ≤ MAX_U32) &&
  (t.locktime == 0 || !(t.inputs.all (fun i => i.sequence == MAX_U32)))

/-- The parameters of the model (see the module docstring). -/
structure Env (CetOutT : Type) where
  txidOf : Tx → Bytes
  sizeOf : Tx → Nat
  fundingScript : List Bytes → Nat → Option Bytes
  hex32 : Bytes → Bool
  hexAny : Bytes → Bool
  anchorScriptOk : Bytes → Bool
  p2aScript : Bytes
  sortCets : List CetOutT → List CetOutT
  /-- JS `Array.prototype.sort` returns a permutation of its input. -/
  sort_perm : ∀ l, (sortCets l).Perm l

/-! ## Fee policy (:252-296) -/

inductive Strategy where
  | trucP2a
  | cpfpAnchor
  | other
  deriving DecidableEq, Repr

structure FeePolicyIn where
  strategy : Strategy
  maxRecoveryFee : Nat
  maxFeerate : Nat
  minRelayPeers : Nat
  anchorAmount : Nat
  anchorScript : Bytes

structure NPolicy where
  strategy : Strategy
  txVersion : Nat
  anchorAmount : Nat
  anchorScript : Bytes
  deriving DecidableEq, Repr

/-- `normalizeFeePolicy`. -/
def normalizeFeePolicy {C : Type} (env : Env C) (p : FeePolicyIn) : Option NPolicy :=
  if decide (0 < p.maxRecoveryFee ∧ p.maxRecoveryFee ≤ MAX_MONEY) &&
      decide (1 ≤ p.maxFeerate ∧ p.maxFeerate ≤ 10000) &&
      decide (1 ≤ p.minRelayPeers ∧ p.minRelayPeers ≤ 16) then
    if p.strategy = Strategy.trucP2a then
      if p.anchorAmount = 0 ∧ p.anchorScript = env.p2aScript then
        some ⟨Strategy.trucP2a, TRUC_VERSION, 0, env.p2aScript⟩
      else none
    else if p.strategy = Strategy.cpfpAnchor ∧ 330 ≤ p.anchorAmount ∧ p.anchorAmount ≤ 10000 ∧
        env.anchorScriptOk p.anchorScript = true ∧ p.anchorAmount ≤ p.maxRecoveryFee then
      some ⟨Strategy.cpfpAnchor, 2, p.anchorAmount, p.anchorScript⟩
    else none
  else none

/-! ## Funding (:209-236) -/

structure Funding where
  txid : Bytes
  vout : Nat
  value : Nat
  scriptPubKey : Bytes
  partyKeys : List Bytes
  refundCsv : Nat
  deriving DecidableEq, Repr

/-- `deriveFundingOutput`: the refund delay must be in `1..0xffff`
(dlc_funding_output.js:85-90) before the output is built. -/
def deriveFundingOutput {C : Type} (env : Env C) (f : Funding) : Option Bytes :=
  if 1 ≤ f.refundCsv ∧ f.refundCsv ≤ MAX_REFUND_CSV then env.fundingScript f.partyKeys f.refundCsv
  else none

/-- `normalizeFunding`: outpoint/value range (:221-224), the committed script equals the derived
two-party output (:225, :214), txid shape (:227). -/
def normalizeFunding {C : Type} (env : Env C) (f : Funding) : Option Funding :=
  if f.vout ≤ MAX_U32 ∧ 1 ≤ f.value ∧ f.value ≤ MAX_MONEY then
    match deriveFundingOutput env f with
    | none => none
    | some s => if f.scriptPubKey = s ∧ env.hex32 f.txid = true then some f else none
  else none

/-! ## One spend (:238-339) -/

structure SpendIn where
  tx : Tx
  expectedOutputs : List TxOut
  expectedLocktime : Nat
  requiredSequence : Option Nat

/-- `validateExpectedOutputs`: same count, and each expected entry is well formed and equal. -/
def outputsMatch (hexAny : Bytes → Bool) : List TxOut → List TxOut → Bool
  | [], [] => true
  | a :: as, e :: es => hexAny e.script && decide (a = e) && outputsMatch hexAny as es
  | _, _ => false

/-- `validateAnchor`: exactly one output equals the committed anchor and the last one does. -/
def anchorOk (outs : List TxOut) (pol : NPolicy) : Bool :=
  decide (outs.countP (fun o => decide (o.value = pol.anchorAmount ∧ o.script = pol.anchorScript)) = 1) &&
  (match outs.getLast? with
   | none => false
   | some o => decide (o.value = pol.anchorAmount ∧ o.script = pol.anchorScript))

def reqSeqOk : Option Nat → List TxIn → Bool
  | none, _ => true
  | some r, ins => ins.all (fun i => i.sequence == r)

def totalOut (outs : List TxOut) : Nat := (outs.map (·.value)).sum

/-- The conjunction of the checks of `validateSpend`, in the order of :314-337. -/
def spendCond {C : Type} (env : Env C) (f : Funding) (pol : NPolicy) (minF maxF : Nat)
    (s : SpendIn) : Bool :=
  parsedOk s.tx &&
  reqSeqOk s.requiredSequence s.tx.inputs &&
  decide (s.tx.version = pol.txVersion) &&
  (decide (pol.strategy ≠ Strategy.trucP2a) || decide (env.sizeOf s.tx ≤ TRUC_MAX_VSIZE)) &&
  decide (s.tx.inputs.length = 1) &&
  s.tx.inputs.all (fun i => decide (i.prevTxid = f.txid ∧ i.vout = f.vout)) &&
  decide (s.expectedLocktime ≤ MAX_U32 ∧ s.tx.locktime = s.expectedLocktime) &&
  outputsMatch env.hexAny s.tx.outputs s.expectedOutputs &&
  anchorOk s.tx.outputs pol &&
  decide (totalOut s.tx.outputs ≤ f.value) &&
  decide (minF ≤ f.value - totalOut s.tx.outputs ∧ f.value - totalOut s.tx.outputs ≤ maxF)

/-- `validateSpend`: the validated transaction and its fee. -/
def validateSpend {C : Type} (env : Env C) (f : Funding) (pol : NPolicy) (minF maxF : Nat)
    (s : SpendIn) : Option (Tx × Nat) :=
  if spendCond env f pol minF maxF s = true then some (s.tx, f.value - totalOut s.tx.outputs)
  else none

/-- What `validateSpend` returning a value says. -/
structure SpendFacts {C : Type} (env : Env C) (f : Funding) (pol : NPolicy) (minF maxF : Nat)
    (s : SpendIn) (fee : Nat) : Prop where
  parsed : parsedOk s.tx = true
  reqSeq : ∀ r, s.requiredSequence = some r → ∀ i ∈ s.tx.inputs, i.sequence = r
  version : s.tx.version = pol.txVersion
  size : pol.strategy = Strategy.trucP2a → env.sizeOf s.tx ≤ TRUC_MAX_VSIZE
  oneInput : s.tx.inputs.length = 1
  spendsFunding : ∀ i ∈ s.tx.inputs, i.prevTxid = f.txid ∧ i.vout = f.vout
  locktime : s.tx.locktime = s.expectedLocktime
  outputs : s.tx.outputs = s.expectedOutputs
  anchor : anchorOk s.tx.outputs pol = true
  feeDef : fee = f.value - totalOut s.tx.outputs ∧ totalOut s.tx.outputs ≤ f.value
  feeRange : minF ≤ fee ∧ fee ≤ maxF

theorem outputsMatch_eq (h : Bytes → Bool) :
    ∀ (a e : List TxOut), outputsMatch h a e = true → a = e
  | [], [] => fun _ => rfl
  | [], _ :: _ => fun hh => by simp [outputsMatch] at hh
  | _ :: _, [] => fun hh => by simp [outputsMatch] at hh
  | a :: as, e :: es => fun hh => by
      simp only [outputsMatch, Bool.and_eq_true, decide_eq_true_eq] at hh
      obtain ⟨⟨_, hae⟩, hrest⟩ := hh
      rw [hae, outputsMatch_eq h as es hrest]

theorem validateSpend_facts {C : Type} {env : Env C} {f : Funding} {pol : NPolicy}
    {minF maxF : Nat} {s : SpendIn} {tx : Tx} {fee : Nat}
    (h : validateSpend env f pol minF maxF s = some (tx, fee)) :
    tx = s.tx ∧ SpendFacts env f pol minF maxF s fee := by
  unfold validateSpend at h
  split at h
  · rename_i hc
    simp only [Option.some.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    refine ⟨rfl, ?_⟩
    unfold spendCond at hc
    simp only [Bool.and_eq_true, decide_eq_true_eq, Bool.or_eq_true, List.all_eq_true] at hc
    obtain ⟨⟨⟨⟨⟨⟨⟨⟨⟨⟨h1, h2⟩, h3⟩, h4⟩, h5⟩, h6⟩, h7⟩, h8⟩, h9⟩, h10⟩, h11⟩ := hc
    refine ⟨h1, ?_, h3, ?_, h5, ?_, h7.2, outputsMatch_eq _ _ _ h8, h9, ⟨rfl, h10⟩, h11⟩
    · intro r hr i hi
      unfold reqSeqOk at h2
      rw [hr] at h2
      simp only [List.all_eq_true, beq_iff_eq] at h2
      exact h2 i hi
    · intro hs
      rcases h4 with h4 | h4
      · exact absurd hs (by simpa using h4)
      · exact h4
    · intro i hi
      exact h6 i hi
  · simp at h

/-! ## The whole set (:355-462) -/

structure Claim where
  tx : Tx
  expectedOutputs : List TxOut
  locktime : Nat

structure CetIn where
  outcome : Bytes
  oracles : List Bytes
  claim : Claim

structure CetOut where
  outcome : Bytes
  oracles : List Bytes
  tx : Tx
  fee : Nat

def CetOut.identity (c : CetOut) : Bytes × List Bytes := (c.outcome, c.oracles)

structure SetIn where
  funding : Funding
  policy : FeePolicyIn
  minFee : Nat
  maxFee : Nat
  cets : List CetIn
  refund : Claim

structure SetOut where
  funding : Funding
  policy : NPolicy
  cets : List CetOut
  refund : Tx
  refundFee : Nat

/-- :369-375. Fields are shaped as 32-byte hex, at least two oracle keys, unique, sorted. -/
def cetShapeOk {C : Type} (env : Env C) (c : CetIn) : Bool :=
  env.hex32 c.outcome &&
  decide (2 ≤ c.oracles.length) &&
  c.oracles.all env.hex32 &&
  decide c.oracles.Nodup &&
  decide (c.oracles.Pairwise (· ≤ ·))

def spendOfClaim (cl : Claim) (req : Option Nat) : SpendIn :=
  ⟨cl.tx, cl.expectedOutputs, cl.locktime, req⟩

/-- The `cets.map` loop (:368-393), threading the identity `Set` as `seen`. -/
def cetLoop {C : Type} (env : Env C) (f : Funding) (pol : NPolicy) (minF maxF : Nat) :
    List (Bytes × List Bytes) → List CetIn → Option (List CetOut)
  | _, [] => some []
  | seen, c :: cs =>
    if cetShapeOk env c = true then
      if (c.outcome, c.oracles) ∈ seen then none
      else
        match validateSpend env f pol minF maxF (spendOfClaim c.claim none) with
        | none => none
        | some (tx, fee) =>
          match cetLoop env f pol minF maxF ((c.outcome, c.oracles) :: seen) cs with
          | none => none
          | some rest => some (⟨c.outcome, c.oracles, tx, fee⟩ :: rest)
    else none

/-- `validateDlcTransactionSet`. -/
def validateSet (env : Env CetOut) (inp : SetIn) : Option SetOut :=
  match normalizeFunding env inp.funding with
  | none => none
  | some f =>
  match normalizeFeePolicy env inp.policy with
  | none => none
  | some pol =>
  if ¬ (inp.minFee ≤ inp.maxFee ∧ inp.maxFee ≤ f.value) then none
  else if ¬ (1 ≤ inp.cets.length ∧ inp.cets.length ≤ 4096) then none
  else
  match cetLoop env f pol inp.minFee inp.maxFee [] inp.cets with
  | none => none
  | some cs =>
  match validateSpend env f pol inp.minFee inp.maxFee (spendOfClaim inp.refund (some f.refundCsv)) with
  | none => none
  | some (rtx, rfee) =>
  if (env.sortCets cs).any (fun c => decide (inp.refund.locktime ≤ c.tx.locktime)) then none
  else if ¬ (((env.sortCets cs).map (fun c => env.txidOf c.tx) ++ [env.txidOf rtx]).Nodup) then none
  else some ⟨f, pol, env.sortCets cs, rtx, rfee⟩

/-! ## Facts about the loop -/

def CetRel {C : Type} (env : Env C) (f : Funding) (pol : NPolicy) (minF maxF : Nat)
    (c : CetIn) (o : CetOut) : Prop :=
  cetShapeOk env c = true ∧ o.outcome = c.outcome ∧ o.oracles = c.oracles ∧
  validateSpend env f pol minF maxF (spendOfClaim c.claim none) = some (o.tx, o.fee)

theorem cetLoop_spec {C : Type} (env : Env C) (f : Funding) (pol : NPolicy) (minF maxF : Nat) :
    ∀ (cs : List CetIn) (seen : List (Bytes × List Bytes)) (outs : List CetOut),
      cetLoop env f pol minF maxF seen cs = some outs →
      (∀ o ∈ outs, ∃ c ∈ cs, CetRel env f pol minF maxF c o) ∧
      (outs.map CetOut.identity).Nodup ∧
      (∀ o ∈ outs, o.identity ∉ seen)
  | [], seen, outs, h => by
      simp only [cetLoop, Option.some.injEq] at h
      subst h
      simp
  | c :: cs, seen, outs, h => by
      unfold cetLoop at h
      split at h
      · rename_i hshape
        split at h
        · simp at h
        · rename_i hnot
          split at h
          · simp at h
          · rename_i tx fee hv
            split at h
            · simp at h
            · rename_i rest hrest
              simp only [Option.some.injEq] at h
              subst h
              obtain ⟨ih1, ih2, ih3⟩ :=
                cetLoop_spec env f pol minF maxF cs ((c.outcome, c.oracles) :: seen) rest hrest
              refine ⟨?_, ?_, ?_⟩
              · intro o ho
                rcases List.mem_cons.mp ho with rfl | ho
                · exact ⟨c, List.mem_cons_self, hshape, rfl, rfl, hv⟩
                · obtain ⟨c', hc', hr⟩ := ih1 o ho
                  exact ⟨c', List.mem_cons_of_mem _ hc', hr⟩
              · rw [List.map_cons, List.nodup_cons]
                refine ⟨?_, ih2⟩
                intro hmem
                obtain ⟨o, ho, hoe⟩ := List.mem_map.mp hmem
                exact ih3 o ho (by simp [CetOut.identity] at hoe ⊢; simp [hoe])
              · intro o ho
                rcases List.mem_cons.mp ho with rfl | ho
                · simpa [CetOut.identity] using hnot
                · intro hs
                  exact ih3 o ho (List.mem_cons_of_mem _ hs)
      · simp at h

/-! ## What an accepted set guarantees -/

/-- The data an accepted set carries, in terms of the input. -/
structure Accepted (env : Env CetOut) (inp : SetIn) (out : SetOut) : Prop where
  fundingValid : normalizeFunding env inp.funding = some out.funding
  policyValid : normalizeFeePolicy env inp.policy = some out.policy
  feeRange : inp.minFee ≤ inp.maxFee ∧ inp.maxFee ≤ out.funding.value
  cetCount : 1 ≤ inp.cets.length ∧ inp.cets.length ≤ 4096
  cetsFrom : ∀ o ∈ out.cets, ∃ c ∈ inp.cets,
    CetRel env out.funding out.policy inp.minFee inp.maxFee c o
  cetIdsDistinct : (out.cets.map CetOut.identity).Nodup
  refundSpend : ∃ fee, validateSpend env out.funding out.policy inp.minFee inp.maxFee
      (spendOfClaim inp.refund (some out.funding.refundCsv)) = some (out.refund, fee)
  refundLater : ∀ o ∈ out.cets, o.tx.locktime < inp.refund.locktime
  txidsDistinct : (out.cets.map (fun c => env.txidOf c.tx) ++ [env.txidOf out.refund]).Nodup

theorem validateSet_accepted {env : Env CetOut} {inp : SetIn} {out : SetOut}
    (h : validateSet env inp = some out) : Accepted env inp out := by
  unfold validateSet at h
  split at h
  · simp at h
  · rename_i f hf
    split at h
    · simp at h
    · rename_i pol hpol
      split at h
      · simp at h
      · rename_i hfee
        split at h
        · simp at h
        · rename_i hcnt
          split at h
          · simp at h
          · rename_i cs hcs
            split at h
            · simp at h
            · rename_i rtx rfee hr
              split at h
              · simp at h
              · rename_i hlate
                split at h
                · simp at h
                · rename_i hnd
                  simp only [Option.some.injEq] at h
                  subst h
                  obtain ⟨s1, s2, _⟩ :=
                    cetLoop_spec env f pol inp.minFee inp.maxFee inp.cets [] cs hcs
                  have hperm := env.sort_perm cs
                  refine ⟨hf, hpol, ?_, ?_, ?_, ?_, ⟨rfee, hr⟩, ?_, ?_⟩
                  · simpa using hfee
                  · simpa using hcnt
                  · intro o ho
                    exact s1 o (hperm.mem_iff.mp ho)
                  · exact (hperm.map CetOut.identity).nodup_iff.mpr s2
                  · intro o ho
                    have : ¬ (decide (inp.refund.locktime ≤ o.tx.locktime) = true) := by
                      intro hd
                      apply hlate
                      exact List.any_eq_true.mpr ⟨o, ho, hd⟩
                    simpa using this
                  · simpa using hnd

/-- The input outpoint of every transaction of the set. -/
def fundingOutpoint (f : Funding) : Bytes × Nat := (f.txid, f.vout)

/-- (a) Every CET spends exactly the one funding outpoint, through a single input. -/
theorem accepted_cet_single_input_funding {env : Env CetOut} {inp : SetIn} {out : SetOut}
    (h : validateSet env inp = some out) :
    ∀ o ∈ out.cets, o.tx.inputs.length = 1 ∧
      ∀ i ∈ o.tx.inputs, i.outpoint = fundingOutpoint out.funding := by
  intro o ho
  obtain ⟨c, _, _, _, _, hv⟩ := (validateSet_accepted h).cetsFrom o ho
  obtain ⟨htx, hf⟩ := validateSpend_facts hv
  rw [htx]
  refine ⟨hf.oneInput, fun i hi => ?_⟩
  obtain ⟨a, b⟩ := hf.spendsFunding i hi
  simp [TxIn.outpoint, fundingOutpoint, a, b]

/-- (a) The refund spends exactly the one funding outpoint, through a single input. -/
theorem accepted_refund_single_input_funding {env : Env CetOut} {inp : SetIn} {out : SetOut}
    (h : validateSet env inp = some out) :
    out.refund.inputs.length = 1 ∧
      ∀ i ∈ out.refund.inputs, i.outpoint = fundingOutpoint out.funding := by
  obtain ⟨fee, hv⟩ := (validateSet_accepted h).refundSpend
  obtain ⟨htx, hf⟩ := validateSpend_facts hv
  rw [htx]
  refine ⟨hf.oneInput, fun i hi => ?_⟩
  obtain ⟨a, b⟩ := hf.spendsFunding i hi
  simp [TxIn.outpoint, fundingOutpoint, a, b]

theorem nodup_of_map_nodup {α β : Type} (f : α → β) {l : List α}
    (h : (l.map f).Nodup) : l.Nodup := by
  have := List.pairwise_map.mp (List.nodup_iff_pairwise_ne.mp h)
  exact List.nodup_iff_pairwise_ne.mpr (this.imp (fun hab e => hab (by rw [e])))

/-- The transactions of an accepted set: every CET and the refund. -/
def members (out : SetOut) : List Tx := out.cets.map (·.tx) ++ [out.refund]

/-- (a) Any two members of an accepted set have an input with the same outpoint, so they
conflict. -/
theorem accepted_members_pairwise_conflict {env : Env CetOut} {inp : SetIn} {out : SetOut}
    (h : validateSet env inp = some out) :
    ∀ t ∈ members out, ∀ t' ∈ members out,
      ∃ i ∈ t.inputs, ∃ i' ∈ t'.inputs, i.outpoint = i'.outpoint := by
  have hsingle : ∀ t ∈ members out, ∃ i ∈ t.inputs, i.outpoint = fundingOutpoint out.funding := by
    intro t ht
    unfold members at ht
    rcases List.mem_append.mp ht with ht | ht
    · obtain ⟨o, ho, rfl⟩ := List.mem_map.mp ht
      obtain ⟨hl, hall⟩ := accepted_cet_single_input_funding h o ho
      obtain ⟨i, hi⟩ : ∃ i, i ∈ o.tx.inputs := by
        cases hh : o.tx.inputs with
        | nil => rw [hh] at hl; simp at hl
        | cons a as => exact ⟨a, by simp⟩
      exact ⟨i, hi, hall i hi⟩
    · have : t = out.refund := by simpa using ht
      subst this
      obtain ⟨hl, hall⟩ := accepted_refund_single_input_funding h
      obtain ⟨i, hi⟩ : ∃ i, i ∈ out.refund.inputs := by
        cases hh : out.refund.inputs with
        | nil => rw [hh] at hl; simp at hl
        | cons a as => exact ⟨a, by simp⟩
      exact ⟨i, hi, hall i hi⟩
  intro t ht t' ht'
  obtain ⟨i, hi, e⟩ := hsingle t ht
  obtain ⟨i', hi', e'⟩ := hsingle t' ht'
  exact ⟨i, hi, i', hi', e.trans e'.symm⟩

/-- (b) CET identities `(outcome, oracle subset)` are pairwise distinct. -/
theorem accepted_cet_identities_distinct {env : Env CetOut} {inp : SetIn} {out : SetOut}
    (h : validateSet env inp = some out) : (out.cets.map CetOut.identity).Nodup :=
  (validateSet_accepted h).cetIdsDistinct

/-- (b) The txids of all CETs and the refund are pairwise distinct. -/
theorem accepted_txids_distinct {env : Env CetOut} {inp : SetIn} {out : SetOut}
    (h : validateSet env inp = some out) :
    (out.cets.map (fun c => env.txidOf c.tx) ++ [env.txidOf out.refund]).Nodup :=
  (validateSet_accepted h).txidsDistinct

/-- (b) Consequently the members are pairwise distinct transactions. -/
theorem accepted_members_nodup {env : Env CetOut} {inp : SetIn} {out : SetOut}
    (h : validateSet env inp = some out) : (members out).Nodup := by
  have hn := accepted_txids_distinct h
  unfold members
  have : (out.cets.map (·.tx) ++ [out.refund]).map env.txidOf =
      out.cets.map (fun c => env.txidOf c.tx) ++ [env.txidOf out.refund] := by
    simp [List.map_append, List.map_map, Function.comp_def]
  rw [← this] at hn
  exact nodup_of_map_nodup _ hn

/-- What `normalizeFunding` returning a value says about it. -/
theorem normalizeFunding_facts {C : Type} {env : Env C} {f g : Funding}
    (h : normalizeFunding env f = some g) :
    1 ≤ g.refundCsv ∧ g.refundCsv ≤ MAX_REFUND_CSV ∧
      env.fundingScript g.partyKeys g.refundCsv = some g.scriptPubKey := by
  unfold normalizeFunding at h
  split at h
  · split at h
    · simp at h
    · rename_i s hs
      split at h
      · rename_i hc
        simp only [Option.some.injEq] at h
        subst h
        unfold deriveFundingOutput at hs
        split at hs
        · rename_i hr
          exact ⟨hr.1, hr.2, by rw [hs, hc.1]⟩
        · simp at hs
      · simp at h
  · simp at h

/-- BIP112 admissibility of a sequence for a block-count CSV of value `csv`: the disable flag
(bit 31) and the type flag (bit 22) are clear and the sequence is at least `csv`. -/
def Bip112Blocks (seq csv : Nat) : Prop := seq < 2 ^ 22 ∧ csv ≤ seq

/-- (c) The refund's nSequence on every input equals `funding.refundCsv`, the delay the funding
script was derived from; that delay is in `1..0xffff`; the refund transaction version is 2 or
3 (CSV needs at least 2); the funding scriptPubKey is the derived two-party output for the
committed keys and that delay; and the sequence satisfies BIP112 for it. The absolute locktime
of the refund is the committed one and exceeds every CET locktime; the refund leaf contains no
OP_CHECKLOCKTIMEVERIFY, so the locktime is not part of what the leaf commits to. -/
theorem accepted_refund_sequence_is_committed_csv {env : Env CetOut} {inp : SetIn}
    {out : SetOut} (h : validateSet env inp = some out) :
    (∀ i ∈ out.refund.inputs, i.sequence = out.funding.refundCsv) ∧
    (1 ≤ out.funding.refundCsv ∧ out.funding.refundCsv ≤ MAX_REFUND_CSV) ∧
    env.fundingScript out.funding.partyKeys out.funding.refundCsv = some out.funding.scriptPubKey ∧
    (out.refund.version = 2 ∨ out.refund.version = 3) ∧
    (∀ i ∈ out.refund.inputs, Bip112Blocks i.sequence out.funding.refundCsv) ∧
    out.refund.locktime = inp.refund.locktime ∧
    (∀ o ∈ out.cets, o.tx.locktime < out.refund.locktime) := by
  have ha := validateSet_accepted h
  obtain ⟨fee, hv⟩ := ha.refundSpend
  obtain ⟨htx, hf⟩ := validateSpend_facts hv
  have hloc : out.refund.locktime = inp.refund.locktime := by
    rw [htx]; exact hf.locktime
  have hseq : ∀ i ∈ out.refund.inputs, i.sequence = out.funding.refundCsv := by
    rw [htx]; exact hf.reqSeq _ rfl
  have hrange := normalizeFunding_facts ha.fundingValid
  have hver : out.refund.version = 2 ∨ out.refund.version = 3 := by
    rw [htx]
    have := hf.parsed
    unfold parsedOk at this
    simp only [Bool.and_eq_true, Bool.or_eq_true, beq_iff_eq] at this
    exact this.1.1.1.1.1.1
  have hbip : ∀ i ∈ out.refund.inputs, Bip112Blocks i.sequence out.funding.refundCsv := by
    intro i hi
    have e := hseq i hi
    refine ⟨?_, by omega⟩
    rw [e]
    have : out.funding.refundCsv ≤ 0xffff := hrange.2.1
    have h22 : (0xffff : Nat) < 2 ^ 22 := by decide
    omega
  refine ⟨hseq, ⟨hrange.1, hrange.2.1⟩, hrange.2.2, hver, hbip, hloc, ?_⟩
  intro o ho
  rw [hloc]
  exact ha.refundLater o ho

/-- The CSV value a funding scriptPubKey commits to is unique for a fixed key set. This follows
from collision resistance of the tagged SHA-256 hashes in the Taproot tweak (axiom 2); it is a
hypothesis here, not an axiom. -/
def CsvBinding (env : Env CetOut) : Prop :=
  ∀ ks c c' s, env.fundingScript ks c = some s → env.fundingScript ks c' = some s → c = c'

/-- (c) Under `CsvBinding`, the refund's nSequence is the only CSV value any refund leaf of the
committed keys and funding scriptPubKey can contain. -/
theorem accepted_refund_csv_is_unique_commitment {env : Env CetOut} {inp : SetIn}
    {out : SetOut} (h : validateSet env inp = some out) (bind : CsvBinding env)
    (c' : Nat) (hc' : env.fundingScript out.funding.partyKeys c' = some out.funding.scriptPubKey) :
    ∀ i ∈ out.refund.inputs, i.sequence = c' := by
  obtain ⟨hseq, _, hscript, _⟩ := accepted_refund_sequence_is_committed_csv h
  intro i hi
  rw [hseq i hi]
  exact bind _ _ _ _ hscript hc'

/-- (d) Every CET's oracle subset has at least two keys, each key is a 32-byte hex string, and
the keys are strictly increasing (sorted and unique). The validator imposes no upper bound and
no common size across CETs; the size is not compared with any threshold at this layer. -/
theorem accepted_oracle_subsets_sorted_unique {env : Env CetOut} {inp : SetIn} {out : SetOut}
    (h : validateSet env inp = some out) :
    ∀ o ∈ out.cets, 2 ≤ o.oracles.length ∧ (∀ k ∈ o.oracles, env.hex32 k = true) ∧
      o.oracles.Pairwise (· < ·) := by
  intro o ho
  obtain ⟨c, _, hshape, _, hor, _⟩ := (validateSet_accepted h).cetsFrom o ho
  unfold cetShapeOk at hshape
  simp only [Bool.and_eq_true, decide_eq_true_eq, List.all_eq_true] at hshape
  obtain ⟨⟨⟨⟨_, hlen⟩, hkeys⟩, hnd⟩, hsort⟩ := hshape
  rw [hor]
  refine ⟨hlen, hkeys, ?_⟩
  have hp : c.oracles.Pairwise (fun a b => a ≤ b ∧ a ≠ b) :=
    (List.Pairwise.and hsort (List.nodup_iff_pairwise_ne.mp hnd))
  exact hp.imp (fun hab => Nat.lt_of_le_of_ne hab.1 hab.2)

/-- (b/dup rule) What the identity rule guarantees about CETs for one outcome: two distinct
entries with the same outcome message have different oracle subsets. It does not say their
outputs differ; see `same_outcome_cets_accepted` for a concrete accepted set. -/
theorem accepted_same_outcome_have_different_subsets {env : Env CetOut} {inp : SetIn}
    {out : SetOut} (h : validateSet env inp = some out) :
    ∀ (l₁ l₂ : List CetOut), out.cets = l₁ ++ l₂ →
      ∀ a ∈ l₁, ∀ b ∈ l₂, a.outcome = b.outcome → a.oracles ≠ b.oracles := by
  intro l₁ l₂ hl a ha b hb hout hor
  have hn := accepted_cet_identities_distinct h
  rw [hl, List.map_append, List.nodup_append] at hn
  exact hn.2.2 a.identity (List.mem_map.mpr ⟨a, ha, rfl⟩) b.identity
    (List.mem_map.mpr ⟨b, hb, rfl⟩) (by simp [CetOut.identity, hout, hor])

/-- A chain model in which every outpoint is spent by at most one confirmed transaction. -/
structure Chain where
  confirmed : Tx → Prop
  spendsOnce : ∀ t t', confirmed t → confirmed t' →
    ∀ i ∈ t.inputs, ∀ i' ∈ t'.inputs, i.outpoint = i'.outpoint → t = t'

/-- (e) In any such chain at most one transaction of an accepted set confirms: two confirmed
members are equal, and members are pairwise distinct (`accepted_members_nodup`), so they are
the same member. -/
theorem accepted_at_most_one_member_confirms {env : Env CetOut} {inp : SetIn} {out : SetOut}
    (h : validateSet env inp = some out) (ch : Chain) :
    ∀ t ∈ members out, ∀ t' ∈ members out, ch.confirmed t → ch.confirmed t' → t = t' := by
  intro t ht t' ht' ct ct'
  obtain ⟨i, hi, i', hi', e⟩ := accepted_members_pairwise_conflict h t ht t' ht'
  exact ch.spendsOnce t t' ct ct' i hi i' hi' e

/-! ## Concrete vectors

`vecEnv` hashes a transaction to a number that depends on every field, so equal ids imply equal
transactions in the vectors. -/

def vecEnv : Env CetOut where
  txidOf := fun t => t.locktime * 1000003 + t.version * 7919 +
    (t.inputs.map (fun i => i.sequence * 31 + i.vout)).sum * 101 +
    (t.outputs.map (fun o => o.value * 13 + o.script)).sum
  sizeOf := fun _ => 200
  fundingScript := fun ks c => some (ks.sum * 100000 + c)
  hex32 := fun _ => true
  hexAny := fun _ => true
  anchorScriptOk := fun s => s != 0
  p2aScript := 5
  sortCets := id
  sort_perm := fun _ => List.Perm.refl _

def vecKeys : List Bytes := [10, 20]
def vecCsv : Nat := 144
def vecFunding : Funding :=
  ⟨1, 0, 100000, vecKeys.sum * 100000 + vecCsv, vecKeys, vecCsv⟩
def vecPolicy : FeePolicyIn := ⟨Strategy.cpfpAnchor, 5000, 10, 1, 330, 77⟩
def vecOuts : List TxOut := [⟨98670, 8⟩, ⟨330, 77⟩]
def vecIn (seq : Nat) : TxIn := ⟨1, 0, seq⟩
def vecCetTx (seq : Nat) : Tx := ⟨2, [vecIn seq], vecOuts, 100⟩
def vecCet (outcome : Nat) (ks : List Bytes) (seq : Nat) : CetIn :=
  ⟨outcome, ks, ⟨vecCetTx seq, vecOuts, 100⟩⟩
def vecRefundTx : Tx := ⟨2, [vecIn vecCsv], vecOuts, 200⟩
def vecRefund : Claim := ⟨vecRefundTx, vecOuts, 200⟩

def vecSet (cets : List CetIn) (refund : Claim := vecRefund) : SetIn :=
  ⟨vecFunding, vecPolicy, 0, 1000, cets, refund⟩

/-- Distinct outcomes, one subset each: accepted. -/
example : (validateSet vecEnv (vecSet
    [vecCet 1 [1, 2] 0xfffffffe, vecCet 2 [1, 2] 0xfffffffd])).isSome = true := by decide

/-- The identical identity twice is rejected even though the nSequence differs (so the txids
would differ). -/
example : validateSet vecEnv (vecSet
    [vecCet 1 [1, 2] 0xfffffffe, vecCet 1 [1, 2] 0xfffffffd]) = none := by decide

/-- Two CETs for the SAME outcome with different oracle subsets and identical outputs are
accepted when they differ in nothing but nSequence (dlc_transaction_validator.js:376-378 keys the
identity on outcome plus subset; :413-415 only requires distinct txids). -/
theorem same_outcome_cets_accepted : (validateSet vecEnv (vecSet
    [vecCet 1 [1, 2] 0xfffffffe, vecCet 1 [1, 3] 0xfffffffd])).isSome = true := by decide

/-- With the same nSequence the two transactions coincide and the txid rule rejects the set. -/
example : validateSet vecEnv (vecSet
    [vecCet 1 [1, 2] 0xfffffffe, vecCet 1 [1, 3] 0xfffffffe]) = none := by decide

/-- A refund whose nSequence differs from the committed delay is rejected (:315-317). -/
example : validateSet vecEnv (vecSet [vecCet 1 [1, 2] 0xfffffffe]
    ⟨⟨2, [vecIn 145], vecOuts, 200⟩, vecOuts, 200⟩) = none := by decide

/-- A refund locktime that does not exceed the CET locktime is rejected (:410). -/
example : validateSet vecEnv (vecSet [vecCet 1 [1, 2] 0xfffffffe]
    ⟨⟨2, [vecIn vecCsv], vecOuts, 100⟩, vecOuts, 100⟩) = none := by decide

/-- A one-oracle subset is rejected (:370); a five-oracle subset is accepted: only `≥ 2` is
required. -/
example : cetShapeOk vecEnv (vecCet 1 [1] 0) = false := by decide
example : cetShapeOk vecEnv (vecCet 1 [1, 2, 3, 4, 5] 0) = true := by decide
/-- Unsorted and duplicated subsets are rejected (:371-373). -/
example : cetShapeOk vecEnv (vecCet 1 [2, 1] 0) = false := by decide
example : cetShapeOk vecEnv (vecCet 1 [1, 1] 0) = false := by decide

/-- A spend with two inputs is rejected (:324). -/
example : validateSet vecEnv (vecSet [⟨1, [1, 2], ⟨⟨2, [vecIn 0xfffffffe, ⟨2, 0, 0xfffffffe⟩],
    vecOuts, 100⟩, vecOuts, 100⟩⟩]) = none := by decide

end UTXORefFormal.TxSet
