# Formal security proofs (Lean 4) for the UTXO-Ref pilot surface

These proofs cover security-critical code of the pilot surface (docs/PILOT_SURFACE.md) at commit
`5883e03` (`origin/main`). Every `file:line` below refers to that commit; paths without a
directory are in `bitvm3/utxo_referee/`. The Lean sources are under `formal/`, built with
`leanprover/lean4:v4.35.0` and core Lean only (no Mathlib), by `lake build` in `formal/` as
`.github/workflows/lean.yml` runs it. `formal/UTXORefFormal.lean` imports every module listed
here. Two code changes since `5883e03` fix the findings below: `094598d` (BitVM F1, in
`tradelayer_bitvm_dispute.js`) and `30bf8a5` (the TxSet, OneShot and Adaptor findings, in
`dlc_transaction_validator.js`,
`dlc_signing_authorization_store.js`, `m1_deposit_indexer.js`, `dlc_signing_target.js`,
`dlc_contract_state.js`, `tradelayer_dlc_adaptor_sig.js` and native/dlc-signer). The models
follow the fixed code; a `file:line` marked "after the fix" is at the fixing commit, every other
one is at `5883e03`.

A Lean model is a functional transcription of the named function: the same checks in the same
order with the same results. A theorem is proved about the model. The correspondence between
the model and the Rust or JavaScript code is established by reading, not by extraction or a
verified compiler. Each section lists what the model abstracts; those parts are not proven.

## Assumptions

`formal/UTXORefAxioms.lean` is the only file that declares axioms. It declares exactly two:

| Axiom | Statement | Justification |
| --- | --- | --- |
| `UTXORefAxioms.signatures_unforgeable` | An Ed25519 or BIP340 signature that verifies for key `k` on message `m` exists only if the holder of `k` signed `m`. | EUF-CMA of Ed25519 (RFC 8032) and of BIP340 Schnorr over secp256k1, and the correctness of the verifiers the code calls (`ed25519-dalek` and `k256` in native/dlc-signer, the secp256k1 code of tradelayer_dlc_adaptor_sig.js). |
| `UTXORefAxioms.sha256_binding` | Equal SHA-256 digests come from equal byte strings. | Collision resistance of SHA-256, idealized as injectivity: a proof using two inputs with one digest would exhibit a collision. Every digest, txid, tagged hash, tapleaf hash and hashlock in the models is SHA-256 of a fixed-layout or canonical-JSON encoding. |

The primitives they speak about (`ed25519Verify`, `ed25519Signed`, `bip340Verify`,
`bip340Signed`, `sha256`) are `opaque` constants, which add no axioms.

Every theorem in the `UTXORefFormal` namespace takes the cryptographic property it needs as an
explicit hypothesis and depends only on Lean's `propext`, `Classical.choice` and `Quot.sound`,
which the `lean.yml` axiom audit enforces for that namespace. The `UTXORefAxioms.deployed_*`
corollaries discharge those hypotheses with the two axioms. Where a theorem needs an
assumption that is neither axiom (discrete-log secrecy of an oracle outcome, an encoder being
injective), it stays a hypothesis of the theorem and is listed in its section.

## 1. Native signer boundary — `formal/UTXORefFormal/Signer.lean`

Model of `verify_request` (native/dlc-signer/src/main.rs:787), the order of `run` (main.rs:1055,
steps at :1096–1131), `derive_signing_target` (native/dlc-signer/src/signing_target.rs:497),
`verify_signing_target` (signing_target.rs:642), `dlc_funding_output` (:246),
`verified_announcement` (:437), `outcome_point` (:483) and the oracle-subset loop (:608–621).

| Lean theorem | Statement | Code |
| --- | --- | --- |
| `Signer.emitted_presignature_targets_committed_cet` | Every presignature `run` emits is on the BIP341 CET-leaf script-path sighash of a CET in the committed CET set that hashes to its txid and spends the committed funding outpoint of the re-derived two-party output, for the funding value; the signer is a funding party and pinned by the policy; the adaptor point is the sum of the outcome points of the CET's oracle subset; the validator-signed payload names that sighash, CET, CET-set digest, funding digest, announcement digest and adaptor point; its stage is `COUNTERPARTY_SIGNATURES_VERIFIED`; a pinned validator key verifies it; the authorization was consumed before signing. | main.rs:787–933, :1096–1131; signing_target.rs:497–676 |
| `Signer.emitted_presignature_validator_signed` | Under Ed25519 unforgeability, the holder of a pinned validator key signed the exact payload bytes, which decode to a payload naming the emitted message and adaptor point. | main.rs:892–911 |
| `Signer.bare_sighash_refused` | A request without a signing context never verifies: a bare sighash is never signed. | main.rs:920–923, signing_target.rs:646 |
| `Signer.cet_outside_committed_set_refused` | A named CET absent from the committed set is never a signing target. | signing_target.rs:560–566 |
| `Signer.cet_not_spending_funding_refused` | A named CET that does not spend the committed funding outpoint is never a signing target. | signing_target.rs:567–573 |
| `Signer.non_party_signer_refused` | A signer that is not one of the two funding keys is refused. | signing_target.rs:647–650 |
| `Signer.target_funding_is_two_party_nums` | The funding output of every target has two ascending distinct valid party keys, neither the NUMS internal key, and a refund delay in 1..65535; its scriptPubKey is the one the model derives from them, never the one the request names. | signing_target.rs:246–279, :521–547 |
| `Signer.committed_cet_set_unique` | Under digest binding, two targets accepted under one signed `cetSetDigest` come from the same CET set. | signing_target.rs:511–514 |
| `Signer.adaptor_oracles_signed_announcements` | Under BIP340 unforgeability, every announcement whose outcome point enters the adaptor point was signed by its oracle over its event, nonce and full outcome list; the subset has at least two oracles and commits to the CET's outcome. | signing_target.rs:437–481, :603–621 |
| `UTXORefAxioms.deployed_emitted_presignature_validator_signed`, `deployed_committed_cet_set_unique`, `deployed_adaptor_oracles_signed_announcements` | The three theorems above with the two axioms; the CET-set corollary takes the canonical-JSON encoder's injectivity as a hypothesis. | as above |

Supporting lemmas: `dlcFundingOutput_spec`, `verifiedAnnouncement_spec`, `subsetPoint_spec`,
`deriveSigningTarget_spec` (the structure `TargetOf`), `verifySigningTarget_spec`,
`verifyRequest_spec` (the structure `VerifiedOf`), `run_spec`, `mapE_spec`.

**Abstracted, not proven:**
- JSON, base64, hex and canonical-JSON parsing. A request arrives as a record; a missing or
  ill-typed field is the corresponding `Option` or check. The 13-field equality loop
  (main.rs:826) is equality of the `Named` record.
- The taproot output derivation, tapleaf and branch hashing, transaction parsing, the BIP341
  sighash and the curve arithmetic are fields of `Prims`; `dlc_funding_output` is modelled as
  its guards followed by that derivation.
- The DPAPI key load, the clock store, the consumed-authorization marker and the executable
  digest check of `run` are Boolean results (`Env`). The one-shot property of the marker is
  section 4.
- The adaptor signature itself (`adaptor_sign`, main.rs:355) is section 2; this section is about
  which message and point are signed.
- `canonical_json` being injective is a hypothesis of `deployed_committed_cet_set_unique`.

## 2. Adaptor signatures and oracle binding — `formal/UTXORefFormal/Adaptor.lean`

Lean file: `formal/UTXORefFormal/Adaptor.lean`, namespace `UTXORefFormal.Adaptor`. Code references are
at commit `5883e03`. `adaptor.js` below means `bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig.js`,
`threshold.js` means `bitvm3/utxo_referee/dlc_threshold_oracle.js`, `main.rs` means
`native/dlc-signer/src/main.rs`, `target.rs` means `native/dlc-signer/src/signing_target.rs`.

### Model

`Curve Pt Sc Xc Msg` is the abstract secp256k1: an additive commutative group of points (`padd`, `pzero` = infinity, `pneg`), a commutative ring of scalars, scalar multiplication `smul` with distributivity and compatibility laws, the generator `G`, the x-coordinate map `xOf`, the y-parity test `hasEvenY`, `lift` (BIP340 `lift_x`), and the challenge hash `chal`. Every field is a law that secp256k1 satisfies: group and ring axioms; `smul` laws; `smul x G ≠ 0` for `x ≠ 0` (prime group order); `xOf (-p) = xOf p`; `hasEvenY (-p) = !hasEvenY p` for `p ≠ 0`; a nonzero even-y point is determined by its x-coordinate; `lift` returns the even-y point with that x-coordinate. No hardness property is a field. `Toy.curve` (the group `Z/7`) instantiates all fields, so the structure is consistent, and the worked `example`s run each guard on it.

### Hypotheses (definitions, not axioms)

