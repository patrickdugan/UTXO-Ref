import UTXORefFormal.Signer

/-!
# The two cryptographic assumptions

This file is the only place the UTXO-Ref proofs assume anything that is not proved. It declares
the deployed primitives as `opaque` constants and states exactly two axioms about them. Every
theorem in the `UTXORefFormal` namespace is proved from explicit hypotheses and depends on no
axiom beyond Lean's `propext`, `Classical.choice` and `Quot.sound`. The corollaries below, in
the `UTXORefAxioms` namespace, discharge those hypotheses with the two axioms.
-/

set_option autoImplicit false

namespace UTXORefAxioms

open UTXORefFormal

/-- Ed25519 verification of a message under a public key (`ed25519_dalek::VerifyingKey::verify`
in native/dlc-signer/src/main.rs; `crypto.verify` with an Ed25519 key in the host code). -/
opaque ed25519Verify : Nat → List Nat → Nat → Bool

/-- `ed25519Signed key msg`: the holder of the private key of `key` signed `msg`. -/
opaque ed25519Signed : Nat → List Nat → Prop

/-- BIP340 verification of a 32-byte message under an x-only key (`schnorr_verify` in
native/dlc-signer/src/signing_target.rs, `schnorrVerify` in tradelayer_dlc_adaptor_sig.js). -/
opaque bip340Verify : Nat → Nat → Nat → Bool

/-- `bip340Signed key msg`: the holder of the private key of `key` signed `msg`. -/
opaque bip340Signed : Nat → Nat → Prop

/-- **Axiom 1: unforgeability (EUF-CMA) of the two deployed signature schemes.**

A signature that Ed25519 or BIP340 verification accepts for public key `key` on message `msg`
exists only if the holder of `key` signed `msg`. This is the standard existential
unforgeability under chosen-message attack of Ed25519 (RFC 8032) and of BIP340 Schnorr over
secp256k1, together with the correctness of the verifiers the code calls (`ed25519-dalek` and
`k256` in the Rust signer, the secp256k1 code of tradelayer_dlc_adaptor_sig.js on the host). -/
axiom signatures_unforgeable :
    (∀ key msg sig, ed25519Verify key msg sig = true → ed25519Signed key msg) ∧
      ∀ key msg sig, bip340Verify key msg sig = true → bip340Signed key msg

/-- SHA-256 of a byte string, as a 256-bit number. Every digest, tagged hash, txid, tapleaf
hash and hashlock in the models is SHA-256 (or SHA-256d, or a BIP340 tagged hash, each a
SHA-256 of a fixed-layout byte string) of an encoding of the hashed value. -/
opaque sha256 : List Nat → Nat

/-- **Axiom 2: SHA-256 binds its input.**

Equal SHA-256 digests come from equal byte strings. This idealizes the collision resistance of
SHA-256 as injectivity: no collision of SHA-256 is known, and a proof that uses two inputs with
one digest would exhibit one. It is consistent because `sha256` is an uninterpreted constant
on an infinite codomain. Combined with an injective encoding (canonical JSON, fixed-width or
length-prefixed fields), it makes every digest in the models bind the value it names. -/
axiom sha256_binding : ∀ x y, sha256 x = sha256 y → x = y

/-- A digest built as SHA-256 of an injective encoding binds the encoded value. -/
theorem digest_binding_of_encoding {α : Type} (enc : α → List Nat)
    (henc : ∀ x y, enc x = enc y → x = y) :
    Signer.DigestBinding (fun x => sha256 (enc x)) :=
  fun x y h => henc x y (sha256_binding _ _ h)

/-! ## Signer boundary for the deployed primitives -/

theorem deployed_emitted_presignature_validator_signed {Pt : Type} (P : Signer.Prims Pt)
    (M : Signer.MainPrims) (hM : M.edVerify = ed25519Verify) (pol : Signer.Policy)
    (skew now : Nat) (E : Signer.Env) (r : Signer.Request) (e : Signer.Emitted)
    (h : Signer.run P M pol skew now E r = .ok e) :
    ∃ (vk : Nat × Nat) (p : Signer.Payload), vk.2 ∈ pol.validatorKeyIds ∧
      ed25519Signed vk.1 r.payloadBytes ∧ M.decode r.payloadBytes = some p ∧
      p.named.sighash = e.message ∧ p.adaptor = e.adaptor ∧
      p.named.stage = Signer.SIGNABLE_STAGE :=
  Signer.emitted_presignature_validator_signed P M pol ed25519Signed
    (by rw [hM]; exact signatures_unforgeable.1) skew now E r e h

theorem deployed_committed_cet_set_unique {Pt : Type} (P : Signer.Prims Pt)
    (enc : List Signer.CetRaw → List Nat) (henc : ∀ x y, enc x = enc y → x = y)
    (hP : P.digestCets = fun l => sha256 (enc l)) (c₁ c₂ : Signer.Context)
    (t₁ t₂ : Signer.SigningTarget) (h₁ : Signer.deriveSigningTarget P c₁ = .ok t₁)
    (h₂ : Signer.deriveSigningTarget P c₂ = .ok t₂) (he : t₁.cetSetDigest = t₂.cetSetDigest) :
    c₁.cets = c₂.cets :=
  Signer.committed_cet_set_unique P (hP ▸ digest_binding_of_encoding enc henc) c₁ c₂ t₁ t₂ h₁ h₂ he

theorem deployed_adaptor_oracles_signed_announcements {Pt : Type} (P : Signer.Prims Pt)
    (hP : P.schnorrVerify = bip340Verify) (c : Signer.Context) (t : Signer.SigningTarget)
    (h : Signer.deriveSigningTarget P c = .ok t) :
    ∃ cet ∈ c.cets, ∃ used : List Signer.Ann, used.map (·.px) = cet.oraclePubkeys ∧
      2 ≤ cet.oraclePubkeys.length ∧
      ∀ a ∈ used, cet.outcomeMessage ∈ a.outcomes ∧
        bip340Signed a.px (P.annDigest a.eventId a.px a.rx a.outcomes) :=
  Signer.adaptor_oracles_signed_announcements P bip340Signed
    (by rw [hP]; exact signatures_unforgeable.2) c t h

end UTXORefAxioms
