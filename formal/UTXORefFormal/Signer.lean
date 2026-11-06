/-!
# Native DLC signer boundary

Model of the request path of the isolated Rust signer at commit `5883e03`:
`verify_request` (native/dlc-signer/src/main.rs), the signing-target derivation
`derive_signing_target` / `verify_signing_target` (native/dlc-signer/src/signing_target.rs) with
`dlc_funding_output`, `verified_announcement` and `outcome_point`, and the order of `run`
(main.rs): verify the request, refuse a consumed authorization, guard the clock, check
freshness, consume the authorization, load the key, then adaptor-sign.

The theorems say what a presignature the signer emits is a presignature *of*: the BIP341
script-path sighash of a CET that is in the committed CET set, spends the committed funding
outpoint under the CET leaf of the re-derived two-party funding output, for a signer that is a
funding party, under the sum of the oracle outcome points of the CET's announced oracle
subset, all named by a payload that a validator pinned by the signer policy signed.

Abstracted: JSON, base64, hex and canonical-JSON parsing (a request arrives as a record; a
missing or ill-typed field is the corresponding `Option`/check), the hash and digest functions,
the BIP341 sighash, the taproot output derivation, transaction parsing, curve arithmetic, the
Ed25519 and BIP340 verifiers (all fields of `Prims`), and the filesystem, DPAPI and clock steps
of `run` (Boolean results in `Env`). Error values are the Rust messages, abbreviated. The
cryptographic properties are the hypotheses `Unforgeable` and `DigestBinding`, instantiated in
UTXORefAxioms.lean.
-/

set_option autoImplicit false

namespace UTXORefFormal.Signer

/-! ## A guard-and-bind style that keeps each check a separate step -/

abbrev Res := Except String

def check (c : Bool) (msg : String) : Res Unit := if c then .ok () else .error msg

def need {α : Type} (o : Option α) (msg : String) : Res α :=
  match o with
  | some a => .ok a
  | none => .error msg

theorem bind_ok {α β : Type} {x : Res α} {f : α → Res β} {b : β} :
    (x >>= f) = .ok b ↔ ∃ a, x = .ok a ∧ f a = .ok b := by
  cases x <;> simp [bind, Except.bind]

theorem check_ok {c : Bool} {m : String} {u : Unit} : check c m = .ok u ↔ c = true := by
  cases c <;> simp [check]

theorem need_ok {α : Type} {o : Option α} {m : String} {a : α} : need o m = .ok a ↔ o = some a := by
  cases o <;> simp [need]

/-- Peel one `check` off a successful chain. -/
theorem check_then {β : Type} {c : Bool} {m : String} {f : Unit → Res β} {b : β}
    (h : (check c m >>= f) = .ok b) : c = true ∧ f () = .ok b := by
  obtain ⟨u, hu, hf⟩ := bind_ok.mp h
  exact ⟨check_ok.mp hu, hf⟩

theorem need_then {α β : Type} {o : Option α} {m : String} {f : α → Res β} {b : β}
    (h : (need o m >>= f) = .ok b) : ∃ a, o = some a ∧ f a = .ok b := by
  obtain ⟨a, ha, hf⟩ := bind_ok.mp h
  exact ⟨a, need_ok.mp ha, hf⟩

theorem step_then {α β : Type} {x : Res α} {f : α → Res β} {b : β}
    (h : (x >>= f) = .ok b) : ∃ a, x = .ok a ∧ f a = .ok b := bind_ok.mp h

/-- `mapM` over `Res`, written out so its specification is a plain induction. -/
def mapE {α β : Type} (f : α → Res β) : List α → Res (List β)
  | [] => .ok []
  | x :: xs => f x >>= fun y => mapE f xs >>= fun ys => .ok (y :: ys)

theorem mapE_spec {α β : Type} (f : α → Res β) :
    ∀ (xs : List α) (ys : List β), mapE f xs = .ok ys →
      ys.length = xs.length ∧ ∀ y ∈ ys, ∃ x ∈ xs, f x = .ok y := by
  intro xs
  induction xs with
  | nil => intro ys h; simp only [mapE, Except.ok.injEq] at h; subst h; simp
  | cons x xs ih =>
    intro ys h
    obtain ⟨y, hy, h⟩ := step_then h
    obtain ⟨zs, hzs, h⟩ := step_then h
    simp only [Except.ok.injEq] at h
    subst h
    obtain ⟨hl, hm⟩ := ih zs hzs
    refine ⟨by simp [hl], ?_⟩
    intro w hw
    simp only [List.mem_cons] at hw
    rcases hw with rfl | hw
    · exact ⟨x, by simp, hy⟩
    · obtain ⟨v, hv, hfv⟩ := hm w hw
      exact ⟨v, by simp [hv], hfv⟩

/-! ## Records -/

/-- An oracle announcement as `verified_announcement` reads it. `schemaOk`: six fields and the
announcement kind. -/
structure AnnRaw where
  schemaOk : Bool
  eventId : String
  px : Nat
  rx : Nat
  outcomes : List Nat
  signature : Nat
  deriving DecidableEq, Repr

structure Ann where
  eventId : String
  px : Nat
  rx : Nat
  outcomes : List Nat
  deriving DecidableEq, Repr

/-- `transactionSet.funding`. `valueSats` is `none` when it is not a decimal string. -/
structure FundingRaw where
  party : List Nat
  refundCsvBlocks : Nat
  scriptPubKey : Nat
  cetLeafHash : Nat
  refundLeafHash : Nat
  valueSats : Option Nat
  txid : Nat
  vout : Nat
  deriving DecidableEq, Repr

structure CetRaw where
  txid : Nat
  rawTx : Nat
  outcomeMessage : Nat
  oraclePubkeys : List Nat
  deriving DecidableEq, Repr

/-- `signingContext`: `fieldCount` is the number of keys of the context object. -/
structure Context where
  fieldCount : Nat
  cets : List CetRaw
  cetSetDigest : Nat
  funding : FundingRaw
  fundingTemplateDigest : Nat
  cetTxid : Nat
  announcements : List AnnRaw
  deriving DecidableEq, Repr

/-- A parsed unsigned CET: its txid and its single input's outpoint (txid, vout). -/
structure Tx where
  txid : Nat
  input : Nat × Nat
  deriving DecidableEq, Repr

structure FundingOutput where
  scriptPubKey : Nat
  cetLeafHash : Nat
  refundLeafHash : Nat
  deriving DecidableEq, Repr

structure SigningTarget where
  cetTxid : Nat
  sighash : Nat
  adaptor : Nat × Nat
  cetSetDigest : Nat
  fundingTemplateDigest : Nat
  oracleAnnouncementsDigest : Nat
  oracleEventId : String
  fundingScriptPubKey : Nat
  party : List Nat
  deriving DecidableEq, Repr