* `DlogUnique C`: `s ↦ s·G` is injective. This is an algebraic fact about the prime-order group. It is used only for the "only if" directions of (d) and for the corollary. It is not a computational assumption.
* `OracleSecrecy C Knows attested anns subset`: for every outcome `o` the oracles did not attest, no party knows `Σ s_i` for any list of valid BIP340 attestation scalars of the CET's oracle subset. It is instantiated by coordinator axiom 1 (EUF-CMA of BIP340): take one honest oracle `h` in the subset; a party knowing `Σ s_i` and the `s_j` of the other oracles (a reduction that generated their keys knows them) holds `s_h`, the `s` component of a BIP340 signature by `h` on `o`; `h` attests at most one outcome per announced nonce (`adaptor.js:585-592`, `dlcAttest` refuses a conflicting outcome), so that signature is a forgery. The hypothesis is false when every oracle in the subset colludes with the party.

### Theorems

#### Group and ring algebra
* Lean names: `Curve.padd_pzero_left`, `padd_pneg_left`, `padd_left_cancel`, `padd_right_cancel`, `padd_right_comm`, `pneg_unique`, `padd_pneg_cancel_right`, `smul_szero`, `smul_sneg`, `sadd_szero_left`, `sadd_sneg_left`, `sub_add_cancel`, `add_sub_cancel_left`, `pneg_ne_pzero`.
* Statement: the elementary identities of an abelian group and a ring (cancellation, uniqueness of inverses, `0·p = 0`, `(-a)·p = -(a·p)`, `(s - s0) + s0 = s`, `(s0 + t) - s0 = t`) derived from the `Curve` fields.
* Code modelled: the arithmetic of `pointAdd`/`pointMul`/`mod` (`adaptor.js:79-140`) and `k256` `ProjectivePoint`/`Scalar` operators, used in every function below.
* **Abstracted, not proven:** the identities are proven from the `Curve` laws; that `pointAdd`, `pointMul`, `pointNegate`, `mod N` (`adaptor.js:75-145`) and `k256` satisfy those laws is not proven.

#### `schnorrVerify_iff`
* Statement: `schnorrVerify` accepts exactly when `lift px = some P` and `R = s·G - e·P` (`e = chal rx px m`) is finite, has even y, and has x-coordinate `rx`.
* Code modelled: `schnorrVerify` `adaptor.js:290-307`; `schnorr_verify` `target.rs:153-168`.
* **Abstracted, not proven:** the `rx >= P || s >= N` range check (carried by the types `Xc`, `Sc`); hex/byte decoding; the tagged-hash computation of `e` (the function `chal`).

#### `schnorrVerify_iff_attests`
* Statement: a BIP340 attestation `(rx, s)` for key `px` and outcome `m` verifies exactly when `lift px = some P`, `lift rx = some R` and `s·G = R + e·P`.
* Code modelled: `verifyDlcAttestation` `adaptor.js:608-622` (builds the signature `rx || s` and calls `schnorrVerify`); `dlcAttest` `adaptor.js:585-606`.
* **Abstracted, not proven:** announcement signature verification (`verifyNormalizedDlcOracleAnnouncement`); that an oracle's `s` is computed as `k + e·x` (`adaptor.js:598`).

#### `parseOk_iff`, `adaptorVerify_iff`, `adaptorVerifyForPoint_iff`
* Statement: `adaptorVerify` accepts exactly when `lift px = some P`, `R0` and `T` are finite, `Rp = R0 + T` is finite with even y and x-coordinate `rx`, `s0·G` and `R0 + e·P` are finite, and `s0·G = R0 + e·P` with `e = chal rx px m`; `adaptorVerifyForPoint` additionally requires the carried `T` to equal the expected point.
* Code modelled: `presigPoints` `adaptor.js:348-368`; `adaptorVerify` `adaptor.js:370-387`; `adaptorVerifyForPoint` `adaptor.js:393-404`.
* **Abstracted, not proven:** `presigPoints` hex parsing, `kind` check and field ranges; `snapshotOwnDataArguments`; `onCurve` (membership in `Pt`); the exceptions of `requireBuffer` (message length).

#### `evenSecret_point`
* Statement: for a nonzero secret `x`, the even-y secret `d` has `d·G` finite, with even y, with the x-coordinate of `x·G`, and `lift (xOf (x·G)) = some (d·G)`.
* Code modelled: `d = hasEvenY(Ppoint) ? d0 : N - d0`, `adaptor.js:318-319`; Rust `if public_y[31] & 1 == 1 { *secret = -*secret }`, `main.rs:364-366`; `liftX(px)` in `schnorrVerify`.
* **Abstracted, not proven:** `N - d0` is the ring negation `sneg`; that `Scalar` negation in `k256` is the ring negation is not proven.

#### `adaptorSignStep_some`, `adaptorSign_some`
* Statement: one loop pass returns a presignature only for a nonzero nonce with `R0 + T` finite and even-y, and the presignature is `(xOf (R0+T), k0 + e·d, R0, T)`; `adaptorSign` returns one only for a nonzero secret, a finite `T`, and some counter below 64 that passes.
* Code modelled: `adaptorSign` `adaptor.js:313-346`; `adaptor_sign` `main.rs:355-418`.
* **Abstracted, not proven:** the candidate nonce `k0` is the parameter `nonce c` (the tagged hash of `adaptor.js:324-327` and `main.rs:382-391`); the aux-hash masking of the secret enters only the hash input; 64 iterations always find an even-y nonce with probability 1 - 2^-64 (the theorem covers the case where the loop returns, not the probability of returning).

#### `adaptorSign_equation`
* Statement: a presignature returned by `adaptorSign` has `ps.T = T`, `R0 ≠ 0`, `R0 + T` finite with even y and x-coordinate `rx`, and `s0·G = R0 + e·(d·G)` with `e = chal rx (xOf (x·G)) m`.
* Code modelled: `adaptorSign` `adaptor.js:331-343`; `adaptor_sign` `main.rs:393-411`.
* **Abstracted, not proven:** as `adaptorSignStep_some`.

#### (a) `adaptorSign_verify_iff`, `adaptorSign_s0_ne`, `adaptorSign_verifies` (completeness)
* Statement: a presignature produced by `adaptorSign` passes `adaptorVerify` for the x-only key `xOf (x·G)` exactly when `s0 ≠ 0`; the signer never returns `s0 = 0` (`adaptorSign_s0_ne`), so every presignature it returns passes `adaptorVerify` and `adaptorVerifyForPoint` with `T`, with no hypothesis (`adaptorSign_verifies`).
* Code modelled: `adaptorSign` `adaptor.js:313` with the `s0 === 0n` retry at `:337`, `adaptorVerify` `adaptor.js:370`, `adaptorVerifyForPoint` `adaptor.js:393`; `adaptor_sign` `main.rs:355` with the retry at `:408` (after the fix in `30bf8a5`).
* **Abstracted, not proven:** the hash outputs are arbitrary. See Findings F1, fixed.

#### `rustLoop_eq_findSome`, `rust_adaptorSign_eq_js`
* Statement: the Rust loop `for counter in 0u8..64 { ...continue... return Ok }` returns the same presignature as the JavaScript loop for every nonce sequence, secret, message and point.
* Code modelled: `adaptor_sign` `main.rs:381-417` against `adaptorSign` `adaptor.js:322-345`.
* **Abstracted, not proven:** the per-iteration checks are shared as `adaptorSignStep`; the model asserts by reading that `main.rs:393-404` (zero nonce, `R0 + T` identity, odd `ry`) is the same predicate as `adaptor.js:328-332`, and the two compute the same nonce hash input (`tbase`, signer x, message, compressed `T`, counter byte); the Rust-only paths `scalar_from_bytes` (secret in `1..n-1`, `main.rs:302`) and `parse_point` (finite on-curve `T`, `main.rs:338`) are modelled by the top-level guard `x = 0 ∨ T = 0`.

#### `adaptorComplete_eq_some_iff`
* Statement: for a parsed presignature, `adaptorComplete ps t` returns `sig` exactly when `t·G = T` and `sig = (rx, s0 + t)`.
* Code modelled: `adaptorComplete` `adaptor.js:406-416`.
* **Abstracted, not proven:** `requireScalar` byte/bigint handling; the 32-byte encoding of `s`.

#### (b) `complete_verifies_iff`, `adaptorComplete_iff`
* Statement: for a presignature passing `adaptorVerify` (resp. `adaptorVerifyForPoint` with `T`), the completion `(rx, s0 + t)` passes `schnorrVerify` on `m` if and only if `t·G = T`, and `adaptorComplete` returns that completion if and only if `t·G = T`.
* Code modelled: `adaptorComplete` `adaptor.js:406`, `schnorrVerify` `adaptor.js:290`, `adaptorVerifyForPoint` `adaptor.js:393`.
* **Abstracted, not proven:** the even-y conditions are the ones the code checks (`isInf`, `hasEvenY`, `R.x === rx`); they enter through the `Curve` fields `xOf_inj_even` and `lift_xOf`.

#### `presig_not_signature`
* Statement: for a presignature passing `adaptorVerify`, `(rx, s0)` fails `schnorrVerify` (a presignature is not a signature).
* Code modelled: test "adaptor pre-signature is not a valid signature on its own", `tradelayer_dlc_adaptor_sig.test.js:75`; `adaptorVerify` and `schnorrVerify`.
* **Abstracted, not proven:** as (b).

