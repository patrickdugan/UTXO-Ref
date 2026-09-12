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

`dlc-regtest-recovery.ps1` runs two isolated Bitcoin Core peers with valueless regtest coins. It proves that the committed 330-sat anchor is wallet-spendable, rejects the 1 sat/vB parent alone under a 2 sat/vB relay floor, admits and relays it with the child by package feerate, reproduces a full-RBF fee pin, verifies the Core RPC replacement-policy and mempool-entry fields used by the watchtower observer, relays the higher-fee rescue, disconnects the six-block branch containing the package, verifies both transactions return to the primary mempool, and restores the branch. Every run uses fresh D-drive datadirs and stops both daemons in `finally`.

`dlc-truc-p2a-regtest.ps1` exercises the anti-pinning settlement format against Bitcoin Core 31.1. It builds a signed zero-fee version-3 parent with a final zero-sat P2A `51024e73` output, proves the parent fails the relay floor alone, admits it with a version-3 recovery child, requires `testmempoolaccept` to authorize the exact replacement, then demonstrates higher-fee sibling eviction. It records the two-transaction cluster before and after replacement, the full mempool entries and feerate diagram, and Core's `TRUC-violation` rejection of a third unconfirmed transaction. The run uses a fresh D-drive datadir and stops its hidden daemon in `finally`.

`dlc_security_eval.js` is a separate locked benchmark for the experimental DLC adaptor-signature boundary. It checks nonce separation, canonical parsing, validated extraction, authenticated and one-shot oracle behavior, signed anchor-recovery budgets, direct multi-node Core observations, exact `testmempoolaccept` proposal evidence, relay quorum, version-3 TRUC/P2A commitments, and the funding-broadcast guard. Run it with `eval/dlc-security.ps1` on Windows or `eval/dlc-security.sh` on POSIX. Its Hive prompt and config are `program-dlc-security.md` and `hive-task-config.dlc-security.example.json`. Keep its score separate from the sweep score because the mutable implementation and security contract differ.

`dlc-dedicated-account-testnet4.ps1` is the elevated Windows isolation lane. It creates a randomly named ephemeral non-administrator account, generates and DPAPI-protects the signer keys inside that account, gives the signer read-only access to its pinned runtime closure, and sends one signed public request from the distinct client SID through the protected named pipe. It verifies the runtime-signed pre-signature, removes the account and ephemeral key workspace in `finally`, and writes only public evidence to `D:\bitagent-testnet4\btc-test-snapshots`. The random account password is built as a `SecureString` and passed to native `NetUserAdd` through a zeroed unmanaged buffer; it is never materialized as a managed plaintext string or written to a file, process argument, or output. Run this lane from an elevated 64-bit Windows PowerShell session.

There is no public specification for a tool named BitVMArena that could be verified while this harness was written. Arena integrations should invoke the JSON command above and ingest `score`, `cases`, `seed`, and `profile`; this keeps results reproducible without claiming compatibility with an undocumented schema.
