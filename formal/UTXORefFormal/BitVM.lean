/-!
# BitVM V2 assertion graph: wire hashlocks, disprove leaves, challenge coverage

Model of the BitVM V2 predicate commitment at commit `5883e03`:

* `bitvm_trace_v2.js`: `createWireSecretV2`, `selectedHash`, `validateGates`,
  `validateCircuitStructure`, `buildPublicTraceV2`, `verifyPublicTraceV2`,
  `buildGateDisproveLeavesV2`, `buildInputBindingLeavesV2`, `findGateDisproveV2`,
  `findInputBindingDisproveV2`.
* `bitvm_assertion_graph_v2.js`: `deriveExpectedInputsV2`, `buildOutputBindingLeavesV2`,
  `buildBitvmAssertionTemplateV2` (including the challenge-window check),
  `verifyBitvmAssertionTemplateV2`, the window check of `verifyBitvmAssertionGraphV2`,
  `findOutputBindingDisproveV2`, `bindingFraudsV2`, `selectFraudEvidence`.
* `tradelayer_bitvm_circuit.js`: `GATES` (and, or, xor, nand, not) and `gateInvalidRows`.

What the model keeps: the five gate kinds and their truth tables; the invalid rows of a gate
(`output = 1 - f(inputs)`); the order of the checks in `verifyPublicTraceV2` (gates, circuit
structure, per-wire hash match); every condition of `validateCircuitStructure` (non-empty, unique
labels, all 2n wire commitments distinct, single producer per wire, topological order, no
orphan wires, at least one primary input, exactly one terminal output); the gate, input and
output disprove leaves with the hash list each one reveals; the first-fraud selection of
`findGateDisproveV2`; the first-mismatch selection of `findInputBindingDisproveV2`; the
challenge-window checks (`csvSequence` range, minimum 6, recovery above challenge); the legacy
(`predicatePolicy` absent) versus bound-predicate template split; the verifier-derived expected
inputs.

What the model abstracts (docs/FORMAL_SECURITY.md lists the same items):
* Wire labels are `Nat`; bits are `Bool`; a gate's `index` is a field checked against its list
  position (the canonical-gates comparison of `verifyPublicTraceV2`).
* `sha256` is a parameter `H : Pre → Hash`; hashes and 32-byte preimages are opaque types.
* A tapscript is the pair (hashes it checks, challenger key): `buildRevealScript` is injective in
  that pair (fixed opcode layout, 32-byte pushes), so equality of scripts is equality of pairs.
* The reveal set equals the wire set by construction (`reveal` is total on `labels`).
* Trace-commitment recomputation (`wireRoot`, `gatesHash`, `bindingHash`, `traceRoot`), the
  secret-pair leak scan, and the `kind`/`version` tags are omitted: no disprove leaf depends on them.
* Taproot tree construction, leaf identifiers, control blocks, the NUMS internal key, the
  settlement and recovery scripts, x-only key validity, and everything after the template
  (graph signing, settlement, disprove transactions) are omitted. `traceCommit`, `settlement`
  and `recovery` leaves are opaque constants.
* `deriveExpectedInputsV2` is a parameter `d : Label → Option Bool` (the bit the verifier derives
  for a primary input label, `none` where the code throws); the byte and bit arithmetic behind it
  is not modelled.
* The default `?? DEFAULT_CHALLENGE_CSV_BLOCKS` and the numeric type of `challengeCsvBlocks`:
  the model takes a `Nat` that has already been defaulted. The code accepts non-integers, NaN
  and numeric strings there; see BitVM.SECURITY.md, finding F1.
* The statement that the unrevealed preimage of a wire stays secret is the restriction of
  `Spendable` to revealed preimages; it is preimage resistance of SHA-256 on random 32-byte
  secrets, not a theorem.

Cryptographic hypothesis: `HashBinding` (below) is collision resistance of the hashlock hash on
the 32-byte wire preimages; it is the instance of the coordinator's axiom (2) (collision
resistance of SHA-256) used by this module.
-/

set_option autoImplicit false

namespace UTXORefFormal.BitVM

/-! ## Gates -/

abbrev Label := Nat

/-- The gate kinds of `GATES` in tradelayer_bitvm_circuit.js:31-37. -/
inductive GateKind where
  | and | or | xor | nand | not
  deriving DecidableEq, Repr

def GateKind.arity : GateKind → Nat
  | .not => 1
  | _ => 2

/-- `GATES[type].f` on a list of bits. The wildcard row is unreachable once the arity is checked. -/
def GateKind.f : GateKind → List Bool → Bool
  | .and, [a, b] => a && b
  | .or, [a, b] => a || b
  | .xor, [a, b] => Bool.xor a b
  | .nand, [a, b] => !(a && b)
  | .not, [a] => !a
  | _, _ => false

/-- The input combinations enumerated by `gateInvalidRows` (tradelayer_bitvm_circuit.js:73). -/
def GateKind.combos (k : GateKind) : List (List Bool) :=
  if k.arity = 1 then [[false], [true]]
  else [[false, false], [false, true], [true, false], [true, true]]

/-- `gateInvalidRows`: for every input combination, the wrong output
(tradelayer_bitvm_circuit.js:69-79). -/
def GateKind.invalidRows (k : GateKind) : List (List Bool × Bool) :=
  k.combos.map (fun ins => (ins, !(k.f ins)))

/-- A validated gate: `{index, type, inputs, output}` of `validateGates`. -/
structure Gate where
  idx : Nat
  kind : GateKind
  inputs : List Label
  output : Label
  deriving DecidableEq, Repr

theorem mem_combos (k : GateKind) (ins : List Bool) (h : ins.length = k.arity) :
    ins ∈ k.combos := by
  rcases ins with _ | ⟨a, _ | ⟨b, _ | ⟨c, rest⟩⟩⟩ <;> cases k <;>
    simp [GateKind.arity] at h <;> cases a <;> (try cases b) <;> simp [GateKind.combos, GateKind.arity]

theorem mem_invalidRows (k : GateKind) (ins : List Bool) (h : ins.length = k.arity) :
    (ins, !(k.f ins)) ∈ k.invalidRows := by
  unfold GateKind.invalidRows
  exact List.mem_map.2 ⟨ins, mem_combos k ins h, rfl⟩

theorem invalidRows_wrong (k : GateKind) (r : List Bool × Bool) (h : r ∈ k.invalidRows) :
    r.2 = !(k.f r.1) ∧ r.1.length = k.arity := by
  unfold GateKind.invalidRows at h
  obtain ⟨ins, hm, rfl⟩ := List.mem_map.1 h
  refine ⟨rfl, ?_⟩
  unfold GateKind.combos at hm
  cases k <;> simp [GateKind.arity] at hm ⊢ <;> rcases hm with rfl | rfl | rfl | rfl <;> rfl

/-! ## Wires, reveals, traces -/

structure Wire (Hash : Type) where
  hash0 : Hash
  hash1 : Hash
  deriving DecidableEq, Repr

/-- `selectedHash(wire, bit)` (bitvm_trace_v2.js:135-137). -/
def Wire.sel {Hash : Type} (w : Wire Hash) : Bool → Hash
  | true => w.hash1
  | false => w.hash0

structure Reveal (Pre : Type) where
  bit : Bool
  pre : Pre

/-- A public trace (`utxoref_bitvm_public_trace_v2`): the wire commitments, one reveal per wire,
and the gate list. -/
structure Trace (Pre Hash : Type) where
  labels : List Label
  gates : List Gate
  wire : Label → Wire Hash
  reveal : Label → Reveal Pre

def Trace.value {Pre Hash : Type} (tr : Trace Pre Hash) (l : Label) : Bool := (tr.reveal l).bit

/-- A tapscript by the data `buildRevealScript` encodes (tradelayer_bitvm_circuit.js:55-66):
the hashes it checks in order and the challenger key it ends with. -/
structure Script (Hash Key : Type) where
  hashes : List Hash
  key : Key
  deriving DecidableEq, Repr

/-! ## Structure checks (`validateGates`, `validateCircuitStructure`) -/

def idxOk : Nat → List Gate → Bool
  | _, [] => true
  | n, g :: gs => g.idx == n && idxOk (n + 1) gs

/-- `validateGates` plus the canonical-gates comparison of `verifyPublicTraceV2`
(bitvm_trace_v2.js:71-84, 234-238): arity matches, every referenced wire is known, and the
`index` field is the list position. -/
abbrev GatesOk (labels : List Label) (gs : List Gate) : Prop :=
  idxOk 0 gs = true ∧
  ∀ g ∈ gs, g.inputs.length = g.kind.arity ∧ (∀ l ∈ g.inputs, l ∈ labels) ∧ g.output ∈ labels

/-- Primary inputs: wires no gate produces (bitvm_trace_v2.js:124). -/
def primaryOf (labels : List Label) (gs : List Gate) : List Label :=
  labels.filter (fun l => !(gs.any (fun g => g.output == l)))

/-- Terminal outputs: gate outputs no gate consumes (bitvm_trace_v2.js:126). -/
def terminalsOf (gs : List Gate) : List Label :=
  (gs.map Gate.output).filter (fun o => !(gs.any (fun g => g.inputs.contains o)))

structure Circuit where
  primary : List Label
  terminal : Label