#### (c) `adaptorExtract_sound`
* Statement: whenever `adaptorExtract` returns `t`, the presignature and the signature both verify and `t·G = T`.
* Code modelled: `adaptorExtract` `adaptor.js:418-431`.
* **Abstracted, not proven:** exception behaviour of `requireBuffer`.

#### (c) `adaptorExtract_of_completed`, `adaptorExtract_complete`
* Statement: for a passing presignature and a passing signature on the same message with `sig.rx = ps.rx`, `adaptorExtract` returns `s - s0` and `(s - s0)·G = T`; completing with `t` (`t·G = T`) and then extracting returns `t`.
* Code modelled: `adaptorExtract` `adaptor.js:418`; test "completing the adaptor reveals the oracle scalar (extractable)", `tradelayer_dlc_adaptor_sig.test.js:105`.
* **Abstracted, not proven:** the hypothesis `sig.rx = ps.rx` is required; a valid signature with another nonce makes `adaptorExtract` return none (the `Toy` example `adaptorExtract ... ⟨2, 2⟩ = none`).

#### `outcomePoint_some`, `cetFold_spec`
* Statement: `outcome_point` returns `lift rx + e·lift px` after the committed-outcome check; if the subset fold returns `T`, there are selected announcements `sel` (in the announcement set, committing to `o`, with keys exactly `subset` in order) with `T = Σ rawOutcome o a`.
* Code modelled: `outcome_point` `target.rs:483-495`; the subset loop `target.rs:603-623`; `dlcOutcomePoint` `adaptor.js:571-583`; `addPoints` `threshold.js:63-68`.
* **Abstracted, not proven:** `verified_announcement` (`target.rs:437`) verification of each announcement's own BIP340 signature and its schema, and the checks at `target.rs:594-602` (distinct sorted announcement keys, same event and ordered outcome set), are not modelled: announcements enter as already verified; `lt` stands for the byte order on x-only keys.

#### `rawOutcome_of_attests`, `smul_scSum`, `ptSum_rawOutcome_of_attests`
* Statement: the outcome point of an announcement whose attestation `s` verifies equals `s·G`; `(Σ s_i)·G = Σ (s_i·G)`; hence the sum of the outcome points of the selected announcements equals `(Σ s_i)·G` for valid attestation scalars `s_i`.
* Code modelled: `combineThresholdAttestations` `threshold.js:83-113` (sums verified attestations and compares `combinedScalar·G` with the summed outcome points).
* **Abstracted, not proven:** scalar addition mod `N` is the ring addition `sadd`.

#### (d) `cet_point_binding`
* Statement: if `cetPoint` returns `T`, the subset has at least two keys, `T` is finite, `T` is the sum of the selected outcome points, and for every list of valid BIP340 attestation scalars `ss` for `o` by the selected oracles, `(Σ s_i)·G = T` (unconditional).
* Code modelled: `target.rs:603-623` (`outcome_point` summed from `IDENTITY`; error "combined oracle outcome point is infinity"); `threshold.js:63-80`.
* **Abstracted, not proven:** as `cetFold_spec`.

#### (d) `completing_scalar_iff`, `sum_attestations_complete`
* Statement: for `T` the summed outcome point and `ss` valid attestation scalars, `t·G = T` if `t = Σ s_i` (unconditional, `sum_attestations_complete`), and under `DlogUnique` `t·G = T` if and only if `t = Σ s_i` (`completing_scalar_iff`).
* Code modelled: `combineThresholdAttestations` `threshold.js:83-113`; `adaptorComplete` `adaptor.js:406`.
* **Abstracted, not proven:** `DlogUnique` is a hypothesis.

#### (b)+(d) `cet_completion_iff_attestations`
* Statement: if `cetPoint` returns `T` and a presignature passes `adaptorVerifyForPoint` with `T`, then for the selected oracles and every list `ss` of valid attestation scalars for `o`, the completion `(rx, s0 + t)` passes `schnorrVerify` on `m` if and only if `t = Σ s_i` (under `DlogUnique`).
* Code modelled: `derive_signing_target` `target.rs:603-640` feeding `adaptor_sign` `main.rs:355`; `adaptorComplete` `adaptor.js:406`.
* **Abstracted, not proven:** `m` is an arbitrary message; the binding of `m` to the CET sighash (`script_path_sighash`, `target.rs`) is not part of this module.

#### `no_completed_signature_without_attestation`
* Statement: under `OracleSecrecy`, `DlogUnique`, the existence of attestation scalars for the selected oracles (`hexists`), and a holder of a passing completion-shaped signature (`sig.rx = ps.rx`) whose knowledge is closed under `adaptorExtract` (`hclosed`), the oracles attested the CET's outcome `o`.
* Code modelled: (c) `adaptorExtract` `adaptor.js:418` and (d) `target.rs:603-623`.
* **Abstracted, not proven:** `OracleSecrecy` (EUF-CMA of the oracle BIP340 keys, axiom 1) is a hypothesis; `hclosed` states that a party holding the public presignature and a completed signature computes `s - s0`, which is the code of `adaptorExtract`; `hexists` states that each announced `(R_i, P_i)` has a discrete logarithm, which holds because `lift_x(rx)` and `lift_x(px)` are curve points of a prime-order group; a signature on `m` with a different nonce (a fresh signature under the funding key) is outside this theorem and is covered by EUF-CMA of the signer's own key (axiom 1).

#### `Toy.dlogUnique` and the `Toy` examples
* Statement: `DlogUnique` holds in `Z/7`; the `example`s run each guard (zero nonce, `R0 + T` at infinity, odd-y `R0 + T`, zero secret, infinite `T`, odd-y secret negation, unsorted/single/duplicate/unknown oracle subsets, uncommitted outcome, wrong completion scalar, unrelated-nonce extraction) and the end-to-end CET flow (two oracles, sum `T = 2`, completion with `t = 5 + 4 = 2`).
* Code modelled: tests at `tradelayer_dlc_adaptor_sig.test.js:75,88,105,116,141`.
* **Abstracted, not proven:** a seven-element group stands in for secp256k1; the examples show the guards fire and the theorems' hypotheses are satisfiable.

### Findings

* **F1 (adaptorSign does not reject `s0 = 0`).** `adaptor.js:333-343` and `main.rs:399-411` return a presignature without checking `s0 ≠ 0`; `adaptorVerify` rejects `s0·G` at infinity (`adaptor.js:384`). If `k0 + e·d ≡ 0 (mod n)` the signer emits a presignature its own verifier rejects. The event requires a hash output equal to `-e·d mod n`, probability about 2^-256 per attempt. No concrete input is known. The theorem `adaptorSign_verify_iff` states the exact condition. **Fixed:** both loops now take the next nonce when `s0 = 0` (`adaptor.js:337`, `main.rs:408`), and `adaptorSign_verifies` holds unconditionally.
* **F2 (adaptorExtract does not tie the signature to the presignature).** `adaptor.js:418-431` accepts any valid signature on `m` under `pubkeyX` and relies on the final `extracted·G == T` check; a valid signature with a different nonce (the `Toy` example `⟨2, 2⟩`) makes it throw. The code never returns a wrong scalar (`adaptorExtract_sound`); it can refuse to return the right one for a non-completion signature.
* **F3 (JS and Rust nonce and negation handling match).** Compared line by line: the even-y negation of the secret (`adaptor.js:318-319` vs `main.rs:364-366`), the aux mask `tbase = d XOR tagged_hash("BIP0340/aux", aux)` (`adaptor.js:321` vs `main.rs:367-373`), the compressed adaptor encoding in the nonce hash (`pointBytes`, `adaptor.js:207-210` vs `main.rs:376-380`), the nonce reduction mod `n`, the counter byte, the three rejection conditions and their order, the 64-iteration bound, and the challenge input order `(rx, px, m)` with `px` taken before negation. No divergence in nonce or negation handling was found. Differences that do not change accepted outputs: Rust always draws `aux` from `OsRng`, while the JS function accepts a caller-supplied `aux32` (deterministic presignatures); Rust returns errors where JS throws.
* **F4 (oracle-set bounds differ between the oracle builder and the signing target).** `validateOracleSet` requires 3..16 announcements and a threshold of at least 2 (`threshold.js:31-33`). The signing-target derivation accepts 2..16 announcements on both sides, `dlc_signing_target.js:70` and `target.rs:585`, and a CET subset of at least 2 (`target.rs:605`). The signer therefore signs for a two-oracle announcement set that `validateOracleSet` refuses. This does not affect the algebra of (d). **Fixed:** the signing target requires 3..16 announcements on both sides (`dlc_signing_target.js:73`, `target.rs:587`, Rust test `two_announcements_are_refused`, Lean example `vContextTwo`), and a contract oracle policy needs at least 3 oracles at creation (`dlc_contract_state.js:67`).
* **F5 (ordering primitive).** JS sorts oracle keys with `localeCompare` (`threshold.js:76`) and Rust requires strictly increasing byte order (`target.rs:613`). For lowercase 64-digit hex strings the two orders coincide; the model takes the order as the parameter `lt` and does not prove the equivalence.
* **F6 (the CET adaptor point is a plain sum).** `T = Σ (R_i + e_i·P_i)` means `Σ s_i` stays secret only while at least one oracle of the subset withholds its `s_i`. `OracleSecrecy` is false when all oracles of a CET's subset collude with a funding party; the threshold design (subsets of size `threshold`) does not change this per-subset property.

