# BitVM3 Referee Architecture

## Scope

The referee verifies one claim:

`This sweep transaction follows the committed settlement rules.`

The referee does not compute PnL, does not evaluate oracle truth, and does not model token economics.

## Files

1. `bitvm3/utxo_referee/types.js`
- Define deterministic serialization for commitments and payout leaves.
- Enforce `BigInt` for u64-like values.
- Apply domain separation with `LEAF_TAG` for leaf hashing.

2. `bitvm3/utxo_referee/merkle.js`
- Build payout Merkle tree and inclusion proofs.
- Verify proofs against the committed withdrawal root.
- Pad to power-of-two leaf count with zero hashes.

3. `bitvm3/utxo_referee/verify.js`
- Implement off-chain verifier entrypoint: `verifySweep(commitment, sweep)`.
- Return `{ ok: false, reason }` on first failing rule for deterministic debugging.

4. `bitvm3/utxo_referee/circuit.js`
- Encode the same rule set as boolean constraints.
- Keep current hash path as placeholder only; production requires real cryptographic hashing.

5. `bitvm3/utxo_referee/test.js`
- Exercise valid and invalid cases for all four core rules.

## Core Rules

1. Epoch binding:
- `sweep.epochIdCommitted == commitment.epochId`

2. Membership:
- Every payout output must prove inclusion in `withdrawalRoot`.

3. Cap check:
- `sum(payoutOutputs.amountSats) <= commitment.capSats`

4. Residual handling:
- `residual.amountSats == capSats - payoutSum`
- `residual.recipientScriptPubKey == residualDest`

## Invariants

- Keep satoshi amounts as integers, never floating-point.
- Keep serialization deterministic for all commitment-critical objects.
- Keep error messages specific enough to diagnose rule failures quickly.
- Keep off-chain rule semantics aligned with circuit semantics.

