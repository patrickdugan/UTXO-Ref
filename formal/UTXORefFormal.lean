import UTXORefAxioms
import UTXORefFormal.Signer

/-!
# UTXO-Ref: Lean models of the pilot's security-critical code

Each module under `UTXORefFormal/` is a functional transcription of one part of the pilot
surface (docs/PILOT_SURFACE.md) at commit `5883e03`, with theorems about it. Cryptographic
properties enter every theorem in the `UTXORefFormal` namespace as explicit hypotheses;
`UTXORefAxioms.lean` states the two axioms that discharge them for the deployed primitives.
docs/FORMAL_SECURITY.md lists every theorem, the code it models, and what is not proven.
-/
