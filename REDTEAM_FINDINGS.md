# Red-team baseline

Date: 2026-09-11

The live Bitcoin Core testnet4 scale result is recorded in `BTC_TESTNET4_REDTEAM_REPORT.md`.

Three independent review agents attacked the sweep verifier, milestone-1 state/circuit layer, and Hive packaging. Existing repository tests remained green, while the new public verifier eval scored `0.53` on lite, full, and scale profiles.

## Reproduced sweep-verifier failures

- One committed Merkle position can be repeated many times in one sweep up to the cap.
- Proof indices are coerced through JavaScript bitwise operations. Strings, fractions, `NaN`, `null`, booleans, and indices with ignored high bits can alias a valid position.
- Malformed sibling containers, `BigInt` indices, negative payouts, and malformed buffer fields can throw across the untrusted verification boundary.
- The off-chain verifier accepts more than the circuit's configured maximum of eight payout outputs.
- Values above `u64` can be accepted in memory and fail only when serialized.
- Empty-tree root helpers disagree.
- Deserialization does not require exact input consumption and can accept truncated declared script lengths.

## Reproduced state and circuit failures

- Honest off-chain SHA-256 balance claims do not satisfy the circuit's custom placeholder hash.
- `Circuit.constantBits` uses 32-bit JavaScript shifts for wider constants, so 64-bit constants repeat high bits and alter arithmetic constraints.
- `verifyBalanceClaim` trusts the supplied leaf hash instead of recomputing it from account, epoch, and balance. Account and amount fields can be changed while the claim still verifies.
- Claim balance bits are unused by the transition circuit, and there is no account identifier input.
- Route bits are one-hot but are not bound to a selected transaction payout, output, or timeout event.
- The circuit lacks the off-chain `pnlPayoutBps <= 10000` rule.
- Deposit replay protection keys on caller-provided `depositId`, not the chain outpoint; one outpoint can mint twice under different IDs.
- Balance addition can exceed `u64`, after which witness conversion truncates high bits.
- Committed-blob loading does not validate the supplied snapshot hash, balance root, total supply, or kind.
- Epoch finalization permits same/backward epochs; transitions permit wraparound/negative domains and inconsistent challenge windows.
- `localeCompare` can treat distinct Unicode account IDs as equal, making insertion order affect roots.

## Required next eval stages

1. Execute circuit gates for honest witnesses, then mutate every public semantic field and require rejection.
2. Differential-test off-chain transitions against the circuit at `0`, `1`, `9999`, `10000`, `10001`, and `u64::MAX` across every route and timeout state.
3. Add raw structural fuzzing for null/missing fields, wrong scalar/container types, sibling sizes/depths, index domains, and serialization boundaries.
4. Model unique chain outpoints, global event replay, supply conservation, atomic failure, state-envelope integrity, monotonic epochs, and exact challenge-window boundaries.
5. Add large multi-output sweeps and state sequences, then concurrency, reorg, UTXO-race, latency, and resource measurements on regtest.
6. Run a small end-to-end Bitcoin testnet4 smoke matrix only after deterministic and regtest gates pass.

## Hive hardening before public scoring

The repository evaluator is a visible development loop. Mutable JavaScript modules currently execute in the same process that prints the score, so hostile candidates could print a fake score, exit early, patch globals, or special-case public fixtures. A production leaderboard needs a server-only held-out evaluator, isolated candidate subprocess/container, captured and discarded candidate output, rotating undisclosed seeds, multiple trials, and resource quotas. The Hive server's verified score should be the only ranking metric.

No public specification or repository for a product named BitVMArena was found during this pass. The JSON result mode is an adapter surface, not a claim of BitVMArena compatibility.