/-- The commitment check of `validateCircuitStructure` (bitvm_trace_v2.js:90-103): for every
pair of (wire, bit) the committed hashes are equal only for the same pair. This is exactly
"`hash0 !== hash1` per wire and no hash owned twice". -/
abbrev CommitmentsUnique {Hash : Type} (labels : List Label) (wire : Label → Wire Hash) : Prop :=
  ∀ l ∈ labels, ∀ l' ∈ labels, ∀ b b' : Bool, (wire l).sel b = (wire l').sel b' → l = l' ∧ b = b'

/-- `validateCircuitStructure` (bitvm_trace_v2.js:86-132). -/
abbrev StructOk {Hash : Type} (labels : List Label) (wire : Label → Wire Hash)
    (gs : List Gate) : Prop :=
  gs ≠ [] ∧ labels.Nodup ∧ CommitmentsUnique labels wire ∧ (gs.map Gate.output).Nodup ∧
  (∀ g ∈ gs, ∀ i ∈ g.inputs, ∀ p ∈ gs, p.output = i → p.idx < g.idx) ∧
  (∀ l ∈ labels, ∃ g ∈ gs, l = g.output ∨ l ∈ g.inputs) ∧
  primaryOf labels gs ≠ [] ∧ (terminalsOf gs).length = 1

def structureCheck {Hash : Type} [DecidableEq Hash] (labels : List Label) (wire : Label → Wire Hash)
    (gs : List Gate) : Option Circuit :=
  if StructOk labels wire gs then
    some ⟨primaryOf labels gs, (terminalsOf gs).headD 0⟩
  else none

/-! ## Trace verification (`verifyPublicTraceV2`) -/

structure Fraud where
  gate : Gate
  inputs : List Bool
  expected : Bool
  actual : Bool
  deriving DecidableEq, Repr

structure Verified where
  values : Label → Bool
  frauds : List Fraud
  circuit : Circuit

/-- The per-gate fraud record (bitvm_trace_v2.js:257-263). -/
def fraudOf (v : Label → Bool) (g : Gate) : Option Fraud :=
  if v g.output != g.kind.f (g.inputs.map v) then
    some ⟨g, g.inputs.map v, g.kind.f (g.inputs.map v), v g.output⟩
  else none

def fraudsOf (v : Label → Bool) (gs : List Gate) : List Fraud := gs.filterMap (fraudOf v)

/-- `sha256Hex(preimage) === selectedHash(wire, reveal.bit)` (bitvm_trace_v2.js:245-248). -/
def hashMatches {Pre Hash : Type} [DecidableEq Hash] (H : Pre → Hash) (tr : Trace Pre Hash)
    (l : Label) : Bool :=
  decide (H (tr.reveal l).pre = (tr.wire l).sel (tr.reveal l).bit)

def verifyTrace {Pre Hash : Type} [DecidableEq Hash] (H : Pre → Hash) (tr : Trace Pre Hash) :
    Option Verified :=
  if GatesOk tr.labels tr.gates then
    match structureCheck tr.labels tr.wire tr.gates with
    | none => none
    | some c =>
      if tr.labels.all (hashMatches H tr) then
        some ⟨tr.value, fraudsOf tr.value tr.gates, c⟩
      else none
  else none

/-! ## Disprove leaves -/

inductive Leaf (Hash Key : Type) where
  | gate (gateIndex : Nat) (g : Gate) (rowIn : List Bool) (rowOut : Bool) (s : Script Hash Key)
  | input (label : Label) (expectedBit wrongBit : Bool) (s : Script Hash Key)
  | output (label : Label) (expectedBit wrongBit : Bool) (s : Script Hash Key)
  | traceCommit
  | settlement
  | recovery
  deriving DecidableEq, Repr

def Leaf.script? {Hash Key : Type} : Leaf Hash Key → Option (Script Hash Key)
  | .gate _ _ _ _ s => some s
  | .input _ _ _ s => some s
  | .output _ _ _ s => some s
  | _ => none

/-- `leaf.kind.includes('disprove')` (bitvm_assertion_graph_v2.js:913, 967). -/
def Leaf.isDisprove {Hash Key : Type} : Leaf Hash Key → Bool
  | .gate .. => true
  | .input .. => true
  | .output .. => true
  | _ => false

/-- The hashes a gate-disprove leaf reveals for the row `(ins, out)`
(bitvm_trace_v2.js:277-283). -/
def rowHashes {Hash : Type} (wire : Label → Wire Hash) (g : Gate) (ins : List Bool)
    (out : Bool) : List Hash :=
  (g.inputs.zip ins).map (fun p => (wire p.1).sel p.2) ++ [(wire g.output).sel out]

/-- `buildGateDisproveLeavesV2` (bitvm_trace_v2.js:274-291). -/
def gateLeaves {Hash Key : Type} (wire : Label → Wire Hash) (key : Key) (gs : List Gate) :
    List (Leaf Hash Key) :=
  gs.flatMap (fun g => g.kind.invalidRows.map
    (fun r => Leaf.gate g.idx g r.1 r.2 ⟨rowHashes wire g r.1 r.2, key⟩))

/-- `buildInputBindingLeavesV2` (bitvm_trace_v2.js:293-307): for every bound label the leaf
that reveals the preimage of the wrong bit. -/
def inputLeaves {Hash Key : Type} (wire : Label → Wire Hash) (key : Key)
    (E : List (Label × Bool)) : List (Leaf Hash Key) :=
  E.map (fun p => Leaf.input p.1 p.2 (!p.2) ⟨[(wire p.1).sel (!p.2)], key⟩)

def Leaf.toOutput {Hash Key : Type} : Leaf Hash Key → Leaf Hash Key
  | .input l e w s => .output l e w s
  | x => x

/-- `buildOutputBindingLeavesV2` (bitvm_assertion_graph_v2.js:199-202). -/
def outputLeaves {Hash Key : Type} (wire : Label → Wire Hash) (key : Key) (t : Label) :
    List (Leaf Hash Key) :=
  (inputLeaves wire key [(t, true)]).map Leaf.toOutput

/-! ## Evidence search (`findGateDisproveV2`, `findInputBindingDisproveV2`, ...) -/

/-- The outcome of a `find*` function: it throws on an invalid trace, returns `null`, or
returns evidence. -/
inductive Find (α : Type) where
  | invalid
  | clean
  | found (a : α)

def Find.isFound {α : Type} : Find α → Bool
  | .found _ => true
  | _ => false

def Find.isClean {α : Type} : Find α → Bool
  | .clean => true
  | _ => false

structure GateEvidence (Pre Hash Key : Type) where
  gate : Gate
  rowIn : List Bool
  rowOut : Bool
  script : Script Hash Key
  preimages : List Pre

structure BindEvidence (Pre Hash Key : Type) where
  label : Label
  expectedBit : Bool
  actualBit : Bool
  script : Script Hash Key
  preimages : List Pre

/-- `findGateDisproveV2` (bitvm_trace_v2.js:309-327): the first fraud, with the revealed
preimages of its inputs and output. -/
def findGateDisprove {Pre Hash Key : Type} [DecidableEq Hash] (H : Pre → Hash) (key : Key)
    (tr : Trace Pre Hash) : Find (GateEvidence Pre Hash Key) :=
  match verifyTrace H tr with
  | none => .invalid
  | some v =>
    match v.frauds with
    | [] => .clean
    | f :: _ => .found
        { gate := f.gate, rowIn := f.inputs, rowOut := f.actual
          script := ⟨f.gate.inputs.map (fun l => (tr.wire l).sel (tr.value l)) ++
                      [(tr.wire f.gate.output).sel (tr.value f.gate.output)], key⟩
          preimages := f.gate.inputs.map (fun l => (tr.reveal l).pre) ++
                      [(tr.reveal f.gate.output).pre] }

/-- The loop of `findInputBindingDisproveV2` (bitvm_trace_v2.js:329-347): first mismatch in
order; an absent label throws. -/
def findBindingAux {Pre Hash Key : Type} (key : Key) (tr : Trace Pre Hash) :
    List (Label × Bool) → Find (BindEvidence Pre Hash Key)
  | [] => .clean
  | (l, e) :: rest =>
    if l ∈ tr.labels then
      if tr.value l != e then
        .found ⟨l, e, tr.value l, ⟨[(tr.wire l).sel (tr.value l)], key⟩, [(tr.reveal l).pre]⟩
      else findBindingAux key tr rest
    else .invalid

def findInputBinding {Pre Hash Key : Type} [DecidableEq Hash] (H : Pre → Hash) (key : Key)
    (tr : Trace Pre Hash) (E : List (Label × Bool)) : Find (BindEvidence Pre Hash Key) :=
  match verifyTrace H tr with
  | none => .invalid
  | some _ => findBindingAux key tr E

/-- `findOutputBindingDisproveV2` (bitvm_assertion_graph_v2.js:869-877): `null` for a legacy
template, otherwise the input-binding search on the terminal output with expected bit 1. -/
def findOutputBinding {Pre Hash Key : Type} [DecidableEq Hash] (H : Pre → Hash) (key : Key)
    (tr : Trace Pre Hash) (terminal : Option Label) : Find (BindEvidence Pre Hash Key) :=
  match terminal with
  | none => .clean
  | some t => findInputBinding H key tr [(t, true)]

inductive Evidence (Pre Hash Key : Type) where
  | gate (e : GateEvidence Pre Hash Key)
  | input (e : BindEvidence Pre Hash Key)
  | output (e : BindEvidence Pre Hash Key)

/-- `selectFraudEvidence` with no fraud type: `gate || input || output`
(bitvm_assertion_graph_v2.js:887-899). -/
def selectFraud {Pre Hash Key : Type} [DecidableEq Hash] (H : Pre → Hash) (key : Key)
    (tr : Trace Pre Hash) (E : List (Label × Bool)) (terminal : Option Label) :
    Option (Evidence Pre Hash Key) :=
  match findGateDisprove H key tr with
  | .found e => some (.gate e)
  | _ =>
    match findInputBinding H key tr E with
    | .found e => some (.input e)
    | _ =>
      match findOutputBinding H key tr terminal with
      | .found e => some (.output e)
      | _ => none

/-- The leaf of the template that a piece of evidence spends. -/
def Evidence.leaf {Pre Hash Key : Type} : Evidence Pre Hash Key → Leaf Hash Key
  | .gate e => Leaf.gate e.gate.idx e.gate e.rowIn e.rowOut e.script
  | .input e => Leaf.input e.label e.expectedBit e.actualBit e.script
  | .output e => Leaf.output e.label e.expectedBit e.actualBit e.script

def Evidence.script {Pre Hash Key : Type} : Evidence Pre Hash Key → Script Hash Key
  | .gate e => e.script
  | .input e => e.script
  | .output e => e.script

/-- `bindingFraudsV2` (bitvm_assertion_graph_v2.js:879-885): the counts of unmet input
bindings and of a terminal output that is not 1. -/
def bindingInputFrauds {Pre Hash : Type} (tr : Trace Pre Hash) (E : List (Label × Bool)) : Nat :=
  (E.filter (fun p => tr.value p.1 != p.2)).length

def bindingOutputFrauds {Pre Hash : Type} (tr : Trace Pre Hash) (terminal : Option Label) : Nat :=
  match terminal with
  | some t => if tr.value t != true then 1 else 0
  | none => 0

def bindingFrauds {Pre Hash : Type} (tr : Trace Pre Hash) (E : List (Label × Bool))
    (terminal : Option Label) : Nat × Nat :=
  (bindingInputFrauds tr E, bindingOutputFrauds tr terminal)

/-! ## The template (`buildBitvmAssertionTemplateV2`) -/

/-- `MIN_CHALLENGE_CSV_BLOCKS` (bitvm_assertion_graph_v2.js:49). -/
def MIN_CHALLENGE_CSV_BLOCKS : Nat := 6

/-- The upper bound of `csvSequence` (tradelayer_bitvm_dispute.js:38). -/
def CSV_MAX : Nat := 0xffff

/-- `csvSequence` on a natural number (tradelayer_bitvm_dispute.js:37-40). -/
def csvSequence (n : Nat) : Option Nat := if n ≤ CSV_MAX then some n else none

/-- `deriveExpectedInputsV2` (bitvm_assertion_graph_v2.js:175-197): one derived bit per
primary input, or a throw where an input has none. -/
def deriveExpected (d : Label → Option Bool) : List Label → Option (List (Label × Bool))
  | [] => some []
  | l :: ls =>
    match d l, deriveExpected d ls with
    | some b, some rest => some ((l, b) :: rest)
    | _, _ => none

structure Template (Hash Key : Type) where
  expectedInputs : List (Label × Bool)
  operator : Key
  challenger : Key
  challengeCsv : Nat
  recoveryCsv : Nat
  /-- `terminalOutput`; `none` for a legacy template (no `predicatePolicy`). -/
  terminal : Option Label
  leaves : List (Leaf Hash Key)

/-- The arguments of `buildBitvmAssertionTemplateV2`, with the defaults already applied. -/
structure Cfg (Key : Type) where
  operator : Key
  challenger : Key
  challengeCsv : Nat
  recoveryCsv : Nat
  legacy : Bool
  expectedInputs : Option (List (Label × Bool))

/-- The expected-input step (bitvm_assertion_graph_v2.js:257-271). -/
def expectedFor {Key : Type} (d : Label → Option Bool) (c : Circuit) (cfg : Cfg Key) :
    Option (List (Label × Bool)) :=
  if cfg.legacy then
    let e := cfg.expectedInputs.getD []
    if e.map Prod.fst = c.primary then some e else none
  else
    match deriveExpected d c.primary with
    | none => none
    | some e =>
      match cfg.expectedInputs with
      | none => some e
      | some claimed => if claimed = e then some e else none

def assemble {Pre Hash Key : Type} (tr : Trace Pre Hash) (cfg : Cfg Key) (c : Circuit)
    (ch rc : Nat) (E : List (Label × Bool)) : Template Hash Key :=
  { expectedInputs := E, operator := cfg.operator, challenger := cfg.challenger
    challengeCsv := ch, recoveryCsv := rc
    terminal := if cfg.legacy then none else some c.terminal
    leaves := gateLeaves tr.wire cfg.challenger tr.gates ++
              inputLeaves tr.wire cfg.challenger E ++
              (if cfg.legacy then [] else outputLeaves tr.wire cfg.challenger c.terminal) ++
              [Leaf.traceCommit, Leaf.settlement, Leaf.recovery] }

/-- `buildBitvmAssertionTemplateV2`; `none` is a throw. The checks run in the order of the code:
public trace, operator and challenger keys differ, challenge and recovery windows in
range, challenge window at least `MIN_CHALLENGE_CSV_BLOCKS`, recovery above challenge, circuit
structure, expected inputs, leaves. -/
def buildTemplate {Pre Hash Key : Type} [DecidableEq Hash] [DecidableEq Key] (H : Pre → Hash)
    (d : Label → Option Bool) (tr : Trace Pre Hash) (cfg : Cfg Key) :
    Option (Template Hash Key) :=
  match verifyTrace H tr with
  | none => none
  | some v =>
    if cfg.operator = cfg.challenger then none
    else
      match csvSequence cfg.challengeCsv, csvSequence cfg.recoveryCsv with
      | some ch, some rc =>
        if ch < MIN_CHALLENGE_CSV_BLOCKS then none
        else if rc ≤ ch then none
        else
          match expectedFor d v.circuit cfg with
          | none => none
          | some E => some (assemble tr cfg v.circuit ch rc E)
      | _, _ => none

def cfgOfTemplate {Hash Key : Type} (T : Template Hash Key) : Cfg Key :=
  { operator := T.operator, challenger := T.challenger, challengeCsv := T.challengeCsv
    recoveryCsv := T.recoveryCsv, legacy := T.terminal.isNone
    expectedInputs := some T.expectedInputs }

/-- `verifyBitvmAssertionTemplateV2` (bitvm_assertion_graph_v2.js:350-381): a legacy template is
refused unless the caller allows it, and the template must equal the rebuild from its own
fields and the public trace. -/
def TemplateVerifies {Pre Hash Key : Type} [DecidableEq Hash] [DecidableEq Key] (H : Pre → Hash)
    (d : Label → Option Bool) (allowLegacy : Bool) (T : Template Hash Key)
    (tr : Trace Pre Hash) : Prop :=
  (T.terminal = none → allowLegacy = true) ∧ buildTemplate H d tr (cfgOfTemplate T) = some T

/-- The challenge-window check of `verifyBitvmAssertionGraphV2` (bitvm_assertion_graph_v2.js:
751-754): `max(MIN_CHALLENGE_CSV_BLOCKS, options.minimumChallengeCsvBlocks)`. -/
def graphWindowOk {Hash Key : Type} (T : Template Hash Key) (minimum : Nat) : Bool :=
  decide (max MIN_CHALLENGE_CSV_BLOCKS minimum ≤ T.challengeCsv)

/-! ## Hash binding -/

/-- Collision resistance of the hashlock hash on wire preimages. Instance of the coordinator's
axiom (2) (collision resistance of SHA-256). -/
def HashBinding {Pre Hash : Type} (H : Pre → Hash) : Prop := ∀ x y : Pre, H x = H y → x = y

/-- What a spending witness can contain: preimages in `K`. A witness spends a script when its
hashes are the script's hashes in order. -/
def Spendable {Pre Hash Key : Type} (H : Pre → Hash) (K : Pre → Prop) (s : Script Hash Key)
    (ws : List Pre) : Prop :=
  ws.map H = s.hashes ∧ ∀ w ∈ ws, K w

/-- The preimages the trace publishes. -/
def Revealed {Pre Hash : Type} (tr : Trace Pre Hash) (p : Pre) : Prop :=
  ∃ l ∈ tr.labels, (tr.reveal l).pre = p

/-! ## Consistency predicates -/

def GateConsistent (v : Label → Bool) (g : Gate) : Prop := v g.output = g.kind.f (g.inputs.map v)
def InputsMatch (v : Label → Bool) (E : List (Label × Bool)) : Prop := ∀ p ∈ E, v p.1 = p.2
def OutputOne (v : Label → Bool) (t : Option Label) : Prop := ∀ x, t = some x → v x = true

/-! ## Lemmas about the checks -/

theorem fraudsOf_nil_iff (v : Label → Bool) (gs : List Gate) :
    fraudsOf v gs = [] ↔ ∀ g ∈ gs, GateConsistent v g := by
  unfold fraudsOf
  rw [List.filterMap_eq_nil_iff]
  refine forall_congr' (fun g => forall_congr' (fun _ => ?_))
  unfold fraudOf GateConsistent
  by_cases h : v g.output = g.kind.f (g.inputs.map v)
  · simp [h]
  · simp [h]