/-- The parts of the deployed code the model does not define. `Pt` is the curve point type. -/
structure Prims (Pt : Type) where
  /-- `lift_x` succeeds. -/
  validKey : Nat → Bool
  nums : Nat
  /-- `dlc_funding_output` after its guards: the P2TR output of the NUMS internal key with the
  CET leaf `<A> CHECKSIGVERIFY <B> CHECKSIG` and the CSV refund leaf. -/
  taproot : Nat → Nat → Nat → FundingOutput
  digestCets : List CetRaw → Nat
  digestFunding : FundingRaw → Nat
  digestAnns : List AnnRaw → Nat
  parseTx : Nat → Option Tx
  /-- `script_path_sighash(tx, value, scriptPubKey, cet leaf)`: BIP341 SIGHASH_DEFAULT. -/
  sighash : Tx → Nat → Nat → Nat → Nat
  /-- The announcement message `tagged_hash("TradeLayer/dlc/oracle/announcement/v1", ..)`. -/
  annDigest : String → Nat → Nat → List Nat → Nat
  schnorrVerify : Nat → Nat → Nat → Bool
  /-- `outcome_point`: `R + e(R, P, outcome)·P`. -/
  outcomePoint : Ann → Nat → Pt
  add : Pt → Pt → Pt
  identity : Pt
  /-- Affine coordinates; `none` at infinity. -/
  coords : Pt → Option (Nat × Nat)

variable {Pt : Type}

/-! ## `signing_target.rs` -/

/-- `dlc_funding_output`. -/
def dlcFundingOutput (P : Prims Pt) (p0 p1 csv : Nat) : Res FundingOutput :=
  check (decide (p0 < p1)) "partyPubkeyXs must be two distinct keys in ascending order" >>= fun _ =>
  check (P.validKey p0 && P.validKey p1) "a party key is not a valid x-only public key" >>= fun _ =>
  check (decide (1 ≤ csv ∧ csv ≤ 0xffff)) "refundCsvBlocks must be an integer in 1..65535" >>= fun _ =>
  check (decide (p0 ≠ P.nums ∧ p1 ≠ P.nums)) "a party key must not equal the NUMS internal key" >>= fun _ =>
  .ok (P.taproot p0 p1 csv)

/-- `verified_announcement`. -/
def verifiedAnnouncement (P : Prims Pt) (a : AnnRaw) : Res Ann :=
  check a.schemaOk "announcement has the wrong schema" >>= fun _ =>
  check (decide (1 ≤ a.eventId.utf8ByteSize ∧ a.eventId.utf8ByteSize ≤ 256))
    "eventId must be 1..256 bytes" >>= fun _ =>
  check (decide (a.outcomes ≠ [] ∧ a.outcomes.length ≤ 1024))
    "outcomeMessages must be non-empty" >>= fun _ =>
  check (decide a.outcomes.Nodup) "outcomes must be unique" >>= fun _ =>
  check (P.schnorrVerify a.px (P.annDigest a.eventId a.px a.rx a.outcomes) a.signature)
    "signature does not verify under its oracle key" >>= fun _ =>
  .ok ⟨a.eventId, a.px, a.rx, a.outcomes⟩

/-- `announcements.windows(2).any(|pair| pair[0].px >= pair[1].px)` is false. -/
def strictlySorted : List Nat → Bool
  | a :: b :: rest => decide (a < b) && strictlySorted (b :: rest)
  | _ => true

/-- The loop over the CET's oracle subset (signing_target.rs:608-621): keys strictly
increasing, each key announced, the CET outcome committed by its announcement, outcome points
summed from the identity. -/
def subsetPoint (P : Prims Pt) (anns : List Ann) (outcome : Nat) :
    Option Nat → List Nat → Pt → Res Pt
  | _, [], acc => .ok acc
  | prev, k :: ks, acc =>
    check (!(prev.any (fun p => decide (p ≥ k)))) "CET oracle subset must be sorted and unique" >>= fun _ =>
    need (anns.find? (fun a => a.px == k)) "CET oracle is not in the announcement set" >>= fun a =>
    check (decide (outcome ∈ a.outcomes))
      "CET outcome is not committed by the oracle announcement" >>= fun _ =>
    subsetPoint P anns outcome (some k) ks (P.add acc (P.outcomePoint a outcome))

/-- `derive_signing_target`. -/
def deriveSigningTarget (P : Prims Pt) (c : Context) : Res SigningTarget :=
  check (decide (c.fieldCount = 3))
    "signingContext must contain transactionSet, cetTxid and oracleAnnouncements" >>= fun _ =>
  check (decide (c.cets ≠ [] ∧ c.cets.length ≤ 4096)) "transactionSet must contain 1..4096 CETs" >>= fun _ =>
  check (decide (c.cetSetDigest = P.digestCets c.cets))
    "transactionSet cetSetDigest does not match its CETs" >>= fun _ =>
  check (decide (c.fundingTemplateDigest = P.digestFunding c.funding))
    "transactionSet fundingTemplateDigest does not match its funding" >>= fun _ =>
  need (match c.funding.party with | [p0, p1] => some (p0, p1) | _ => none)
    "funding.partyPubkeyXs must contain exactly two keys" >>= fun keys =>
  dlcFundingOutput P keys.1 keys.2 c.funding.refundCsvBlocks >>= fun out =>
  check (decide (c.funding.scriptPubKey = out.scriptPubKey))
    "funding scriptPubKey is not the two-party DLC output" >>= fun _ =>
  check (decide (c.funding.cetLeafHash = out.cetLeafHash ∧ c.funding.refundLeafHash = out.refundLeafHash))
    "funding leaf hashes do not match the two-party output" >>= fun _ =>
  need c.funding.valueSats "funding.valueSats must be a decimal string" >>= fun value =>
  check (decide (c.funding.vout < 2 ^ 32)) "funding.vout is out of range" >>= fun _ =>
  need (c.cets.find? (fun t => t.txid == c.cetTxid))
    "signing context CET is absent from the committed CET set" >>= fun cet =>
  need (P.parseTx cet.rawTx) "CET rawTxHex is not a canonical unsigned transaction" >>= fun tx =>
  check (decide (tx.txid = c.cetTxid)) "CET rawTxHex does not hash to the named txid" >>= fun _ =>
  check (decide (tx.input = (c.funding.txid, c.funding.vout)))
    "CET does not spend the committed funding outpoint" >>= fun _ =>
  check (decide (2 ≤ c.announcements.length ∧ c.announcements.length ≤ 16))
    "oracleAnnouncements must contain 2..16 announcements" >>= fun _ =>
  mapE (verifiedAnnouncement P) c.announcements >>= fun anns =>
  check (strictlySorted (anns.map (·.px)))
    "oracleAnnouncements must be sorted by distinct oracle key" >>= fun _ =>
  need anns.head? "oracleAnnouncements must contain 2..16 announcements" >>= fun first =>
  check (anns.all (fun a => a.eventId == first.eventId && a.outcomes == first.outcomes))
    "oracle announcements must commit to the same event and ordered outcome set" >>= fun _ =>
  check (decide (2 ≤ cet.oraclePubkeys.length))
    "CET oracle subset must contain at least two oracles" >>= fun _ =>
  subsetPoint P anns cet.outcomeMessage none cet.oraclePubkeys P.identity >>= fun pt =>
  need (P.coords pt) "combined oracle outcome point is infinity" >>= fun xy =>
  .ok { cetTxid := c.cetTxid, sighash := P.sighash tx value out.scriptPubKey out.cetLeafHash,
        adaptor := xy, cetSetDigest := P.digestCets c.cets,
        fundingTemplateDigest := P.digestFunding c.funding,
        oracleAnnouncementsDigest := P.digestAnns c.announcements,
        oracleEventId := first.eventId, fundingScriptPubKey := out.scriptPubKey,
        party := [keys.1, keys.2] }