## 3. DLC transaction set — `formal/UTXORefFormal/TxSet.lean`

Lean file: `formal/UTXORefFormal/TxSet.lean`. Code: `bitvm3/utxo_referee/dlc_transaction_validator.js`
at `5883e03` (line numbers below are in that file unless another file is named).

Common premise of every theorem except the two marked "no `Env` assumption": `validateSet env inp = some out`,
that is, the validator accepted the set. `Env` carries the abstracted functions: `txidOf` (double SHA-256 of the
raw bytes), `sizeOf`, `fundingScript` (`buildDlcFundingOutput`), the hex regexes, and `sortCets` with the
field `sort_perm` (JS `sort` returns a permutation). No cryptographic hypothesis is used except in
`accepted_refund_csv_is_unique_commitment`.

### validateSet_accepted

**Statement.** An accepted set decomposes into the facts of `Accepted`: the funding and fee policy normalized,
the fee range valid, 1..4096 CETs, each output CET derived from an input CET that passed shape and spend
validation, CET identities distinct, the refund validated with `requiredSequence = refundCsv`, every CET
locktime below the refund locktime, all txids distinct.

**Models.** `validateDlcTransactionSet` 355-415 (`normalizeFunding` 220-236, `normalizeFeePolicy` 252-296,
fee range 360-363, count 364-366, CET loop 367-393, refund 397-409, locktime rule 410-412, unique txids 413-416).

**Abstracted, not proven:**
- The canonical-JSON digests and the `normalizeDlcTransactionSet` re-validation (417-461, 464-498) are not modelled.
- Byte parsing is not modelled; `parsedOk` restates the post-parse conditions of `parseCanonicalUnsignedTransaction` (83, 86-87, 98-99, 103, 111).
- `txidOf` is a parameter; nothing says it is the Bitcoin txid of the bytes.
- The CET sort (394-395) is only a permutation (`sort_perm`).

### validateSpend_facts

**Statement.** `validateSpend` returning `(tx, fee)` implies: the transaction parsed, every input carries the
required sequence when one is required, its version equals the policy version, the TRUC size bound holds for
`truc-p2a-v1`, it has exactly one input and that input is the funding outpoint, its locktime equals the committed
locktime, its outputs equal the committed outputs, the anchor appears exactly once and last, the outputs do not
exceed the funding value, and `minFee <= fee <= maxFee`.

**Models.** `validateSpend` 311-339 with `validateExpectedOutputs` 238-250 and `validateAnchor` 298-309.

**Abstracted, not proven:**
- `sizeOf` stands for `Buffer.byteLength(rawTxHex, 'hex')` (321); the model does not say it is the serialized length.
- The check that expected scripts are lowercase hex (245) is the parameter `hexAny`.
- Fee-rate (`maxRecoveryFeerateSatPerVb`) is only range-checked in `normalizeFeePolicy`; no spend is checked against it.

### accepted_cet_single_input_funding

**Statement (a).** Every CET of an accepted set has exactly one input, and its outpoint is the funding outpoint.

**Models.** 324-327 (`inputs.length !== 1 || inputs[0].txid !== funding.txid || inputs[0].vout !== funding.vout`),
called for each CET at 379-388.

**Abstracted, not proven:**
- The funding outpoint is whatever the caller committed; nothing here says a transaction with that txid and a
  Taproot output of that value and script exists on chain.

### accepted_refund_single_input_funding

**Statement (a).** The refund has exactly one input, and its outpoint is the funding outpoint.

**Models.** 324-327, called for the refund at 397-409.

**Abstracted, not proven:** same as above.

### accepted_members_pairwise_conflict

**Statement (a).** Any two members of the set (every CET and the refund) have an input with the same outpoint, so
any two of them conflict.

**Models.** The conjunction of 324-327 over all members.

**Abstracted, not proven:**
- Conflict is "share an input outpoint"; the model has no mempool or script semantics.

### accepted_cet_identities_distinct

**Statement (b).** The `(outcomeMessage, oraclePubkeys)` pairs of the CETs of an accepted set are pairwise distinct.

**Models.** 376-378 (`identities` is a `Set` of `outcome:key1:key2..`).

**Abstracted, not proven:**
- The identity string is modelled as the pair; the string join is injective because every field is validated to a fixed 64 lowercase hex characters (369, 371), which the model takes from `hex32`.

### accepted_txids_distinct

**Statement (b).** The txids of all CETs and of the refund are pairwise distinct.

**Models.** 413-416.

**Abstracted, not proven:**
- `txidOf` is not tied to the real double SHA-256; no collision-resistance statement is made (none is needed for this theorem, which reports what the code checked).

### accepted_members_nodup

**Statement (b).** The members of an accepted set are pairwise distinct transactions.

**Models.** 413-416, since equal transactions have equal txids.

**Abstracted, not proven:** none beyond `txidOf` being a function (no `Env` assumption beyond that).

### accepted_refund_sequence_is_committed_csv

**Statement (c).** Every refund input has `nSequence = funding.refundCsv`; that value is in `1..0xffff`; the funding
scriptPubKey equals `fundingScript partyKeys refundCsv`; the refund version is 2 or 3; each refund sequence
satisfies BIP112 for that delay (bit 31 clear, bit 22 clear, `sequence >= csv`); the refund locktime equals
the committed locktime and every CET locktime is strictly below it.

**Models.** `requiredSequence` check 315-317 and 408; CSV range `normalizeRefundCsvBlocks`
(dlc_funding_output.js:85-90, called at :126 from `deriveFundingOutput` 209-215 and `normalizeFunding` 225);
scriptPubKey equality 214; version 83 and 318-320; locktime 328-331 and 410-412. The refund leaf is
`<csv> OP_CHECKSEQUENCEVERIFY OP_DROP <A> OP_CHECKSIGVERIFY <B> OP_CHECKSIG` (dlc_funding_output.js:114-121).

**Abstracted, not proven:**
- That the refund leaf script on chain contains exactly `refundCsv` is not derived here; it follows from the Taproot construction (`fundingScript`), which is a parameter. `accepted_refund_csv_is_unique_commitment` states the binding as a hypothesis.
- The refund leaf has no `OP_CHECKLOCKTIMEVERIFY`: its locktime is checked only against the caller's committed value and the CET locktimes, and is not committed by the leaf.
- The sequence of a CET is not constrained by the validator (CET `nSequence` is any u32 that, with a nonzero locktime, is not all-final).

### accepted_refund_csv_is_unique_commitment

**Statement (c).** Under `CsvBinding env` (a fixed key set and a funding scriptPubKey determine the CSV value), any
`c'` for which `fundingScript keys c'` equals the funding scriptPubKey is the refund's nSequence.

**Models.** The Taproot output commits to the refund leaf through the tweak (dlc_funding_output.js:131-146).

**Abstracted, not proven:**
- `CsvBinding` is a hypothesis; it follows from collision resistance of the tagged SHA-256 hashes TapLeaf, TapBranch and TapTweak (axiom 2). Not discharged here.

### accepted_oracle_subsets_sorted_unique

**Statement (d).** Every CET has at least two oracle keys, each a valid 32-byte hex key, and the keys are strictly increasing.

**Models.** 369-375.

**Abstracted, not proven:**
- The only size requirement is `length >= 2` (370). The validator does not compare the subset size with any threshold, does not require a common size across CETs, and has no upper bound. The equality with the contract's threshold and membership in the pinned oracle set are enforced in `dlc_signing_target.js:185-193` (a different layer, not modelled).
- Byte order of keys is `Nat` order; JS `.sort()` on equal-length lowercase hex is the same order.
- That the keys are valid x-only points is not checked at this layer (371 checks the regex only).

### accepted_same_outcome_have_different_subsets

**Statement (b, duplicate rule).** Two distinct entries of an accepted set with the same `outcomeMessage` have different oracle subsets.

**Models.** 376-378. The rule is "no duplicate `(outcome, subset)`", not "one CET per outcome".

**Abstracted, not proven:**
- Several CETs for one outcome with different oracle subsets remain valid: that is the threshold design. Their locktimes and nSequence can differ; their payouts cannot (next theorem).

### accepted_same_outcome_same_payout

**Statement.** Any two CETs of an accepted set with the same `outcomeMessage` have equal outputs: which threshold subset attests cannot change the payout.

**Models.** The `payoutsByOutcome` check, dlc_transaction_validator.js:371 and :395-399 (after the fix in `30bf8a5`; before it, the validator accepted different payouts for one outcome).

### accepted_at_most_one_member_confirms

**Statement (e).** In any chain model where every outpoint is spent by at most one confirmed transaction (`Chain.spendsOnce`), any two confirmed members of an accepted set are equal, and members are pairwise distinct, so at most one member confirms.

**Models.** 324-327 and 413-416 together with the Bitcoin consensus rule that an outpoint is spent once.

**Abstracted, not proven:**
- The chain model is a hypothesis (`Chain`). Reorgs, mempool replacement and confirmation depth are not modelled: the statement is about one chain state.
- A member that never confirms is not excluded; the statement is exclusivity, not liveness.

