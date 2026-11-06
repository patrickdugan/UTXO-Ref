/-!
# Schnorr adaptor signatures and oracle outcome points

Model of the adaptor-signature scheme of `bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig.js` at
commit `5883e03`: `challenge` (256), `schnorrVerify` (290), `adaptorSign` (313), `presigPoints`
(348), `adaptorVerify` (370), `adaptorVerifyForPoint` (393), `adaptorComplete` (406),
`adaptorExtract` (418), `dlcOutcomePoint` (571); the Rust signer's `adaptor_sign`
(`native/dlc-signer/src/main.rs:355`); the oracle outcome point `outcome_point`
(`native/dlc-signer/src/signing_target.rs:483`) and the sum over the CET's oracle subset
(`signing_target.rs:608-623`); and the JS threshold sum `addPoints` / `combineThresholdAttestations`
(`bitvm3/utxo_referee/dlc_threshold_oracle.js:63,87`).

What the model keeps: the order and content of every guard (zero secret, adaptor point at
infinity, zero nonce, `R0 + T` at infinity, odd-y `R0 + T`, the 64-iteration nonce loop, the
even-y negation of the secret, the parse guards of `presigPoints`, the `lhs`/`rhs` infinity
checks of `adaptorVerify`, the `t·G = T` guard of `adaptorComplete`, the `(s - s0)·G = T` guard
of `adaptorExtract`, the sorted/unique/at-least-two subset checks and the infinity check on the
summed adaptor point).

What the model abstracts:
* Curve arithmetic. Points, scalars, the group and ring laws, scalar multiplication, the
  generator, the x-coordinate map, the y-parity test, `lift_x` and the BIP340 challenge hash are
  the fields of `Curve`. Every field law is a law that secp256k1 satisfies. No cryptographic
  hardness is a field.
* Bytes. Hex parsing, range checks (`rx < p`, `s < n`) and 32-byte encodings are replaced by the
  types `Xc` and `Sc`. A presignature is the record of its parsed fields.
* The nonce hash. The tagged hash that yields the candidate nonce for iteration `counter` is the
  parameter `nonce : Nat → Sc`; every theorem holds for all such sequences. Both
  implementations feed the same inputs (secret masked with the aux hash, signer x, message,
  compressed adaptor point, counter), so the sequence is the same function in both.
