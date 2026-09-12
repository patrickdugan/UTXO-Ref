# Adversarial evaluation

`utxo_referee_eval.js` is a deterministic, dependency-free development benchmark for agent swarms and arena runners. It prints a Hive-compatible `score: <0..1>` metric and can emit one-line JSON with `--json` for other orchestrators.

Profiles:

- `lite`: fast agent iteration.
- `full`: submission and CI verification.
- `scale`: a verifier microbenchmark with 10,000 seeded membership mutations and 2,048 one-output sweeps proven against a 32,768-leaf tree.

Example commands:

```bash
EVAL_PROFILE=full bash eval/eval.sh
node eval/utxo_referee_eval.js --profile=scale --seed=123 --json
node eval/utxo_referee_eval.js --profile=full --require-perfect
```

The eval is deliberately off-chain. Agent-generated attacks must first reproduce here or on regtest. Testnet is reserved for a small end-to-end smoke matrix because public-chain broadcast is slow, stateful, and unsuitable for high-volume fuzzing.

For rLLM Hive, use `program.md` as the task prompt, `prepare.sh` as preparation, `eval/eval.sh` as the evaluation command, and restrict mutable paths to the four implementation files listed in `program.md`. A server verification config template is in `hive-task-config.example.json`; its snapshot placeholder must be replaced with a real Node 18+ Daytona snapshot.

The public evaluator is suitable for development, not a hostile leaderboard boundary. Candidate modules execute in the evaluator process and the cases and default seed are visible. A production Hive run must compute the verified score in a server-only evaluator, isolate candidate execution, discard candidate stdout, use undisclosed rotating seeds and holdouts, and apply process/memory/output quotas. Only that verified score should count for ranking.

The `scale` profile does not simulate concurrent agents, chain reorgs, UTXO races, network faults, Bitcoin transaction parsing, or broadcasts. Those require a separate regtest fault harness and the read-only Bitcoin testnet4 smoke lane in `bitvm3/utxo_referee/btc_testnet4_smoke.js`. See `REDTEAM_FINDINGS.md` for the first swarm's attack backlog.

There is no public specification for a tool named BitVMArena that could be verified while this harness was written. Arena integrations should invoke the JSON command above and ingest `score`, `cases`, `seed`, and `profile`; this keeps results reproducible without claiming compatibility with an undocumented schema.