### The `example`s

**Statement.** Concrete vectors by `decide` on `vecEnv`: an accepted set with distinct outcomes; the same identity twice rejected even with different nSequence; same outcome, different subsets and the same payout accepted (by nSequence and by locktime); same outcome, different subsets and different payouts rejected; identical bytes rejected; refund sequence 145 against delay 144 rejected (315-317); refund locktime not above the CET locktime rejected (410); one-oracle subset rejected, five-oracle subset accepted (370); unsorted and duplicate subsets rejected (371-373); two inputs rejected (324).

**Models.** The cited lines.

**Abstracted, not proven:** `vecEnv` uses a toy `txidOf` and `fundingScript`; these vectors do not exercise real hashing or Taproot.

## 4. One-shot authorizations and deposit replay — `formal/UTXORefFormal/OneShot.lean`

Lean file: `formal/UTXORefFormal/OneShot.lean`. Code at `5883e03`: `native/dlc-signer/src/main.rs` (signer),
`bitvm3/utxo_referee/dlc_signing_authorization_store.js`, `m1_deposit_indexer.js`, `m1_receipt_ledger.js`.

Atomicity. The signer marker is created by `OpenOptions::new().write(true).create_new(true).open(..)`
(main.rs:961-964), one create-if-absent system call; `consumeOk` and `consumeExists` are single atomic
transitions, so `Signer.Reach` models any interleaving of any number of runs. The host store creates its
marker with `fs.mkdirSync(directory)` (dlc_signing_authorization_store.js:127), one atomic call that raises
`EEXIST`; success of `consume` is decided by that call alone, and the record write (:152) happens after it. No
code path removes a marker (`remove_file`, `remove_dir`: no match in main.rs; the store has no delete).

Cryptographic hypotheses: none are used by any theorem below. Collision resistance of SHA-256 (axiom 2) would
only matter for the converse (a different authorization sharing a marker is refused, which is fail-closed).

### Signer.signer_marker_present_when_signing

**Statement.** In every reachable state (any interleaving, any failures or kills), a process that has computed a presignature (`signed` or `output`) has its digest's marker present in the directory.

**Models.** `consume_authorization` main.rs:947-979 before `adaptor_sign` in `run`, main.rs:1110 then 1126-1131.

**Abstracted, not proven:**
- Signature verification, policy pinning, the clock guard, freshness and the key unprotection are transitions that either occur or are replaced by an abort; nothing about their content is proven.
- A marker removed by an external actor (operator, disk failure) is outside the model.

### Signer.signer_marker_present_before_sign

**Statement.** In every reachable state in which a process is at `consumed` (the state from which the key is unprotected and `adaptor_sign` called), its digest's marker is present.

**Models.** main.rs:1110 (`consume_authorization`) precedes 1111-1131.

**Abstracted, not proven:** same as above.

### Signer.signer_at_most_one_presignature_per_digest

**Statement.** In any reachable state, two processes that have both computed a presignature with the same authorization digest are the same process; this covers runs that fail at any step and a kill after consume and before output.

**Models.** `run` main.rs:1055-1167: `reject_consumed_authorization` (935-945, called 1100), the clock guard and freshness (1103-1109), `consume_authorization` with `create_new` (947-979, called 1110), then signing and output.

**Abstracted, not proven:**
- A presignature is a value computed by `adaptor_sign`; the model does not say two digests cannot yield the same presignature, and it does not say one CET sighash is presigned once: two different authorizations (different digests) over the same CET are presigned independently by this process. The one-per-CET property rests on how authorizations are issued (host store below).
- The digest is `sha256(canonical_json(authorization))` (main.rs:913); the model treats it as an opaque value.

### Signer.signer_consumed_digest_never_signs

**Statement.** A digest present in the directory at the start (consumed by an earlier run) is never consumed or signed by any later run, whatever the interleaving.

**Models.** main.rs:941 (`Ok(_) => Err("already durably consumed")`) and 966-967 (`AlreadyExists`).

**Abstracted, not proven:** the directory at the start is arbitrary; the model does not say which digests earlier runs consumed.

### Signer.signer_at_most_one_presignature_per_authorization

**Statement.** Corollary: if two processes hold the same authorization (`auth i = auth j`) and both computed a presignature, they are the same process.

**Models.** As `signer_at_most_one_presignature_per_digest`.

**Abstracted, not proven:** no collision-resistance hypothesis is needed (one authorization has one digest).

### Signer.step_marker_permanent

**Statement.** No step removes a name from the marker directory.

**Models.** The absence of `remove_file`/`remove_dir` in main.rs; `reject_consumed_authorization` and `consume_authorization` only read and `create_new`.

**Abstracted, not proven:** external deletion.

### Signer.run_signs_marks_digest, Signer.run_consumed_never_signs, Signer.signer_run_sequence_at_most_one_presignature

**Statement.** The sequential `run` function: a run that computes a presignature found the marker absent and leaves it present (`run_signs_marks_digest`); a run for a digest already present never computes one (`run_consumed_never_signs`); over any list of runs with arbitrary failure flags, at most one run computes a presignature for a given digest (`signer_run_sequence_at_most_one_presignature`).

**Models.** main.rs:1096-1131 in order: verify (1096), reject consumed (1100), clock guard and freshness (1103-1109), consume (1110), key and signing (1111-1131); a run that fails before 1110 leaves the directory unchanged, a run that fails after 1110 leaves the marker.

**Abstracted, not proven:** the sequential function has no concurrency; concurrency is covered by `Reach`. The `examples` fix the outcomes of: a first run, a repeat, a run killed after signing (digest consumed, no output), a key failure after consume (digest consumed), a freshness failure before consume (no marker), and a three-run list.

### Host.host_never_consumes_same_pair_twice

**Statement.** Over any sequence of `consume(contractId, authorizationId)` calls, the keys of the calls that returned success are pairwise distinct; the key is a function of the pair, so one pair is never consumed twice.

**Models.** `consume` dlc_signing_authorization_store.js:112-157: `mkdirSync` (127) refuses an existing directory (128-136); `consumptionKey` (46-50).

**Abstracted, not proven:**
- `H` (SHA-256) is a parameter; no hash property is assumed or needed.
- The record content, `recordHash`, the network check and id/hash validation (118-124) are not modelled; each only adds refusals.
- A crash after `mkdirSync` and before the record is written leaves a directory without `consumed.json`; later `consume` calls for that pair are refused at `_readDirectory` (91-93, throws "incomplete consumption marker"), which the model treats as a refusal (`persistFailed`, then `refused`).

### Host.host_consumed_key_never_consumed_again

**Statement.** A key already in the store at the start is never reported consumed by any later call.

**Models.** 127-136.

**Abstracted, not proven:** as above.

### Host.consume_after_created_refused

**Statement.** After a call that created the directory (success or a failed record write), a later call for the same pair is refused.

**Models.** 127-136.

**Abstracted, not proven:** as above.

### Host.keyString_injective, Host.consumption_key_distinct, Host.consume_other_pair_not_refused

**Statement.** For contract ids without `:`, the joined string `${contractId}:${authorizationId}` determines the pair; under SHA-256 binding (the key hash `H` injective, an explicit hypothesis) distinct valid pairs get distinct keys, and consuming one pair never makes another valid pair refused. A contract id containing `:` is refused (`.invalid`).

**Models.** `requireContractId` dlc_signing_authorization_store.js:49-53 and `consumptionKey` (after the fix in `30bf8a5`). Before it, the id pattern allowed `:` in both ids, so `("a:b","c")` and `("a","b:c")` shared a key and the second distinct pair was refused (fail-closed, not a double consumption). Authorization ids still contain `:` (`cet:0:oracle-set:0`); keys of every pair with a colon-free contract id are unchanged, so existing consumption markers stay valid.

**Abstracted, not proven:** `H` is a parameter; its injectivity is the hypothesis, discharged by `UTXORefAxioms.sha256_binding` for the deployed hash.

### Indexer.ledger_live_credit_unique

**Statement.** In any ledger satisfying the invariant (`LedgerInv`), two live deposit events with the same outpoint key have the same depositId.

**Models.** `ReceiptLedger.applyDeposit` m1_receipt_ledger.js:45-80 (duplicate depositId 53-55, outpoint already credited 56-59, map set 66, event set 68) and `rollbackDeposit` 120-155 (outpoint entry deleted when it names this depositId, 141-142).

**Abstracted, not proven:** balances, supply overflow and the `normalizeAmountSats` checks are not modelled. The txid is lower-cased by `depositOutpointKey` (27); the model keys on an opaque value.

### Indexer.ledger_apply_refuses_credited_outpoint, Indexer.ledger_rollback_frees_outpoint, Indexer.ledger_recredit_after_rollback, Indexer.ledger_rolled_back_id_never_credited_again

**Statement.** `applyDeposit` fails for an outpoint that has a live credit (:56-59); after `rollbackDeposit` of a live credit the outpoint map no longer holds the outpoint (:141-142); the same outpoint can then be credited again under a new depositId; the rolled-back depositId can never be credited again (:53-55: events are never deleted).