theorem mem_fraudsOf (v : Label → Bool) (gs : List Gate) (f : Fraud) (h : f ∈ fraudsOf v gs) :
    f.gate ∈ gs ∧ f.inputs = f.gate.inputs.map v ∧ f.expected = f.gate.kind.f f.inputs ∧
      f.actual = v f.gate.output ∧ f.actual ≠ f.expected := by
  unfold fraudsOf at h
  obtain ⟨g, hg, hf⟩ := List.mem_filterMap.1 h
  unfold fraudOf at hf
  split at hf
  · rename_i hne
    cases hf
    simp only [bne_iff_ne, ne_eq] at hne
    exact ⟨hg, rfl, rfl, rfl, hne⟩
  · cases hf

theorem structureCheck_some {Hash : Type} [DecidableEq Hash] (labels : List Label)
    (wire : Label → Wire Hash) (gs : List Gate) (c : Circuit)
    (h : structureCheck labels wire gs = some c) :
    StructOk labels wire gs ∧ c.primary = primaryOf labels gs ∧
      c.terminal = (terminalsOf gs).headD 0 := by
  unfold structureCheck at h
  split at h
  · rename_i hs
    cases h
    exact ⟨hs, rfl, rfl⟩
  · cases h

theorem verifyTrace_spec {Pre Hash : Type} [DecidableEq Hash] (H : Pre → Hash)
    (tr : Trace Pre Hash) (v : Verified) (h : verifyTrace H tr = some v) :
    GatesOk tr.labels tr.gates ∧ StructOk tr.labels tr.wire tr.gates ∧
      (∀ l ∈ tr.labels, H (tr.reveal l).pre = (tr.wire l).sel (tr.reveal l).bit) ∧
      v.values = tr.value ∧ v.frauds = fraudsOf tr.value tr.gates ∧
      v.circuit.primary = primaryOf tr.labels tr.gates ∧
      v.circuit.terminal = (terminalsOf tr.gates).headD 0 := by
  unfold verifyTrace at h
  split at h
  · rename_i hg
    split at h
    · cases h
    · rename_i c hc
      split at h
      · rename_i ha
        cases h
        obtain ⟨hs, hp, ht⟩ := structureCheck_some _ _ _ _ hc
        refine ⟨hg, hs, ?_, rfl, rfl, hp, ht⟩
        intro l hl
        have := List.all_eq_true.1 ha l hl
        simpa [hashMatches] using this
      · cases h
  · cases h

/-- A verified trace's gates reference only known wires. -/
theorem verified_gate_wires {Pre Hash : Type} [DecidableEq Hash] (H : Pre → Hash)
    (tr : Trace Pre Hash) (v : Verified) (h : verifyTrace H tr = some v) (g : Gate)
    (hg : g ∈ tr.gates) :
    g.inputs.length = g.kind.arity ∧ (∀ l ∈ g.inputs, l ∈ tr.labels) ∧ g.output ∈ tr.labels :=
  ((verifyTrace_spec H tr v h).1.2) g hg

theorem mem_primary {labels : List Label} {gs : List Gate} {l : Label}
    (h : l ∈ primaryOf labels gs) : l ∈ labels ∧ ∀ g ∈ gs, g.output ≠ l := by
  unfold primaryOf at h
  obtain ⟨hl, hf⟩ := List.mem_filter.1 h
  refine ⟨hl, fun g hg heq => ?_⟩
  have : (!(gs.any (fun g => g.output == l))) = true := hf
  have hany : gs.any (fun g => g.output == l) = true :=
    List.any_eq_true.2 ⟨g, hg, by simp [heq]⟩
  rw [hany] at this
  cases this

theorem not_primary_of_produced {labels : List Label} {gs : List Gate} {l : Label} {g : Gate}
    (hg : g ∈ gs) (hl : g.output = l) : l ∉ primaryOf labels gs := fun hp =>
  (mem_primary hp).2 g hg hl

theorem mem_primary_of {labels : List Label} {gs : List Gate} {l : Label} (hl : l ∈ labels)
    (hn : ∀ g ∈ gs, g.output ≠ l) : l ∈ primaryOf labels gs := by
  unfold primaryOf
  refine List.mem_filter.2 ⟨hl, ?_⟩
  have : gs.any (fun g => g.output == l) = false := by
    rw [Bool.eq_false_iff]
    intro hany
    obtain ⟨g, hg, hb⟩ := List.any_eq_true.1 hany
    exact hn g hg (by simpa using hb)
  simp [this]

