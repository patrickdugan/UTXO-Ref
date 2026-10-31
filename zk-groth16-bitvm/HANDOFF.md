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