**Models.** The cited lines.

**Abstracted, not proven:** that a rolled-back outpoint is credited again only if it re-confirms is not enforced by the ledger; a caller that re-observes it under a new depositId obtains a second credit after the first was debited (net one live credit). `rollbackDeposit` can also fail for an insufficient balance (131-135); the model treats that as no step.

### Indexer.indexer_credits_each_outpoint_at_most_once

**Statement.** From an empty indexer and ledger, after any sequence of `observe`, `sync`, `credit` and `rollback` operations (the ledger is only mutated through the indexer), two indexer records in state `credited` with the same outpoint are the same depositId. Invariant (`WInv`): the ledger invariant plus every credited record has a live ledger event with the same outpoint.

**Models.** `ReceiptDepositIndexer.applyConfirmedDepositsToLedger` m1_deposit_indexer.js:187-206 (credit through `ledger.applyDeposit` 193, status set 195), `rollbackDeposit` 208-227 (ledger rollback 221, status 224), `observeDeposit` 74-126, `syncConfirmations` 132-142.

**Abstracted, not proven:**
- The same ledger object is used for every call; a different ledger passed to `applyConfirmedDepositsToLedger` or a direct call to `ledger.rollbackDeposit` is outside the model.
- Confirmation counting is a nondeterministic choice between `observed` and `confirmed`.
- The enforcement is in the ledger's outpoint map (`depositOutpoints`) and, after the fix in `30bf8a5`, also in the indexer (next theorem).

### Indexer.observe_existing_keeps_identity and Indexer.observe_conflict_refused

**Statement.** Re-observing an existing depositId never creates another record, never changes its account, amount or outpoint, leaves the ledger unchanged, fails if the stored record is rolled back, and fails if any of account, outpoint or amount differs.

**Models.** m1_deposit_indexer.js:85-107 (conflict 87-94, rolled back 95-97, update 99-105).

**Abstracted, not proven:** `blockHeight`, confirmations and `targetScriptPubKey` are not modelled.

### Indexer.indexer_one_live_record_per_outpoint, Indexer.second_deposit_id_for_live_outpoint_refused, Indexer.observe_before_rollback_still_refused, Indexer.second_credit_for_same_outpoint_refused

**Statement.** After any operation sequence, two indexer records that are not `rolled_back` and share an outpoint (`txid.toLowerCase():vout`) are the same depositId; a second depositId for a live outpoint is refused (`decide`), also before a rollback; the ledger independently refuses a second credit for a credited outpoint.

**Models.** The outpoint scan in `observeDeposit`, m1_deposit_indexer.js:108-117 (after the fix in `30bf8a5`). Before it, the indexer recorded one outpoint under two depositIds, the ledger refused the second credit, and the stuck `confirmed` record made every later depositId in the sorted credit pass (`getDepositsByStatus`) fail with it.

**Abstracted, not proven:** the outpoint key is an opaque value; the lower-casing of the txid is the code's, shared with `depositOutpointKey` in the ledger.

### Indexer.rollback_then_new_deposit_id_credits_again and Indexer.rolled_back_deposit_id_cannot_be_reobserved

**Statement.** What rollback does to the replay record: rolling back a credited deposit through the indexer debits the ledger and frees the outpoint; the old depositId is `rolled_back` and re-observing it is refused (:95-97); the same outpoint observed under a new depositId can be credited again, once.

**Models.** m1_deposit_indexer.js:208-227, 95-97; m1_receipt_ledger.js:141-142.

**Abstracted, not proven:** whether the chain still contains the deposit at the time of the second credit is not checked by either module.

## 5. BitVM V2 assertion graph — `formal/UTXORefFormal/BitVM.lean`

Module: `formal/UTXORefFormal/BitVM.lean`, namespace `UTXORefFormal.BitVM`. Source commit `5883e03`.
Code paths are relative to `bitvm3/utxo_referee/`.

Build: `LAKE_EXIT=0`, no `sorry`, `admit`, `axiom` or `native_decide`. `#print axioms` on every main
theorem lists only `propext`, `Classical.choice`, `Quot.sound` (or fewer).

### Hypotheses

- `HashBinding H` (`H` injective on wire preimages) is collision resistance of SHA-256 on 32-byte
  strings, the instance of the coordinator's axiom (2). It is a hypothesis of
  `hashBinding_preimage_unique` and `verified_reveals_canonical` only.
- No theorem needs unforgeability (axiom 1): this module contains no signature check.
- The assumption that the unrevealed preimage of a wire stays secret (preimage resistance) is not a
  hypothesis of any theorem; `honest_disprove_leaves_unspendable` and `equivocation_always_punishable`
  state spendability relative to a set of known preimages (`Spendable H K s ws`), and `K` is the set
  of published preimages.

### Coverage of the code (what the disprove leaves reach)

- Gate kinds: all five of `GATES` (`and`, `or`, `xor`, `nand`, `not`); every gate has one leaf per
  input combination, whose output hash is the wrong bit (`tradelayer_bitvm_circuit.js:69-79`,
  `bitvm_trace_v2.js:274-291`).
- Wires: every gate output wire (through its producing gate), every primary input (through
  `buildInputBindingLeavesV2`), and the terminal output (through the output-binding leaf). The
  structure check leaves no other wire: every label is a gate input or output (no orphans) and a
  wire without a producer is a primary input (`bitvm_trace_v2.js:122-125`).
- A gate that lists the same wire twice (`and(x,x)`) gets leaves whose rows ask for both preimages
  of `x`; those leaves are unspendable without equivocation and the rows they cover are the rows no
  single assignment reaches. Coverage of every reachable inconsistency is unaffected.
- `findGateDisproveV2` returns the first fraud only (`bitvm_trace_v2.js:312`); coverage is
  existence of evidence, not enumeration.
- No uncovered inconsistency exists in the model. The one input class that escapes the model's
  guarantee is a non-integer, NaN or string challenge window: finding F1.

### Findings

**F1. `csvSequence` accepts non-integers, NaN and numeric strings; the minimum-window check and the
CSV script then misbehave** (`tradelayer_bitvm_dispute.js:37-40`, `bitvm_assertion_graph_v2.js:248-254`,
`tradelayer_bitvm_dispute.js:25-34` `pushScriptNum`). The Lean model takes `Nat`, so (c) holds there;
the JavaScript guarantee holds for JS numbers that are integers. Reproduced with
`buildBitvmAssertionTemplateV2` on a one-gate circuit (`and(state_checkpoint_valid, payout_vector_exact)`),
`recoveryCsvBlocks: 144`:

- `challengeCsvBlocks: NaN`: accepted (`NaN < 6` and `144 <= NaN` are both false). The settlement
  leaf script begins `00 b2 75 20`, a CSV delay of 0. The same template after a JSON round trip is
  rejected (`null ?? 144` rebuilds with 144, so recovery does not exceed challenge), and the
  graph path rejects it in `toU32` (`utxoref_v2.js:70-76`).
- `challengeCsvBlocks: "7"` (any string `"6"` to `"16"`): accepted, and `verifyBitvmAssertionTemplateV2`
  returns `ok: true` after a JSON round trip. `pushScriptNum` computes `0x50 + n` by string
  concatenation (`"807"`), so the script begins `27 b2 75 20` instead of `57 b2 75 20`: `0x27` pushes
  39 bytes that swallow the CSV opcodes and the operator check, and the remaining bytes are the
  challenger's key read as opcodes. For 20,000 random operator and challenger key pairs, the
  BIP342 scan finds an `OP_SUCCESS` opcode before any push error in 62% of the scripts (the leaf
  is spendable by anyone, with no signature and no delay) and a push error in 36% (the leaf is
  unspendable). The same string passes the numeric comparisons at `bitvm_assertion_graph_v2.js:250`
  and `:752`, and `toU32` normalizes it to 7 on the settlement path. Run end to end with the
  fixture of `bitvm_assertion_graph_v2.test.js` (`buildFixture`, with `challengeCsvBlocks: "7"`):
  `finalizeBitvmAssertionGraphV2` builds the graph, its cooperative-settlement leaf script begins
  `27 b2 75 20` (with `6` it begins `56 b2 75 20`), and `verifyBitvmAssertionGraphV2` on the graph
  after a JSON round trip returns `ok: true`. With `NaN` and `6.5` the graph build throws
  `challengeCsvBlocks must fit u32`.
- `challengeCsvBlocks: 6.5`: accepted at template level; script byte `0x56` (`OP_6`), so the window
  is 6.

A party that verifies a template received as JSON was the exposed party; the live driver
(`btc_testnet4_utxoref_v2_live.js:388`) normalizes its own argument with `toSafeInteger`.

Fixed in `094598d`: `csvSequence` requires an integer in 0..65535 and `pushScriptNum` an integer in
0..2^31-1, so the template builder, `verifyBitvmAssertionTemplateV2` and
`verifyBitvmAssertionGraphV2` refuse `"7"`, `NaN` and `6.5`; tests in
`tradelayer_bitvm_dispute.test.js` and `bitvm_assertion_graph_v2.test.js` cover each case.