/-! ## `main.rs` -/

/-- The thirteen payload fields `verify_request` requires the request to repeat. -/
structure Named where
  contractId : Nat
  contractDigest : Nat
  stateRecordHash : Nat
  transcriptHash : Nat
  cetSetDigest : Nat
  network : String
  stage : String
  signerPubkeyX : Nat
  cetTxid : Nat
  fundingTemplateDigest : Nat
  oracleAnnouncementsDigest : Nat
  oracleEventId : String
  sighash : Nat
  deriving DecidableEq, Repr

/-- The validator-signed authorization payload (decoded from `authorizationPayload`). -/
structure Payload where
  kind : String
  named : Named
  revision : Nat
  authorizationId : Nat
  adaptor : Nat × Nat
  issuedAt : Nat
  expiresAt : Nat
  deriving DecidableEq, Repr

structure Authorization where
  kind : String
  authorizationId : Nat
  stateRecordHash : Nat
  signerPubkeyX : Nat
  sighash : Nat
  cetTxid : Nat
  oracleAnnouncementsDigest : Nat
  adaptor : Nat × Nat
  validatorKeyId : Nat
  signature : Nat
  issuedAt : Nat
  expiresAt : Nat
  deriving DecidableEq, Repr

/-- The sign request. `hostSecret`: the request carries `secret` or `keyHandle`. -/
structure Request where
  kind : String
  hostSecret : Bool
  authorization : Option Authorization
  payloadBytes : List Nat
  named : Named
  revision : Nat
  adaptor : Nat × Nat
  validatorSpki : Nat
  authorizationDigest : Nat
  signingContext : Option Context
  deriving Repr

/-- The audited signer policy (`load_validator_policy`). -/
structure Policy where
  network : String
  signerPubkeys : List Nat
  validatorKeyIds : List Nat

/-- Parsing and signature primitives of `main.rs`. -/
structure MainPrims where
  /-- base64 decode then JSON parse of the payload. -/
  decode : List Nat → Option Payload
  canonical : Payload → List Nat
  /-- `ed25519_public_from_spki`: the verifying key and its key id. -/
  spki : Nat → Option (Nat × Nat)
  edVerify : Nat → List Nat → Nat → Bool
  /-- `sha256_hex(canonical_json(authorization))`. -/
  authDigest : Authorization → Nat

def SIGN_REQUEST_KIND : String := "utxoref_dlc_native_adaptor_sign_request_v2"
def AUTHORIZATION_KIND : String := "utxoref_dlc_adaptor_sign_authorization_v4"
def SIGNABLE_STAGE : String := "COUNTERPARTY_SIGNATURES_VERIFIED"
def MAX_AUTHORIZATION_TTL_SECONDS : Nat := 300

/-- `verify_signing_target`. -/
def verifySigningTarget (P : Prims Pt) (r : Request) (p : Payload) : Res SigningTarget :=
  need r.signingContext "signingContext is required" >>= fun c =>
  deriveSigningTarget P c >>= fun t =>
  check (t.party.contains p.named.signerPubkeyX)
    "signer is not a party to the two-party DLC funding output" >>= fun _ =>
  check (decide (p.named.cetTxid = t.cetTxid ∧ r.named.cetTxid = t.cetTxid ∧
      p.named.cetSetDigest = t.cetSetDigest ∧ r.named.cetSetDigest = t.cetSetDigest ∧
      p.named.fundingTemplateDigest = t.fundingTemplateDigest ∧
      r.named.fundingTemplateDigest = t.fundingTemplateDigest ∧
      p.named.oracleAnnouncementsDigest = t.oracleAnnouncementsDigest ∧
      r.named.oracleAnnouncementsDigest = t.oracleAnnouncementsDigest ∧
      p.named.oracleEventId = t.oracleEventId ∧ r.named.oracleEventId = t.oracleEventId ∧
      p.named.sighash = t.sighash ∧ r.named.sighash = t.sighash))
    "signed value differs from the value derived from the signing context" >>= fun _ =>
  check (decide (p.adaptor = t.adaptor ∧ r.adaptor = t.adaptor))
    "signed adaptor point differs from the oracle outcome point of the CET" >>= fun _ =>
  .ok t

structure Verified where
  signer : Nat
  message : Nat
  adaptor : Nat × Nat
  authorizationDigest : Nat
  issuedAt : Nat
  expiresAt : Nat
  deriving DecidableEq, Repr