* Oracle announcements arrive already verified (`verified_announcement` /
  `verifyDlcOracleAnnouncement`: the announcement's own BIP340 signature is not modelled here).
* Discrete-log hardness. It appears only as hypotheses: `DlogUnique` (an algebraic property of
  the prime-order group, used for the "only if" direction of oracle binding) and `OracleSecrecy`
  (a secrecy assumption about the oracles' nonces and keys, instantiated by the EUF-CMA
  assumption on the oracles' BIP340 keys: an oracle that signs one outcome and never another
  does not leak a signature on the other).
-/

set_option autoImplicit false
set_option linter.unusedSectionVars false
set_option linter.unusedSimpArgs false

namespace UTXORefFormal.Adaptor

/-- Abstract secp256k1: points `Pt` (with the point at infinity `pzero`), scalars `Sc` (integers
mod the group order), x-coordinates `Xc`, and 32-byte messages `Msg`. -/
structure Curve (Pt Sc Xc Msg : Type) where
  -- additive commutative group of points
  padd : Pt → Pt → Pt
  pzero : Pt
  pneg : Pt → Pt
  padd_assoc : ∀ a b c, padd (padd a b) c = padd a (padd b c)
  padd_comm : ∀ a b, padd a b = padd b a
  padd_pzero : ∀ a, padd a pzero = a
  padd_pneg : ∀ a, padd a (pneg a) = pzero
  -- commutative ring of scalars
  sadd : Sc → Sc → Sc
  szero : Sc
  sneg : Sc → Sc
  sone : Sc
  rmul : Sc → Sc → Sc
  sadd_assoc : ∀ a b c, sadd (sadd a b) c = sadd a (sadd b c)
  sadd_comm : ∀ a b, sadd a b = sadd b a
  sadd_szero : ∀ a, sadd a szero = a
  sadd_sneg : ∀ a, sadd a (sneg a) = szero
  rmul_assoc : ∀ a b c, rmul (rmul a b) c = rmul a (rmul b c)
  rmul_comm : ∀ a b, rmul a b = rmul b a
  rmul_sone : ∀ a, rmul a sone = a
  rmul_sadd : ∀ a b c, rmul a (sadd b c) = sadd (rmul a b) (rmul a c)
  -- scalar multiplication
  smul : Sc → Pt → Pt
  smul_sadd : ∀ a b p, smul (sadd a b) p = padd (smul a p) (smul b p)
  smul_padd : ∀ a p q, smul a (padd p q) = padd (smul a p) (smul a q)
  smul_rmul : ∀ a b p, smul (rmul a b) p = smul a (smul b p)
  smul_sone : ∀ p, smul sone p = p
  -- generator and the group order: no nonzero scalar below the order kills G
  G : Pt
  smul_G_ne_zero : ∀ x, x ≠ szero → smul x G ≠ pzero
  -- coordinates
  xOf : Pt → Xc
  hasEvenY : Pt → Bool
  xOf_pneg : ∀ p, xOf (pneg p) = xOf p
  even_pneg : ∀ p, p ≠ pzero → hasEvenY (pneg p) = !hasEvenY p
  /-- A nonzero point with even y is determined by its x-coordinate. -/
  xOf_inj_even : ∀ p q, p ≠ pzero → q ≠ pzero → hasEvenY p = true → hasEvenY q = true →
    xOf p = xOf q → p = q
  /-- `lift_x`: the even-y point with the given x-coordinate, if x is on the curve. -/
  lift : Xc → Option Pt
  lift_spec : ∀ x p, lift x = some p → p ≠ pzero ∧ hasEvenY p = true ∧ xOf p = x
  lift_xOf : ∀ p, p ≠ pzero → hasEvenY p = true → lift (xOf p) = some p
  /-- The BIP340 challenge `int(tagged_hash("BIP0340/challenge", rx || px || m)) mod n`. -/
  chal : Xc → Xc → Msg → Sc

/-- A parsed adaptor presignature (`presigPoints`): effective nonce x `rx`, response `s0`, nonce
point `R0 = (R0x, R0y)` and adaptor point `T = (Tx, Ty)`. -/
structure Presig (Pt Sc Xc : Type) where
  rx : Xc
  s0 : Sc
  R0 : Pt
  T : Pt
  deriving DecidableEq, Repr

/-- A 64-byte BIP340 signature `(rx, s)`. -/
structure Sig (Sc Xc : Type) where
  rx : Xc
  s : Sc
  deriving DecidableEq, Repr

namespace Curve

variable {Pt Sc Xc Msg : Type} (C : Curve Pt Sc Xc Msg)

theorem padd_pzero_left (a : Pt) : C.padd C.pzero a = a := by
  rw [C.padd_comm]; exact C.padd_pzero a

theorem padd_pneg_left (a : Pt) : C.padd (C.pneg a) a = C.pzero := by
  rw [C.padd_comm]; exact C.padd_pneg a

theorem padd_left_cancel {a b c : Pt} (h : C.padd a b = C.padd a c) : b = c := by
  have h2 := congrArg (C.padd (C.pneg a)) h
  rw [← C.padd_assoc, ← C.padd_assoc, C.padd_pneg_left, C.padd_pzero_left,
    C.padd_pzero_left] at h2
  exact h2

theorem padd_right_cancel {a b c : Pt} (h : C.padd b a = C.padd c a) : b = c := by
  rw [C.padd_comm b a, C.padd_comm c a] at h
  exact C.padd_left_cancel h

theorem padd_right_comm (a b c : Pt) : C.padd (C.padd a b) c = C.padd (C.padd a c) b := by
  rw [C.padd_assoc, C.padd_comm b c, ← C.padd_assoc]

theorem pneg_unique {a b : Pt} (h : C.padd a b = C.pzero) : b = C.pneg a :=
  C.padd_left_cancel (h.trans (C.padd_pneg a).symm)

theorem padd_pneg_cancel_right (a b : Pt) : C.padd (C.padd a b) (C.pneg b) = a := by
  rw [C.padd_assoc, C.padd_pneg, C.padd_pzero]

theorem smul_szero (p : Pt) : C.smul C.szero p = C.pzero := by
  have h : C.smul C.szero p = C.padd (C.smul C.szero p) (C.smul C.szero p) := by
    rw [← C.smul_sadd, C.sadd_szero]
  have h2 : C.padd (C.smul C.szero p) C.pzero = C.padd (C.smul C.szero p) (C.smul C.szero p) := by
    rw [C.padd_pzero]; exact h
  exact (C.padd_left_cancel h2).symm

theorem smul_sneg (a : Sc) (p : Pt) : C.smul (C.sneg a) p = C.pneg (C.smul a p) := by
  apply C.pneg_unique
  rw [← C.smul_sadd, C.sadd_sneg, C.smul_szero]

theorem sadd_szero_left (a : Sc) : C.sadd C.szero a = a := by
  rw [C.sadd_comm]; exact C.sadd_szero a

theorem sadd_sneg_left (a : Sc) : C.sadd (C.sneg a) a = C.szero := by
  rw [C.sadd_comm]; exact C.sadd_sneg a

/-- `(s - s0) + s0 = s`. -/
theorem sub_add_cancel (s s0 : Sc) : C.sadd (C.sadd s (C.sneg s0)) s0 = s := by
  rw [C.sadd_assoc, C.sadd_sneg_left, C.sadd_szero]

/-- `(s0 + t) - s0 = t`. -/
theorem add_sub_cancel_left (s0 t : Sc) : C.sadd (C.sadd s0 t) (C.sneg s0) = t := by
  rw [C.sadd_comm s0 t, C.sadd_assoc, C.sadd_sneg, C.sadd_szero]

/-- The point of a sum of scalars is the sum of the points. -/
def ptSum : List Pt → Pt
  | [] => C.pzero
  | p :: ps => C.padd p (ptSum ps)

def scSum : List Sc → Sc
  | [] => C.szero
  | s :: ss => C.sadd s (scSum ss)

end Curve

section Scheme

variable {Pt Sc Xc Msg : Type} [DecidableEq Pt] [DecidableEq Sc] [DecidableEq Xc]
  [DecidableEq Msg] (C : Curve Pt Sc Xc Msg)

/-! ## BIP340 verification (`schnorrVerify`, tradelayer_dlc_adaptor_sig.js:290) -/

/-- `schnorrVerify`: `P = liftX(px)`, `e = challenge(rx, px, m)`, `R = s·G - e·P`, accept iff `R`
is finite, has even y, and `R.x = rx`. -/
def schnorrVerify (px : Xc) (m : Msg) (sig : Sig Sc Xc) : Bool :=
  match C.lift px with
  | none => false
  | some P =>
    let e := C.chal sig.rx px m
    let R := C.padd (C.smul sig.s C.G) (C.pneg (C.smul e P))
    !(decide (R = C.pzero)) && C.hasEvenY R && decide (C.xOf R = sig.rx)

theorem schnorrVerify_iff (px : Xc) (m : Msg) (sig : Sig Sc Xc) :
    schnorrVerify C px m sig = true ↔
      ∃ P, C.lift px = some P ∧
        C.padd (C.smul sig.s C.G) (C.pneg (C.smul (C.chal sig.rx px m) P)) ≠ C.pzero ∧
        C.hasEvenY (C.padd (C.smul sig.s C.G) (C.pneg (C.smul (C.chal sig.rx px m) P))) = true ∧
        C.xOf (C.padd (C.smul sig.s C.G) (C.pneg (C.smul (C.chal sig.rx px m) P))) = sig.rx := by
  unfold schnorrVerify
  cases hl : C.lift px with
  | none => simp
  | some P => simp [and_assoc]

/-- A BIP340 attestation scalar `s` for oracle key `px`, nonce x `rx` and outcome `o` is exactly a
scalar with `s·G = R + e·P` for `R = lift rx`, `P = lift px`, `e = chal rx px o`. -/
theorem schnorrVerify_iff_attests (px rx : Xc) (m : Msg) (s : Sc) :
    schnorrVerify C px m ⟨rx, s⟩ = true ↔
      ∃ P R, C.lift px = some P ∧ C.lift rx = some R ∧
        C.smul s C.G = C.padd R (C.smul (C.chal rx px m) P) := by
  rw [schnorrVerify_iff]
  constructor
  · rintro ⟨P, hP, hne, hev, hx⟩
    have hl := C.lift_xOf _ hne hev
    rw [hx] at hl
    refine ⟨P, _, hP, hl, ?_⟩
    rw [C.padd_assoc, C.padd_pneg_left, C.padd_pzero]
  · rintro ⟨P, R, hP, hR, h⟩
    obtain ⟨hne, hev, hx⟩ := C.lift_spec _ _ hR
    have hR' : C.padd (C.smul s C.G) (C.pneg (C.smul (C.chal rx px m) P)) = R := by
      rw [h]; exact C.padd_pneg_cancel_right _ _
    refine ⟨P, hP, ?_, ?_, ?_⟩ <;> rw [hR']
    · exact hne
    · exact hev
    · exact hx

/-! ## Presignature parsing and verification (`presigPoints`, `adaptorVerify`) -/

/-- The parse guards of `presigPoints` (line 348): both points pass `requirePoint`, which rejects
the point at infinity. (Field ranges and the `kind` tag are carried by the types.) -/
def parseOk (ps : Presig Pt Sc Xc) : Bool :=
  !(decide (ps.R0 = C.pzero)) && !(decide (ps.T = C.pzero))

theorem parseOk_iff (ps : Presig Pt Sc Xc) :
    parseOk C ps = true ↔ ps.R0 ≠ C.pzero ∧ ps.T ≠ C.pzero := by
  simp [parseOk]

/-- `adaptorVerify` (line 370). -/
def adaptorVerify (px : Xc) (m : Msg) (ps : Presig Pt Sc Xc) : Bool :=
  match C.lift px with
  | none => false
  | some P =>
    let Rp := C.padd ps.R0 ps.T
    let e := C.chal (C.xOf Rp) px m
    let lhs := C.smul ps.s0 C.G
    let rhs := C.padd ps.R0 (C.smul e P)
    parseOk C ps &&
    !(decide (Rp = C.pzero)) && C.hasEvenY Rp && decide (C.xOf Rp = ps.rx) &&
    !(decide (lhs = C.pzero)) && !(decide (rhs = C.pzero)) && decide (lhs = rhs)

theorem adaptorVerify_iff (px : Xc) (m : Msg) (ps : Presig Pt Sc Xc) :
    adaptorVerify C px m ps = true ↔
      ∃ P, C.lift px = some P ∧ (ps.R0 ≠ C.pzero ∧ ps.T ≠ C.pzero) ∧
        (C.padd ps.R0 ps.T ≠ C.pzero ∧ C.hasEvenY (C.padd ps.R0 ps.T) = true ∧
          C.xOf (C.padd ps.R0 ps.T) = ps.rx) ∧
        (C.smul ps.s0 C.G ≠ C.pzero ∧
          C.padd ps.R0 (C.smul (C.chal ps.rx px m) P) ≠ C.pzero ∧
          C.smul ps.s0 C.G = C.padd ps.R0 (C.smul (C.chal ps.rx px m) P)) := by
  unfold adaptorVerify
  cases hl : C.lift px with
  | none => simp
  | some P =>
    simp only [Bool.and_eq_true, Bool.not_eq_true', decide_eq_false_iff_not,
      decide_eq_true_eq, parseOk_iff, Option.some.injEq, exists_eq_left']
    constructor
    · rintro ⟨⟨⟨⟨⟨⟨hp, hRp⟩, hev⟩, hx⟩, hl⟩, hr⟩, heq⟩
      rw [hx] at hr heq
      exact ⟨hp, ⟨hRp, hev, hx⟩, hl, hr, heq⟩
    · rintro ⟨hp, ⟨hRp, hev, hx⟩, hl, hr, heq⟩
      rw [← hx] at hr heq
      exact ⟨⟨⟨⟨⟨⟨hp, hRp⟩, hev⟩, hx⟩, hl⟩, hr⟩, heq⟩

/-- `adaptorVerifyForPoint` (line 393): the carried adaptor point must equal the expected one. -/
def adaptorVerifyForPoint (px : Xc) (m : Msg) (ps : Presig Pt Sc Xc) (expected : Pt) : Bool :=
  decide (ps.T = expected) && adaptorVerify C px m ps

theorem adaptorVerifyForPoint_iff (px : Xc) (m : Msg) (ps : Presig Pt Sc Xc) (T : Pt) :
    adaptorVerifyForPoint C px m ps T = true ↔ ps.T = T ∧ adaptorVerify C px m ps = true := by
  simp [adaptorVerifyForPoint]

/-! ## Even-y secret and the nonce loop (`adaptorSign`, `adaptor_sign`) -/

/-- `d = hasEvenY(d0·G) ? d0 : N - d0` (JS line 318; Rust `if public_y[31] & 1 == 1 { -secret }`). -/
def evenSecret (x : Sc) : Sc := if C.hasEvenY (C.smul x C.G) then x else C.sneg x

theorem pneg_ne_pzero {q : Pt} (h : q ≠ C.pzero) : C.pneg q ≠ C.pzero := by
  intro h0
  apply h
  have := C.padd_pneg q
  rw [h0, C.padd_pzero] at this
  exact this

/-- For a valid secret the even-y secret's public point is nonzero, has even y, shares the
x-coordinate of `x·G`, and is what `liftX(x-only pubkey)` returns. -/
theorem evenSecret_point {x : Sc} (hx : x ≠ C.szero) :
    C.smul (evenSecret C x) C.G ≠ C.pzero ∧
    C.hasEvenY (C.smul (evenSecret C x) C.G) = true ∧
    C.xOf (C.smul (evenSecret C x) C.G) = C.xOf (C.smul x C.G) ∧
    C.lift (C.xOf (C.smul x C.G)) = some (C.smul (evenSecret C x) C.G) := by
  have hq := C.smul_G_ne_zero x hx
  by_cases he : C.hasEvenY (C.smul x C.G) = true
  · have hd : evenSecret C x = x := by simp [evenSecret, he]
    rw [hd]
    exact ⟨hq, he, rfl, C.lift_xOf _ hq he⟩
  · have hf : C.hasEvenY (C.smul x C.G) = false := by simpa using he
    have hd : evenSecret C x = C.sneg x := by simp [evenSecret, hf]
    rw [hd, C.smul_sneg]
    have hn := pneg_ne_pzero C hq
    have hev : C.hasEvenY (C.pneg (C.smul x C.G)) = true := by
      rw [C.even_pneg _ hq, hf]; rfl
    have hxo : C.xOf (C.pneg (C.smul x C.G)) = C.xOf (C.smul x C.G) := C.xOf_pneg _
    refine ⟨hn, hev, hxo, ?_⟩
    rw [← hxo]
    exact C.lift_xOf _ hn hev

/-- One pass of the nonce loop with candidate nonce `k0` (JS lines 326-344; Rust lines 376-401):
reject a zero nonce, reject `R0 + T` at infinity, reject odd-y `R0 + T`, otherwise return the
presignature with `s0 = k0 + e·d`. -/
def adaptorSignStep (x : Sc) (m : Msg) (T : Pt) (k0 : Sc) : Option (Presig Pt Sc Xc) :=
  if k0 = C.szero then none else
  if C.padd (C.smul k0 C.G) T = C.pzero then none else
  if C.hasEvenY (C.padd (C.smul k0 C.G) T) = false then none else
  some { rx := C.xOf (C.padd (C.smul k0 C.G) T)
         s0 := C.sadd k0 (C.rmul (C.chal (C.xOf (C.padd (C.smul k0 C.G) T))
                  (C.xOf (C.smul x C.G)) m) (evenSecret C x))
         R0 := C.smul k0 C.G
         T := T }

/-- `adaptorSign` (JS line 313): guards on the secret and on `T`, then the first successful pass
of at most 64 iterations; `nonce c` is the candidate nonce hash for counter `c`. -/
def adaptorSign (x : Sc) (m : Msg) (T : Pt) (nonce : Nat → Sc) : Option (Presig Pt Sc Xc) :=
  if x = C.szero ∨ T = C.pzero then none else
  (List.range 64).findSome? (fun c => adaptorSignStep C x m T (nonce c))

theorem adaptorSignStep_some {x : Sc} {m : Msg} {T : Pt} {k0 : Sc} {ps : Presig Pt Sc Xc}
    (h : adaptorSignStep C x m T k0 = some ps) :
    k0 ≠ C.szero ∧ C.padd (C.smul k0 C.G) T ≠ C.pzero ∧
    C.hasEvenY (C.padd (C.smul k0 C.G) T) = true ∧
    ps = { rx := C.xOf (C.padd (C.smul k0 C.G) T)
           s0 := C.sadd k0 (C.rmul (C.chal (C.xOf (C.padd (C.smul k0 C.G) T))
                  (C.xOf (C.smul x C.G)) m) (evenSecret C x))
           R0 := C.smul k0 C.G
           T := T } := by
  unfold adaptorSignStep at h
  by_cases h1 : k0 = C.szero
  · simp [h1] at h
  · by_cases h2 : C.padd (C.smul k0 C.G) T = C.pzero
    · simp [h1, h2] at h
    · by_cases h3 : C.hasEvenY (C.padd (C.smul k0 C.G) T) = false
      · simp [h1, h2, h3] at h
      · have h3' : C.hasEvenY (C.padd (C.smul k0 C.G) T) = true := by simpa using h3
        simp only [h1, h2, h3, ite_false] at h
        exact ⟨h1, h2, h3', (Option.some.inj h).symm⟩

theorem adaptorSign_some {x : Sc} {m : Msg} {T : Pt} {nonce : Nat → Sc}
    {ps : Presig Pt Sc Xc} (h : adaptorSign C x m T nonce = some ps) :
    x ≠ C.szero ∧ T ≠ C.pzero ∧ ∃ c, c < 64 ∧ adaptorSignStep C x m T (nonce c) = some ps := by
  unfold adaptorSign at h
  by_cases hg : x = C.szero ∨ T = C.pzero
  · simp [hg] at h
  · simp only [hg, ite_false] at h
    obtain ⟨c, hc, hs⟩ := List.exists_of_findSome?_eq_some h
    refine ⟨fun hx => hg (Or.inl hx), fun hT => hg (Or.inr hT), c, ?_, hs⟩
    simpa using hc

/-! ### (a) Completeness -/

/-- The presignature's own invariants after signing: `R0 = k0·G`, `T` is the input point,
`rx` is the x-coordinate of the even-y point `R0 + T`, and `s0·G = R0 + e·(d·G)`. -/
theorem adaptorSign_equation {x : Sc} {m : Msg} {T : Pt} {nonce : Nat → Sc}
    {ps : Presig Pt Sc Xc} (h : adaptorSign C x m T nonce = some ps) :
    ps.T = T ∧ ps.R0 ≠ C.pzero ∧ C.padd ps.R0 ps.T ≠ C.pzero ∧
    C.hasEvenY (C.padd ps.R0 ps.T) = true ∧ C.xOf (C.padd ps.R0 ps.T) = ps.rx ∧
    C.smul ps.s0 C.G =
      C.padd ps.R0 (C.smul (C.chal ps.rx (C.xOf (C.smul x C.G)) m) (C.smul (evenSecret C x) C.G)) := by
  obtain ⟨hx, hT, c, _, hs⟩ := adaptorSign_some C h
  obtain ⟨hk, hRp, hev, hps⟩ := adaptorSignStep_some C hs
  subst hps
  refine ⟨rfl, C.smul_G_ne_zero _ hk, hRp, hev, rfl, ?_⟩
  show C.smul (C.sadd _ (C.rmul _ _)) C.G = _
  rw [C.smul_sadd, C.smul_rmul]

/-- (a) Completeness. A presignature produced by `adaptorSign` for secret `x`, message `m` and
point `T` passes `adaptorVerify` for the x-only key of `x·G` (the even-y point `d·G`) exactly
when its response is nonzero. The code does not reject `s0 = 0` at signing time; the
verifier rejects it (`lhs` at infinity). That event needs `k0 + e·d = 0 (mod n)`. -/
theorem adaptorSign_verify_iff {x : Sc} {m : Msg} {T : Pt} {nonce : Nat → Sc}
    {ps : Presig Pt Sc Xc} (h : adaptorSign C x m T nonce = some ps) :
    adaptorVerify C (C.xOf (C.smul x C.G)) m ps = true ↔ ps.s0 ≠ C.szero := by
  obtain ⟨hx, hT, _⟩ := adaptorSign_some C h
  obtain ⟨hpT, hR0, hRp, hev, hxo, hs⟩ := adaptorSign_equation C h
  obtain ⟨hdn, hde, hdx, hdl⟩ := evenSecret_point C hx
  rw [adaptorVerify_iff]
  constructor
  · rintro ⟨P, hP, _, _, ⟨hl0, _, _⟩⟩ hz
    apply hl0
    rw [hz, C.smul_szero]
  · intro hz
    have hl0 := C.smul_G_ne_zero _ hz
    refine ⟨_, hdl, ⟨hR0, hpT ▸ hT⟩, ⟨hRp, hev, hxo⟩, ⟨hl0, ?_, hs⟩⟩
    rw [← hs]
    exact hl0

theorem adaptorSign_verifies {x : Sc} {m : Msg} {T : Pt} {nonce : Nat → Sc}
    {ps : Presig Pt Sc Xc} (h : adaptorSign C x m T nonce = some ps) (hs0 : ps.s0 ≠ C.szero) :
    adaptorVerify C (C.xOf (C.smul x C.G)) m ps = true ∧
    adaptorVerifyForPoint C (C.xOf (C.smul x C.G)) m ps T = true := by
  have hv := (adaptorSign_verify_iff C h).2 hs0
  refine ⟨hv, ?_⟩
  rw [adaptorVerifyForPoint_iff]
  exact ⟨(adaptorSign_equation C h).1, hv⟩

/-! ### The Rust signer's loop is the same loop

`adaptor_sign` (main.rs:355) runs `for counter in 0u8..64` with `continue` on the three
rejection conditions and `return Ok(..)` on the first success. -/

def rustLoop (x : Sc) (m : Msg) (T : Pt) (nonce : Nat → Sc) :
    Nat → Nat → Option (Presig Pt Sc Xc)
  | 0, _ => none
  | n + 1, c =>
    match adaptorSignStep C x m T (nonce c) with
    | some ps => some ps
    | none => rustLoop x m T nonce n (c + 1)

theorem rustLoop_eq_findSome (x : Sc) (m : Msg) (T : Pt) (nonce : Nat → Sc) (n c : Nat) :
    rustLoop C x m T nonce n c =
      (List.range' c n).findSome? (fun c => adaptorSignStep C x m T (nonce c)) := by
  induction n generalizing c with
  | zero => simp [rustLoop]
  | succ n ih =>
    rw [List.range'_succ, List.findSome?_cons, rustLoop]
    cases adaptorSignStep C x m T (nonce c) with
    | some ps => rfl
    | none => simpa using ih (c + 1)

/-- `adaptor_sign` as the Rust code runs it: the secret is nonzero (`scalar_from_bytes`), the
adaptor point parses to a finite curve point (`parse_point` rejects the encoding of infinity),
then the 64-iteration loop. -/
def rustAdaptorSign (x : Sc) (m : Msg) (T : Pt) (nonce : Nat → Sc) :
    Option (Presig Pt Sc Xc) :=
  if x = C.szero ∨ T = C.pzero then none else rustLoop C x m T nonce 64 0

theorem rust_adaptorSign_eq_js (x : Sc) (m : Msg) (T : Pt) (nonce : Nat → Sc) :
    rustAdaptorSign C x m T nonce = adaptorSign C x m T nonce := by
  unfold rustAdaptorSign adaptorSign
  by_cases hg : x = C.szero ∨ T = C.pzero
  · simp [hg]
  · simp only [hg, ite_false]
    rw [rustLoop_eq_findSome, List.range_eq_range']

/-! ## (b) Completion (`adaptorComplete`, line 406) -/

/-- The completed signature `(rx, s0 + t)`. -/
def completeRaw (ps : Presig Pt Sc Xc) (t : Sc) : Sig Sc Xc := ⟨ps.rx, C.sadd ps.s0 t⟩

/-- `adaptorComplete`: `t` in `1..n-1`, parsed presignature, and `t·G` a finite point equal to
`T`; then `(rx, s0 + t)`. -/
def adaptorComplete (ps : Presig Pt Sc Xc) (t : Sc) : Option (Sig Sc Xc) :=
  if t = C.szero then none else
  if parseOk C ps = false then none else
  if C.smul t C.G = C.pzero ∨ C.smul t C.G ≠ ps.T then none else
  some (completeRaw C ps t)

theorem adaptorComplete_eq_some_iff {ps : Presig Pt Sc Xc} (hp : parseOk C ps = true) (t : Sc)
    (sig : Sig Sc Xc) :
    adaptorComplete C ps t = some sig ↔ C.smul t C.G = ps.T ∧ sig = completeRaw C ps t := by
  obtain ⟨_, hT⟩ := (parseOk_iff C ps).1 hp
  by_cases h1 : t = C.szero
  · have hc : adaptorComplete C ps t = none := by
      unfold adaptorComplete; simp [h1]
    rw [hc]
    constructor
    · intro h; exact absurd h (by simp)
    · rintro ⟨h, _⟩
      rw [h1, C.smul_szero] at h
      exact absurd h.symm hT
  · by_cases h2 : C.smul t C.G = ps.T
    · have h3 : C.smul t C.G ≠ C.pzero := C.smul_G_ne_zero t h1
      have hc : adaptorComplete C ps t = some (completeRaw C ps t) := by
        unfold adaptorComplete; simp [h1, hp, h2, hT]
      rw [hc]
      constructor
      · intro h; exact ⟨h2, (Option.some.inj h).symm⟩
      · rintro ⟨_, rfl⟩; rfl
    · have hc : adaptorComplete C ps t = none := by
        unfold adaptorComplete; simp [h1, hp, h2]
      rw [hc]
      constructor
      · intro h; exact absurd h (by simp)
      · rintro ⟨h, _⟩; exact absurd h h2

/-- Main algebraic step: for a presignature that passes `adaptorVerify`, the completed signature
`(rx, s0 + t)` is a BIP340 signature exactly when `t·G = T`. -/
theorem complete_verifies_iff {px : Xc} {m : Msg} {ps : Presig Pt Sc Xc}
    (hv : adaptorVerify C px m ps = true) (t : Sc) :
    schnorrVerify C px m (completeRaw C ps t) = true ↔ C.smul t C.G = ps.T := by
  obtain ⟨P, hl, _, ⟨hRp, hev, hxo⟩, ⟨_, _, heq⟩⟩ := (adaptorVerify_iff C px m ps).1 hv
  rw [schnorrVerify_iff]
  -- the recovered nonce point is R0 + t·G
  have hR' : C.padd (C.smul (C.sadd ps.s0 t) C.G)
      (C.pneg (C.smul (C.chal ps.rx px m) P)) = C.padd ps.R0 (C.smul t C.G) := by
    rw [C.smul_sadd, heq, C.padd_right_comm, C.padd_pneg_cancel_right]
  simp only [completeRaw]
  constructor
  · rintro ⟨P', hP', hne, hev', hx'⟩
    rw [hl] at hP'
    obtain rfl := Option.some.inj hP'
    rw [hR'] at hne hev' hx'
    have hpt := C.xOf_inj_even _ _ hne hRp hev' hev (hx'.trans hxo.symm)
    exact C.padd_left_cancel hpt
  · intro ht
    refine ⟨P, hl, ?_, ?_, ?_⟩ <;> rw [hR', ht]
    · exact hRp
    · exact hev
    · exact hxo

/-- (b) as the code states it, both directions: for a presignature that passes
`adaptorVerifyForPoint` with point `T`, the scalar `t` completes it to a signature that passes
`schnorrVerify` on `m` iff `t·G = T`; `adaptorComplete` returns that signature exactly when
`t·G = T`, and rejects every other `t`. -/
theorem adaptorComplete_iff {px : Xc} {m : Msg} {ps : Presig Pt Sc Xc} {T : Pt}
    (hv : adaptorVerifyForPoint C px m ps T = true) (t : Sc) :
    (C.smul t C.G = T ↔ schnorrVerify C px m (completeRaw C ps t) = true) ∧
    (C.smul t C.G = T ↔ adaptorComplete C ps t = some (completeRaw C ps t)) := by
  obtain ⟨hT, hv'⟩ := (adaptorVerifyForPoint_iff C px m ps T).1 hv
  obtain ⟨_, _, hpT, _, _⟩ := (adaptorVerify_iff C px m ps).1 hv'
  have hp : parseOk C ps = true := (parseOk_iff C ps).2 hpT
  refine ⟨?_, ?_⟩
  · rw [complete_verifies_iff C hv', hT]
  · rw [adaptorComplete_eq_some_iff C hp, hT]
    simp

/-- A presignature is not itself a signature: `(rx, s0)` fails `schnorrVerify` (test
"adaptor pre-signature is not a valid signature on its own"). -/
theorem presig_not_signature {px : Xc} {m : Msg} {ps : Presig Pt Sc Xc}
    (hv : adaptorVerify C px m ps = true) :
    schnorrVerify C px m ⟨ps.rx, ps.s0⟩ = false := by
  have h := complete_verifies_iff C hv C.szero
  have hz : completeRaw C ps C.szero = ⟨ps.rx, ps.s0⟩ := by
    simp [completeRaw, C.sadd_szero]
  rw [hz] at h
  obtain ⟨_, _, ⟨_, hT⟩, _, _⟩ := (adaptorVerify_iff C px m ps).1 hv
  cases hb : schnorrVerify C px m ⟨ps.rx, ps.s0⟩
  · rfl
  · exfalso
    apply hT
    rw [← h.1 hb, C.smul_szero]

/-! ## (c) Extraction (`adaptorExtract`, line 418) -/

/-- `adaptorExtract`: the presignature and the signature both verify, `ex = s - s0`, and
`ex·G` is finite and equals `T`. -/
def adaptorExtract (px : Xc) (m : Msg) (ps : Presig Pt Sc Xc) (sig : Sig Sc Xc) : Option Sc :=
  if adaptorVerify C px m ps = false then none else
  if schnorrVerify C px m sig = false then none else
  if C.smul (C.sadd sig.s (C.sneg ps.s0)) C.G = C.pzero ∨
     C.smul (C.sadd sig.s (C.sneg ps.s0)) C.G ≠ ps.T then none else
  some (C.sadd sig.s (C.sneg ps.s0))

/-- (c), soundness: whatever `adaptorExtract` returns satisfies `t·G = T`. -/
theorem adaptorExtract_sound {px : Xc} {m : Msg} {ps : Presig Pt Sc Xc} {sig : Sig Sc Xc}
    {t : Sc} (h : adaptorExtract C px m ps sig = some t) :
    C.smul t C.G = ps.T ∧ adaptorVerify C px m ps = true ∧ schnorrVerify C px m sig = true := by
  unfold adaptorExtract at h
  by_cases h1 : adaptorVerify C px m ps = false
  · simp [h1] at h
  · by_cases h2 : schnorrVerify C px m sig = false
    · simp [h1, h2] at h
    · by_cases h3 : C.smul (C.sadd sig.s (C.sneg ps.s0)) C.G = C.pzero ∨
          C.smul (C.sadd sig.s (C.sneg ps.s0)) C.G ≠ ps.T
      · simp only [h1, h2, h3, ite_true, ite_false] at h
        exact absurd h (by simp)
      · simp only [h1, h2, h3, ite_false] at h
        have ht := (Option.some.inj h).symm
        subst ht
        have h3' := not_or.1 h3
        exact ⟨Classical.not_not.1 h3'.2, by simpa using h1, by simpa using h2⟩

/-- (c) For a passing presignature and a passing signature on the same message that carries the
presignature's nonce `rx` (that is, a completion of it), `adaptorExtract` returns `s - s0`, and
that scalar satisfies `t·G = T`. -/
theorem adaptorExtract_of_completed {px : Xc} {m : Msg} {ps : Presig Pt Sc Xc}
    {sig : Sig Sc Xc} (hv : adaptorVerify C px m ps = true)
    (hs : schnorrVerify C px m sig = true) (hrx : sig.rx = ps.rx) :
    adaptorExtract C px m ps sig = some (C.sadd sig.s (C.sneg ps.s0)) ∧
    C.smul (C.sadd sig.s (C.sneg ps.s0)) C.G = ps.T := by
  obtain ⟨P, hl, ⟨_, hT⟩, ⟨hRp, hev, hxo⟩, ⟨_, _, heq⟩⟩ := (adaptorVerify_iff C px m ps).1 hv
  obtain ⟨P', hP', hne, hev', hx'⟩ := (schnorrVerify_iff C px m sig).1 hs
  rw [hl] at hP'
  obtain rfl := Option.some.inj hP'
  rw [hrx] at hne hev' hx'
  -- the signature's nonce point is R0 + T
  have hpt := C.xOf_inj_even _ _ hne hRp hev' hev (hx'.trans hxo.symm)
  have hsG : C.smul sig.s C.G =
      C.padd (C.padd ps.R0 ps.T) (C.smul (C.chal ps.rx px m) P) := by
    rw [← hpt, C.padd_assoc, C.padd_pneg_left, C.padd_pzero]
  have hu : C.smul (C.sadd sig.s (C.sneg ps.s0)) C.G = ps.T := by
    have h1 : C.padd (C.smul (C.sadd sig.s (C.sneg ps.s0)) C.G) (C.smul ps.s0 C.G) =
        C.smul sig.s C.G := by
      rw [← C.smul_sadd, C.sub_add_cancel]
    rw [hsG, heq] at h1
    -- u + (R0 + eP) = (R0 + T) + eP = T + (R0 + eP)
    have h2 : C.padd (C.padd ps.R0 ps.T) (C.smul (C.chal ps.rx px m) P) =
        C.padd ps.T (C.padd ps.R0 (C.smul (C.chal ps.rx px m) P)) := by
      rw [C.padd_comm ps.R0 ps.T, C.padd_assoc]
    rw [h2] at h1
    exact C.padd_right_cancel h1
  have hnz : C.smul (C.sadd sig.s (C.sneg ps.s0)) C.G ≠ C.pzero := by
    rw [hu]; exact hT
  refine ⟨?_, hu⟩
  unfold adaptorExtract
  simp [hv, hs, hu, hT]

/-- (c) Round trip: completing with `t` (where `t·G = T`) and then extracting returns `t`
(test "completing the adaptor reveals the oracle scalar (extractable)"). -/
theorem adaptorExtract_complete {px : Xc} {m : Msg} {ps : Presig Pt Sc Xc} {T : Pt}
    (hv : adaptorVerifyForPoint C px m ps T = true) {t : Sc} (ht : C.smul t C.G = T) :
    adaptorExtract C px m ps (completeRaw C ps t) = some t := by
  have hv' := ((adaptorVerifyForPoint_iff C px m ps T).1 hv).2
  have hs := ((adaptorComplete_iff C hv t).1.1 ht)
  obtain ⟨he, _⟩ := adaptorExtract_of_completed C hv' hs rfl
  have : C.sadd (completeRaw C ps t).s (C.sneg ps.s0) = t := by
    show C.sadd (C.sadd ps.s0 t) (C.sneg ps.s0) = t
    exact C.add_sub_cancel_left _ _
  rw [this] at he
  exact he

/-! ## (d) Oracle outcome points and the CET adaptor point -/

/-- A verified oracle announcement: x-only key, x-only nonce, committed outcome set. -/
structure Ann (Xc Msg : Type) where
  px : Xc
  rx : Xc
  outcomes : List Msg

/-- `outcome_point` (signing_target.rs:483) / `dlcOutcomePoint` (JS line 571):
`lift_x(rx) + e·lift_x(px)` with `e = challenge(rx, px, o)`, after the committed-outcome check. -/
def outcomePoint (a : Ann Xc Msg) (o : Msg) : Option Pt :=
  if decide (o ∈ a.outcomes) = false then none else
  match C.lift a.rx, C.lift a.px with
  | some R, some P => some (C.padd R (C.smul (C.chal a.rx a.px o) P))
  | _, _ => none

/-- The same expression as a total function (`pzero` when a key does not lift). -/
def rawOutcome (o : Msg) (a : Ann Xc Msg) : Pt :=
  match C.lift a.rx, C.lift a.px with
  | some R, some P => C.padd R (C.smul (C.chal a.rx a.px o) P)
  | _, _ => C.pzero

theorem outcomePoint_some {a : Ann Xc Msg} {o : Msg} {q : Pt}
    (h : outcomePoint C a o = some q) :
    o ∈ a.outcomes ∧ q = rawOutcome C o a ∧ ∃ R P, C.lift a.rx = some R ∧ C.lift a.px = some P := by
  unfold outcomePoint at h
  by_cases h1 : decide (o ∈ a.outcomes) = false
  · simp [h1] at h
  · have h1' : o ∈ a.outcomes := by simpa using h1
    simp only [h1, ite_false] at h
    unfold rawOutcome
    cases hr : C.lift a.rx <;> cases hp : C.lift a.px <;> simp [hr, hp] at h ⊢
    · exact ⟨h1', h.symm⟩
    -- (unreachable branches closed by simp)

/-- The CET oracle-subset sum (signing_target.rs:608-623): each key must be strictly greater than
the previous one (`lt` is the byte order on x-only keys; `previous >= key` is an error), found in
the announcement set, and contribute an outcome point; the points are added from the identity. -/
def sortViolation (lt : Xc → Xc → Bool) (prev : Option Xc) (k : Xc) : Bool :=
  match prev with
  | some p => !(lt p k)
  | none => false

def cetFold (anns : List (Ann Xc Msg)) (lt : Xc → Xc → Bool) (o : Msg) :
    Option Xc → Pt → List Xc → Option Pt
  | _, acc, [] => some acc
  | prev, acc, k :: ks =>
    if sortViolation lt prev k = true then none else
    match anns.find? (fun a => decide (a.px = k)) with
    | none => none
    | some a =>
      match outcomePoint C a o with
      | none => none
      | some q => cetFold anns lt o (some k) (C.padd acc q) ks

/-- The adaptor point of a CET with outcome `o` and oracle subset `subset`: at least two
oracles, sorted and unique, then the sum, which must not be the point at infinity. -/
def cetPoint (anns : List (Ann Xc Msg)) (lt : Xc → Xc → Bool) (o : Msg) (subset : List Xc) :
    Option Pt :=
  if subset.length < 2 then none else
  match cetFold C anns lt o none C.pzero subset with
  | none => none
  | some T => if T = C.pzero then none else some T

theorem cetFold_spec (anns : List (Ann Xc Msg)) (lt : Xc → Xc → Bool) (o : Msg) :
    ∀ (ks : List Xc) (prev : Option Xc) (acc T : Pt),
      cetFold C anns lt o prev acc ks = some T →
      ∃ sel : List (Ann Xc Msg), sel.map (·.px) = ks ∧ (∀ a ∈ sel, a ∈ anns) ∧
        (∀ a ∈ sel, o ∈ a.outcomes ∧ ∃ R P, C.lift a.rx = some R ∧ C.lift a.px = some P) ∧
        T = C.padd acc (C.ptSum (sel.map (rawOutcome C o))) := by
  intro ks
  induction ks with
  | nil =>
    intro prev acc T h
    simp only [cetFold, Option.some.injEq] at h
    subst h
    exact ⟨[], rfl, by simp, by simp, by simp [Curve.ptSum, C.padd_pzero]⟩
  | cons k ks ih =>
    intro prev acc T h
    unfold cetFold at h
    by_cases hb : sortViolation lt prev k = true
    · simp only [hb, ite_true] at h; exact absurd h (by simp)
    · simp only [hb, ite_false] at h
      cases hf : anns.find? (fun a => decide (a.px = k)) with
      | none => simp [hf] at h
      | some a =>
        simp only [hf] at h
        cases hq : outcomePoint C a o with
        | none => simp [hq] at h
        | some q =>
          simp only [hq] at h
          obtain ⟨sel, hk, hmem, hspec, hT⟩ := ih (some k) (C.padd acc q) T h
          obtain ⟨hout, hqr, hlifts⟩ := outcomePoint_some C hq
          have hpx : a.px = k := by
            have := List.find?_some hf
            simpa using this
          have hmemA : a ∈ anns := List.mem_of_find?_eq_some hf
          refine ⟨a :: sel, ?_, ?_, ?_, ?_⟩
          · simp [hk, hpx]
          · intro b hb'
            rcases List.mem_cons.1 hb' with rfl | hb'
            · exact hmemA
            · exact hmem b hb'
          · intro b hb'
            rcases List.mem_cons.1 hb' with rfl | hb'
            · exact ⟨hout, hlifts⟩
            · exact hspec b hb'
          · rw [hT, hqr]
            simp only [List.map_cons, Curve.ptSum]
            rw [← C.padd_assoc]

/-- `rawOutcome` of an attested announcement is `s·G`. -/
theorem rawOutcome_of_attests {a : Ann Xc Msg} {o : Msg} {s : Sc}
    (h : schnorrVerify C a.px o ⟨a.rx, s⟩ = true) :
    rawOutcome C o a = C.smul s C.G := by
  obtain ⟨P, R, hP, hR, heq⟩ := (schnorrVerify_iff_attests C a.px a.rx o s).1 h
  unfold rawOutcome
  rw [hR, hP]
  exact heq.symm

/-- `ss` are valid BIP340 attestation scalars for outcome `o`, one per selected announcement. -/
inductive Attests (o : Msg) : List (Ann Xc Msg) → List Sc → Prop
  | nil : Attests o [] []
  | cons (a : Ann Xc Msg) (s : Sc) (sel : List (Ann Xc Msg)) (ss : List Sc) :
      schnorrVerify C a.px o ⟨a.rx, s⟩ = true → Attests o sel ss →
      Attests o (a :: sel) (s :: ss)

theorem smul_scSum (ss : List Sc) :
    C.smul (C.scSum ss) C.G = C.ptSum (ss.map (fun s => C.smul s C.G)) := by
  induction ss with
  | nil => simp [Curve.scSum, Curve.ptSum, C.smul_szero]
  | cons s ss ih => simp [Curve.scSum, Curve.ptSum, C.smul_sadd, ih]

/-- Sum of the outcome points equals the point of the summed attestation scalars. -/
theorem ptSum_rawOutcome_of_attests {o : Msg} :
    ∀ {sel : List (Ann Xc Msg)} {ss : List Sc}, Attests C o sel ss →
      C.ptSum (sel.map (rawOutcome C o)) = C.smul (C.scSum ss) C.G := by
  intro sel ss h
  induction h with
  | nil => simp [Curve.ptSum, Curve.scSum, C.smul_szero]
  | cons a s sel ss hs _ ih =>
    simp only [List.map_cons, Curve.ptSum, Curve.scSum, C.smul_sadd]
    rw [rawOutcome_of_attests C hs, ih]

/-- Discrete-log uniqueness in the prime-order group: `s ↦ s·G` is injective. This is a property
of the group, not of the signature scheme; it is used only for the "only if" directions. -/
def DlogUnique : Prop := ∀ a b : Sc, C.smul a C.G = C.smul b C.G → a = b

/-- (d) Oracle binding. If `cetPoint` returns `T`, then `T` is the sum of the outcome points of
the selected announcements, and for every list `ss` of valid BIP340 attestation scalars for `o`
by those oracles, `(Σ s_i)·G = T`. The selected announcements are in the announcement set, commit
to `o`, have the keys of `subset` in order, and `T` is finite. -/
theorem cet_point_binding {anns : List (Ann Xc Msg)} {lt : Xc → Xc → Bool} {o : Msg}
    {subset : List Xc} {T : Pt} (h : cetPoint C anns lt o subset = some T) :
    ∃ sel : List (Ann Xc Msg), sel.map (·.px) = subset ∧ (∀ a ∈ sel, a ∈ anns) ∧
      (∀ a ∈ sel, o ∈ a.outcomes) ∧ 2 ≤ subset.length ∧ T ≠ C.pzero ∧
      T = C.ptSum (sel.map (rawOutcome C o)) ∧
      ∀ ss, Attests C o sel ss → C.smul (C.scSum ss) C.G = T := by
  unfold cetPoint at h
  by_cases hl : subset.length < 2
  · simp only [hl, ite_true] at h; exact absurd h (by simp)
  · simp only [hl, ite_false] at h
    cases hf : cetFold C anns lt o none C.pzero subset with
    | none => rw [hf] at h; exact absurd h (by simp)
    | some T' =>
      rw [hf] at h
      by_cases hz : T' = C.pzero
      · simp only [hz, ite_true] at h; exact absurd h (by simp)
      · simp only [hz, ite_false] at h
        have hT := Option.some.inj h
        subst hT
        obtain ⟨sel, hk, hmem, hspec, hsum⟩ := cetFold_spec C anns lt o subset none C.pzero T' hf
        rw [C.padd_pzero_left] at hsum
        refine ⟨sel, hk, hmem, fun a ha => (hspec a ha).1, by omega, hz, hsum, ?_⟩
        intro ss hss
        rw [← ptSum_rawOutcome_of_attests C hss]
        exact hsum.symm

/-- (d) A completing scalar for the CET of outcome `o` is exactly a sum of valid BIP340
attestation scalars for `o`: the "if" direction is unconditional; the "only if" direction uses
`DlogUnique`. -/
theorem completing_scalar_iff {sel : List (Ann Xc Msg)} {ss : List Sc} {o : Msg} {T : Pt}
    (hatt : Attests C o sel ss) (hT : T = C.ptSum (sel.map (rawOutcome C o)))
    (hdl : DlogUnique C) (t : Sc) :
    C.smul t C.G = T ↔ t = C.scSum ss := by
  rw [hT, ptSum_rawOutcome_of_attests C hatt]
  constructor
  · exact hdl _ _
  · intro h; rw [h]

theorem sum_attestations_complete {sel : List (Ann Xc Msg)} {ss : List Sc} {o : Msg} {T : Pt}
    (hatt : Attests C o sel ss) (hT : T = C.ptSum (sel.map (rawOutcome C o))) :
    C.smul (C.scSum ss) C.G = T := by
  rw [hT, ptSum_rawOutcome_of_attests C hatt]

/-- (b)+(d) for a CET: given the adaptor point `T = cetPoint ...` and a presignature that passes
`adaptorVerifyForPoint` with `T`, the completion `(rx, s0 + t)` is a valid signature on `m` iff
`t` is the sum of valid attestation scalars for `o` by the CET's oracles. -/
theorem cet_completion_iff_attestations {anns : List (Ann Xc Msg)} {lt : Xc → Xc → Bool}
    {o : Msg} {subset : List Xc} {T : Pt} {px : Xc} {m : Msg} {ps : Presig Pt Sc Xc}
    (hcet : cetPoint C anns lt o subset = some T)
    (hv : adaptorVerifyForPoint C px m ps T = true) (hdl : DlogUnique C) :
    ∃ sel : List (Ann Xc Msg), sel.map (·.px) = subset ∧ (∀ a ∈ sel, a ∈ anns) ∧
      ∀ ss, Attests C o sel ss → ∀ t,
        schnorrVerify C px m (completeRaw C ps t) = true ↔ t = C.scSum ss := by
  obtain ⟨sel, hk, hmem, _, _, _, hsum, _⟩ := cet_point_binding C hcet
  refine ⟨sel, hk, hmem, fun ss hss t => ?_⟩
  rw [← (adaptorComplete_iff C hv t).1, completing_scalar_iff C hss hsum hdl]

/-! ## Oracle secrecy and the no-forgery corollary -/

/-- `OracleSecrecy Knows attested anns subset` (hypothesis, not proved): for every outcome the
oracles did not attest, no party knows the sum `Σ s_i` of the BIP340 attestation scalars of the
CET's oracle subset. It is the EUF-CMA assumption (coordinator axiom 1, BIP340) applied to one
honest oracle `h` in the subset: a party that knows `Σ s_i` and all `s_j` with `j ≠ h` (a reduction
that generated the other oracles' keys knows them) holds `s_h`, the `s` component of a BIP340
signature by `h` on `o`; `h` attests at most one outcome per announced nonce, so that signature
is a forgery. The hypothesis is false when every oracle in the subset colludes. -/
def OracleSecrecy (Knows : Sc → Prop) (attested : Msg → Prop) (anns : List (Ann Xc Msg))
    (subset : List Xc) : Prop :=
  ∀ (o : Msg) (sel : List (Ann Xc Msg)) (ss : List Sc),
    ¬ attested o → sel.map (·.px) = subset → (∀ a ∈ sel, a ∈ anns) →
    Attests C o sel ss → ¬ Knows (C.scSum ss)

/-- Corollary of (c) and (d). Take a CET for outcome `o` whose presignature passes
`adaptorVerifyForPoint` with the CET adaptor point, and a signature on the CET message that
passes `schnorrVerify`, carries the presignature's `rx`, and is held by a party whose knowledge
is closed under `adaptorExtract` (a party holding `ps` and `sig` computes `s - s0`). Under
`OracleSecrecy` and `DlogUnique`, and given that attestation scalars for the selected oracles
exist (`hexists`: each announced `R_i`, `P_i` is a real point with a discrete logarithm), the
oracles attested `o`. -/
theorem no_completed_signature_without_attestation
    {anns : List (Ann Xc Msg)} {lt : Xc → Xc → Bool} {o : Msg} {subset : List Xc} {T : Pt}
    {px : Xc} {m : Msg} {ps : Presig Pt Sc Xc} {sig : Sig Sc Xc}
    {Knows : Sc → Prop} {attested : Msg → Prop}
    (hcet : cetPoint C anns lt o subset = some T)
    (hv : adaptorVerifyForPoint C px m ps T = true)
    (hs : schnorrVerify C px m sig = true) (hrx : sig.rx = ps.rx)
    (hclosed : ∀ t, adaptorExtract C px m ps sig = some t → Knows t)
    (hdl : DlogUnique C)
    (hexists : ∀ sel : List (Ann Xc Msg), sel.map (·.px) = subset → (∀ a ∈ sel, a ∈ anns) →
      ∃ ss, Attests C o sel ss)
    (hsecret : OracleSecrecy C Knows attested anns subset) :
    attested o := by
  refine Classical.byContradiction fun hna => ?_
  obtain ⟨hvT, hv'⟩ := (adaptorVerifyForPoint_iff C px m ps T).1 hv
  obtain ⟨hex, htG⟩ := adaptorExtract_of_completed C hv' hs hrx
  obtain ⟨sel, hk, hmem, _, _, _, hsum, hall⟩ := cet_point_binding C hcet
  obtain ⟨ss, hss⟩ := hexists sel hk hmem
  have h1 : C.smul (C.sadd sig.s (C.sneg ps.s0)) C.G = C.smul (C.scSum ss) C.G := by
    rw [htG, hvT, ← hall ss hss]
  have h2 := hdl _ _ h1
  exact hsecret o sel ss hna hk hmem hss (h2 ▸ hclosed _ hex)
end Scheme

/-! ## A concrete instance and worked vectors

`Toy.curve` is the cyclic group `Z/7` with `G = 1`, scalars `Z/7`, `hasEvenY p = (1 ≤ p ≤ 3)`,
`xOf p = min p (7 - p)`, `lift x = x` for `1 ≤ x ≤ 3`, and `chal r p m = r + 2p + 3m`. It satisfies
every field law of `Curve` (each proved by `decide`), so the theorems above apply to it, and it
exercises each guard of the code on small values. -/

namespace Toy

def neg7 (a : Fin 7) : Fin 7 := ⟨(7 - a.val) % 7, by omega⟩

def curve : Curve (Fin 7) (Fin 7) (Fin 7) (Fin 7) where
  padd := fun a b => a + b
  pzero := 0
  pneg := neg7
  padd_assoc := by decide
  padd_comm := by decide
  padd_pzero := by decide
  padd_pneg := by decide
  sadd := fun a b => a + b
  szero := 0
  sneg := neg7
  sone := 1
  rmul := fun a b => a * b
  sadd_assoc := by decide
  sadd_comm := by decide
  sadd_szero := by decide
  sadd_sneg := by decide
  rmul_assoc := by decide
  rmul_comm := by decide
  rmul_sone := by decide
  rmul_sadd := by decide
  smul := fun a p => a * p
  smul_sadd := by decide
  smul_padd := by decide
  smul_rmul := by decide
  smul_sone := by decide
  G := 1
  smul_G_ne_zero := by decide
  xOf := fun p => ⟨min p.val (7 - p.val) % 7, by omega⟩
  hasEvenY := fun p => decide (1 ≤ p.val ∧ p.val ≤ 3)
  xOf_pneg := by decide
  even_pneg := by decide
  xOf_inj_even := by decide
  lift := fun x => if 1 ≤ x.val ∧ x.val ≤ 3 then some x else none
  lift_spec := by decide
  lift_xOf := by decide
  chal := fun r p m => r + 2 * p + 3 * m

/-- Candidate nonce for counter `c`: `c + 1` (never zero for `c < 6`). -/
def nonce : Nat → Fin 7 := fun c => Fin.ofNat 7 (c + 1)

/-- The group is the cyclic group of order 7 generated by `G`: `DlogUnique` holds. -/
theorem dlogUnique : DlogUnique curve := by
  intro a b h
  revert a b
  decide

-- secret 2, message 5, adaptor point T = 3·G, nonce loop: counters 0..3 are rejected, counter 4
-- (k0 = 5) is accepted
example : adaptorSignStep curve 2 5 3 0 = none := by decide          -- zero nonce
example : adaptorSignStep curve 2 5 3 1 = none := by decide          -- R0 + T = 4, odd y
example : adaptorSignStep curve 2 5 3 4 = none := by decide          -- R0 + T = 7 = infinity
example : adaptorSignStep curve 2 5 3 5 = some ⟨1, 3, 5, 3⟩ := by decide
example : adaptorSign curve 2 5 3 nonce = some ⟨1, 3, 5, 3⟩ := by decide
-- guards: zero secret, adaptor point at infinity
example : adaptorSign curve 0 5 3 nonce = none := by decide
example : adaptorSign curve 2 5 0 nonce = none := by decide
-- the Rust loop returns the same presignature
example : rustAdaptorSign curve 2 5 3 nonce = adaptorSign curve 2 5 3 nonce := by decide
-- test "adaptor pre-signature is not a valid signature on its own"
example : adaptorVerify curve 2 5 ⟨1, 3, 5, 3⟩ = true := by decide
example : schnorrVerify curve 2 5 ⟨1, 3⟩ = false := by decide
-- test "only the oracle attestation completes the adaptor into a valid signature"
example : adaptorComplete curve ⟨1, 3, 5, 3⟩ 3 = some ⟨1, 6⟩ := by decide
example : schnorrVerify curve 2 5 ⟨1, 6⟩ = true := by decide
example : adaptorComplete curve ⟨1, 3, 5, 3⟩ 4 = none := by decide
example : schnorrVerify curve 2 5 (completeRaw curve ⟨1, 3, 5, 3⟩ 4) = false := by decide
-- test "completing the adaptor reveals the oracle scalar (extractable)"
example : adaptorExtract curve 2 5 ⟨1, 3, 5, 3⟩ ⟨1, 6⟩ = some 3 := by decide
-- an unrelated valid signature (different nonce x) is rejected by the `s - s0` guard
example : schnorrVerify curve 2 5 ⟨2, 2⟩ = true := by decide
example : adaptorExtract curve 2 5 ⟨1, 3, 5, 3⟩ ⟨2, 2⟩ = none := by decide
-- even-y negation: secret 4 has odd y (4·G = 4), signs for d = -4 = 3, x-only key 3
example : curve.hasEvenY (curve.smul 4 curve.G) = false := by decide
example : evenSecret curve 4 = 3 := by decide
example : (adaptorSign curve 4 5 3 nonce).map (adaptorVerify curve 3 5) = some true := by decide

-- oracle announcements (px, rx, committed outcomes)
def a1 : Ann (Fin 7) (Fin 7) := ⟨1, 2, [5]⟩
def a2 : Ann (Fin 7) (Fin 7) := ⟨3, 1, [5, 6]⟩
def a3 : Ann (Fin 7) (Fin 7) := ⟨2, 3, [5]⟩
def lt7 : Fin 7 → Fin 7 → Bool := fun a b => decide (a.val < b.val)

example : outcomePoint curve a3 5 = some 5 := by decide
example : outcomePoint curve a2 5 = some 4 := by decide
example : cetPoint curve [a1, a2, a3] lt7 5 [2, 3] = some 2 := by decide
-- rejected subsets: unsorted, single oracle, duplicate key, unknown key, uncommitted outcome
example : cetPoint curve [a1, a2, a3] lt7 5 [3, 2] = none := by decide
example : cetPoint curve [a1, a2, a3] lt7 5 [2] = none := by decide
example : cetPoint curve [a1, a2, a3] lt7 5 [2, 2] = none := by decide
example : cetPoint curve [a1, a2, a3] lt7 5 [2, 6] = none := by decide
example : cetPoint curve [a1, a2, a3] lt7 6 [2, 3] = none := by decide
-- attestation scalars: 5 for a3, 4 for a2 (sum 9 = 2 = T); 3 is not an attestation for a2
example : schnorrVerify curve a3.px 5 ⟨a3.rx, 5⟩ = true := by decide
example : schnorrVerify curve a2.px 5 ⟨a2.rx, 4⟩ = true := by decide
example : schnorrVerify curve a2.px 5 ⟨a2.rx, 3⟩ = false := by decide
-- end to end: presignature on CET message 6 under the CET point T = 2
example : adaptorSign curve 2 6 2 nonce = some ⟨3, 2, 1, 2⟩ := by decide
example : adaptorVerifyForPoint curve 2 6 ⟨3, 2, 1, 2⟩ 2 = true := by decide
example : (adaptorComplete curve ⟨3, 2, 1, 2⟩ 2).map (schnorrVerify curve 2 6) = some true := by decide
example : adaptorComplete curve ⟨3, 2, 1, 2⟩ 3 = none := by decide

end Toy

end UTXORefFormal.Adaptor
