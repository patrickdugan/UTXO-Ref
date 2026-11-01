# Stage 1: V2 single-assertion settlement gate

## Inspected reference and implementation

The existing UTXO-Ref V2 verifier authenticates an Ed25519 state checkpoint
under an externally supplied signer allowlist, re-derives payout rows and
output order, checks value conservation, and validates a canonical unsigned
Bitcoin transaction against the committed funding inputs.

In V2, fundingOutpoints are **the inputs of the settlement transaction**.
For the Groth16/BitVM Stage 1 profile, the sole funding outpoint is the
funded BitVM assertion output. The earlier deposits that fund that assertion
are upstream and require a separate, independently authenticated graph.

The adapter is an off-chain inspector: it calls V2, enforces a single
assertion input, binds its txid/vout/amount/P2TR script to the pinned policy
and computes the V0 Groth16 statement and SHA-256 public-input limbs. It
cannot authorize a spend, validate Bitcoin inclusion, or verify a ZK proof.

## Security requirements for caller-supplied policy

The caller MUST load these values from an independently pinned source:

- programHash, verifyingKeyHash, policyHash
- assertionTxid, assertionVout, assertionAmountSats,
  assertionScriptPubKeyHex (a P2TR script)
- stateVerification.trustedSigners, expectedGenesisHash,
  expectedNetwork, currentHeight

The policyHash is a **supplied identifier** at this stage. A later
implementation must derive and check it against canonical signed policy
artifact bytes. A claimant choosing this object is outside the trust
model. The current fixture uses invented network/genesis/transaction hashes
and a fixed test signing key.

## Test evidence / command

Run:

    node --test zk-groth16-bitvm/statement.test.cjs \
      zk-groth16-bitvm/v2_adapter.test.cjs \
      zk-groth16-bitvm/v2_adapter.integration.test.js
    node bitvm3/utxo_referee/utxoref_v2.test.js

The integration suite constructs a deterministic Ed25519 checkpoint,
a V2 payout batch, and an unsigned transaction. It compares the adapter
against the actual V2 referee for valid/invalid cases, including a valid V2
multi-input transaction that this narrower profile must reject.

## Remaining gaps before circuit work

1. Authenticate the funded assertion output with Bitcoin Core or a
   reviewed SPV chain/inclusion proof, including amount and script.
2. Define the upstream deposits -> assertion transaction graph without
   treating earlier deposits as direct settlement inputs.
3. Fix exact funding-time commitment ordering to avoid a circular
   dependency between script construction and assertion TXID.
4. Specify the complete circuit witness, canonical transaction encoding,
   V2 state/PNL relation and a reproducible independent test oracle.
5. Constrain all relevant conditions in a real Groth16 circuit, verify
   the proof with an independently pinned key, then bind the same
   statement to an executable BitVM dispute graph.

The host V2 verifier is currently the sole executable relation. This
work does not assert equivalence to a ZK circuit, chain consensus,
unspentness, or final settlement authority.
