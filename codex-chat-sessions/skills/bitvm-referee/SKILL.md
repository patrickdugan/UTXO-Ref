---
name: bitvm-referee
description: Implement, validate, and document BitVM3 UTXO-referee settlement verification for Bitcoin sweep transactions. Use when working on `bitvm3/utxo_referee` data structures, Merkle proofs, `verifySweep` rule logic, referee circuit scaffolding, witness formatting, or grant-ready technical narratives that emphasize Bitcoin-native settlement integrity over token economics.
---

# Bitvm Referee

Execute focused BitVM3 referee work that is easy to validate, easy to explain, and easy to position for Bitcoin-native grant review.

## Workflow

1. Confirm scope and boundaries.
- Keep changes under `bitvm3/utxo_referee` for settlement logic.
- Keep generic VM/circuit work under `bitvm3/` when it is reusable beyond referee flows.
- Preserve the core statement: verify sweep correctness against a committed payout set and cap.

2. Load the right references before editing.
- Read `references/architecture.md` for module responsibilities and invariants.
- Read `references/grant-positioning.md` when preparing external summaries, milestones, or grant text.

3. Apply changes in the correct layer.
- Edit `types.js` for deterministic serialization, domain separation, and amount/epoch semantics.
- Edit `merkle.js` for tree construction or proof behavior.
- Edit `verify.js` for off-chain acceptance rules and error reasons.
- Edit `circuit.js` for boolean-constraint scaffolding and witness shape.

4. Validate every change.
- Run `node bitvm3/utxo_referee/test.js`.
- Run `node bitvm3/utxo_referee/demo.js`.
- Or run `pwsh codex-chat-sessions/skills/bitvm-referee/scripts/run_referee_checks.ps1`.

5. Report status in referee terms.
- State which rule changed: epoch binding, membership, cap, or residual.
- State whether behavior changed off-chain verifier logic, circuit scaffolding, or both.
- Explicitly call out remaining production gaps when relevant (for example, placeholder hash in circuit path).

## Guardrails

- Keep amounts in satoshis and use `BigInt` for u64 paths.
- Keep hashing deterministic and domain separated for leaves.
- Avoid introducing token-pricing, collateral, or oracle logic into referee verification paths.
- Keep claims grounded: current circuit path is scaffolding until real SHA256 or another production hash is wired in.

## Commands

```powershell
node bitvm3/utxo_referee/test.js
node bitvm3/utxo_referee/demo.js
powershell -File codex-chat-sessions/skills/bitvm-referee/scripts/run_referee_checks.ps1
```
