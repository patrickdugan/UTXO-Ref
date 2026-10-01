# CivKit Arbitration Agent

This module puts a hard boundary around "AI arbitrator" behavior.

The trust model is not "the model is right." It is:
- evidence is hashed and fixed before judgment
- two bounded sub-agents review the same evidence independently
- the arbitrator can only choose `release`, `refund`, or `split`
- the final decision is bound to the escrow spend package and BitVM transition commitment

## Scope

- deterministic evidence normalization
- two-sub-agent review with explicit route/confidence outputs
- bounded arbitration policy with autonomous-signing threshold
- final settlement package generation through `civkit/p2p_platform`
- receipt/trust envelope hashing for auditability
- governance checks for whether an arbitrator model/key is allowed to act

## Trust Boundary

An autonomous arbitration result is only considered trusted when:
- the arbitration policy threshold is met
- the final route is allowed by policy
- the spend package and BitVM transition bundle are both generated successfully

If those checks fail, the module should be treated as a recommendation engine and escalated to human review.

## Files

- `types.js`: policy, evidence, review, and receipt records
- `workflow.js`: review scoring, decision derivation, and spend package binding
- `governance.js`: arbitrator profile records and governance authorization checks
- `test.js`: focused arbitration tests
- `smoke_ltc_testnet.js`: LTC testnet-compatible smoke harness
- `live_ltc_testnet_settlement.js`: live LTC testnet funding + signed settlement broadcast against a local wallet/node

## Governance Layer

The new governance layer is intentionally simple but operationally useful:
- an arbitrator profile can be approved or revoked
- governance can require specific model versions and capabilities
- governance can require a minimum service bond before autonomous signing is allowed

## Run

```powershell
node civkit/arbitration_agent/test.js
node civkit/arbitration_agent/smoke_ltc_testnet.js
node civkit/arbitration_agent/live_ltc_testnet_settlement.js
```