theorem terminal_mem {labels : List Label} {gs : List Gate} (hg : GatesOk labels gs)
    (hlen : (terminalsOf gs).length = 1) : (terminalsOf gs).headD 0 ∈ labels := by
  have hne : terminalsOf gs ≠ [] := by
    intro h; rw [h] at hlen; simp at hlen
  have hmem : (terminalsOf gs).headD 0 ∈ terminalsOf gs := by
    cases hx : terminalsOf gs with
    | nil => exact absurd hx hne
    | cons a t => simp
  have hm : (terminalsOf gs).headD 0 ∈ gs.map Gate.output := (List.mem_filter.1 hmem).1
  obtain ⟨g, hg', hgo⟩ := List.mem_map.1 hm
  rw [← hgo]
  exact (hg.2 g hg').2.2

theorem deriveExpected_keys (d : Label → Option Bool) (L : List Label)
    (E : List (Label × Bool)) (h : deriveExpected d L = some E) :
    E.map Prod.fst = L ∧ ∀ p ∈ E, d p.1 = some p.2 := by
  induction L generalizing E with
  | nil => cases h; simp
  | cons l ls ih =>
    unfold deriveExpected at h
    split at h
    · rename_i b rest hb hr
      cases h
      obtain ⟨h1, h2⟩ := ih rest hr
      refine ⟨by simp [h1], ?_⟩
      intro p hp
      rcases List.mem_cons.1 hp with rfl | hp
      · exact hb
      · exact h2 p hp
    · cases h

/-! ## Template construction: what a built template contains -/

theorem buildTemplate_spec {Pre Hash Key : Type} [DecidableEq Hash] [DecidableEq Key]
    (H : Pre → Hash) (d : Label → Option Bool) (tr : Trace Pre Hash) (cfg : Cfg Key)
    (T : Template Hash Key) (h : buildTemplate H d tr cfg = some T) :
    ∃ v, verifyTrace H tr = some v ∧ cfg.operator ≠ cfg.challenger ∧
      T.challengeCsv = cfg.challengeCsv ∧ T.recoveryCsv = cfg.recoveryCsv ∧
      MIN_CHALLENGE_CSV_BLOCKS ≤ T.challengeCsv ∧ T.challengeCsv < T.recoveryCsv ∧
      T.recoveryCsv ≤ CSV_MAX ∧ T.challenger = cfg.challenger ∧
      expectedFor d v.circuit cfg = some T.expectedInputs ∧
      T.terminal = (if cfg.legacy then none else some v.circuit.terminal) ∧
      T.leaves = gateLeaves tr.wire cfg.challenger tr.gates ++
                 inputLeaves tr.wire cfg.challenger T.expectedInputs ++
                 (if cfg.legacy then [] else outputLeaves tr.wire cfg.challenger v.circuit.terminal) ++
                 [Leaf.traceCommit, Leaf.settlement, Leaf.recovery] := by
  unfold buildTemplate at h
  split at h
  · cases h
  · rename_i v hv
    split at h
    · cases h
    · rename_i hne
      split at h
      · rename_i ch rc hch hrc
        split at h
        · cases h
        · rename_i hlt
          split at h
          · cases h
          · rename_i hle
            split at h
            · cases h
            · rename_i E hE
              cases h
              unfold csvSequence at hch hrc
              split at hch
              · split at hrc
                · cases hch; cases hrc
                  refine ⟨v, hv, hne, rfl, rfl, ?_, ?_, ?_, rfl, hE, rfl, rfl⟩
                  · exact Nat.le_of_not_lt hlt
                  · exact Nat.lt_of_not_le hle
                  · assumption
                · cases hrc
              · cases hch
      · cases h

theorem expectedFor_nonlegacy {Key : Type} (d : Label → Option Bool) (c : Circuit) (cfg : Cfg Key)
    (E : List (Label × Bool)) (hl : cfg.legacy = false) (h : expectedFor d c cfg = some E) :
    deriveExpected d c.primary = some E := by
  unfold expectedFor at h
  rw [hl] at h
  simp only [Bool.false_eq_true, ite_false] at h
  split at h
  · cases h
  · rename_i e he
    split at h
    · cases h; exact he
    · rename_i claimed hc
      split at h
      · cases h; exact he
      · cases h

theorem expectedFor_legacy {Key : Type} (d : Label → Option Bool) (c : Circuit) (cfg : Cfg Key)
    (E : List (Label × Bool)) (hl : cfg.legacy = true) (h : expectedFor d c cfg = some E) :
    E.map Prod.fst = c.primary := by
  unfold expectedFor at h
  rw [hl] at h
  simp only [ite_true] at h
  split at h
  · rename_i hm; cases h; exact hm
  · cases h

/-- The expected inputs of a built template are bound to the circuit's primary inputs, and
every label in them is a wire of the trace. -/
theorem template_expected_known {Pre Hash Key : Type} [DecidableEq Hash] [DecidableEq Key]
    (H : Pre → Hash) (d : Label → Option Bool) (tr : Trace Pre Hash) (cfg : Cfg Key)
    (T : Template Hash Key) (h : buildTemplate H d tr cfg = some T) :
    ∀ p ∈ T.expectedInputs, p.1 ∈ tr.labels := by
  obtain ⟨v, hv, _, _, _, _, _, _, _, hE, _, _⟩ := buildTemplate_spec H d tr cfg T h
  obtain ⟨_, _, _, _, _, hp, _⟩ := verifyTrace_spec H tr v hv
  intro p hp'
  have hkeys : T.expectedInputs.map Prod.fst = v.circuit.primary := by
    cases hl : cfg.legacy
    · exact (deriveExpected_keys d _ _ (expectedFor_nonlegacy d _ cfg _ hl hE)).1
    · exact expectedFor_legacy d _ cfg _ hl hE
  have : p.1 ∈ v.circuit.primary := hkeys ▸ List.mem_map.2 ⟨p, hp', rfl⟩
  rw [hp] at this
  exact (mem_primary this).1

theorem template_terminal_known {Pre Hash Key : Type} [DecidableEq Hash] [DecidableEq Key]
    (H : Pre → Hash) (d : Label → Option Bool) (tr : Trace Pre Hash) (cfg : Cfg Key)
    (T : Template Hash Key) (h : buildTemplate H d tr cfg = some T) (t : Label)
    (ht : T.terminal = some t) : t ∈ tr.labels := by
  obtain ⟨v, hv, _, _, _, _, _, _, _, _, hterm, _⟩ := buildTemplate_spec H d tr cfg T h
  obtain ⟨hg, hs, _, _, _, _, hterm'⟩ := verifyTrace_spec H tr v hv
  rw [hterm] at ht
  cases hl : cfg.legacy
  · rw [hl] at ht
    simp only [Bool.false_eq_true, ite_false, Option.some.injEq] at ht
    subst ht
    rw [hterm']
    exact terminal_mem hg hs.2.2.2.2.2.2.2
  · rw [hl] at ht
    simp at ht

/-! ## (c) The challenge window and the terminal-output leaf -/

/-- The template refuses a challenge window below `MIN_CHALLENGE_CSV_BLOCKS = 6`, and a recovery
window that does not exceed it. -/
theorem template_refuses_short_window {Pre Hash Key : Type} [DecidableEq Hash] [DecidableEq Key]
    (H : Pre → Hash) (d : Label → Option Bool) (tr : Trace Pre Hash) (cfg : Cfg Key)
    (hshort : cfg.challengeCsv < MIN_CHALLENGE_CSV_BLOCKS) :
    buildTemplate H d tr cfg = none := by
  cases hb : buildTemplate H d tr cfg with
  | none => rfl
  | some T =>
    obtain ⟨_, _, _, hc, _, hmin, _⟩ := buildTemplate_spec H d tr cfg T hb
    omega

theorem template_window_bounds {Pre Hash Key : Type} [DecidableEq Hash] [DecidableEq Key]
    (H : Pre → Hash) (d : Label → Option Bool) (tr : Trace Pre Hash) (cfg : Cfg Key)
    (T : Template Hash Key) (h : buildTemplate H d tr cfg = some T) :
    6 ≤ T.challengeCsv ∧ T.challengeCsv < T.recoveryCsv ∧ T.recoveryCsv ≤ 0xffff := by
  obtain ⟨_, _, _, _, _, hmin, hlt, hmax, _⟩ := buildTemplate_spec H d tr cfg T h
  exact ⟨hmin, hlt, hmax⟩

/-- A bound-predicate template contains the terminal-output disprove leaf for the circuit's
terminal output, and records that terminal output. -/
theorem template_requires_output_leaf {Pre Hash Key : Type} [DecidableEq Hash] [DecidableEq Key]
    (H : Pre → Hash) (d : Label → Option Bool) (tr : Trace Pre Hash) (cfg : Cfg Key)
    (T : Template Hash Key) (h : buildTemplate H d tr cfg = some T) (hl : cfg.legacy = false) :
    ∃ t, T.terminal = some t ∧ t ∈ tr.labels ∧
      Leaf.output t true false ⟨[(tr.wire t).sel false], cfg.challenger⟩ ∈ T.leaves := by
  obtain ⟨v, hv, _, _, _, _, _, _, _, _, hterm, hleaves⟩ := buildTemplate_spec H d tr cfg T h
  rw [hl] at hterm hleaves
  simp only [Bool.false_eq_true, ite_false] at hterm hleaves
  refine ⟨v.circuit.terminal, hterm, template_terminal_known H d tr cfg T h _ hterm, ?_⟩
  rw [hleaves]
  simp [outputLeaves, inputLeaves, Leaf.toOutput]

/-- A legacy template has no terminal-output leaf and no output disprove at all. -/
theorem legacy_template_has_no_output_leaf {Pre Hash Key : Type} [DecidableEq Hash]
    [DecidableEq Key] (H : Pre → Hash) (d : Label → Option Bool) (tr : Trace Pre Hash)
    (cfg : Cfg Key) (T : Template Hash Key) (h : buildTemplate H d tr cfg = some T)
    (hl : cfg.legacy = true) :
    T.terminal = none ∧ (∀ l, ∀ e w s, Leaf.output l e w s ∉ T.leaves) ∧
      findOutputBinding H cfg.challenger tr T.terminal
        = (Find.clean : Find (BindEvidence Pre Hash Key)) := by
  obtain ⟨v, hv, _, _, _, _, _, _, _, _, hterm, hleaves⟩ := buildTemplate_spec H d tr cfg T h
  rw [hl] at hterm hleaves
  simp only [ite_true] at hterm hleaves
  refine ⟨hterm, ?_, by rw [hterm]; rfl⟩
  intro l e w s hm
  rw [hleaves] at hm
  simp only [List.append_nil, List.mem_append, List.mem_cons, List.not_mem_nil, or_false] at hm
  rcases hm with ((hm | hm) | hm | hm | hm)
  · obtain ⟨g, _, hg⟩ := List.mem_flatMap.1 hm
    obtain ⟨r, _, hr⟩ := List.mem_map.1 hg
    cases hr
  · obtain ⟨p, _, hp⟩ := List.mem_map.1 hm
    cases hp
  all_goals cases hm

/-- A verified template's window is at least 6; a legacy template verifies only when the caller
allows legacy templates; a bound-predicate template carries the terminal-output leaf. -/
theorem verified_template_window_and_output {Pre Hash Key : Type} [DecidableEq Hash]
    [DecidableEq Key] (H : Pre → Hash) (d : Label → Option Bool) (allowLegacy : Bool)
    (T : Template Hash Key) (tr : Trace Pre Hash) (h : TemplateVerifies H d allowLegacy T tr) :
    6 ≤ T.challengeCsv ∧ (T.terminal = none → allowLegacy = true) ∧
      (∀ t, T.terminal = some t →
        Leaf.output t true false ⟨[(tr.wire t).sel false], T.challenger⟩ ∈ T.leaves) := by
  obtain ⟨hleg, hb⟩ := h
  refine ⟨(template_window_bounds H d tr _ T hb).1, hleg, ?_⟩
  intro t ht
  have hl : (cfgOfTemplate T).legacy = false := by
    unfold cfgOfTemplate; rw [ht]; rfl
  obtain ⟨t', ht', _, hm⟩ := template_requires_output_leaf H d tr _ T hb hl
  rw [ht] at ht'
  cases ht'
  exact hm

/-- The expected inputs of a verified bound-predicate template are exactly what the verifier
derives from the primary inputs. -/
theorem verified_template_inputs_derived {Pre Hash Key : Type} [DecidableEq Hash]
    [DecidableEq Key] (H : Pre → Hash) (d : Label → Option Bool) (allowLegacy : Bool)
    (T : Template Hash Key) (tr : Trace Pre Hash) (h : TemplateVerifies H d allowLegacy T tr)
    (t : Label) (ht : T.terminal = some t) :
    ∃ v, verifyTrace H tr = some v ∧
      deriveExpected d (primaryOf tr.labels tr.gates) = some T.expectedInputs := by
  obtain ⟨_, hb⟩ := h
  have hl : (cfgOfTemplate T).legacy = false := by
    unfold cfgOfTemplate; rw [ht]; rfl
  obtain ⟨v, hv, _, _, _, _, _, _, _, hE, _, _⟩ := buildTemplate_spec H d tr _ T hb
  obtain ⟨_, _, _, _, _, hp, _⟩ := verifyTrace_spec H tr v hv
  refine ⟨v, hv, ?_⟩
  have := expectedFor_nonlegacy d _ _ _ hl hE
  rwa [hp] at this

theorem graph_window_check {Hash Key : Type} (T : Template Hash Key) (minimum : Nat)
    (h : graphWindowOk T minimum = true) : 6 ≤ T.challengeCsv ∧ minimum ≤ T.challengeCsv := by
  unfold graphWindowOk MIN_CHALLENGE_CSV_BLOCKS at h
  have := of_decide_eq_true h
  omega

/-! ## Helper lemmas for the leaf-set membership proofs -/

theorem zipWith_row {Hash : Type} (wire : Label → Wire Hash) (inputs : List Label)
    (v : Label → Bool) :
    (inputs.zip (inputs.map v)).map (fun p => (wire p.1).sel p.2) =
      inputs.map (fun l => (wire l).sel (v l)) := by
  induction inputs with
  | nil => rfl
  | cons a t ih => simp [List.zip_cons_cons, ih]

theorem zip_forall_eq (l1 : List Label) (l2 : List Bool) (v : Label → Bool)
    (hlen : l1.length = l2.length) (h : ∀ p ∈ l1.zip l2, p.2 = v p.1) : l2 = l1.map v := by
  induction l1 generalizing l2 with
  | nil =>
    cases l2 with
    | nil => rfl
    | cons _ _ => simp at hlen
  | cons a t ih =>
    cases l2 with
    | nil => simp at hlen
    | cons b rest =>
      simp only [List.length_cons, Nat.add_right_cancel_iff] at hlen
      have hb : b = v a := h (a, b) (by simp)
      have := ih rest hlen (fun p hp => h p (by simp [hp]))
      simp [hb, this]

theorem gate_leaf_mem {Pre Hash Key : Type} [DecidableEq Hash] (H : Pre → Hash) (key : Key)
    (tr : Trace Pre Hash) (v : Verified) (hv : verifyTrace H tr = some v) (g : Gate)
    (hg : g ∈ tr.gates) (out : Bool) (hne : out ≠ g.kind.f (g.inputs.map tr.value)) :
    Leaf.gate g.idx g (g.inputs.map tr.value) out
        ⟨g.inputs.map (fun l => (tr.wire l).sel (tr.value l)) ++
          [(tr.wire g.output).sel out], key⟩ ∈ gateLeaves tr.wire key tr.gates := by
  have hlen := (verified_gate_wires H tr v hv g hg).1
  have hlen' : (g.inputs.map tr.value).length = g.kind.arity := by simpa using hlen
  have hout : out = !(g.kind.f (g.inputs.map tr.value)) := by
    cases hf : g.kind.f (g.inputs.map tr.value) <;> cases out <;> simp_all
  unfold gateLeaves
  refine List.mem_flatMap.2 ⟨g, hg, ?_⟩
  refine List.mem_map.2 ⟨(g.inputs.map tr.value, out), ?_, ?_⟩
  · rw [hout]; exact mem_invalidRows g.kind _ hlen'
  · simp [rowHashes, zipWith_row]

theorem input_leaf_mem {Hash Key : Type} (wire : Label → Wire Hash) (key : Key)
    (E : List (Label × Bool)) (l : Label) (e : Bool) (h : (l, e) ∈ E) :
    Leaf.input l e (!e) ⟨[(wire l).sel (!e)], key⟩ ∈ inputLeaves wire key E :=
  List.mem_map.2 ⟨(l, e), h, rfl⟩

theorem leaf_mem_template {Pre Hash Key : Type} [DecidableEq Hash] [DecidableEq Key]
    (H : Pre → Hash) (d : Label → Option Bool) (tr : Trace Pre Hash) (cfg : Cfg Key)
    (T : Template Hash Key) (h : buildTemplate H d tr cfg = some T) (x : Leaf Hash Key) :
    x ∈ T.leaves ↔
      x ∈ gateLeaves tr.wire cfg.challenger tr.gates ∨
      x ∈ inputLeaves tr.wire cfg.challenger T.expectedInputs ∨
      (cfg.legacy = false ∧ ∃ v, verifyTrace H tr = some v ∧
        x ∈ outputLeaves tr.wire cfg.challenger v.circuit.terminal) ∨
      x = Leaf.traceCommit ∨ x = Leaf.settlement ∨ x = Leaf.recovery := by
  obtain ⟨v, hv, _, _, _, _, _, _, _, _, _, hleaves⟩ := buildTemplate_spec H d tr cfg T h
  rw [hleaves]
  cases hl : cfg.legacy
  · simp only [Bool.false_eq_true, ite_false, List.mem_append, List.mem_cons, List.not_mem_nil,
      or_false, true_and]
    constructor
    · rintro (((h1 | h2) | h3) | h4 | h5 | h6)
      · exact Or.inl h1
      · exact Or.inr (Or.inl h2)
      · exact Or.inr (Or.inr (Or.inl ⟨v, hv, h3⟩))
      · exact Or.inr (Or.inr (Or.inr (Or.inl h4)))
      · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inl h5))))
      · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr h6))))
    · rintro (h1 | h2 | ⟨v', hv', h3⟩ | h4 | h5 | h6)
      · exact Or.inl (Or.inl (Or.inl h1))
      · exact Or.inl (Or.inl (Or.inr h2))
      · rw [hv] at hv'; cases hv'; exact Or.inl (Or.inr h3)
      · exact Or.inr (Or.inl h4)
      · exact Or.inr (Or.inr (Or.inl h5))
      · exact Or.inr (Or.inr (Or.inr h6))
  · simp only [ite_true, List.append_nil, List.mem_append, List.mem_cons, List.not_mem_nil,
      or_false, Bool.true_eq_false, false_and]
    constructor
    · rintro (((h1 | h2)) | h4 | h5 | h6)
      · exact Or.inl h1
      · exact Or.inr (Or.inl h2)
      · exact Or.inr (Or.inr (Or.inr (Or.inl h4)))
      · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inl h5))))
      · exact Or.inr (Or.inr (Or.inr (Or.inr (Or.inr h6))))
    · rintro (h1 | h2 | h3 | h4 | h5 | h6)
      · exact Or.inl (Or.inl h1)
      · exact Or.inl (Or.inr h2)
      · cases h3
      · exact Or.inr (Or.inl h4)
      · exact Or.inr (Or.inr (Or.inl h5))
      · exact Or.inr (Or.inr (Or.inr h6))


