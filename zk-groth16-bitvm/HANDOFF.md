# Engineering handoff: UTXO-Ref Groth16 / BitVM

## Starting point

Keep changes in `zk-groth16-bitvm/` until an integration gate explicitly
requires a reviewed change to the V2 referee. This work concerns UTXO-Ref's
L2 settlement obligations and exits. Preserve the existing settlement ABI,
DLC boundaries and separate Cashu branch.

Inspected baseline: `d90311537c833e684a205686a55ae84b8df574bc`.
`bitvm3/utxo_referee/utxoref_v2.js` blob:
`ce2f3ded7fa287e6f9e4911cd5060e7649062b6e`.
Security-model blob: `55db310a7b1c69333855e929a0c44e2b199fb7a5`.
Recheck these pins and concurrent work before implementing the next stage.

## Gate 1: executable V2 relation parity

Build a deterministic fixture adapter using the actual V2 builders and
checkers. Reuse canonical serialization. Specify the trust-policy artifact
and witness bounds before freezing a circuit. Include the same valid case
and invalid cases in the host checker and future prover tests.

Cover output substitution/reordering, duplicate requests/outpoints, wrong
epoch/contract/network, bad or untrusted checkpoint signatures, stale or
reorganized snapshots, fee/value overflow, extra transaction inputs/outputs,
and mutated version/sequence/locktime. Document how the reserve funding set
maps to the assertion's real input value and how each request is consumed.

Exit evidence: byte-identical V2 commitments, exact TXID/outpoint checks,
reference parity results and a list of assumptions that remain external.
Codec mutation tests alone cannot satisfy this gate.

## Gate 2: real Groth16 proof

Choose and pin a backend plus its dependency lockfiles. A direct bounded
settlement circuit and a wrapped program remain candidates pending measured
cost and verifier compatibility. Reuse existing proof work through an explicit
adapter once its exact statement and source revision have been inspected.

Constrain the actual settlement relation, statement digest and public-input
layout. Pin the verification key externally. Record setup provenance,
compiler/program digest, proof encoding and runtime limits. Add real proofs,
wrong-key tests, malformed points/proofs and public-input mutations. Run a
separate verifier against the same artifacts. Any development-only setup
must be labeled and kept away from custody.

Exit evidence: reproducible proofs and independent verification with recorded
latency/memory, plus rejection of the negative vectors. Proof size and speed
remain unmeasured until this run exists.

## Gate 3: BitVM dispute binding on regtest

