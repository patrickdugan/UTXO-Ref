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

The first ported constraint in [the Nova crate](nova/) computes one level
of the old and inserted authorization paths. Both computations share the
same sibling and direction and use the v1 tagged SHA-256 node format.
Run its constraint test with the locked dependencies.

```sh
cargo test --locked --release --manifest-path LNMarkets/nova/Cargo.toml
```

The GPU smoke test runs a two-step Nova fold with private factors,
compresses it with Spartan IPA, verifies the expected output and checks
rejection under an altered public input. It exercises the proving backend
with a small arithmetic circuit. Use Linux x86-64 with NVIDIA CUDA access.

```sh
cargo run --locked --release --manifest-path LNMarkets/nova/Cargo.toml \
  --features gpu --example gpu_smoke
```

For batch acceptance, the circuit must derive the nullifier bit from the
funding outpoint key, process all 256 levels per row, and connect each new
root to the next row. It also needs the pinned statement's summary and
outcome membership checks, all six BIP340 signatures per row, Taproot
funding commitments, settlement transaction assembly and amounts, and all
276 public journal bytes. Acceptance remains pending until a compressed
proof of that full relation verifies against independently retained journal
bytes, circuit parameters and venue state.

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
[exact public journal](evidence/sp1-two-trade-journal.bin). A verifier-only
probe passed that journal to the pinned host through `verify-batch.js`.
The host rejected a truncated proof during decoding and wrote no receipt.

The execution result is `executed_unproved`. It provides an independent
reference for the Nova circuit's expected output.