theorem template_keys_primary {Pre Hash Key : Type} [DecidableEq Hash] [DecidableEq Key]
    (H : Pre → Hash) (d : Label → Option Bool) (tr : Trace Pre Hash) (cfg : Cfg Key)
    (T : Template Hash Key) (h : buildTemplate H d tr cfg = some T) :
    T.expectedInputs.map Prod.fst = primaryOf tr.labels tr.gates := by
  obtain ⟨v, hv, _, _, _, _, _, _, _, hE, _, _⟩ := buildTemplate_spec H d tr cfg T h
  obtain ⟨_, _, _, _, _, hp, _⟩ := verifyTrace_spec H tr v hv
  rw [← hp]
  cases hl : cfg.legacy
  · exact (deriveExpected_keys d _ _ (expectedFor_nonlegacy d _ cfg _ hl hE)).1
  · exact expectedFor_legacy d _ cfg _ hl hE

/-! ## Search lemmas -/

theorem findBindingAux_found {Pre Hash Key : Type} (key : Key) (tr : Trace Pre Hash)
    (E : List (Label × Bool)) (hknown : ∀ p ∈ E, p.1 ∈ tr.labels)
    (hbad : ∃ p ∈ E, tr.value p.1 ≠ p.2) :
    ∃ ev, findBindingAux key tr E = Find.found ev ∧ (ev.label, ev.expectedBit) ∈ E ∧
      ev.actualBit = tr.value ev.label ∧ ev.actualBit ≠ ev.expectedBit ∧
      ev.script = (⟨[(tr.wire ev.label).sel ev.actualBit], key⟩ : Script Hash Key) := by
  induction E with
  | nil => obtain ⟨p, hp, _⟩ := hbad; simp at hp
  | cons q rest ih =>
    obtain ⟨l, e⟩ := q
    have hl : l ∈ tr.labels := hknown (l, e) (by simp)
    by_cases hm : tr.value l = e
    · have hbad' : ∃ p ∈ rest, tr.value p.1 ≠ p.2 := by
        obtain ⟨p, hp, hne⟩ := hbad
        rcases List.mem_cons.1 hp with rfl | hp
        · exact absurd hm hne
        · exact ⟨p, hp, hne⟩
      obtain ⟨ev, hev, h1, h2, h3, h4⟩ := ih (fun p hp => hknown p (by simp [hp])) hbad'
      refine ⟨ev, ?_, by simp [h1], h2, h3, h4⟩
      simp [findBindingAux, hl, hm, hev]
    · refine ⟨⟨l, e, tr.value l, ⟨[(tr.wire l).sel (tr.value l)], key⟩, [(tr.reveal l).pre]⟩, ?_, by simp, rfl, hm, rfl⟩
      simp [findBindingAux, hl, hm]

theorem findBindingAux_clean {Pre Hash Key : Type} (key : Key) (tr : Trace Pre Hash)
    (E : List (Label × Bool)) (hknown : ∀ p ∈ E, p.1 ∈ tr.labels)
    (hok : ∀ p ∈ E, tr.value p.1 = p.2) :
    findBindingAux key tr E = (Find.clean : Find (BindEvidence Pre Hash Key)) := by
  induction E with
  | nil => rfl
  | cons q rest ih =>
    obtain ⟨l, e⟩ := q
    have hl : l ∈ tr.labels := hknown (l, e) (by simp)
    have hm : tr.value l = e := hok (l, e) (by simp)
    simp only [findBindingAux, hl, hm, bne_self_eq_false, Bool.false_eq_true,
      ↓reduceIte]
    exact ih (fun p hp => hknown p (by simp [hp])) (fun p hp => hok p (by simp [hp]))

theorem findBindingAux_sound {Pre Hash Key : Type} (key : Key) (tr : Trace Pre Hash)
    (E : List (Label × Bool)) (ev : BindEvidence Pre Hash Key)
    (h : findBindingAux key tr E = Find.found ev) :
    (ev.label, ev.expectedBit) ∈ E ∧ ev.actualBit = tr.value ev.label ∧
      ev.actualBit ≠ ev.expectedBit ∧
      ev.script = (⟨[(tr.wire ev.label).sel ev.actualBit], key⟩ : Script Hash Key) := by
  induction E with
  | nil => simp [findBindingAux] at h
  | cons q rest ih =>
    obtain ⟨l, e⟩ := q
    unfold findBindingAux at h
    split at h
    · split at h
      · rename_i hne
        cases h
        simp only [bne_iff_ne, ne_eq] at hne
        exact ⟨by simp, rfl, hne, rfl⟩
      · obtain ⟨h1, h2, h3, h4⟩ := ih h
        exact ⟨by simp [h1], h2, h3, h4⟩
    · cases h

theorem bool_ne_eq_not (a b : Bool) (h : a ≠ b) : a = !b := by
  cases a <;> cases b <;> simp_all

/-! ## (a) Soundness of challenge coverage -/

section Coverage

variable {Pre Hash Key : Type} [DecidableEq Hash] [DecidableEq Key]
  (H : Pre → Hash) (d : Label → Option Bool) (tr : Trace Pre Hash) (cfg : Cfg Key)
  (T : Template Hash Key)