Primary upstream references:
[BitVM verifier implementation](https://github.com/BitVM/BitVM) and
[SNARK verifier design](https://bitvm.org/snark.html).
These are discovery references; no upstream revision has been adopted here.
Pin and review the chosen implementation before importing code. Its protocol
assumptions must be reconciled with UTXO-Ref's existing V2 graph.

Resolve the TXID/commitment dependency ordering in STATEMENT.md first. Then
bind the exact key, statement and challenged computation to the funded graph.
Exercise honest settlement, invalid-proof dispute, operator silence, challenge
expiry, emergency recovery and double-spend/reorg behavior with Bitcoin Core
on isolated regtest. Include the current graph's signer roles, data-availability
requirements and fee-rescue constraints in the test plan.

Exit evidence: reproducible graph artifacts and Core-validated transactions
for each path. A local Groth16 verification result leaves this gate open.

## Gate 4: review and controlled integration

Audit setup/key substitution, unconstrained witnesses, transcript replay and
all graph spend paths. Review who can challenge and what data they need.
Retain current signer/checkpoint assumptions in user-visible documentation
until independently reviewed replacements exist. Add explicit operational
limits before any testnet integration and obtain separate approval for funded
runs. Mainnet custody remains outside this starter.

## Verification recorded for this addition

```text
node --test zk-groth16-bitvm/statement.test.cjs
Node v22.16.0
15 passed; 0 failed; 0 skipped
```

The golden vector was independently encoded with Python `struct` and hashed
with `hashlib`. Only the standalone codec suite was executed. All four gates
above remain open; existing V2 runtime files and PR #9 were left untouched.

## Stage 1 progress: 2026-11-01 (PR #11)

Focused CI run [41272453779](https://github.com/patrickdugan/UTXO-Ref/actions/runs/41272453779)
passed all 28 statement/adapter tests and all 10 existing V2 referee tests.
The positive differential fixture uses a fixed dev-only Ed25519 key and a
V2 settlement spending one synthetic P2TR assertion outpoint. The adapter
checks pinned outpoint, amount, script, chain, state freshness, payout
commitment and exact unsigned transaction through the existing verifier.

**Next agent entry task:** implement authenticated assertion funding evidence
and specify the deposits-to-assertion graph boundary. Keep the V2
`fundingOutpoints` definition as settlement transaction inputs. Inspect the
[relation gate](V2_RELATION_GATE.md), derive a bounded witness contract and
make a truth table for on-chain versus externally trusted predicates. A
verified host statement is not yet a constrained Groth16 relation.

Remaining Gate 1 checks include a frozen canonical trust-policy artifact,
real assertion script/value provenance, authenticated chain tip/reorg handling,
and complete reference-negative cases for every circuit predicate. Preserve
the single-assertion rule until a separate multi-input profile is specified.


## Real Bitcoin Core regtest, 2026-11-01

**Verified:** the isolated Bitcoin Core 31.0 dry-run workflow completed
successfully at [run #41273922843](https://github.com/patrickdugan/UTXO-Ref/actions/runs/41273922843),
head `f7425719324d4912165585b7b8428144b7800a86`.

Evidence:
[permanent JSON receipt](artifacts/regtest_core_dry_run_2026-11-01.json)
and [workflow artifact](https://github.com/patrickdugan/UTXO-Ref/actions/runs/41273922843/artifacts/13071025026)
(artifact retention 7 days).

- Real Core reports `/Satoshi:31.0.0/` on `regtest`.
- Wallet-controlled Taproot surrogate funded: 6,000 sats.
- Exact settlement: V2 reference accepted 5,000 sats in payouts and a
  1,000-sat fee.
- Premature sequence-6 spend: Core rejected `non-BIP68-final`.
- After 7 confirmations: Core `testmempoolaccept` accepted the signed
  transaction.
- Redirect one payout to a different output: V2 rejected; Core accepted
  the wallet-signed surrogate spend. This demonstrates the absence of
  on-chain L2 settlement authorization on the surrogate's key path.
- After invalidating the funding block, the checkpoint's snapshot was
  no longer on the active chain and the assertion lost mature confirmation.

**Trust boundary:** this uses a wallet-owned P2TR surrogate and therefore
does not exercise UTXO-Ref's actual NUMS-keyed Taproot assertion graph.
It proves a Core policy and V2 interface observation, not Groth16
correctness or BitVM enforcement. Signed settlement transactions were
never broadcast. Synthetic regtest funds only.

### Next agent instruction: enforce the actual assertion graph

Inspect `bitvm3/utxo_referee/bitvm_assertion_graph_v2.js`,
`UTXOREF_V2_SECURITY_MODEL.md`, `REGTEST_DRY_RUN.md` and the receipt.
Keep the PR draft, retain the current test as a negative control, and
start with a **static graph/commitment audit**. Resolve the pre-funding
commitment -> funding TXID -> post-funding Groth16 statement ordering
and the host V2 funding-input mapping.

Build a second isolated regtest script which funds the actual
deterministic NUMS Taproot assertion output and exercises its complete
pre-signed settlement, challenger fraud and emergency recovery paths.
Require Bitcoin Core `testmempoolaccept` observations and whole-run
receipts for each. Preserve the independent challenger assumption and
ensure no wallet-controlled key-path escape exists in the funded output.
Do not alter the current V2 signing authority or broadcast outside
regtest. Audit the signed exact settlement and fee/relay behavior.

Before Groth16 circuit work, pin a canonical policy artifact and a
bounded witness relation with a deterministic test oracle. Mark all
remaining externally trusted facts, particularly checkpoint authority,
chain inclusion and active-chain freshness. An off-chain verified
statement alone cannot grant spending authority.

Stop the next agent at a draft PR with tested graph paths, adverse
vectors, and unresolved security assumptions. Mainnet custody and
production key handling remain out of scope.