/-- `verify_request`, with `now` the value `current_unix_seconds` returns and `skew`
`MAX_AUTHORIZATION_CLOCK_SKEW_SECONDS`. -/
def verifyRequest (P : Prims Pt) (M : MainPrims) (pol : Policy) (skew now : Nat) (r : Request) :
    Res Verified :=
  check (r.kind == SIGN_REQUEST_KIND) "wrong native adaptor signing request kind" >>= fun _ =>
  check (!r.hostSecret) "host-supplied secrets and key handles are forbidden" >>= fun _ =>
  need r.authorization "authorization is required" >>= fun a =>
  check (a.kind == AUTHORIZATION_KIND) "wrong adaptor signing authorization kind" >>= fun _ =>
  need (M.decode r.payloadBytes) "authorization payload does not parse" >>= fun p =>
  check (M.canonical p == r.payloadBytes) "authorization payload is not canonical JSON" >>= fun _ =>
  check (p.kind == AUTHORIZATION_KIND) "wrong signed authorization kind" >>= fun _ =>
  check (p.named.network == pol.network)
    "authorization network is not permitted by the audited signer policy" >>= fun _ =>
  check (pol.signerPubkeys.contains p.named.signerPubkeyX)
    "signer public key is not pinned by the audited signer policy" >>= fun _ =>
  check (p.named == r.named) "signed field differs from native request" >>= fun _ =>
  check (p.revision == r.revision) "signed revision differs from native request" >>= fun _ =>
  check (decide (p.authorizationId = a.authorizationId ∧
      p.named.stateRecordHash = a.stateRecordHash ∧ p.named.signerPubkeyX = a.signerPubkeyX ∧
      p.named.sighash = a.sighash))
    "authorization object differs from its signed payload" >>= fun _ =>
  check (decide (p.named.cetTxid = a.cetTxid ∧
      p.named.oracleAnnouncementsDigest = a.oracleAnnouncementsDigest))
    "authorization object differs from its signed payload" >>= fun _ =>
  check (decide (p.adaptor = r.adaptor ∧ p.adaptor = a.adaptor))
    "adaptor point differs from signed authorization" >>= fun _ =>
  need (M.spki r.validatorSpki) "validatorPublicKeySpki is not an Ed25519 key" >>= fun vk =>
  check (pol.validatorKeyIds.contains vk.2)
    "validator identity is not pinned by the audited signer policy" >>= fun _ =>
  check (a.validatorKeyId == vk.2)
    "authorization validator key ID differs from its public key" >>= fun _ =>
  check (M.edVerify vk.1 r.payloadBytes a.signature)
    "validator authorization signature is invalid" >>= fun _ =>
  check (decide (p.issuedAt = a.issuedAt ∧ p.expiresAt = a.expiresAt))
    "authorization lifetime differs from its signed payload" >>= fun _ =>
  check (decide (p.issuedAt < p.expiresAt ∧ p.expiresAt - p.issuedAt ≤ MAX_AUTHORIZATION_TTL_SECONDS))
    "signing authorization lifetime must be 1..300 seconds" >>= fun _ =>
  check (decide (p.issuedAt ≤ now + skew)) "signing authorization is not yet valid" >>= fun _ =>
  check (decide (now ≤ p.expiresAt)) "signing authorization has expired" >>= fun _ =>
  check (decide (M.authDigest a = r.authorizationDigest)) "authorization digest mismatch" >>= fun _ =>
  check (p.named.stage == SIGNABLE_STAGE) "authorization stage is not signable" >>= fun _ =>
  verifySigningTarget P r p >>= fun t =>
  .ok { signer := r.named.signerPubkeyX, message := t.sighash, adaptor := t.adaptor,
        authorizationDigest := M.authDigest a, issuedAt := p.issuedAt, expiresAt := p.expiresAt }

/-- The side-effecting steps of `run` between verification and signing, as results. -/
structure Env where
  /-- `reject_consumed_authorization`: no marker for the digest. -/
  notConsumed : Nat → Bool
  /-- `guard_signer_clock`: the guarded time, or a refusal. -/
  guardedNow : Option Nat
  /-- `consume_authorization`: the create-new marker write and fsync succeed. -/
  consume : Nat → Bool
  /-- The DPAPI key for the signer loads and derives the authorized public key. -/
  keyMatches : Nat → Bool

/-- What `run` writes: an adaptor presignature by `signer` on `message` under `adaptor`. -/
structure Emitted where
  signer : Nat
  message : Nat
  adaptor : Nat × Nat
  authorizationDigest : Nat
  deriving DecidableEq, Repr

/-- `run` from `verify_request` to `adaptor_sign` (main.rs:1096-1131). -/
def run (P : Prims Pt) (M : MainPrims) (pol : Policy) (skew now : Nat) (E : Env) (r : Request) :
    Res Emitted :=
  verifyRequest P M pol skew now r >>= fun v =>
  check (E.notConsumed v.authorizationDigest) "signer authorization was already durably consumed" >>= fun _ =>
  need E.guardedNow "signer clock guard refused" >>= fun g =>
  check (decide (v.issuedAt ≤ g + skew)) "signing authorization is not yet valid" >>= fun _ =>
  check (decide (g ≤ v.expiresAt)) "signing authorization has expired" >>= fun _ =>
  check (E.consume v.authorizationDigest) "could not consume signer authorization" >>= fun _ =>
  check (E.keyMatches v.signer) "DLC signer key does not match the authorized public key" >>= fun _ =>
  .ok ⟨v.signer, v.message, v.adaptor, v.authorizationDigest⟩

/-! ## Specifications of the steps -/

theorem dlcFundingOutput_spec (P : Prims Pt) (p0 p1 csv : Nat) (out : FundingOutput)
    (h : dlcFundingOutput P p0 p1 csv = .ok out) :
    p0 < p1 ∧ P.validKey p0 = true ∧ P.validKey p1 = true ∧ 1 ≤ csv ∧ csv ≤ 0xffff ∧
      p0 ≠ P.nums ∧ p1 ≠ P.nums ∧ out = P.taproot p0 p1 csv := by
  unfold dlcFundingOutput at h
  obtain ⟨h1, h⟩ := check_then h
  obtain ⟨h2, h⟩ := check_then h
  obtain ⟨h3, h⟩ := check_then h
  obtain ⟨h4, h⟩ := check_then h
  simp only [Except.ok.injEq] at h
  simp only [decide_eq_true_eq, Bool.and_eq_true] at h1 h2 h3 h4
  exact ⟨h1, h2.1, h2.2, h3.1, h3.2, h4.1, h4.2, h.symm⟩

theorem verifiedAnnouncement_spec (P : Prims Pt) (a : AnnRaw) (b : Ann)
    (h : verifiedAnnouncement P a = .ok b) :
    b = ⟨a.eventId, a.px, a.rx, a.outcomes⟩ ∧ a.schemaOk = true ∧ a.outcomes ≠ [] ∧
      a.outcomes.Nodup ∧
      P.schnorrVerify a.px (P.annDigest a.eventId a.px a.rx a.outcomes) a.signature = true := by
  unfold verifiedAnnouncement at h
  obtain ⟨h1, h⟩ := check_then h
  obtain ⟨_, h⟩ := check_then h
  obtain ⟨h3, h⟩ := check_then h
  obtain ⟨h4, h⟩ := check_then h
  obtain ⟨h5, h⟩ := check_then h
  simp only [Except.ok.injEq] at h
  simp only [decide_eq_true_eq] at h3 h4
  exact ⟨h.symm, h1, h3.1, h4, h5⟩

/-- Keys after `prev`, strictly increasing. -/
def Increasing : Option Nat → List Nat → Prop
  | _, [] => True
  | prev, k :: ks => (∀ p, prev = some p → p < k) ∧ Increasing (some k) ks

/-- The specification of the subset loop: the keys are strictly increasing, each is the key of
an announcement that commits to the outcome, and the result is the sum of their outcome points
added to the start value in order. -/
theorem subsetPoint_spec (P : Prims Pt) (anns : List Ann) (o : Nat) :
    ∀ (keys : List Nat) (prev : Option Nat) (acc pt : Pt),
      subsetPoint P anns o prev keys acc = .ok pt →
      Increasing prev keys ∧
      ∃ used : List Ann, used.map (·.px) = keys ∧ (∀ a ∈ used, a ∈ anns ∧ o ∈ a.outcomes) ∧
        pt = used.foldl (fun s a => P.add s (P.outcomePoint a o)) acc := by
  intro keys
  induction keys with
  | nil =>
    intro prev acc pt h
    simp only [subsetPoint, Except.ok.injEq] at h
    exact ⟨trivial, [], rfl, by simp, by simp [h]⟩
  | cons k ks ih =>
    intro prev acc pt h
    simp only [subsetPoint] at h
    obtain ⟨hs, h⟩ := check_then h
    obtain ⟨a, ha, h⟩ := need_then h
    obtain ⟨ho, h⟩ := check_then h
    obtain ⟨hinc, used, hmap, hmem, hpt⟩ := ih (some k) _ pt h
    have hfind := List.find?_some ha
    have hain := List.mem_of_find?_eq_some ha
    simp only [beq_iff_eq] at hfind
    refine ⟨⟨?_, hinc⟩, a :: used, by simp [hmap, hfind], ?_, by simp [hpt]⟩
    · intro p hp
      subst hp
      simp only [Option.any_some, Bool.not_eq_eq_eq_not, Bool.not_true,
        decide_eq_false_iff_not, Nat.not_le] at hs
      exact hs
    · intro b hb
      simp only [List.mem_cons] at hb
      rcases hb with rfl | hb
      · exact ⟨hain, by simpa using ho⟩
      · exact hmem b hb

