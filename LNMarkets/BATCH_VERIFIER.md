# UTXORef trade batch verifier integration

This bridge uses the [LNMarkets batch statement in
zk-rusto-no-bitcoino](https://github.com/patrickdugan/zk-rusto-no-bitcoino/tree/992cdb1c51b5c7a630ea552b2648acbad4308a9b/LNMarkets).
The upstream revision is pinned to
`992cdb1c51b5c7a630ea552b2648acbad4308a9b`, the reviewed head of its PR #28.
The statement commits one agreed **unsigned** settlement proposal for
1 to 32 selected, independently collateralized DLC trades.

## Wallet to witness

1. A wallet calls `batch.exportTrade` with its saved recovery package,
   independently retained plan and recovery pins, funding outpoint pin,
   the selected outcome, and two original DLC attestation scalars. UTXORef
   reconstructs and validates the complete package, then checks that the
   original evidence actually completes the selected CET. The exporter
   obtains scripts, amounts, parties and the payout table from the validated
   package. It takes no private key. Retain the generated salt with the
   approved trade summary so both parties sign identical bytes.
2. The summary maps the 32-byte suffix of `lnm-<planDigest>` to the batch
   contract ID. The oracle event uses a tagged SHA-256 hash of the original
   UTXORef event identifier as UTF-8. The selected payout is opened against
   the indexed Merkle tree of the full plan. The chosen original oracle
   subset determines which two application signatures the witness expects.
3. The venue checks the funding outpoints, maturity and accepted contracts
   against its chain view and its authenticated book. It builds the proposal
   with `batch.prepareBatch` using its current authorization root and the
   paths for sequential insertions. Canonical ordering is by displayed txid
   and then numeric vout. Each funding UTXO supplies one input. Identical
   payout scripts aggregate into one output, and the largest participating
   maturity height becomes the transaction locktime.
4. Trader and maker supply BIP340 signatures on their summary and new
   consent signatures binding the entire batch context, including the
   unsigned transaction and old/new authorization roots. Both selected
   oracles separately sign the batch statement using its `oracleDigest`. Existing
   DLC attestations are scalars for committed nonces in a different message
   domain. They must be checked at export and cannot serve as the new oracle
   signature. The fixture signs both envelopes using its public test keys.
5. `batch.assembleWitness` checks all six signatures per row, fixes their
   order, and encodes the private witness. The adapter also computes the
   exact 276-byte public journal for independent retention and comparison
   against the Rust statement and the proof's public output. The verifier's accepted-contract
   set comes from the venue's approved manifest. A prover-supplied root
   doesn't establish which trades the venue actually accepted.

Use the existing signer and recovery gates for any production expansion.
The bridge requests application signatures only. The current authorized
native signer exposes a CET signing policy and needs a reviewed, separate
policy for the new message domains. Original CET/refund transaction
signatures remain bound to their original transactions. Any combined spend
requires new Bitcoin signatures over the exact batch transaction and
independent Core validation. Timeout recovery remains a per-contract path.

## Verify the interoperation locally

Check out the pinned companion revision and build the native relation with
its locked dependencies. From UTXORef, generate two synthetic trades using
real recovery-package cryptography, then verify the result with the
companion executable. Both commands run under Linux with Node and Rust
installed. The witness directory is ignored by Git.

```sh
cargo build --locked --release \
  --manifest-path "$PROVER_REPO/LNMarkets/statement/Cargo.toml"
node LNMarkets/batch-demo.js --out LNMarkets/artifacts/batch-01 \
  --native "$PROVER_REPO/LNMarkets/statement/target/release/lnm-native"
```

With `--native`, the demo requires `native_verified_unproved` and the
same journal digest as `proposal.json`. It also exercises rejection of a
changed journal and a changed funding outpoint. The batch ABI workflow
runs these checks against the pinned companion source. The fixture uses
synthetic funding outpoints and aggregates the payouts into
660, 379,798 and 420,202 sat outputs and commits a 2,000-sat fee.

## Nova GPU proof

The batch proof target is Nova 0.76 over BN254 and Grumpkin with Spartan IPA
compression. Nova's Blitzar feature offloads BN254 commitments to NVIDIA
CUDA on Linux. The proof verifier can use the same reviewed circuit and
public parameters independently of the prover's accelerator.

The [Nova crate](nova/) implements a repeatable step for the old and
inserted authorization paths. The standalone initial state derives the
key and leaves from a specified outpoint. The circuit also constrains that
derivation for a private outpoint. Each path step consumes the next key bit
from the leaf end and computes both parents using the same sibling. A
standalone verifier supplies the initial state, verifies exactly 256 steps
and compares both roots.

The batch nullifier circuit starts from the journal's old root and proves
one path level per fold. The private funding outpoint derives both the
path key and the consumed leaf. At the end of each 256-step path the
empty-leaf branch must recover the current root before the consumed branch
advances it. Tests check the first and last levels of both saved paths
against the journal roots and reject completing the second path against
the stale root. The circuit can bind the ordered outpoints to the main
circuit through a shared digest over the private salt, txid and output
index of each signed summary. The tests reject reordering, salt changes
and output index changes against the same digest.

The amount step uses the v1 summary and outcome wire bits. It constrains
non-dust trader, maker and anchor outputs, the committed miner fee, exact
collateral conservation and the running Bitcoin money range. A regression
test reproduces the saved two-trade journal's 802,660 sats of collateral,
800,660 sats of payouts including anchors and 2,000 sats of fees.

The outcome circuit recomputes the selected leaf from the v1 bytes,
checks its index against the outcome count and compares the Merkle root
with the root in the signed summary. It pads the witness to a fixed circuit
shape independent of the outcome depth. The signing digest
circuit computes the exact summary, oracle and batch consent messages
from those same bytes and the agreed context. The BIP340 transcript
checks coordinate and signature scalar ranges and constrains the
challenge modulo the secp256k1 group order. A test reproduces the
challenge for a saved trader signature and rejects a changed message
against the same challenge.

The secp256k1 circuit validates even-Y public key lifts and constrains
the BIP340 group equation over the Nova field. It verifies the complete
saved trader signature and rejects changing its scalar. The funding
circuit rebuilds the two leaves with canonical CSV encodings, sorts the
TapBranch and constrains the BIP341 tweak and the resulting NUMS output
key. It matches the saved funding script and rejects changing its output
key. The CSV tests match the existing UTXORef implementation at each
script-number encoding boundary.

The accepted-set circuit commits to every summary digest in canonical
row order and applies the v1 padding rule. The transaction circuit binds
ordered outpoints, the unsigned Bitcoin input template, unique sorted
P2TR output scripts, maximum maturity, the signed SHA-256 digest and the
display-order txid. It also matches every trader, maker and anchor
payout to exactly one output by full script and sums all payouts sharing
that script. The tests reproduce the saved 379,798-sat trader,
420,202-sat maker and 660-sat anchor outputs. Changing the trader and
maker payouts by one satoshi or substituting the anchor script fails
even with recomputed transaction digests.

The summary policy checks unique contract IDs, payout roles, maturity and
refund heights, and the ordering of oracle keys. The oracle selector binds
two distinct indices to their summary keys and accepts all three valid
two-of-three subsets. The journal circuit binds the agreed context and
constrained totals to all 276 public bytes and checks the validity window.

```sh
cargo test --locked --release --manifest-path LNMarkets/nova/Cargo.toml \
  -- --test-threads=1
```

The native ABI workflow passes its two-trade witness to the Nova
authorization constraint test. It checks all twelve signatures, both
funding commitments, the retained journal and the shared digest used by
the nullifier circuit. It also changes a selected oracle signature and
checks that the authorization constraints reject it. Run the same check
against a fixture accepted by the pinned native verifier.

```sh
LNM_BATCH_FIXTURE="$PWD/LNMarkets/artifacts/batch-01" \
  cargo test --locked --release --manifest-path LNMarkets/nova/Cargo.toml \
  native_fixture_binds_every_row -- --ignored --test-threads=1
```

The GPU smoke test runs a two-step Nova fold with private factors,
compresses it with Spartan IPA, verifies the expected output and checks
rejection under an altered public input. It exercises the proving backend
with a small arithmetic circuit. Use Linux x86-64 with NVIDIA CUDA access.

```sh
cargo run --locked --release --manifest-path LNMarkets/nova/Cargo.toml \
  --features gpu --example gpu_smoke
```

On the local RTX 5080 Laptop GPU under WSL, the run with
`CUDA_LAUNCH_BLOCKING=1` completed both folds and Spartan IPA compression.
Verification accepted the expected output and rejected the altered public
input. This result covers the smoke circuit's two multiplications.

The same CUDA path verified a Nova proof of both saved settlement amount
rows against the exact journal totals and rejected an altered public input.
Run that component proof from the repository root.

```sh
CUDA_LAUNCH_BLOCKING=1 cargo run --locked --release \
  --manifest-path LNMarkets/nova/Cargo.toml --features gpu --example gpu_smoke \
  -- --settlement-amounts
```

The nullifier example runs all 512 folds for the saved two-trade witness
and checks the old and new roots against the retained journal. To run a
fresh fixture, pass the witness and its separately retained journal from
the batch demo.

```sh
CUDA_LAUNCH_BLOCKING=1 cargo run --locked --release \
  --manifest-path LNMarkets/nova/Cargo.toml --features gpu --example gpu_smoke \
  -- --nullifiers LNMarkets/artifacts/batch-01/witness.bin \
  LNMarkets/artifacts/batch-01/expected-journal.bin
```

On the RTX 5080 Laptop GPU under WSL, the saved run completed all 512
folds in 245.6 seconds. Recursive verification matched the final state
against the saved journal and the digest derived from the fixture's
ordered summaries. Spartan IPA verification matched the same state and
rejected altered public input.

The curve circuit processes eight joint scalar bits per step. Each row
contributes the Taproot funding equation and six BIP340 equations. The
authorization circuit derives all fourteen from the signed bytes of the
saved two-trade fixture and binds their order, inputs and parity rules
with a salted Poseidon commitment. On CUDA, all 448 folds finished in
204.3 seconds and recursive verification matched that commitment.
The curve step has 191,895 primary constraints including Nova's wrapper.
The two-trade authorization step has 3,349,692 constraints before its
wrapper. Selecting the canonical CSV leaf padding before SHA-256
compression removed 303,696 constraints for the fixture.

The batch verifier checks three compressed Nova artifacts. Its
authorization step starts with the separately retained journal, checks
the full settlement and signing transcript, and returns the curve and
outpoint commitments. The curve verifier uses 224 steps per retained row.
The nullifier verifier uses 256 and checks both roots from the same
journal. Both verified commitment outputs must match the authorization
proof. Fresh private salts hide the committed row data.

The prover and verifier both derive parameters from witness-free
circuits. The fixture tests compare the ordered constraint matrices and
output registers with those of populated circuits.

Generate the three proof files from a native-verified two-trade fixture.
The output paths should be new. The complete proof-set run remains
pending.

```sh
manifest=LNMarkets/nova/Cargo.toml
fixture=LNMarkets/artifacts/batch-01
proofs=LNMarkets/artifacts/batch-01-nova
mkdir "$proofs"
export CUDA_LAUNCH_BLOCKING=1
cargo run --locked --release --manifest-path "$manifest" --features gpu \
  --example gpu_smoke -- --authorization-body "$fixture" "$proofs/authorization.bin"
cargo run --locked --release --manifest-path "$manifest" --features gpu \
  --example gpu_smoke -- --curve-equations "$fixture" "$proofs/curve.bin"
cargo run --locked --release --manifest-path "$manifest" --features gpu \
  --example gpu_smoke -- --nullifiers "$fixture/witness.bin" \
  "$fixture/expected-journal.bin" "$proofs/nullifier.bin"
```

Build the independent verifier from the reviewed Nova source. The
example layout has three transaction outputs. Supply the approved
journal separately from the proof directory.

```sh
cargo run --locked --release --manifest-path "$manifest" --bin lnm-nova-verify -- \
  "$fixture/expected-journal.bin" 3 "$proofs/authorization.bin" \
  "$proofs/curve.bin" "$proofs/nullifier.bin"
```

The venue-facing `verify-batch.js` wrapper pins the absolute Nova verifier
path and its SHA-256, the journal SHA-256, output count, expected epoch,
current nullifier root and observed block height. It checks the verifier's
receipt covers the three exact proof files before writing its own receipt.

```sh
node LNMarkets/verify-batch.js --policy "$trusted_policy" \
  --journal "$approved_journal" --proof "$proofs" --report "$new_receipt"
```

The policy fields are `network` with value `bitcoin-regtest`,
`hostExecutable`, `hostSha256`, `expectedJournalSha256`, `outputCount`,
`expectedEpoch` as a decimal string, `currentNullifierRoot` and
`observedHeight`. The proof directory contains `authorization.bin`,
`curve.bin` and `nullifier.bin`.

For the saved two-trade journal, the venue integration test checks a
real receipt and repeats verification with the nullifier artifact
substituted for the curve artifact. The test takes the receipt inputs
from a temporary directory that contains the retained journal and
compressed proofs.

```sh
LNM_NOVA_VERIFIER="$PWD/LNMarkets/nova/target/release/lnm-nova-verify" \
  LNM_NOVA_PROOFS="$proofs" node --test LNMarkets/test/nova-proof-set.test.js
```

Before accepting a verified batch, the venue must atomically compare the
retained epoch and old root with current state and commit the new root and
batch ID. Production still depends on authenticated venue acceptance, a
reviewed native signer, the new oracle envelope and durable replay state.
The journal exposes context and totals. Any later Bitcoin spend exposes
the transaction's inputs and outputs.


## Recorded native checks

On 2026-11-20, the pinned release-mode Rust executable accepted the UTXORef
two-trade witness and matched every byte of the 276-byte approved journal.
The witness was 18,704 bytes and the unsigned proposal was 221 bytes.
The journal SHA-256 was
`d86b336aa405809b466694c13a285dc632230bdcf46f73be9c7f1a18d1dbbe00`.
The unsigned transaction ID was
`7ccc11820d2fa838f8667dc06599a436f2a318b6cdff7d78174facd9c6e915a6`.
Bitcoin Core 31.1 independently decoded the same txid, two inputs, three
outputs and locktime 1001. The native verifier rejected a one-bit change to the expected accepted-set
root and a one-bit change to an outpoint in the signed witness. Fresh
recovery-package signatures can change the witness and journal on rerun.
The repository-wide Node regression runner passed all 120 test files with
loopback access for the local RPC fixtures.

The exporter also validated the saved CET package and attestations from
the confirmed [Bitcoin Core run](REGTEST_REPORT.md). Its selected row bound
outpoint `2b267af922cf90823760a82e1f13e52557d39db4c3f79304e1c10eebf07902b9:0`
to its 401,330-sat funding value and the 290,909 / 109,091-sat payouts.
This exercised the wallet export of an actual confirmed contract. Fresh
co-signs for a batch were exercised with the synthetic fixture, whose
party and oracle keys are available for testing.


## Recorded SP1 preparation

The pinned SP1 6.9.0 CLI compiled the companion's locked guest for
`riscv64im-succinct-zkvm-elf` in WSL. The local ELF was 269,072 bytes
with SHA-256
`bad71141000e84d32881b2f7667b09bb673b8601670ad6d4b29c6e46759ca5d5`.
The official CLI derived this program key in SP1's `bytes32()` encoding.

```text
0x00ea8fcb7a6005d796ce6cc7ec643aa399831db9d2529fb6cba72d7a0eae8f52
```

The release-mode SP1 host independently derived the same program key.
Its equivalent pin for `programVkDigest` uses eight little-endian words.

```text
bde54775e5750118fd98cd5939aa4346ceed184cdb7e4a49f45a4e17528fae0e
```

The guest exited successfully after 48,224,478 instructions and committed
all 276 bytes of the independently retained journal. Guest execution took
9.78 seconds after 16.61 seconds of host key setup. See the
[recorded SP1 execution](evidence/sp1-two-trade-execution.json) and the
[exact public journal](evidence/sp1-two-trade-journal.bin).

The execution result is `executed_unproved`. It provides an independent
reference for the Nova circuit's expected output.
