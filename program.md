# UTXO Referee Adversarial Benchmark

Harden the BitVM3 UTXO Referee against adversarial settlement sweeps while preserving valid behavior.

## Objective

Maximize the `score` emitted by `bash eval/eval.sh`. A score of `1.0` means every correctness, replay, proof-shape, robustness, fuzz, and scale check passed.

## Mutable implementation

- `bitvm3/utxo_referee/verify.js`
- `bitvm3/utxo_referee/merkle.js`
- `bitvm3/utxo_referee/types.js`
- `bitvm3/utxo_referee/index.js`

Treat `eval/`, `program.md`, and `prepare.sh` as locked benchmark infrastructure.

## Security contract

- Valid complete and partial sweeps must verify.
- Identical payout leaves may exist at different Merkle positions.
- A Merkle position may be consumed at most once in one sweep.
- Proof indices and sibling nodes must have canonical types and ranges.
- Untrusted malformed sweep data must return `{ ok: false, reason }`; it must not crash the verifier.
- Payouts must remain bounded by the committed cap and residual rules.
- Behavior must remain deterministic at scale.

Do not special-case the visible scenarios. Generalize validation at the trust boundary.

## Run

```bash
bash prepare.sh
EVAL_PROFILE=lite bash eval/eval.sh
EVAL_PROFILE=full bash eval/eval.sh
EVAL_PROFILE=scale bash eval/eval.sh
```

Use `lite` during iteration, `full` before submitting, and `scale` for verifier soak runs. The seed can be changed with `EVAL_SEED`. CI can append `--require-perfect` to make any failed case return a nonzero status; Hive intentionally receives a partial score with a successful evaluator exit.

The benchmark has no network dependency and never broadcasts a transaction. Run the read-only Bitcoin testnet4 smoke test only after the deterministic eval reaches `1.0`; signing and broadcast remain a later, explicit stage.

This task covers the off-chain sweep verifier boundary. Circuit, ledger, state-envelope, concurrency, and chain-fault findings are tracked in `REDTEAM_FINDINGS.md` and should become separate locked eval stages rather than being inferred from this score.
