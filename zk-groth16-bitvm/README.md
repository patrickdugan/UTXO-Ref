# ZK / Groth16 / BitVM for UTXO-Ref L2 settlement

This folder develops proof-backed settlement of UTXO-Ref's committed L2
obligations into exact Bitcoin payouts. The first target is the existing V2
referee relation: the proposed settlement spends the designated assertion
outpoint and pays the ordered outputs authorized by the committed state.

The work stays inside UTXO-Ref's L2 settlement role. Existing derivatives
accounting and DLC flows supply state through their established boundaries.
This folder adds no shared settlement framework for other repositories.

## Implemented starter

`statement.cjs` defines an experimental, domain-separated statement codec.
It binds the V2 commitment to an assertion outpoint and settlement TXID,
with chain, contract, epoch, program, verifying-key and trust-policy identities.
A SHA-256 digest is exposed as two ordered 128-bit public-input limbs.

`inspectStatementV0()` always returns `UNVERIFIED_STATEMENT_ONLY`,
`proofVerified: false` and `settlementAuthorized: false`. Encoding an asserted
hash establishes no validity for the referenced state or transaction.
The included fixtures use synthetic hashes throughout.

Run with Node.js 22 or later, using built-in modules only:

```sh
node --test zk-groth16-bitvm/statement.test.cjs
```

Local verification on 2026-11-01: **15 tests passed, 0 failed**, Node v22.16.0.
Golden bytes and digest were generated independently with Python
`struct`/`hashlib`. This run covers the isolated codec and its negative cases.
Focused integration tests now exercise the V2 referee and Groth16 statement adapter.
Real Groth16 execution and Bitcoin-enforced settlement remain pending.

## Stage 1 off-chain V2 integration (PR #11)

`v2_adapter.cjs` requires a single explicitly pinned assertion UTXO as
V2's settlement input. It compares the funded outpoint, amount, and Taproot
script against externally supplied policy, invokes the existing V2 referee,
and then derives the deterministic V0 proof statement. Every inspection
remains non-authorizing and unproved.

The focused [GitHub Actions run](https://github.com/patrickdugan/UTXO-Ref/actions/runs/41272453779)
passed **28 statement/adapter tests and 10 existing V2 tests** on November 1,
2026. A deterministic positive case exercises the signed checkpoint, payout
batch and canonical unsigned transaction; negative cases test tampering and
a valid V2 multi-input batch that the single-assertion profile excludes.
The fixture contains synthetic testnet4 identities and a development-only key.

See [V2 settlement gate](V2_RELATION_GATE.md) for the exact trust boundary.
The upstream L2 deposits-to-assertion graph and real Bitcoin inclusion
checks remain independent obligations.

Run:

```sh
node --test zk-groth16-bitvm/statement.test.cjs zk-groth16-bitvm/v2_adapter.test.cjs zk-groth16-bitvm/v2_adapter.integration.test.js
node bitvm3/utxo_referee/utxoref_v2.test.js
```

## Intended proof path

```text
V2 state checkpoint + funding/payout witnesses + exact unsigned settlement
  -> constrained L2 settlement relation
  -> Groth16 proof under a pinned verification key
  -> local verification against the frozen statement
  -> reviewed BitVM verifier/dispute graph bound to that same statement
  -> settlement or dispute/recovery under the graph's actual spend conditions
```

Groth16 proving, cryptographic proof verification and Bitcoin-enforced dispute
execution are unimplemented here. The folder has no signer, RPC client or
broadcast path. Its network labels are restricted to regtest and testnet4.
Privacy guarantees require a separate witness and data-availability review.

## Existing integration points

The source baseline is UTXO-Ref commit
`d90311537c833e684a205686a55ae84b8df574bc`:

- [`utxoref_v2.js`](../bitvm3/utxo_referee/utxoref_v2.js): canonical V2 commitments,
  unique funding/payout sets, conservation and exact output vectors.
- [`UTXOREF_V2_SECURITY_MODEL.md`](../bitvm3/utxo_referee/UTXOREF_V2_SECURITY_MODEL.md):
  pinned checkpoint signers, challenger authorization and remaining blockers.
- [`bitvm_assertion_graph_v2.js`](../bitvm3/utxo_referee/bitvm_assertion_graph_v2.js):
  the existing graph integration surface, requiring its own review before reuse.
- [Cashu work in PR #9](https://github.com/patrickdugan/UTXO-Ref/pull/9):
  separate `PaymentClaimV1` work on `research/cashu-bitvm-trigger-20261028`,
  inspected at `3d053c02b430b83a6dfe63ab77ec70afe311de88`. Its ABI and branch
  are unchanged by this addition.

The existing V2 circuit consumes externally checked boolean facts. The new
relation must implement its stated checks inside the prover before any proof
can stand in for those checks. The current checkpoint authority remains an
explicit assumption until a separately specified state-transition proof exists.

[Statement specification](STATEMENT.md) fixes the experimental byte contract.
[Engineering handoff](HANDOFF.md) records the next implementation gates.