/-- Everything `derive_signing_target` establishes about its result. -/
structure TargetOf (P : Prims Pt) (c : Context) (t : SigningTarget) : Prop where
  cets_bound : c.cets ≠ [] ∧ c.cets.length ≤ 4096
  cet_set_digest : c.cetSetDigest = P.digestCets c.cets ∧ t.cetSetDigest = P.digestCets c.cets
  funding_digest : c.fundingTemplateDigest = P.digestFunding c.funding ∧
    t.fundingTemplateDigest = P.digestFunding c.funding
  announcements_digest : t.oracleAnnouncementsDigest = P.digestAnns c.announcements
  cet_txid : t.cetTxid = c.cetTxid
  /-- The named CET is in the committed set, hashes to its txid and spends the funding
  outpoint; the sighash is the CET-leaf script-path sighash of the re-derived funding output
  for the funding value; the signer's party keys are the funding's. -/
  cet : ∃ cet ∈ c.cets, ∃ (tx : Tx) (p0 p1 value : Nat) (out : FundingOutput),
    cet.txid = c.cetTxid ∧ P.parseTx cet.rawTx = some tx ∧ tx.txid = c.cetTxid ∧
    tx.input = (c.funding.txid, c.funding.vout) ∧ c.funding.party = [p0, p1] ∧
    dlcFundingOutput P p0 p1 c.funding.refundCsvBlocks = .ok out ∧
    c.funding.scriptPubKey = out.scriptPubKey ∧ c.funding.cetLeafHash = out.cetLeafHash ∧
    c.funding.valueSats = some value ∧
    t.sighash = P.sighash tx value out.scriptPubKey out.cetLeafHash ∧
    t.fundingScriptPubKey = out.scriptPubKey ∧ t.party = [p0, p1] ∧
    -- The adaptor point is the sum of the outcome points of the CET's oracle subset: at
    -- least two strictly increasing keys, each a verified announcement for the CET outcome,
    -- all announcements of one event.
    ∃ (anns used : List Ann) (pt : Pt),
      mapE (verifiedAnnouncement P) c.announcements = .ok anns ∧
      2 ≤ c.announcements.length ∧ 2 ≤ cet.oraclePubkeys.length ∧
      Increasing none cet.oraclePubkeys ∧ used.map (·.px) = cet.oraclePubkeys ∧
      (∀ a ∈ used, a ∈ anns ∧ cet.outcomeMessage ∈ a.outcomes ∧ a.eventId = t.oracleEventId) ∧
      pt = used.foldl (fun s a => P.add s (P.outcomePoint a cet.outcomeMessage)) P.identity ∧
      P.coords pt = some t.adaptor

theorem deriveSigningTarget_spec (P : Prims Pt) (c : Context) (t : SigningTarget)
    (h : deriveSigningTarget P c = .ok t) : TargetOf P c t := by
  unfold deriveSigningTarget at h
  obtain ⟨_, h⟩ := check_then h
  obtain ⟨hcets, h⟩ := check_then h
  obtain ⟨hcsd, h⟩ := check_then h
  obtain ⟨hftd, h⟩ := check_then h
  obtain ⟨keys, hkeys, h⟩ := need_then h
  obtain ⟨out, hout, h⟩ := step_then h
  obtain ⟨hspk, h⟩ := check_then h
  obtain ⟨hleaf, h⟩ := check_then h
  obtain ⟨value, hvalue, h⟩ := need_then h
  obtain ⟨_, h⟩ := check_then h
  obtain ⟨cet, hcet, h⟩ := need_then h
  obtain ⟨tx, htx, h⟩ := need_then h
  obtain ⟨htxid, h⟩ := check_then h
  obtain ⟨hin, h⟩ := check_then h
  obtain ⟨hann, h⟩ := check_then h
  obtain ⟨anns, hanns, h⟩ := step_then h
  obtain ⟨_, h⟩ := check_then h
  obtain ⟨first, hfirst, h⟩ := need_then h
  obtain ⟨hall, h⟩ := check_then h
  obtain ⟨hsub, h⟩ := check_then h
  obtain ⟨pt, hpt, h⟩ := step_then h
  obtain ⟨xy, hxy, h⟩ := need_then h
  simp only [Except.ok.injEq] at h
  subst h
  simp only [decide_eq_true_eq] at hcets hcsd hftd hspk hleaf htxid hin hann hsub
  obtain ⟨p0, p1⟩ := keys
  have hparty : c.funding.party = [p0, p1] := by
    revert hkeys
    match c.funding.party with
    | [a, b] => intro hk; simp only [Option.some.injEq, Prod.mk.injEq] at hk; rw [hk.1, hk.2]
    | [] => intro hk; cases hk
    | [_] => intro hk; cases hk
    | _ :: _ :: _ :: _ => intro hk; cases hk
  have hfind := List.find?_some hcet
  simp only [beq_iff_eq] at hfind
  obtain ⟨hinc, used, hmap, hmem, hfold⟩ := subsetPoint_spec P anns cet.outcomeMessage _ none _ pt hpt
  refine ⟨hcets, ⟨hcsd, rfl⟩, ⟨hftd, rfl⟩, rfl, rfl, ⟨cet, List.mem_of_find?_eq_some hcet, tx, p0, p1,
    value, out, hfind, htx, htxid, hin, hparty, hout, hspk, hleaf.1, hvalue, rfl, rfl, rfl,
    anns, used, pt, hanns, hann.1, hsub, hinc, hmap, ?_, hfold, hxy⟩⟩
  intro a ha
  obtain ⟨hain, hao⟩ := hmem a ha
  refine ⟨hain, hao, ?_⟩
  simp only [List.all_eq_true, Bool.and_eq_true, beq_iff_eq] at hall
  exact (hall a hain).1

