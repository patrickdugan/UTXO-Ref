# Signer Migration Plan

This is a plan document only. No cryptographic code is changed here. It
describes how to remove hand-rolled value-signing from the pilot path
before any real-value use, per [`SECURITY_BLOCKERS.md` #1 and #2](SECURITY_BLOCKERS.md).

## Why this exists

`tradelayer_dlc_adaptor_sig.js`, `tradelayer_musig2.js`, and
`tradelayer_taproot.js` implement secp256k1 point arithmetic, BIP340 Schnorr,
BIP327 MuSig2, and BIP341 tweaking from scratch in plain JavaScript BigInt.
The repo's own header on the adaptor-signature file already states this is
"a reference implementation for testnet DLC settlement, not a constant-time
production signer." Correctness is well-tested against published vectors;
resistance to a timing adversary and to nonce-reuse is not designed for or
tested at all. This is acceptable for demonstrating the protocol on
testnet; it is not acceptable for anything that custodies real value.

## What must move, and to where

### 1. Point arithmetic / raw signing primitives

**Current:** `pointAdd`, `pointDouble`, `pointMul`, `invMod` in
`tradelayer_dlc_adaptor_sig.js` — variable-time, no side-channel protection.

**Target:** libsecp256k1 via a reviewed binding. Options, roughly in order
of preference for a Node.js pilot:

- **`secp256k1` (npm, native bindings to libsecp256k1)** — mainstream,
  widely used in Bitcoin JS tooling, constant-time underlying C library.
  Lowest migration effort since the call sites (scalar mult, point add,
  Schnorr sign/verify) map almost 1:1 to the existing function names.
- **Bitcoin Core RPC signing (`signrawtransactionwithwallet`,
  `walletprocesspsbt`)** — already used elsewhere in this repo's live-path
  demos for cooperative signing. Where the protocol only needs a standard
  signature (not an adaptor pre-signature), prefer delegating to Core's
  wallet entirely and removing the custom signer from that path.
- **Rust bindings (`rust-secp256k1` via napi-rs/neon) or a sidecar
  process** — higher migration effort, but keeps the hot cryptographic path
  in a language/library with a much larger security-review history than a
  from-scratch JS implementation. Worth it if the pilot's adaptor-signature
  and MuSig2 needs outgrow what the `secp256k1` npm package exposes
  directly (it does not have first-class adaptor-signature or MuSig2 APIs
  today, so those layers likely still need bespoke code even after
  migration — see below).

### 2. Adaptor signatures and MuSig2 (protocol-level logic, not raw math)

Adaptor signatures and MuSig2 aggregation are not standard operations
exposed by mainstream libsecp256k1 bindings — this repo's from-scratch
implementation of *those specific layers* is not unusual in the DLC/BitVM
space (most DLC libraries roll their own on top of a vetted point-arithmetic
base). The migration goal here is narrower than "rewrite everything":

- Keep the *protocol logic* (which scalars get added when, what the adaptor
  offset is, how the outcome point is derived) — this is well-tested against
  vectors and is the actual novel content.
- Replace only the underlying field/point arithmetic those functions call
  into, so a timing side-channel in point multiplication doesn't leak the
  private scalar regardless of which layer is on top.
- Independently re-audit or vendor-test the nonce-generation and
  nonce-aggregation code against BIP327's specific reuse-safety
  requirements once it sits on a reviewed arithmetic base — a safe base
  library does not by itself fix a protocol-level nonce-reuse bug.

Reference projects worth reviewing for a battle-tested adaptor-signature/
MuSig2 layer instead of retaining the bespoke one: `rust-dlc`, `libsecp256k1-zkp`
(has native MuSig2 module support), and BDK's signer abstractions. Any of
these would reduce the amount of from-scratch protocol code this repo needs
to maintain, at the cost of introducing a Rust/native dependency.

### 3. Taproot tweak / sighash (BIP341)

**Current:** `tradelayer_taproot.js` hand-builds the keypath tweak and
`SIGHASH_DEFAULT` sighash, justified because the pilot's Litecoin Core
0.21.2.2 node has no native taproot address tooling.

**Target:** once the pilot targets a node/library with native taproot
support (any current Bitcoin Core, or a Litecoin Core version with taproot
address support), prefer PSBT-based taproot construction through that
tooling over hand-built sighash bytes. Keep the hand-built path only as a
documented, vector-tested fallback for chains without native tooling, and
never on the value-bearing signing path once a native alternative exists.

### 4. Where signing should not be removed

The BitVM circuit/Script layer (`tradelayer_bitvm_circuit.js`,
`tradelayer_bitvm_comparator.js`, `tradelayer_bitvm_sha256.js`,
`tradelayer_taproot_script.js`, `tradelayer_taproot_tree.js`) does not sign
with value-bearing keys — it builds Script/taproot-tree structures and
control blocks. This is not in scope for this migration; it's a Script
construction problem, not a signing problem. Leave as-is.

## Sequencing

1. Stand up the `secp256k1` npm binding (or chosen alternative) alongside
   the existing implementation; do not remove the existing code yet.
2. Re-run every existing vector test (BIP340/BIP327/BIP341, vendored in
   this repo) against the new binding's outputs to confirm bit-for-bit
   parity before switching any call site.
3. Migrate point arithmetic / plain Schnorr sign-verify first (lowest risk,
   used in `tradelayer_taproot_dlc_demo.js`'s single-key path).
4. Migrate MuSig2 key aggregation and partial signing next, with explicit
   nonce-session bookkeeping added at the same time (this closes
   `SECURITY_BLOCKERS.md` #2, not just #1).
5. Migrate the adaptor-signature layer last, since it has the most
   bespoke protocol logic sitting on top of the base arithmetic.
6. Only after all four signing modules are migrated and re-vector-tested,
   remove the hand-rolled BigInt implementation from the pilot path
   (it may remain in-tree as a reference/test oracle, clearly marked
   non-production, per `docs/PILOT_SURFACE.md`'s scoping).
7. Re-run the full on-chain demo suite (`CLAIMS_MATRIX.md`'s
   NETWORK_VERIFIED rows) against the migrated signer to reconfirm every
   claim still holds with the new signing backend.

## Non-goals of this plan

- This plan does not change the BitVM circuit/dispute-game soundness gaps
  (encumbrance, watchtower, trace availability, bond economics) —
  those are tracked separately in `SECURITY_BLOCKERS.md` #3–#10 and
  `docs/ADVERSARIAL_SIGNET_PLAN.md`. A perfect signer does not make the
  dispute game safe by itself.
- This plan does not pick a final library today — it names concrete
  candidates and the evaluation criteria (constant-time, review history,
  adaptor/MuSig2 support) so that choice can be made deliberately, with
  the option to route standard-signature paths through Bitcoin Core RPC
  entirely where the protocol allows it.
