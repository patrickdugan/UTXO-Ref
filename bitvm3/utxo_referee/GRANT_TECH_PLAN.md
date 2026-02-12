# BitVM3 UTXO Referee: Technical Plan

## Goal

Deliver a Bitcoin-native referee that verifies sweep transactions against committed settlement rules.

## Current Implemented Scope

1. Deterministic data formats
- `CommitmentPackage`, `PayoutLeaf`, and `SweepObject` use deterministic serialization and `BigInt` satoshi accounting.

2. Membership verification
- Payout inclusion is proven with Merkle proofs against a committed withdrawal root.

3. Settlement safety checks
- Enforce epoch binding.
- Enforce payout cap.
- Enforce residual amount and destination.

4. Validation harness
- `node bitvm3/utxo_referee/test.js` (rule-level tests).
- `node bitvm3/utxo_referee/demo.js` (end-to-end flow and failure examples).

5. Circuit scaffolding
- Boolean constraint builder exists for referee rule structure.
- Current hash path is placeholder logic and not production cryptographic hashing.

## Out of Scope (Current)

- PnL computation.
- Oracle truth evaluation.
- Full L2 state transition verification.
- Tokenomics or collateral mechanics.

## Milestones

1. M1: Referee correctness hardening
- Expand adversarial tests (proof tampering, malformed serialization, edge cap values).
- Keep verifier error reasons deterministic for challenge/debug workflows.

2. M2: Witness completeness
- Complete witness generation for all payout/proof fields in circuit path.
- Add deterministic fixtures for witness regression checks.

3. M3: Production hash integration
- Replace placeholder hash circuit with production-appropriate cryptographic constraints.
- Re-benchmark gate counts and prover/verifier cost envelope.

4. M4: Challenge protocol integration
- Connect circuit evidence path into BitVM challenge flow.
- Define dispute lifecycle interfaces and evidence format.

## Evidence to Include in Reports

1. Test output from `bitvm3/utxo_referee/test.js`.
2. Demo output from `bitvm3/utxo_referee/demo.js`.
3. Circuit stats for tracked parameter sets (for example, max payouts and Merkle depth).