theorem verifySigningTarget_spec (P : Prims Pt) (r : Request) (p : Payload) (t : SigningTarget)
    (h : verifySigningTarget P r p = .ok t) :
    ∃ c, r.signingContext = some c ∧ TargetOf P c t ∧ p.named.signerPubkeyX ∈ t.party ∧
      p.named.cetTxid = t.cetTxid ∧ p.named.cetSetDigest = t.cetSetDigest ∧
      p.named.fundingTemplateDigest = t.fundingTemplateDigest ∧
      p.named.oracleAnnouncementsDigest = t.oracleAnnouncementsDigest ∧
      p.named.oracleEventId = t.oracleEventId ∧ p.named.sighash = t.sighash ∧
      p.adaptor = t.adaptor ∧ r.adaptor = t.adaptor := by
  unfold verifySigningTarget at h
  obtain ⟨c, hc, h⟩ := need_then h
  obtain ⟨t', ht, h⟩ := step_then h
  obtain ⟨hparty, h⟩ := check_then h
  obtain ⟨heq, h⟩ := check_then h
  obtain ⟨hpt, h⟩ := check_then h
  simp only [Except.ok.injEq] at h
  subst h
  simp only [decide_eq_true_eq] at heq hpt
  simp only [List.contains_iff_mem] at hparty
  exact ⟨c, hc, deriveSigningTarget_spec P c t' ht, hparty, heq.1, heq.2.2.1, heq.2.2.2.2.1,
    heq.2.2.2.2.2.2.1, heq.2.2.2.2.2.2.2.2.1, heq.2.2.2.2.2.2.2.2.2.2.1, hpt.1, hpt.2⟩

/-- Everything `verify_request` establishes. -/
structure VerifiedOf (P : Prims Pt) (M : MainPrims) (pol : Policy) (r : Request) (v : Verified) :
    Prop where
  facts : ∃ (a : Authorization) (p : Payload) (vk : Nat × Nat) (c : Context) (t : SigningTarget),
    r.authorization = some a ∧ M.decode r.payloadBytes = some p ∧ M.canonical p = r.payloadBytes ∧
    p.kind = AUTHORIZATION_KIND ∧ p.named = r.named ∧ p.named.network = pol.network ∧
    p.named.signerPubkeyX ∈ pol.signerPubkeys ∧ p.named.stage = SIGNABLE_STAGE ∧
    M.spki r.validatorSpki = some vk ∧ vk.2 ∈ pol.validatorKeyIds ∧ a.validatorKeyId = vk.2 ∧
    M.edVerify vk.1 r.payloadBytes a.signature = true ∧
    p.issuedAt < p.expiresAt ∧ p.expiresAt - p.issuedAt ≤ MAX_AUTHORIZATION_TTL_SECONDS ∧
    v.authorizationDigest = M.authDigest a ∧ r.authorizationDigest = M.authDigest a ∧
    a.sighash = p.named.sighash ∧ a.cetTxid = p.named.cetTxid ∧ a.adaptor = p.adaptor ∧
    v.issuedAt = p.issuedAt ∧ v.expiresAt = p.expiresAt ∧
    r.signingContext = some c ∧ TargetOf P c t ∧ v.signer = p.named.signerPubkeyX ∧
    v.signer ∈ t.party ∧ v.message = t.sighash ∧ v.adaptor = t.adaptor ∧
    p.named.sighash = t.sighash ∧ p.adaptor = t.adaptor ∧ p.named.cetTxid = t.cetTxid ∧
    p.named.cetSetDigest = t.cetSetDigest ∧ p.named.fundingTemplateDigest = t.fundingTemplateDigest ∧
    p.named.oracleAnnouncementsDigest = t.oracleAnnouncementsDigest ∧
    p.named.oracleEventId = t.oracleEventId

theorem verifyRequest_spec (P : Prims Pt) (M : MainPrims) (pol : Policy) (skew now : Nat)
    (r : Request) (v : Verified) (h : verifyRequest P M pol skew now r = .ok v) :
    VerifiedOf P M pol r v := by
  unfold verifyRequest at h
  obtain ⟨_, h⟩ := check_then h
  obtain ⟨_, h⟩ := check_then h
  obtain ⟨a, ha, h⟩ := need_then h
  obtain ⟨_, h⟩ := check_then h
  obtain ⟨p, hp, h⟩ := need_then h
  obtain ⟨hcan, h⟩ := check_then h
  obtain ⟨hkind, h⟩ := check_then h
  obtain ⟨hnet, h⟩ := check_then h
  obtain ⟨hsigner, h⟩ := check_then h
  obtain ⟨hnamed, h⟩ := check_then h
  obtain ⟨_, h⟩ := check_then h
  obtain ⟨hauth, h⟩ := check_then h
  obtain ⟨hauth2, h⟩ := check_then h
  obtain ⟨hpoint, h⟩ := check_then h
  obtain ⟨vk, hvk, h⟩ := need_then h
  obtain ⟨hpin, h⟩ := check_then h
  obtain ⟨hkid, h⟩ := check_then h
  obtain ⟨hsig, h⟩ := check_then h
  obtain ⟨_, h⟩ := check_then h
  obtain ⟨hwin, h⟩ := check_then h
  obtain ⟨_, h⟩ := check_then h
  obtain ⟨_, h⟩ := check_then h
  obtain ⟨hdig, h⟩ := check_then h
  obtain ⟨hstage, h⟩ := check_then h
  obtain ⟨t, ht, h⟩ := step_then h
  simp only [Except.ok.injEq] at h
  subst h
  simp only [beq_iff_eq, List.contains_iff_mem] at hcan hkind hnet hsigner hnamed hpin hkid hstage
  simp only [decide_eq_true_eq] at hauth hauth2 hpoint hwin hdig
  obtain ⟨c, hc, htarget, hparty, hcet, hcsd, hftd, hoad, hevent, hsh, hpa, _⟩ :=
    verifySigningTarget_spec P r p t ht
  have hsr : r.named.signerPubkeyX = p.named.signerPubkeyX := by rw [hnamed]
  exact ⟨⟨a, p, vk, c, t, ha, hp, hcan, hkind, hnamed, hnet, hsigner, hstage, hvk, hpin, hkid, hsig,
    hwin.1, hwin.2, rfl, hdig.symm, hauth.2.2.2.symm, hauth2.1.symm, hpoint.2.symm, rfl, rfl, hc,
    htarget, hsr, by rw [hsr]; exact hparty, rfl, rfl, hsh, hpa, hcet, hcsd, hftd, hoad, hevent⟩⟩

theorem run_spec (P : Prims Pt) (M : MainPrims) (pol : Policy) (skew now : Nat) (E : Env)
    (r : Request) (e : Emitted) (h : run P M pol skew now E r = .ok e) :
    ∃ v, verifyRequest P M pol skew now r = .ok v ∧ e = ⟨v.signer, v.message, v.adaptor,
      v.authorizationDigest⟩ ∧ E.notConsumed v.authorizationDigest = true ∧
      E.consume v.authorizationDigest = true := by
  unfold run at h
  obtain ⟨v, hv, h⟩ := step_then h
  obtain ⟨hnc, h⟩ := check_then h
  obtain ⟨g, _, h⟩ := need_then h
  obtain ⟨_, h⟩ := check_then h
  obtain ⟨_, h⟩ := check_then h
  obtain ⟨hcons, h⟩ := check_then h
  obtain ⟨_, h⟩ := check_then h
  simp only [Except.ok.injEq] at h
  exact ⟨v, hv, h.symm, hnc, hcons⟩