/-- Every piece of gate evidence the search returns spends a gate-disprove leaf of the template,
and the gate it names is inconsistent. -/
theorem findGate_found_sound (h : buildTemplate H d tr cfg = some T)
    (ev : GateEvidence Pre Hash Key) (hf : findGateDisprove H cfg.challenger tr = Find.found ev) :
    ev.gate ∈ tr.gates ∧ ¬ GateConsistent tr.value ev.gate ∧
      ev.rowIn = ev.gate.inputs.map tr.value ∧ ev.rowOut = tr.value ev.gate.output ∧
      Leaf.gate ev.gate.idx ev.gate ev.rowIn ev.rowOut ev.script ∈ T.leaves := by
  obtain ⟨v, hv, _⟩ := buildTemplate_spec H d tr cfg T h
  obtain ⟨_, _, _, _, hfr, _⟩ := verifyTrace_spec H tr v hv
  unfold findGateDisprove at hf
  rw [hv] at hf
  simp only at hf
  rcases hfl : v.frauds with _ | ⟨f, rest⟩
  · rw [hfl] at hf; cases hf
  · rw [hfl] at hf
    cases hf
    have hmem : f ∈ fraudsOf tr.value tr.gates := by rw [← hfr, hfl]; simp
    obtain ⟨hg, hin, hexp, hact, hne⟩ := mem_fraudsOf _ _ f hmem
    have hne' : tr.value f.gate.output ≠ f.gate.kind.f (f.gate.inputs.map tr.value) := by
      rw [← hact, ← hin, ← hexp]; exact hne
    refine ⟨hg, hne', hin, hact, ?_⟩
    have := gate_leaf_mem H cfg.challenger tr v hv f.gate hg f.actual
      (by rw [hact]; exact hne')
    rw [← hin, hact] at *
    have hm := (leaf_mem_template H d tr cfg T h _).2 (Or.inl (by simpa [hin, hact] using this))
    simpa [hin, hact] using hm

/-- If some gate of the revealed trace is inconsistent, `findGateDisproveV2` returns evidence. -/
theorem findGate_found_of_bad (h : buildTemplate H d tr cfg = some T)
    (hbad : ∃ g ∈ tr.gates, ¬ GateConsistent tr.value g) :
    ∃ ev, findGateDisprove H cfg.challenger tr = Find.found ev := by
  obtain ⟨v, hv, _⟩ := buildTemplate_spec H d tr cfg T h
  obtain ⟨_, _, _, _, hfr, _⟩ := verifyTrace_spec H tr v hv
  have hne : v.frauds ≠ [] := by
    intro hnil
    rw [hfr, fraudsOf_nil_iff] at hnil
    obtain ⟨g, hg, hc⟩ := hbad
    exact hc (hnil g hg)
  unfold findGateDisprove
  rw [hv]
  rcases hfl : v.frauds with _ | ⟨f, rest⟩
  · exact absurd hfl hne
  · simp [hfl]

theorem findGate_clean_iff (h : buildTemplate H d tr cfg = some T) :
    findGateDisprove H cfg.challenger tr
        = (Find.clean : Find (GateEvidence Pre Hash Key)) ↔
      ∀ g ∈ tr.gates, GateConsistent tr.value g := by
  obtain ⟨v, hv, _⟩ := buildTemplate_spec H d tr cfg T h
  obtain ⟨_, _, _, _, hfr, _⟩ := verifyTrace_spec H tr v hv
  unfold findGateDisprove
  rw [hv]
  rw [← fraudsOf_nil_iff, ← hfr]
  rcases hfl : v.frauds with _ | ⟨f, rest⟩
  · simp [hfl]
  · simp [hfl]

/-- The binding evidence returned for an expected input spends an input-binding leaf. -/
theorem findInput_found_sound (h : buildTemplate H d tr cfg = some T)
    (ev : BindEvidence Pre Hash Key)
    (hf : findInputBinding H cfg.challenger tr T.expectedInputs = Find.found ev) :
    (ev.label, ev.expectedBit) ∈ T.expectedInputs ∧ ev.actualBit = tr.value ev.label ∧
      ev.actualBit ≠ ev.expectedBit ∧
      Leaf.input ev.label ev.expectedBit ev.actualBit ev.script ∈ T.leaves := by
  unfold findInputBinding at hf
  split at hf
  · cases hf
  · obtain ⟨h1, h2, h3, h4⟩ := findBindingAux_sound _ _ _ _ hf
    refine ⟨h1, h2, h3, ?_⟩
    have hw : ev.actualBit = !ev.expectedBit := bool_ne_eq_not _ _ h3
    have := input_leaf_mem tr.wire cfg.challenger T.expectedInputs ev.label ev.expectedBit h1
    have hm := (leaf_mem_template H d tr cfg T h _).2 (Or.inr (Or.inl this))
    rw [h4, hw]
    exact hm

theorem findInput_found_of_bad (h : buildTemplate H d tr cfg = some T)
    (hbad : ∃ p ∈ T.expectedInputs, tr.value p.1 ≠ p.2) :
    ∃ ev, findInputBinding H cfg.challenger tr T.expectedInputs = Find.found ev := by
  obtain ⟨v, hv, _⟩ := buildTemplate_spec H d tr cfg T h
  obtain ⟨ev, hev, _⟩ := findBindingAux_found cfg.challenger tr T.expectedInputs
    (template_expected_known H d tr cfg T h) hbad
  refine ⟨ev, ?_⟩
  unfold findInputBinding
  rw [hv]
  exact hev

theorem findInput_clean_iff (h : buildTemplate H d tr cfg = some T) :
    findInputBinding H cfg.challenger tr T.expectedInputs
        = (Find.clean : Find (BindEvidence Pre Hash Key)) ↔
      InputsMatch tr.value T.expectedInputs := by
  obtain ⟨v, hv, _⟩ := buildTemplate_spec H d tr cfg T h
  constructor
  · intro hc
    refine Classical.byContradiction (fun hn => ?_)
    have hbad : ∃ p ∈ T.expectedInputs, tr.value p.1 ≠ p.2 := by
      refine Classical.byContradiction (fun hn' => ?_)
      exact hn (fun p hp => Classical.byContradiction (fun hne => hn' ⟨p, hp, hne⟩))
    obtain ⟨ev, hev⟩ := findInput_found_of_bad H d tr cfg T h hbad
    rw [hc] at hev
    cases hev
  · intro hm
    unfold findInputBinding
    rw [hv]
    exact findBindingAux_clean _ _ _ (template_expected_known H d tr cfg T h) hm

/-- The terminal-output evidence spends the terminal-output disprove leaf. -/
theorem findOutput_found_sound (h : buildTemplate H d tr cfg = some T)
    (ev : BindEvidence Pre Hash Key)
    (hf : findOutputBinding H cfg.challenger tr T.terminal = Find.found ev) :
    ∃ t, T.terminal = some t ∧ ev.label = t ∧ ev.expectedBit = true ∧ ev.actualBit = false ∧
      tr.value t = false ∧ Leaf.output ev.label ev.expectedBit ev.actualBit ev.script ∈ T.leaves := by
  unfold findOutputBinding at hf
  split at hf
  · cases hf
  · rename_i t ht
    unfold findInputBinding at hf
    split at hf
    · cases hf
    · obtain ⟨h1, h2, h3, h4⟩ := findBindingAux_sound _ _ _ _ hf
      simp only [List.mem_singleton, Prod.mk.injEq] at h1
      obtain ⟨rfl, he⟩ := h1
      have hw : ev.actualBit = !ev.expectedBit := bool_ne_eq_not _ _ h3
      have hact : ev.actualBit = false := by rw [hw, he]; rfl
      refine ⟨ev.label, ht, rfl, he, hact, by rw [← h2, hact], ?_⟩
      obtain ⟨t', ht', _, hm⟩ := (fun hl => template_requires_output_leaf H d tr cfg T h hl) (by
        cases hl : cfg.legacy
        · rfl
        · exfalso
          obtain ⟨hterm, _⟩ := legacy_template_has_no_output_leaf H d tr cfg T h hl
          rw [hterm] at ht; cases ht)
      rw [ht] at ht'; cases ht'
      rw [h4, hact, he]
      exact hm

theorem findOutput_found_of_bad (h : buildTemplate H d tr cfg = some T) (t : Label)
    (ht : T.terminal = some t) (hz : tr.value t ≠ true) :
    ∃ ev, findOutputBinding H cfg.challenger tr T.terminal = Find.found ev := by
  obtain ⟨v, hv, _⟩ := buildTemplate_spec H d tr cfg T h
  have hk := template_terminal_known H d tr cfg T h t ht
  obtain ⟨ev, hev, _⟩ := findBindingAux_found cfg.challenger tr [(t, true)]
    (by intro p hp; simp at hp; rw [hp]; exact hk) ⟨(t, true), by simp, hz⟩
  refine ⟨ev, ?_⟩
  unfold findOutputBinding findInputBinding
  rw [ht]
  simp only
  rw [hv]
  exact hev

theorem findOutput_clean_iff (h : buildTemplate H d tr cfg = some T) :
    findOutputBinding H cfg.challenger tr T.terminal
        = (Find.clean : Find (BindEvidence Pre Hash Key)) ↔
      OutputOne tr.value T.terminal := by
  constructor
  · intro hc t ht
    refine Classical.byContradiction (fun hz => ?_)
    obtain ⟨ev, hev⟩ := findOutput_found_of_bad H d tr cfg T h t ht hz
    rw [hc] at hev
    cases hev
  · intro hone
    unfold findOutputBinding
    cases ht : T.terminal with
    | none => rfl
    | some t =>
      have hk := template_terminal_known H d tr cfg T h t ht
      obtain ⟨v, hv, _⟩ := buildTemplate_spec H d tr cfg T h
      unfold findInputBinding
      rw [hv]
      exact findBindingAux_clean _ _ _ (by intro p hp; simp at hp; rw [hp]; exact hk)
        (by intro p hp; simp at hp; rw [hp]; exact hone t ht)

/-- **Challenge coverage (a), gate part.** If a gate of the revealed trace disagrees with its
revealed inputs, `findGateDisproveV2` returns evidence, and the leaf that evidence spends is in
the template's committed leaf set (and a leaf with the same script is a disprove leaf). -/
theorem gate_inconsistency_disproved (h : buildTemplate H d tr cfg = some T)
    (hbad : ∃ g ∈ tr.gates, ¬ GateConsistent tr.value g) :
    ∃ ev, findGateDisprove H cfg.challenger tr = Find.found ev ∧
      ev.gate ∈ tr.gates ∧ ¬ GateConsistent tr.value ev.gate ∧
      Leaf.gate ev.gate.idx ev.gate ev.rowIn ev.rowOut ev.script ∈ T.leaves ∧
      ∃ lf ∈ T.leaves, lf.script? = some ev.script ∧ lf.isDisprove = true := by
  obtain ⟨ev, hev⟩ := findGate_found_of_bad H d tr cfg T h hbad
  obtain ⟨h1, h2, _, _, h5⟩ := findGate_found_sound H d tr cfg T h ev hev
  exact ⟨ev, hev, h1, h2, h5, _, h5, rfl, rfl⟩

/-- **Challenge coverage (a), input part.** -/
theorem input_mismatch_disproved (h : buildTemplate H d tr cfg = some T)
    (hbad : ∃ p ∈ T.expectedInputs, tr.value p.1 ≠ p.2) :
    ∃ ev, findInputBinding H cfg.challenger tr T.expectedInputs = Find.found ev ∧
      (ev.label, ev.expectedBit) ∈ T.expectedInputs ∧ ev.actualBit ≠ ev.expectedBit ∧
      Leaf.input ev.label ev.expectedBit ev.actualBit ev.script ∈ T.leaves ∧
      ∃ lf ∈ T.leaves, lf.script? = some ev.script ∧ lf.isDisprove = true := by
  obtain ⟨ev, hev⟩ := findInput_found_of_bad H d tr cfg T h hbad
  obtain ⟨h1, _, h3, h4⟩ := findInput_found_sound H d tr cfg T h ev hev
  exact ⟨ev, hev, h1, h3, h4, _, h4, rfl, rfl⟩

/-- **Challenge coverage (a), terminal-output part.** -/
theorem terminal_not_one_disproved (h : buildTemplate H d tr cfg = some T) (t : Label)
    (ht : T.terminal = some t) (hz : tr.value t ≠ true) :
    ∃ ev, findOutputBinding H cfg.challenger tr T.terminal = Find.found ev ∧ ev.label = t ∧
      Leaf.output t true false ev.script ∈ T.leaves ∧
      ∃ lf ∈ T.leaves, lf.script? = some ev.script ∧ lf.isDisprove = true := by
  obtain ⟨ev, hev⟩ := findOutput_found_of_bad H d tr cfg T h t ht hz
  obtain ⟨t', ht', h1, h2, h3, _, h5⟩ := findOutput_found_sound H d tr cfg T h ev hev
  rw [ht] at ht'; cases ht'
  rw [h1, h2, h3] at h5
  exact ⟨ev, hev, h1, h5, _, h5, rfl, rfl⟩

/-- **Challenge coverage (a), combined.** If the revealed trace is inconsistent with the circuit
(a gate), disagrees with a verifier-derived expected input, or has terminal output other than 1,
then `selectFraudEvidence` returns evidence, and the leaf it spends is in the committed set. -/
theorem any_inconsistency_disproved (h : buildTemplate H d tr cfg = some T)
    (hbad : (∃ g ∈ tr.gates, ¬ GateConsistent tr.value g) ∨
            (∃ p ∈ T.expectedInputs, tr.value p.1 ≠ p.2) ∨
            (∃ t, T.terminal = some t ∧ tr.value t ≠ true)) :
    ∃ ev, selectFraud H cfg.challenger tr T.expectedInputs T.terminal = some ev ∧
      ev.leaf ∈ T.leaves ∧
      ∃ lf ∈ T.leaves, lf.script? = some ev.script ∧ lf.isDisprove = true := by
  have hsound : ∀ ev, selectFraud H cfg.challenger tr T.expectedInputs T.terminal = some ev →
      ev.leaf ∈ T.leaves ∧ ∃ lf ∈ T.leaves, lf.script? = some ev.script ∧ lf.isDisprove = true := by
    intro ev hev
    unfold selectFraud at hev
    split at hev
    · rename_i e he
      cases hev
      obtain ⟨_, _, _, _, h5⟩ := findGate_found_sound H d tr cfg T h e he
      exact ⟨h5, _, h5, rfl, rfl⟩
    · split at hev
      · rename_i e he
        cases hev
        obtain ⟨_, _, h3, h4⟩ := findInput_found_sound H d tr cfg T h e he
        exact ⟨h4, _, h4, rfl, rfl⟩
      · split at hev
        · rename_i e he
          cases hev
          obtain ⟨t, _, _, _, _, _, h7⟩ := findOutput_found_sound H d tr cfg T h e he
          exact ⟨h7, _, h7, rfl, rfl⟩
        · cases hev
  have hsome : ∃ ev, selectFraud H cfg.challenger tr T.expectedInputs T.terminal = some ev := by
    by_cases hgf : ∃ e, findGateDisprove H cfg.challenger tr = Find.found e
    · obtain ⟨e, he⟩ := hgf
      exact ⟨.gate e, by simp [selectFraud, he]⟩
    · by_cases hif : ∃ e, findInputBinding H cfg.challenger tr T.expectedInputs = Find.found e
      · obtain ⟨e, he⟩ := hif
        refine ⟨.input e, ?_⟩
        unfold selectFraud
        cases hg : findGateDisprove H cfg.challenger tr with
        | found e' => exact absurd ⟨e', hg⟩ hgf
        | invalid => simp [he]
        | clean => simp [he]
      · rcases hbad with hb | hb | ⟨t, ht, hz⟩
        · exact absurd (findGate_found_of_bad H d tr cfg T h hb) hgf
        · exact absurd (findInput_found_of_bad H d tr cfg T h hb) hif
        · obtain ⟨e, he⟩ := findOutput_found_of_bad H d tr cfg T h t ht hz
          refine ⟨.output e, ?_⟩
          unfold selectFraud
          cases hg : findGateDisprove H cfg.challenger tr with
          | found e' => exact absurd ⟨e', hg⟩ hgf
          | invalid =>
            cases hi : findInputBinding H cfg.challenger tr T.expectedInputs with
            | found e' => exact absurd ⟨e', hi⟩ hif
            | invalid => simp [he]
            | clean => simp [he]
          | clean =>
            cases hi : findInputBinding H cfg.challenger tr T.expectedInputs with
            | found e' => exact absurd ⟨e', hi⟩ hif
            | invalid => simp [he]
            | clean => simp [he]
  obtain ⟨ev, hev⟩ := hsome
  exact ⟨ev, hev, hsound ev hev⟩

end Coverage


/-! ## (b) No false disproof -/

theorem bindingInputFrauds_zero_iff {Pre Hash : Type} (tr : Trace Pre Hash)
    (E : List (Label × Bool)) : bindingInputFrauds tr E = 0 ↔ InputsMatch tr.value E := by
  unfold bindingInputFrauds InputsMatch
  rw [List.length_eq_zero_iff, List.filter_eq_nil_iff]
  refine forall_congr' (fun p => forall_congr' (fun _ => ?_))
  cases hp : (tr.value p.1 != p.2) <;> simp_all

theorem bindingOutputFrauds_zero_iff {Pre Hash : Type} (tr : Trace Pre Hash)
    (terminal : Option Label) : bindingOutputFrauds tr terminal = 0 ↔ OutputOne tr.value terminal := by
  unfold bindingOutputFrauds OutputOne
  cases terminal with
  | none => simp
  | some t =>
    cases hv : tr.value t <;> simp [hv]

section Honest

variable {Pre Hash Key : Type} [DecidableEq Hash] [DecidableEq Key]
  (H : Pre → Hash) (d : Label → Option Bool) (tr : Trace Pre Hash) (cfg : Cfg Key)
  (T : Template Hash Key)

/-- **No false disproof (b).** Let the template be built from the public trace. If every gate of
the revealed trace agrees with its revealed inputs, every verifier-derived input is revealed as
derived, and the terminal output is revealed as 1, then none of `findGateDisproveV2`,
`findInputBindingDisproveV2`, `findOutputBindingDisproveV2`, `selectFraudEvidence` returns
evidence, and `bindingFraudsV2` counts zero. The preimage-to-hash match is part of the
hypothesis `buildTemplate ... = some T`, which includes `verifyTrace`. -/
theorem honest_trace_not_disproved (h : buildTemplate H d tr cfg = some T)
    (hg : ∀ g ∈ tr.gates, GateConsistent tr.value g)
    (hi : InputsMatch tr.value T.expectedInputs) (ho : OutputOne tr.value T.terminal) :
    findGateDisprove H cfg.challenger tr
        = (Find.clean : Find (GateEvidence Pre Hash Key)) ∧
    findInputBinding H cfg.challenger tr T.expectedInputs
        = (Find.clean : Find (BindEvidence Pre Hash Key)) ∧
    findOutputBinding H cfg.challenger tr T.terminal
        = (Find.clean : Find (BindEvidence Pre Hash Key)) ∧
    selectFraud H cfg.challenger tr T.expectedInputs T.terminal
        = (none : Option (Evidence Pre Hash Key)) ∧
    bindingFrauds tr T.expectedInputs T.terminal = (0, 0) := by
  have h1 := (findGate_clean_iff H d tr cfg T h).2 hg
  have h2 := (findInput_clean_iff H d tr cfg T h).2 hi
  have h3 := (findOutput_clean_iff H d tr cfg T h).2 ho
  refine ⟨h1, h2, h3, ?_, ?_⟩
  · simp [selectFraud, h1, h2, h3]
  · unfold bindingFrauds
    rw [(bindingInputFrauds_zero_iff tr _).2 hi, (bindingOutputFrauds_zero_iff tr _).2 ho]

/-- The converse: the search returns nothing exactly when the trace is consistent, the derived
inputs match and the terminal output is 1. Together with `any_inconsistency_disproved` this says
the search is neither too weak nor too strong. -/
theorem selectFraud_none_iff (h : buildTemplate H d tr cfg = some T) :
    selectFraud H cfg.challenger tr T.expectedInputs T.terminal
        = (none : Option (Evidence Pre Hash Key)) ↔
      ((∀ g ∈ tr.gates, GateConsistent tr.value g) ∧ InputsMatch tr.value T.expectedInputs ∧
        OutputOne tr.value T.terminal) := by
  constructor
  · intro hn
    refine ⟨?_, ?_, ?_⟩
    · intro g hg
      refine Classical.byContradiction (fun hc => ?_)
      obtain ⟨ev, hev, _⟩ := any_inconsistency_disproved H d tr cfg T h (Or.inl ⟨g, hg, hc⟩)
      rw [hn] at hev; cases hev
    · intro p hp
      refine Classical.byContradiction (fun hc => ?_)
      obtain ⟨ev, hev, _⟩ :=
        any_inconsistency_disproved H d tr cfg T h (Or.inr (Or.inl ⟨p, hp, hc⟩))
      rw [hn] at hev; cases hev
    · intro t ht
      refine Classical.byContradiction (fun hc => ?_)
      obtain ⟨ev, hev, _⟩ :=
        any_inconsistency_disproved H d tr cfg T h (Or.inr (Or.inr ⟨t, ht, hc⟩))
      rw [hn] at hev; cases hev
  · rintro ⟨hg, hi, ho⟩
    exact (honest_trace_not_disproved H d tr cfg T h hg hi ho).2.2.2.1

omit [DecidableEq Hash] [DecidableEq Key] in
theorem bindingFrauds_zero_iff :
    bindingFrauds tr T.expectedInputs T.terminal = (0, 0) ↔
      (InputsMatch tr.value T.expectedInputs ∧ OutputOne tr.value T.terminal) := by
  unfold bindingFrauds
  rw [Prod.mk.injEq, bindingInputFrauds_zero_iff, bindingOutputFrauds_zero_iff]

/-- A revealed preimage that matches a committed hash of wire `l` fixes the bit of `l` to the
trace's value: no other bit of `l`, and no other wire, owns that hash. -/
theorem revealed_hash_bit (v : Verified) (hv : verifyTrace H tr = some v) (l : Label)
    (hl : l ∈ tr.labels) (b : Bool)
    (hrev : ∃ w, Revealed tr w ∧ H w = (tr.wire l).sel b) : b = tr.value l := by
  obtain ⟨w, ⟨m, hm, hw⟩, hH⟩ := hrev
  obtain ⟨_, hs, hhash, _⟩ := verifyTrace_spec H tr v hv
  have h1 := hhash m hm
  rw [hw] at h1
  have := hs.2.2.1 l hl m hm b (tr.reveal m).bit (hH.symm.trans h1)
  obtain ⟨hlm, hb⟩ := this
  subst hlm
  exact hb

omit [DecidableEq Hash] [DecidableEq Key] in
theorem spendable_hashes {s : Script Hash Key} {ws : List Pre}
    (hsp : Spendable H (Revealed tr) s ws) :
    ∀ x ∈ s.hashes, ∃ w, Revealed tr w ∧ H w = x := by
  intro x hx
  rw [← hsp.1] at hx
  obtain ⟨w, hw, rfl⟩ := List.mem_map.1 hx
  exact ⟨w, hsp.2 w hw, rfl⟩

/-- **No false disproof, on chain (b).** Under the same hypotheses, no disprove leaf of the
template can be spent from the preimages the operator published: each disprove leaf asks for the
preimage of a bit the honest trace did not reveal. (That the unrevealed preimage cannot be
produced is preimage resistance, which this statement takes as the restriction of witnesses to
`Revealed tr`.) -/
theorem honest_disprove_leaves_unspendable (h : buildTemplate H d tr cfg = some T)
    (hg : ∀ g ∈ tr.gates, GateConsistent tr.value g)
    (hi : InputsMatch tr.value T.expectedInputs) (ho : OutputOne tr.value T.terminal) :
    ∀ x ∈ T.leaves, x.isDisprove = true → ∀ (s : Script Hash Key) (ws : List Pre),
      x.script? = some s → ¬ Spendable H (Revealed tr) s ws := by
  intro x hx hdis s ws hscr hsp
  obtain ⟨v, hv, _⟩ := buildTemplate_spec H d tr cfg T h
  have hrev := spendable_hashes H tr hsp
  rcases (leaf_mem_template H d tr cfg T h x).1 hx with
    hgate | hinp | ⟨hleg, v', hv', hout⟩ | rfl | rfl | rfl
  · obtain ⟨g, hgm, hx'⟩ := List.mem_flatMap.1 hgate
    obtain ⟨r, hr, rfl⟩ := List.mem_map.1 hx'
    simp only [Leaf.script?, Option.some.injEq] at hscr
    subst hscr
    obtain ⟨hrw, hrlen⟩ := invalidRows_wrong g.kind r hr
    obtain ⟨hlen, hin, hoL⟩ := verified_gate_wires H tr v hv g hgm
    have hbits : ∀ p ∈ g.inputs.zip r.1, p.2 = tr.value p.1 := by
      intro p hp
      have hmem : (tr.wire p.1).sel p.2 ∈
          (⟨rowHashes tr.wire g r.1 r.2, cfg.challenger⟩ : Script Hash Key).hashes := by
        simp only [rowHashes, List.mem_append]
        exact Or.inl (List.mem_map.2 ⟨p, hp, rfl⟩)
      exact revealed_hash_bit H tr v hv p.1 (hin p.1 (List.of_mem_zip hp).1) p.2
        (hrev _ hmem)
    have hins : r.1 = g.inputs.map tr.value :=
      zip_forall_eq g.inputs r.1 tr.value (by rw [hlen, hrlen]) hbits
    have hmemo : (tr.wire g.output).sel r.2 ∈
        (⟨rowHashes tr.wire g r.1 r.2, cfg.challenger⟩ : Script Hash Key).hashes := by
      simp [rowHashes]
    have hout' : r.2 = tr.value g.output :=
      revealed_hash_bit H tr v hv g.output hoL r.2 (hrev _ hmemo)
    have e1 : tr.value g.output = g.kind.f (g.inputs.map tr.value) := hg g hgm
    have e2 : tr.value g.output = !(g.kind.f (g.inputs.map tr.value)) := by
      rw [← hout', hrw, hins]
    rw [e1] at e2
    generalize g.kind.f (g.inputs.map tr.value) = y at e2
    cases y <;> simp at e2
  · obtain ⟨p, hp, rfl⟩ := List.mem_map.1 hinp
    simp only [Leaf.script?, Option.some.injEq] at hscr
    subst hscr
    have hmem : (tr.wire p.1).sel (!p.2) ∈
        (⟨[(tr.wire p.1).sel (!p.2)], cfg.challenger⟩ : Script Hash Key).hashes := by simp
    have hb := revealed_hash_bit H tr v hv p.1 (template_expected_known H d tr cfg T h p hp)
      (!p.2) (hrev _ hmem)
    have := hi p hp
    rw [this] at hb
    cases hq : p.2 <;> simp_all
  · obtain ⟨hl, hterm⟩ : cfg.legacy = false ∧ T.terminal = some v'.circuit.terminal := by
      refine ⟨hleg, ?_⟩
      obtain ⟨w, hw, _, _, _, _, _, _, _, _, hterm, _⟩ := buildTemplate_spec H d tr cfg T h
      have hvw : w = v' := Option.some.inj (hw.symm.trans hv')
      subst hvw
      rw [hleg] at hterm
      simpa using hterm
    simp only [outputLeaves, inputLeaves, List.map_cons, List.map_nil, List.mem_singleton,
      Leaf.toOutput] at hout
    subst hout
    simp only [Leaf.script?, Option.some.injEq] at hscr
    subst hscr
    have hmem : (tr.wire v'.circuit.terminal).sel false ∈
        (⟨[(tr.wire v'.circuit.terminal).sel false], cfg.challenger⟩ : Script Hash Key).hashes := by
      simp
    have hb := revealed_hash_bit H tr v hv v'.circuit.terminal
      (template_terminal_known H d tr cfg T h _ hterm) false (hrev _ hmem)
    have := ho _ hterm
    rw [this] at hb
    cases hb
  all_goals simp [Leaf.isDisprove] at hdis

end Honest

/-! ## (d) Hash binding and equivocation -/

section Binding

variable {Pre Hash Key : Type}

/-- A preimage that matches a hash of a wire determines the bit, provided the wire's two
commitments differ (checked by `validateCircuitStructure`). This needs no collision-resistance
hypothesis: `H` is a function. -/
theorem preimage_determines_bit (H : Pre → Hash) (w : Wire Hash) (hne : w.hash0 ≠ w.hash1)
    (p : Pre) (b b' : Bool) (h1 : H p = w.sel b) (h2 : H p = w.sel b') : b = b' := by
  cases b <;> cases b' <;> first | rfl | (exfalso; apply hne; simp only [Wire.sel] at h1 h2; first | exact h1.symm.trans h2 | exact h2.symm.trans h1)

/-- In a verified trace no preimage matches two different (wire, bit) commitments. -/
theorem verified_preimage_owner [DecidableEq Hash] (H : Pre → Hash) (tr : Trace Pre Hash) (v : Verified)
    (hv : verifyTrace H tr = some v) (l l' : Label) (hl : l ∈ tr.labels) (hl' : l' ∈ tr.labels)
    (b b' : Bool) (p : Pre) (h1 : H p = (tr.wire l).sel b) (h2 : H p = (tr.wire l').sel b') :
    l = l' ∧ b = b' := by
  obtain ⟨_, hs, _⟩ := verifyTrace_spec H tr v hv
  exact hs.2.2.1 l hl l' hl' b b' (h1.symm.trans h2)

/-- Under `HashBinding`, the preimage that opens a committed hash is unique: the reveal of a
wire is determined by its bit. -/
theorem hashBinding_preimage_unique (H : Pre → Hash) (hb : HashBinding H) (w : Wire Hash)
    (b : Bool) (p p' : Pre) (h1 : H p = w.sel b) (h2 : H p' = w.sel b) : p = p' :=
  hb p p' (h1.trans h2.symm)

/-- Two reveals of the same wire for different bits use different preimages (this holds for any
function `H` once the wire's commitments differ). -/
theorem equivocation_two_preimages (H : Pre → Hash) (w : Wire Hash) (hne : w.hash0 ≠ w.hash1)
    (b b' : Bool) (hbb : b ≠ b') (p p' : Pre) (h1 : H p = w.sel b) (h2 : H p' = w.sel b') :
    p ≠ p' := by
  intro hpp
  subst hpp
  exact hbb (preimage_determines_bit H w hne p b b' h1 h2)

/-- Under `HashBinding`, two verified traces over the same commitments that reveal the same
values reveal the same preimages: the committed reveal is canonical, so the trace commitment
cannot be re-randomized by the operator after the fact. -/
theorem verified_reveals_canonical [DecidableEq Hash] (H : Pre → Hash) (hb : HashBinding H)
    (tr1 tr2 : Trace Pre Hash) (hlab : tr1.labels = tr2.labels) (hwire : tr1.wire = tr2.wire)
    (v1 v2 : Verified) (hv1 : verifyTrace H tr1 = some v1) (hv2 : verifyTrace H tr2 = some v2)
    (hval : ∀ l ∈ tr1.labels, tr1.value l = tr2.value l) :
    ∀ l ∈ tr1.labels, (tr1.reveal l).pre = (tr2.reveal l).pre := by
  intro l hl
  obtain ⟨_, _, h1, _⟩ := verifyTrace_spec H tr1 v1 hv1
  obtain ⟨_, _, h2, _⟩ := verifyTrace_spec H tr2 v2 hv2
  have e1 := h1 l hl
  have e2 := h2 l (hlab ▸ hl)
  have hv : (tr1.reveal l).bit = (tr2.reveal l).bit := hval l hl
  rw [← hwire, ← hv] at e2
  exact hb _ _ (e1.trans e2.symm)

/-- **Equivocation (d).** In a built template over a consistent trace, a second valid reveal
`(b', p')` for any wire `w`, with `b'` different from the committed bit, makes a disprove leaf
spendable from the published preimages together with `p'`. For a wire a gate produces the leaf is
that gate's invalid row; for a primary input it is the input-binding leaf. -/
theorem equivocation_always_punishable [DecidableEq Hash] [DecidableEq Key] {H : Pre → Hash} {d : Label → Option Bool}
    {tr : Trace Pre Hash} {cfg : Cfg Key} {T : Template Hash Key}
    (h : buildTemplate H d tr cfg = some T)
    (hg : ∀ g ∈ tr.gates, GateConsistent tr.value g)
    (hi : InputsMatch tr.value T.expectedInputs)
    (w : Label) (hw : w ∈ tr.labels) (b' : Bool) (p' : Pre) (hb' : b' ≠ tr.value w)
    (hp' : H p' = (tr.wire w).sel b') :
    ∃ x ∈ T.leaves, x.isDisprove = true ∧ ∃ (s : Script Hash Key) (ws : List Pre),
      x.script? = some s ∧ Spendable H (fun p => Revealed tr p ∨ p = p') s ws := by
  obtain ⟨v, hv, _⟩ := buildTemplate_spec H d tr cfg T h
  obtain ⟨_, hs, hhash, _⟩ := verifyTrace_spec H tr v hv
  by_cases hprod : ∃ g ∈ tr.gates, g.output = w
  · obtain ⟨g, hgm, hgo⟩ := hprod
    have e1 : tr.value g.output = g.kind.f (g.inputs.map tr.value) := hg g hgm
    have hne : b' ≠ g.kind.f (g.inputs.map tr.value) := by
      rw [← e1, hgo]; exact hb'
    have hmem := gate_leaf_mem H cfg.challenger tr v hv g hgm b' hne
    have hmemT := (leaf_mem_template H d tr cfg T h _).2 (Or.inl hmem)
    obtain ⟨hlen, hin, hoL⟩ := verified_gate_wires H tr v hv g hgm
    refine ⟨_, hmemT, rfl, _, g.inputs.map (fun l => (tr.reveal l).pre) ++ [p'], rfl, ?_, ?_⟩
    · simp only [List.map_append, List.map_map, List.map_cons, List.map_nil]
      congr 1
      · apply List.map_congr_left
        intro l hl
        simp only [Function.comp]
        exact hhash l (hin l hl)
      · rw [hp', hgo]
    · intro q hq
      rcases List.mem_append.1 hq with hq | hq
      · obtain ⟨l, hl, rfl⟩ := List.mem_map.1 hq
        exact Or.inl ⟨l, hin l hl, rfl⟩
      · simp at hq; exact Or.inr hq
  · have hprim : w ∈ primaryOf tr.labels tr.gates :=
      mem_primary_of hw (fun g hg' heq => hprod ⟨g, hg', heq⟩)
    rw [← template_keys_primary H d tr cfg T h] at hprim
    obtain ⟨⟨w', e⟩, hpE, hpw⟩ := List.mem_map.1 hprim
    simp only at hpw
    subst hpw
    have hve : tr.value w' = e := hi _ hpE
    have hbe : b' = !e := bool_ne_eq_not _ _ (by rw [← hve]; exact hb')
    have hmem := input_leaf_mem tr.wire cfg.challenger T.expectedInputs w' e hpE
    have hmemT := (leaf_mem_template H d tr cfg T h _).2 (Or.inr (Or.inl hmem))
    refine ⟨_, hmemT, rfl, _, [p'], rfl, ?_, ?_⟩
    · simp [hp', hbe]
    · intro q hq
      simp at hq; exact Or.inr hq

end Binding

/-! ## An honest operator's trace (`createWireSecretV2`, `buildPublicTraceV2`) -/

structure Secret (Pre : Type) where
  pre0 : Pre
  pre1 : Pre

def Secret.sel {Pre : Type} (s : Secret Pre) : Bool → Pre
  | true => s.pre1
  | false => s.pre0

/-- `buildPublicTraceV2`: commit to `sha256` of both preimages of every wire and reveal the
preimage of the chosen bit (bitvm_trace_v2.js:37-51, 186-221). -/
def honestTrace {Pre Hash : Type} (H : Pre → Hash) (labels : List Label) (gates : List Gate)
    (sec : Label → Secret Pre) (vals : Label → Bool) : Trace Pre Hash :=
  { labels := labels, gates := gates
    wire := fun l => ⟨H (sec l).pre0, H (sec l).pre1⟩
    reveal := fun l => ⟨vals l, (sec l).sel (vals l)⟩ }

theorem honestTrace_hash_matches {Pre Hash : Type} [DecidableEq Hash] (H : Pre → Hash)
    (labels : List Label) (gates : List Gate) (sec : Label → Secret Pre)
    (vals : Label → Bool) (l : Label) :
    hashMatches H (honestTrace H labels gates sec vals) l = true := by
  unfold hashMatches honestTrace
  cases hv : vals l <;> simp [Wire.sel, Secret.sel, hv]

/-- An honest build over a well-formed circuit passes `verifyPublicTraceV2`, and its fraud list
is exactly the gates where the chosen values disagree. -/
theorem honestTrace_verifies {Pre Hash : Type} [DecidableEq Hash] (H : Pre → Hash)
    (labels : List Label) (gates : List Gate) (sec : Label → Secret Pre) (vals : Label → Bool)
    (hg : GatesOk labels gates)
    (hs : StructOk labels (honestTrace H labels gates sec vals).wire gates) :
    ∃ v, verifyTrace H (honestTrace H labels gates sec vals) = some v ∧
      v.frauds = fraudsOf vals gates := by
  refine ⟨⟨vals, fraudsOf vals gates,
    ⟨primaryOf labels gates, (terminalsOf gates).headD 0⟩⟩, ?_, rfl⟩
  have hg' : GatesOk (honestTrace H labels gates sec vals).labels
      (honestTrace H labels gates sec vals).gates := hg
  have hs' : StructOk (honestTrace H labels gates sec vals).labels
      (honestTrace H labels gates sec vals).wire (honestTrace H labels gates sec vals).gates := hs
  have hall' : (honestTrace H labels gates sec vals).labels.all
      (hashMatches H (honestTrace H labels gates sec vals)) = true :=
    List.all_eq_true.2 (fun l _ => honestTrace_hash_matches H labels gates sec vals l)
  unfold verifyTrace
  have hsc : structureCheck (honestTrace H labels gates sec vals).labels
      (honestTrace H labels gates sec vals).wire (honestTrace H labels gates sec vals).gates =
      some ⟨primaryOf labels gates, (terminalsOf gates).headD 0⟩ := by
    unfold structureCheck
    split
    · rfl
    · contradiction
  split
  · rw [hsc]
    dsimp only
    rfl
  · contradiction


/-! ## Examples mirroring bitvm_trace_v2.test.js and bitvm_assertion_graph_v2.test.js

Wires 0, 1, 2 are the test's `a`, `b`, `c`; the one gate is `and(a, b) -> c`. The hash is
`p ↦ p + 100`, wire `l` has preimages `2l` and `2l + 1`. -/

namespace Examples

def HN : Nat → Nat := fun p => p + 100
def secN : Label → Secret Nat := fun l => ⟨2 * l, 2 * l + 1⟩
def andGate : List Gate := [⟨0, .and, [0, 1], 2⟩]
def mk (labels : List Label) (gates : List Gate) (vals : Label → Bool) : Trace Nat Nat :=
  honestTrace HN labels gates secN vals

def vals111 : Label → Bool := fun _ => true
def vals110 : Label → Bool := fun l => l != 2
def vals010 : Label → Bool := fun l => l == 1
def vals100 : Label → Bool := fun l => l == 0

/-- 'honest trace has no constructible invalid-row witness' -/
example : (verifyTrace HN (mk [0, 1, 2] andGate vals111)).isSome = true := by decide
example : (findGateDisprove HN 7 (mk [0, 1, 2] andGate vals111)).isClean = true := by decide

/-- 'fraudulent trace yields exactly one committed disprove leaf': a = b = 1, c = 0. -/
example : (findGateDisprove HN 7 (mk [0, 1, 2] andGate vals110)).isFound = true := by decide

example : (match findGateDisprove HN 7 (mk [0, 1, 2] andGate vals110) with
    | .found ev => decide (ev.rowIn = [true, true] ∧ ev.rowOut = false ∧
        ev.script = ⟨[HN 1, HN 3, HN 4], 7⟩ ∧ ev.preimages = [1, 3, 4])
    | _ => false) = true := by decide

/-- ... and that evidence is a leaf of the gate-disprove set. -/
example : (Leaf.gate 0 ⟨0, .and, [0, 1], 2⟩ [true, true] false ⟨[HN 1, HN 3, HN 4], 7⟩ :
    Leaf Nat Nat) ∈ gateLeaves (mk [0, 1, 2] andGate vals110).wire 7 andGate := by decide

/-- 'rejects vacuous, cyclic, orphaned, and ambiguous circuits' -/
example : (verifyTrace HN (mk [0, 1, 2] [] vals111)).isSome = false := by decide
example : (verifyTrace HN (mk [0, 1, 2] [⟨0, .and, [0, 2], 2⟩] vals111)).isSome = false := by decide
example : (verifyTrace HN (mk [0, 1, 2] [⟨0, .and, [0, 1], 0⟩] vals111)).isSome = false := by decide
example : (verifyTrace HN (mk [0, 1, 2, 3] andGate vals111)).isSome = false := by decide

/-- 'rejects equal and cross-wire reused bit commitments' -/
example : (verifyTrace HN
    { mk [0, 1, 2] andGate vals111 with wire := fun l => if l = 1 then ⟨HN 0, HN 3⟩ else
        ⟨HN (2 * l), HN (2 * l + 1)⟩ }).isSome = false := by decide
example : (verifyTrace HN
    { mk [0, 1, 2] andGate vals111 with wire := fun l => if l = 0 then ⟨HN 0, HN 0⟩ else
        ⟨HN (2 * l), HN (2 * l + 1)⟩ }).isSome = false := by decide

/-- 'tampered reveal ... rejected' -/
example : (verifyTrace HN
    { mk [0, 1, 2] andGate vals111 with reveal := fun l => if l = 0 then ⟨true, 255⟩ else
        ⟨true, 2 * l + 1⟩ }).isSome = false := by decide

/-- The derived expected bits of the test: `a` and `b` are verifier facts (bit 1). -/
def dN : Label → Option Bool := fun l => if l < 2 then some true else none

def cfgN (ch : Nat) (legacy : Bool) : Cfg Nat :=
  { operator := 1, challenger := 7, challengeCsv := ch, recoveryCsv := 144, legacy := legacy
    expectedInputs := none }

/-- 'BVM-3: the challenge window has a policy minimum': 0 and 5 are refused, 6 is accepted. -/
example : (buildTemplate HN dN (mk [0, 1, 2] andGate vals111) (cfgN 0 false)).isSome = false := by
  decide
example : (buildTemplate HN dN (mk [0, 1, 2] andGate vals111) (cfgN 5 false)).isSome = false := by
  decide
example : (buildTemplate HN dN (mk [0, 1, 2] andGate vals111) (cfgN 6 false)).isSome = true := by
  decide
/-- The recovery window (144) must exceed the challenge window. -/
example : (buildTemplate HN dN (mk [0, 1, 2] andGate vals111) (cfgN 144 false)).isSome = false := by
  decide

/-- A bound-predicate template over `and(a, b)` has the 4 gate rows, 2 input leaves, 1
terminal-output leaf and the 3 fixed leaves. -/
example : ((buildTemplate HN dN (mk [0, 1, 2] andGate vals111) (cfgN 6 false)).map
    (fun T => T.leaves.length)) = some 10 := by decide

/-- A legacy template must name an expected bit for every primary input; with them it has no
terminal-output leaf (9 leaves), and its terminal is not recorded. -/
def cfgLegacy : Cfg Nat :=
  { cfgN 6 true with expectedInputs := some [(0, true), (1, true)] }

example : (buildTemplate HN dN (mk [0, 1, 2] andGate vals111) (cfgN 6 true)).isSome = false := by
  decide
example : ((buildTemplate HN dN (mk [0, 1, 2] andGate vals111) cfgLegacy).map
    (fun T => (T.leaves.length, T.terminal))) = some (9, none) := by decide

/-- 'BVM-1: ... a circuit over signed-state bits that honestly computes 0 is disprovable at the
terminal output': derived `a = 1`, `b = 0`; the trace reveals a = 1, b = 0, c = 0. -/
def dN2 : Label → Option Bool := fun l => if l = 0 then some true else if l = 1 then some false else none

example : (match buildTemplate HN dN2 (mk [0, 1, 2] andGate vals100) (cfgN 6 false) with
    | some T => (findGateDisprove HN 7 (mk [0, 1, 2] andGate vals100)).isClean &&
        (findInputBinding HN 7 (mk [0, 1, 2] andGate vals100) T.expectedInputs).isClean &&
        (findOutputBinding HN 7 (mk [0, 1, 2] andGate vals100) T.terminal).isFound
    | none => false) = true := by decide

/-- 'wrong public input creates an input-binding disprove': derived `a = b = 1`, revealed
a = 0, b = 1, c = 0. -/
example : (match buildTemplate HN dN (mk [0, 1, 2] andGate vals010) (cfgN 6 false) with
    | some T => (findGateDisprove HN 7 (mk [0, 1, 2] andGate vals010)).isClean &&
        (findInputBinding HN 7 (mk [0, 1, 2] andGate vals010) T.expectedInputs).isFound
    | none => false) = true := by decide

/-- An honest trace over derived inputs with terminal 1 is not disproved by anything. -/
example : (match buildTemplate HN dN (mk [0, 1, 2] andGate vals111) (cfgN 6 false) with
    | some T => (selectFraud HN 7 (mk [0, 1, 2] andGate vals111) T.expectedInputs T.terminal :
        Option (Evidence Nat Nat Nat)).isNone
    | none => false) = true := by decide

end Examples

end UTXORefFormal.BitVM