**F2. Legacy templates carry no terminal-output leaf** (`bitvm_assertion_graph_v2.js:287`, `:337-343`).
This is the documented design (`legacy-unbound-v2-monitor-only`, verified only when the caller pins
the graph hash, `:355-363`); `legacy_template_has_no_output_leaf` states it. It is not a code defect.

### Theorems

Entries are grouped; every named theorem is listed.

#### Gate truth tables

**`mem_combos`, `mem_invalidRows`, `invalidRows_wrong`**: every input list of the gate's arity is
enumerated by the combination list, `(ins, !f ins)` is an invalid row, and every invalid row has
output `!f ins` and arity-length inputs.
Code: `tradelayer_bitvm_circuit.js:31-37`, `:69-79`.
**Abstracted, not proven:** Booleans are bits `0/1`; the unreachable arity-mismatch case of `GATES[type].f`
is `false`.

#### Verification of the public trace

**`fraudsOf_nil_iff`**: the fraud list is empty exactly when every gate's output equals the gate
applied to its inputs.
**`mem_fraudsOf`**: a listed fraud names a gate of the trace, its input bits, the expected bit and the
revealed bit, and the two differ.
Code: `bitvm_trace_v2.js:257-263`.
**Abstracted, not proven:** the `values` map is the revealed bit of each wire; gate evaluation is
`GateKind.f`.

**`structureCheck_some`**: a successful structure check implies all eight conditions of
`validateCircuitStructure` and fixes the primary inputs and the terminal output.
**`verifyTrace_spec`**: a successful `verifyTrace` implies the gate check, the structure check, the
per-wire hash match, `values = revealed bits`, and `frauds = fraudsOf values gates`.
**`verified_gate_wires`**: a verified trace's gates have arity-correct inputs and known wires.
Code: `bitvm_trace_v2.js:71-84`, `:86-132`, `:223-272`.
**Abstracted, not proven:** the `wireRoot`, `gatesHash`, `bindingHash`, `traceRoot` recomputation
(`:250-253`), the secret-pair scan (`:228`), the `kind`/`version` check (`:225-227`), and the
reveal-set-equals-wire-set check (`:231-233`; `reveal` is total on `labels` in the model); wire
labels are `Nat`; the canonical-gates comparison is `idx = list position`; the sorted order of
labels is not modelled.

**`mem_primary`, `not_primary_of_produced`, `mem_primary_of`**: a label is a primary input exactly
when it is a known wire that no gate outputs.
**`terminal_mem`**: when the structure check holds the terminal output is a known wire.
Code: `bitvm_trace_v2.js:124`, `:126`.
**Abstracted, not proven:** `Array.sort()` order of the primary list.

**`honestTrace_hash_matches`, `honestTrace_verifies`**: a trace built from secret pairs by revealing
the chosen preimage passes the hash check, and over a well-formed circuit passes `verifyPublicTraceV2`
with fraud list `fraudsOf vals gates`.
Code: `bitvm_trace_v2.js:37-51`, `:186-221`.
**Abstracted, not proven:** the RNG and the `preimage0 != preimage1` check (`:42`); that the
commitments of a fresh random wire set are distinct is the hypothesis `StructOk` of
`honestTrace_verifies`.

#### Expected inputs and the template

**`deriveExpected_keys`**: when derivation succeeds its keys are exactly the primary inputs in order and
each bit is the derived bit.
Code: `bitvm_assertion_graph_v2.js:175-197`.
**Abstracted, not proven:** the derivation of a bit from the binding (verified facts, hash bits, payout
bits) is the parameter `d`; the regular expressions and index ranges are not modelled.

**`buildTemplate_spec`**: a built template came from a verified trace, distinct operator and challenger
keys, windows in `[6, 0xffff]` with recovery above challenge, expected inputs from the expectedFor
step, the terminal output recorded iff the template is not legacy, and the leaf list
`gate ++ input ++ (output unless legacy) ++ [traceCommit, settlement, recovery]`.
**`expectedFor_nonlegacy`, `expectedFor_legacy`**: a bound-predicate template's expected inputs are the
derived ones; a legacy template's expected inputs have exactly the primary labels.
**`template_expected_known`, `template_keys_primary`, `template_terminal_known`**: the labels of the
expected inputs are the primary inputs (known wires), and the recorded terminal output is a known wire.
Code: `bitvm_assertion_graph_v2.js:240-348` (checks `:246-256`, expected inputs `:257-271`, leaves
`:274-302`).
**Abstracted, not proven:** network, x-only key validity, the NUMS internal key, the taproot tree,
leaf identifiers and their uniqueness (`:311`), control blocks, the template hash, the settlement and
recovery scripts (opaque leaves), `normalizeExpectedInputs`'s range check, the sorted order of the
expected-input list, and the `?? DEFAULT` defaults (the model takes the defaulted `Nat`).

**`leaf_mem_template`**: a leaf is in a built template iff it is a gate leaf, an input leaf, a
terminal-output leaf (not legacy) or one of the three fixed leaves.
**`gate_leaf_mem`**: for a gate of the trace and an output bit other than the gate's value on the revealed
inputs, the leaf with the revealed inputs and that output is in the gate-leaf set.
**`input_leaf_mem`**: the wrong-bit leaf of every expected input is in the input-leaf set.
**`zipWith_row`, `zip_forall_eq`, `bool_ne_eq_not`**: list and Boolean helpers.
Code: `bitvm_trace_v2.js:274-307`, `bitvm_assertion_graph_v2.js:199-202`.
**Abstracted, not proven:** tapscript bytes: a script is the pair (hash list, challenger key).

#### (c) Challenge window and the terminal-output leaf

**`template_refuses_short_window`**: a challenge window below 6 makes `buildTemplate` fail.
**`template_window_bounds`**: a built template has `6 <= challengeCsv < recoveryCsv <= 0xffff`.
Code: `bitvm_assertion_graph_v2.js:49` (`MIN_CHALLENGE_CSV_BLOCKS = 6`), `:248-254`;
`tradelayer_bitvm_dispute.js:37-40`.
**Abstracted, not proven:** JS numeric types (finding F1).

**`template_requires_output_leaf`**: a bound-predicate template records the circuit's terminal output
and contains its terminal-output disprove leaf (wrong bit 0, expected bit 1).
**`legacy_template_has_no_output_leaf`**: a legacy template has no output leaf, no recorded terminal,
and `findOutputBindingDisproveV2` returns `null` for it.
Code: `bitvm_assertion_graph_v2.js:199-202`, `:287`, `:337-343`, `:869-877`.
**Abstracted, not proven:** the output leaf's script bytes.

**`verified_template_window_and_output`**: a template that `verifyBitvmAssertionTemplateV2` accepts has
window at least 6, is legacy only when the caller allows legacy templates, and a bound-predicate one
contains the terminal-output leaf.
**`verified_template_inputs_derived`**: a verified bound-predicate template's expected inputs are the
inputs the verifier derives from the trace's primary inputs.
**`graph_window_check`**: the graph-level check `max(6, minimum) <= challengeCsv` implies both bounds.
Code: `bitvm_assertion_graph_v2.js:350-381` (legacy `:355-363`, rebuild-and-compare `:377`), `:751-754`.
**Abstracted, not proven:** `canonicalStringify` equality is modelled as equality of the rebuilt
template; `predicatePolicy` string comparison; the graph verifier's remaining checks (settlement,
signatures, witnesses).

#### (a) Soundness of challenge coverage

**`findGate_found_sound`**: evidence returned by `findGateDisproveV2` names a trace gate that is
inconsistent, carries the revealed input bits and the revealed output bit as its row, and the gate
leaf with that row and script is in the template's leaf set.
**`findGate_found_of_bad`**: if some trace gate is inconsistent, `findGateDisproveV2` returns evidence.
**`findInput_found_sound`, `findInput_found_of_bad`, `findOutput_found_sound`,
`findOutput_found_of_bad`**: the same for the input-binding and terminal-output searches, with the leaf
carrying the wrong bit equal to the revealed bit.
**`findBindingAux_found`, `findBindingAux_clean`, `findBindingAux_sound`**: the loop of
`findInputBindingDisproveV2` returns the first mismatch with the revealed wrong-bit script, and returns
nothing exactly when all bindings match.
**`gate_inconsistency_disproved`**: if a revealed gate output differs from the gate applied to its
revealed inputs, `findGateDisproveV2` returns evidence, the gate leaf of that row is in the template,
and a leaf of the template with the evidence's script is a disprove leaf.
**`input_mismatch_disproved`**: if a revealed primary input differs from the verifier-derived expected
bit, `findInputBindingDisproveV2` returns evidence and its input leaf is in the template.
**`terminal_not_one_disproved`**: if the terminal output is not revealed as 1 in a bound-predicate
template, `findOutputBindingDisproveV2` returns evidence and the terminal-output leaf is in the template.
**`any_inconsistency_disproved`**: if any of the three holds, `selectFraudEvidence` returns evidence and
the leaf it spends is in the template, with a disprove leaf of the same script.
Code: `bitvm_trace_v2.js:309-347`, `bitvm_assertion_graph_v2.js:869-899`, `:912-913` (the lookup by
script that `buildBitvmDisproveV2` performs).
**Abstracted, not proven:** the `preimages` witness list is carried but not constrained beyond being
the revealed ones; the transaction, sighash and challenger signature that spend the leaf; the
`Number(expectedValue)` coercion.