/-! ## Theorems -/

/-- **Signer boundary.** Every presignature the signer emits is on the BIP341 CET-leaf
script-path sighash of a CET in the committed CET set that spends the committed funding
outpoint of the re-derived two-party funding output, for a signer that is a funding party and
pinned by the policy, under the adaptor point that is the sum of the outcome points of the
CET's announced oracle subset; the validator-signed payload names that sighash, CET, CET-set
digest, funding digest, announcement digest and adaptor point; its stage is signable; a pinned
validator key verifies it; the authorization was consumed before signing. -/
theorem emitted_presignature_targets_committed_cet (P : Prims Pt) (M : MainPrims) (pol : Policy)
    (skew now : Nat) (E : Env) (r : Request) (e : Emitted) (h : run P M pol skew now E r = .ok e) :
    ∃ (c : Context) (t : SigningTarget) (p : Payload) (a : Authorization) (vk : Nat × Nat),
      r.signingContext = some c ∧ TargetOf P c t ∧
      e.message = t.sighash ∧ e.adaptor = t.adaptor ∧ e.signer ∈ t.party ∧
      e.signer ∈ pol.signerPubkeys ∧
      r.authorization = some a ∧ M.decode r.payloadBytes = some p ∧
      p.named.sighash = t.sighash ∧ p.adaptor = t.adaptor ∧ p.named.cetTxid = t.cetTxid ∧
      p.named.cetSetDigest = P.digestCets c.cets ∧
      p.named.fundingTemplateDigest = P.digestFunding c.funding ∧
      p.named.oracleAnnouncementsDigest = P.digestAnns c.announcements ∧
      p.named.stage = SIGNABLE_STAGE ∧
      M.spki r.validatorSpki = some vk ∧ vk.2 ∈ pol.validatorKeyIds ∧
      M.edVerify vk.1 r.payloadBytes a.signature = true ∧
      e.authorizationDigest = M.authDigest a ∧ E.consume (M.authDigest a) = true := by
  obtain ⟨v, hv, rfl, _, hcons⟩ := run_spec P M pol skew now E r e h
  obtain ⟨a, p, vk, c, t, ha, hp, _, _, _, _, hsigner, hstage, hvk, hpin, _, hsig, _, _, hd, _, _,
    _, _, _, _, hc, ht, hvs, hparty, hmsg, hadapt, hsh, hpa, hcet, hcsd, hftd, hoad, _⟩ :=
    (verifyRequest_spec P M pol skew now r v hv).facts
  refine ⟨c, t, p, a, vk, hc, ht, hmsg, hadapt, hparty, by rw [hvs]; exact hsigner, ha, hp, hsh, hpa,
    hcet, by rw [hcsd, ht.cet_set_digest.2], by rw [hftd, ht.funding_digest.2],
    by rw [hoad, ht.announcements_digest], hstage, hvk, hpin, hsig, hd, ?_⟩
  rw [← hd]; exact hcons

/-- A request without a signing context (a bare sighash) never verifies. -/
theorem bare_sighash_refused (P : Prims Pt) (M : MainPrims) (pol : Policy) (skew now : Nat)
    (r : Request) (hr : r.signingContext = none) (v : Verified) :
    verifyRequest P M pol skew now r ≠ .ok v := by
  intro h
  obtain ⟨_, _, _, c, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, hc, _⟩ :=
    (verifyRequest_spec P M pol skew now r v h).facts
  rw [hr] at hc; cases hc

/-- A CET the committed set does not contain is never a signing target. -/
theorem cet_outside_committed_set_refused (P : Prims Pt) (c : Context)
    (hc : ∀ cet ∈ c.cets, cet.txid ≠ c.cetTxid) (t : SigningTarget) :
    deriveSigningTarget P c ≠ .ok t := by
  intro h
  obtain ⟨cet, hmem, _, _, _, _, _, htxid, _⟩ := (deriveSigningTarget_spec P c t h).cet
  exact hc cet hmem htxid

/-- A named CET that does not spend the funding outpoint is never a signing target. -/
theorem cet_not_spending_funding_refused (P : Prims Pt) (c : Context)
    (hc : ∀ cet ∈ c.cets, cet.txid = c.cetTxid → ∀ tx, P.parseTx cet.rawTx = some tx →
      tx.input ≠ (c.funding.txid, c.funding.vout)) (t : SigningTarget) :
    deriveSigningTarget P c ≠ .ok t := by
  intro h
  obtain ⟨cet, hmem, tx, _, _, _, _, htxid, hparse, _, hin, _⟩ := (deriveSigningTarget_spec P c t h).cet
  exact hc cet hmem htxid tx hparse hin

/-- A signer that is not one of the two funding party keys never signs. -/
theorem non_party_signer_refused (P : Prims Pt) (r : Request) (p : Payload)
    (hc : ∀ c t, r.signingContext = some c → deriveSigningTarget P c = .ok t →
      p.named.signerPubkeyX ∉ t.party) (t : SigningTarget) :
    verifySigningTarget P r p ≠ .ok t := by
  intro h
  unfold verifySigningTarget at h
  obtain ⟨c, hc', h⟩ := need_then h
  obtain ⟨t', ht, h⟩ := step_then h
  obtain ⟨hparty, _⟩ := check_then h
  simp only [List.contains_iff_mem] at hparty
  exact hc c t' hc' ht hparty

/-- The funding output a target is derived for has ascending distinct valid party keys, neither
equal to the NUMS internal key, and a refund delay in 1..65535: the re-derived output is the
NUMS-keyed two-party output, never one the request names. -/
theorem target_funding_is_two_party_nums (P : Prims Pt) (c : Context) (t : SigningTarget)
    (h : deriveSigningTarget P c = .ok t) :
    ∃ p0 p1, c.funding.party = [p0, p1] ∧ t.party = [p0, p1] ∧ p0 < p1 ∧ p0 ≠ P.nums ∧
      p1 ≠ P.nums ∧ 1 ≤ c.funding.refundCsvBlocks ∧ c.funding.refundCsvBlocks ≤ 0xffff ∧
      t.fundingScriptPubKey = (P.taproot p0 p1 c.funding.refundCsvBlocks).scriptPubKey := by
  obtain ⟨_, _, _, p0, p1, _, out, _, _, _, _, hparty, hout, _, _, _, _, hspk, htp, _⟩ :=
    (deriveSigningTarget_spec P c t h).cet
  obtain ⟨hlt, _, _, hc1, hc2, hn0, hn1, rfl⟩ := dlcFundingOutput_spec P p0 p1 _ out hout
  exact ⟨p0, p1, hparty, htp, hlt, hn0, hn1, hc1, hc2, hspk⟩

