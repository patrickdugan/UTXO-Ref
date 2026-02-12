# Grant Positioning Notes

## Objective

Position BitVM3 referee work as Bitcoin settlement integrity infrastructure, not speculative token infrastructure.

## Safe Framing

Use these emphases:

1. Bitcoin-native settlement controls
- Membership proofs against committed payout roots
- Hard payout caps per settlement epoch
- Deterministic residual routing

2. Verifiable constraint path
- Off-chain verifier behavior mirrors circuit rule intent
- Circuit scaffolding defines an upgrade path to challenge verification

3. Risk containment
- Scope-limited statement with explicit non-goals
- Clear trust assumptions and known production gaps

## Avoid

- Pricing language, leverage language, or collateral marketing language in referee descriptions.
- Claims that circuit verification is production-complete until real cryptographic hash constraints are integrated.
- Broad claims about full L2 correctness when only settlement sweep correctness is in scope.

## Suggested Milestone Labels

1. Deterministic settlement commitment format
2. Withdrawal-root membership verifier
3. Cap and residual enforcement engine
4. Circuit parity for referee rule set
5. Production hash integration for circuit path

## Report Template

Use this concise status template:

1. What changed
- Rule(s) touched: epoch, membership, cap, residual.

2. Evidence
- `node bitvm3/utxo_referee/test.js` result.
- `node bitvm3/utxo_referee/demo.js` result.

3. Remaining gap
- State if hash circuit is still placeholder and what is needed next.