#### (b) No false disproof

**`findGate_clean_iff`, `findInput_clean_iff`, `findOutput_clean_iff`**: each search returns `null`
exactly when every gate is consistent, every derived input matches, and the terminal output is 1,
respectively.
**`bindingInputFrauds_zero_iff`, `bindingOutputFrauds_zero_iff`, `bindingFrauds_zero_iff`**:
`bindingFraudsV2` counts zero exactly in those cases.
**`honest_trace_not_disproved`**: for a trace consistent on the derived inputs with terminal output 1,
`findGateDisproveV2`, `findInputBindingDisproveV2`, `findOutputBindingDisproveV2` and
`selectFraudEvidence` all return nothing, and `bindingFraudsV2` is `(0, 0)`; the preimage-to-hash match
is part of the hypothesis that the template built from the verified trace.
**`selectFraud_none_iff`**: `selectFraudEvidence` returns nothing iff the trace is consistent, matches
the derived inputs, and has terminal output 1.
Code: `bitvm_trace_v2.js:309-347`, `bitvm_assertion_graph_v2.js:869-899`, `:879-885`.
**Abstracted, not proven:** a thrown error in the JavaScript (invalid trace) is the `invalid` result
and is excluded by the hypothesis `buildTemplate ... = some T`.

**`revealed_hash_bit`**: a published preimage whose hash equals a committed hash of wire `l` with bit `b`
forces `b` to be `l`'s revealed bit.
**`spendable_hashes`**: every hash a spendable script checks is the hash of a published preimage.
**`honest_disprove_leaves_unspendable`**: for a trace consistent on the derived inputs with terminal
output 1, no gate, input or output disprove leaf of the template can be spent with only the published
preimages.
Code: `bitvm_trace_v2.js:90-103` (commitment uniqueness), `:245-248`;
`tradelayer_bitvm_circuit.js:55-66` (the script checks each listed hash).
**Abstracted, not proven:** that an adversary holds only the published preimages (preimage resistance
of SHA-256 on the unrevealed secret); the challenger signature in the script; script execution.

#### (d) Hash binding and equivocation

**`preimage_determines_bit`**: one preimage cannot match both hashes of a wire whose two commitments
differ, so a reveal fixes the bit. No hypothesis is used beyond the commitments differing.
**`verified_preimage_owner`**: in a verified trace a preimage matches at most one (wire, bit)
commitment.
Code: `bitvm_trace_v2.js:95-103` (`hash0 === hash1` and `commitmentOwners`), `:245-248`.
**Abstracted, not proven:** equality of lowercase hex strings (the code compares `sha256Hex` output with
the stored string, so an upper-case stored hash fails verification and is never accepted).

**`hashBinding_preimage_unique`** (hypothesis `HashBinding`): the preimage that opens a committed hash
is unique.
**`verified_reveals_canonical`** (hypothesis `HashBinding`): two verified traces over the same
commitments that reveal the same values reveal the same preimages.
**`equivocation_two_preimages`**: two reveals of one wire for different bits use different preimages.
Code: `bitvm_trace_v2.js:137` `selectedHash`, `:245-248`.
**Abstracted, not proven:** SHA-256 is a parameter; `HashBinding` is the coordinator's collision
resistance axiom applied to 32-byte inputs.

**`equivocation_always_punishable`**: in a built template over a consistent trace, a second valid reveal
`(b', p')` for any known wire with `b'` different from the revealed bit makes a disprove leaf spendable
from the published preimages together with `p'`: the gate leaf of the producing gate when a gate
outputs the wire, the input-binding leaf when the wire is a primary input.
Code: `bitvm_trace_v2.js:274-307`, `bitvm_assertion_graph_v2.js:240-302`.
**Abstracted, not proven:** how the extra preimage becomes public (the model assumes the operator
publishes it); the on-chain spend.

### Examples (`decide`)

`Examples` mirrors `bitvm_trace_v2.test.js:53-122` (honest trace has no witness; fraudulent trace
`a=1, b=1, c=0` yields the gate evidence with preimages `[1, 3, 4]` and that leaf is in the gate-leaf
set; empty, cyclic, self-feeding and orphan circuits rejected; equal and reused commitments rejected;
tampered reveal rejected) and `bitvm_assertion_graph_v2.test.js:312-370` (windows 0 and 5 refused, 6
accepted; terminal-output fraud with clean gates and inputs; input-binding fraud with clean gates;
leaf counts 10 and 9).

## Build and audit

```sh
cd formal
lake build
lake env leanchecker UTXORefFormal
lake env leanchecker UTXORefAxioms
```

Result with the fixes, lean4 v4.35.0: `Build completed successfully (9 jobs)`,
both `leanchecker` runs exit 0. An axiom audit over every theorem in the two namespaces (923
declarations, `Lean.collectAxioms`) finds only `propext`, `Classical.choice` and `Quot.sound` under
`UTXORefFormal`; the six `UTXORefAxioms` theorems add exactly one of `signatures_unforgeable`
(`deployed_emitted_presignature_validator_signed`, `deployed_adaptor_oracles_signed_announcements`)
or `sha256_binding` (`digest_binding_of_encoding`, `deployed_committed_cet_set_unique`,
`deployed_hash_binding`, `deployed_wire_preimage_unique`). The only axiom declarations are those
two. No file under `formal/` contains `sorry`, `admit` or `native_decide`.

## Findings in the code

The models were written to the code as it is; where the code lacks a property, the theorem states
what holds and the finding names the gap. Details are in each section.

| ID | Where | Finding |
| --- | --- | --- |
| BitVM F1 | `tradelayer_bitvm_dispute.js:37-40`, `bitvm_assertion_graph_v2.js:248-254` | `csvSequence` accepts a numeric string. A template with `challengeCsvBlocks: "7"` passes the 6-block minimum, `pushScriptNum` emits byte `0x27` instead of `OP_7`, the CSV and operator check of the cooperative-settlement leaf become pushed data, and `verifyBitvmAssertionGraphV2` accepts the graph after a JSON round trip. A challenger verifying an operator-supplied graph was exposed. **Fixed in `094598d`**: both helpers require an integer. |
| TxSet | `dlc_transaction_validator.js:376-378` | Two CETs for one outcome with different oracle subsets could carry different `expectedOutputs`, so the attesting subset chose the payout. **Fixed in `30bf8a5`**: CETs for one outcome must have equal outputs (`accepted_same_outcome_same_payout`). Unchanged by design: subsets need at least 2 keys at this layer (threshold equality is checked in `dlc_signing_target.js`); CET nSequence is free; the refund leaf has no CLTV, so the validator, not the leaf, checks the refund locktime. |
| OneShot | `dlc_signing_authorization_store.js:40`, `:49` | The consumption key joined ids with `:` while both ids could contain `:`, so `("a:b","c")` and `("a","b:c")` shared a key (fail-closed). **Fixed in `30bf8a5`**: a contract id containing `:` is refused (`keyString_injective`); existing keys are unchanged. |
| OneShot | `m1_deposit_indexer.js:85`, `:124`; `m1_receipt_ledger.js:56-59` | The indexer recorded one outpoint under two depositIds; the ledger refused the second credit and the stuck record blocked later deposits in the sorted pass. **Fixed in `30bf8a5`**: one live record per outpoint (`indexer_one_live_record_per_outpoint`); rollback still frees the outpoint. |
| OneShot | native/dlc-signer/src/main.rs:935-979 | The signer enforces one presignature per authorization digest, not per CET sighash: two authorizations for one CET are each presigned. Kept by design: each presignature uses a fresh nonce on the same message and adaptor point, which leaks nothing, and a validator re-authorizing after a lost presignature is the recovery path. |
| Adaptor F1, F4 | section 2 | `adaptorSign` returned a presignature with `s0 = 0` (probability about 2^-256) that its own verifier rejects; the signer accepted a two-oracle announcement set that `validateOracleSet` refuses. **Both fixed in `30bf8a5`.** |
| Adaptor F2 | section 2 | `adaptorExtract` refuses a valid signature with a different nonce instead of returning a scalar. Kept: it never returns a wrong scalar (`adaptorExtract_sound`). |

## What is not proven

- There is no refinement proof from the Rust or JavaScript code to the models; the
  correspondence is by reading, with the `file:line` references above.
- Bytes, JSON, hashing, curve arithmetic, transaction parsing and the BIP341 sighash are abstract
  in every model. The two axioms carry the cryptographic content.
- Discrete-log secrecy of an unattested oracle outcome (`Adaptor.OracleSecrecy`) and uniqueness of
  discrete logs (`Adaptor.DlogUnique`) are hypotheses of the oracle-binding theorems, not axioms;
  `OracleSecrecy` fails when every oracle of a CET's subset colludes with a funding party.
- `TxSet.CsvBinding` (one CSV value per funding scriptPubKey) and the injectivity of
  `canonical_json` are hypotheses of the theorems that use them.
- Signing, broadcasting, chain observation, the watchtower and the fee-rescue code are outside
  these models.