/-! ## With the cryptographic hypotheses -/

/-- A verifier that accepts only what the key holder signed. -/
def Unforgeable (verify : Nat → List Nat → Nat → Bool) (Signed : Nat → List Nat → Prop) : Prop :=
  ∀ key msg sig, verify key msg sig = true → Signed key msg

/-- Equal digests come from equal values. -/
def DigestBinding {α : Type} (digest : α → Nat) : Prop := ∀ x y, digest x = digest y → x = y

/-- Under Ed25519 unforgeability, every emitted presignature was authorized by a validator
pinned by the policy: the holder of that validator key signed the exact payload bytes, and the
payload decodes to one naming this sighash and adaptor point. -/
theorem emitted_presignature_validator_signed (P : Prims Pt) (M : MainPrims) (pol : Policy)
    (Signed : Nat → List Nat → Prop) (hu : Unforgeable M.edVerify Signed)
    (skew now : Nat) (E : Env) (r : Request) (e : Emitted) (h : run P M pol skew now E r = .ok e) :
    ∃ (vk : Nat × Nat) (p : Payload), vk.2 ∈ pol.validatorKeyIds ∧ Signed vk.1 r.payloadBytes ∧
      M.decode r.payloadBytes = some p ∧ p.named.sighash = e.message ∧ p.adaptor = e.adaptor ∧
      p.named.stage = SIGNABLE_STAGE := by
  obtain ⟨_, t, p, a, vk, _, _, hm, ha, _, _, _, hp, hsh, hpa, _, _, _, _, hst, _, hpin, hsig, _⟩ :=
    emitted_presignature_targets_committed_cet P M pol skew now E r e h
  exact ⟨vk, p, hpin, hu _ _ _ hsig, hp, by rw [hsh, hm], by rw [hpa, ha], hst⟩

/-- Under digest binding of the CET-set digest, two signing targets accepted under the same
signed `cetSetDigest` come from the same CET set: a validator signature on a CET-set digest
authorizes signing for CETs of exactly one set. -/
theorem committed_cet_set_unique (P : Prims Pt) (hb : DigestBinding P.digestCets)
    (c₁ c₂ : Context) (t₁ t₂ : SigningTarget) (h₁ : deriveSigningTarget P c₁ = .ok t₁)
    (h₂ : deriveSigningTarget P c₂ = .ok t₂) (he : t₁.cetSetDigest = t₂.cetSetDigest) :
    c₁.cets = c₂.cets := by
  have e₁ := (deriveSigningTarget_spec P c₁ t₁ h₁).cet_set_digest.2
  have e₂ := (deriveSigningTarget_spec P c₂ t₂ h₂).cet_set_digest.2
  exact hb _ _ (by rw [← e₁, ← e₂, he])

/-- Under BIP340 unforgeability, every announcement whose outcome point enters the adaptor
point was signed by its oracle key over its event, nonce and full outcome list. -/
theorem adaptor_oracles_signed_announcements (P : Prims Pt) (Signed : Nat → Nat → Prop)
    (hu : ∀ key msg sig, P.schnorrVerify key msg sig = true → Signed key msg)
    (c : Context) (t : SigningTarget) (h : deriveSigningTarget P c = .ok t) :
    ∃ cet ∈ c.cets, ∃ used : List Ann, used.map (·.px) = cet.oraclePubkeys ∧
      2 ≤ cet.oraclePubkeys.length ∧
      ∀ a ∈ used, cet.outcomeMessage ∈ a.outcomes ∧
        Signed a.px (P.annDigest a.eventId a.px a.rx a.outcomes) := by
  obtain ⟨cet, hmem, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, anns, used, _, hanns, _, h2,
    _, hmap, hused, _⟩ := (deriveSigningTarget_spec P c t h).cet
  refine ⟨cet, hmem, used, hmap, h2, ?_⟩
  intro a ha
  obtain ⟨hain, hao, _⟩ := hused a ha
  obtain ⟨_, hm⟩ := mapE_spec (verifiedAnnouncement P) c.announcements anns hanns
  obtain ⟨raw, _, hraw⟩ := hm a hain
  obtain ⟨rfl, _, _, _, hsig⟩ := verifiedAnnouncement_spec P raw _ hraw
  exact ⟨hao, hu _ _ _ hsig⟩

/-! ## Vectors -/

/-- Points are naturals under addition; every check primitive succeeds; `coords` fails only at
zero. -/
def vP : Prims Nat where
  validKey := fun _ => true
  nums := 999
  taproot := fun a b c => ⟨a + b + c, a * b, c⟩
  digestCets := fun l => l.length + 100
  digestFunding := fun f => f.txid + 200
  digestAnns := fun l => l.length + 300
  parseTx := fun raw => some ⟨raw, (7, 0)⟩
  sighash := fun tx v _ _ => tx.txid + v
  annDigest := fun _ _ _ _ => 0
  schnorrVerify := fun _ _ _ => true
  outcomePoint := fun a o => a.rx + o
  add := (· + ·)
  identity := 0
  coords := fun n => if n = 0 then none else some (n, 0)

def vFunding : FundingRaw := ⟨[1, 2], 144, 147, 2, 144, some 5000, 7, 0⟩
def vCet : CetRaw := ⟨11, 11, 4, [20, 30]⟩
def vAnn (px : Nat) : AnnRaw := ⟨true, "event", px, px + 1, [4, 5], 0⟩
def vContext : Context := ⟨3, [vCet], 101, vFunding, 207, 11, [vAnn 20, vAnn 30]⟩

-- Mirrors `signing_target.rs` test `derives_the_committed_target`: the target's sighash is
-- the CET sighash for the funding value and its adaptor point sums the two outcome points.
example : (deriveSigningTarget vP vContext).toOption.map (fun t => (t.sighash, t.adaptor)) =
    some (5011, (60, 0)) := by decide
-- A context naming a CET outside the set is refused.
example : (deriveSigningTarget vP { vContext with cetTxid := 12 }).toBool = false := by decide
-- A CET subset of one oracle is refused.
def vContextOne : Context := ⟨3, [⟨11, 11, 4, [20]⟩], 101, vFunding, 207, 11, [vAnn 20, vAnn 30]⟩
example : (deriveSigningTarget vP vContextOne).toBool = false := by decide
-- An unsorted subset is refused.
def vContextUnsorted : Context :=
  ⟨3, [⟨11, 11, 4, [30, 20]⟩], 101, vFunding, 207, 11, [vAnn 20, vAnn 30]⟩
example : (deriveSigningTarget vP vContextUnsorted).toBool = false := by decide
-- Funding keys out of order are refused.
def vContextKeys : Context :=
  ⟨3, [vCet], 101, ⟨[2, 1], 144, 147, 2, 144, some 5000, 7, 0⟩, 207, 11, [vAnn 20, vAnn 30]⟩
example : (deriveSigningTarget vP vContextKeys).toBool = false := by decide

end UTXORefFormal.Signer
