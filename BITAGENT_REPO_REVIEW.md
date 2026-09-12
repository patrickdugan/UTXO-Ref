# BitAgent repository review

Date: 2026-09-11

Reviewed checkout: `C:\projects\BitAgent\BitAgent`

Reviewed testnet corpus: `D:\bitagent-testnet4`

## Current state

The checkout is clean on `codex/bitagent-starter-order-mvp`, three commits ahead of the locally recorded `origin/main`. The active application is `apps/bitagent-launch-kernel`, a TypeScript launch kernel for a narrow Bitcoin deposit, TradeLayer starter strategy, approval, verification, and withdrawal workflow.

BitAgent has useful safety architecture:

- a deterministic host owns workflow state and tool validation;
- state-changing actions are simulation and approval bound;
- prepared PSBTs, fees, inputs, outputs, payloads, and approval hashes are revalidated before signing;
- capability leases are fingerprinted and one shot;
- the sovereign harness refuses candidates with unsafe authorizations;
- exact-height relay, tip-alignment, prune-lag, and reorg fixtures already exist for paired testnet4 nodes;
- `D:\bitagent-testnet4` contains replay snapshots, recovery checkpoints, paired nodes, candidate deployments, and reorg probes through candidate 12.

The deterministic sovereign and testnet-control suites passed locally: 5 sovereign tests, 1 wallet-snapshot test, and 31 exact-height, tip-alignment, and sync-throttle tests.

## Hard integration blocker

BitAgent currently imports APIs that do not exist in the checked-out UTXORef repository:

- `v2.settlement.buildFundingSetV2()` from `src/adapters/utxoRefAdapter.ts`, `src/launch/utxoTool.ts`, and `src/signals/utxoFunding.ts`;
- `ReceiptDepositIndexer` from `src/launch/utxoTool.ts`;
- `bitvm3/utxo_referee/taproot_reserve_vault.js` from `src/launch/reserveIntake.ts`.

`C:\projects\UTXORef\UTXO-Ref\bitvm3\utxo_referee\index.js` exports none of those APIs, and no local or remote branch recorded in this checkout contains `buildFundingSetV2`. Deposit observation, canonical UTXO mapping, committed-signal funding, and reserve-intake construction therefore cannot run against the current UTXORef source.

BitAgent's dependencies are also not installed in its working tree. The standalone wallet and sovereign tests can run through the D-drive `tsx` tool, but broader suites stop on missing `ethers` or the sibling `tradelayer.js` dependency `bignumber.js` before reaching protocol assertions.

## Testnet4 gaps relevant to the swarm

### Moving wallet snapshots

`testnet4WalletSnapshot.ts` launches chain, wallet, balance, address, lock, and UTXO RPC calls concurrently and never rechecks the tip or mempool sequence. A result can combine different chain states. It also trusts the deprecated `listunspent.spendable` field and rounds `Number(value) * 100_000_000`.

Use the stable snapshot contract from the UTXORef stress harness:

1. record block hash and mempool sequence;
2. read wallet state and `listunspent`;
3. verify each outpoint through `gettxout` at the recorded block;
4. re-read block hash, mempool sequence, and wallet processed block;
5. retry any drifted snapshot.

### RPC authority

`BitcoinCliBrokerRpc.call(method, ...)` accepts any RPC method, while `TestnetSignerBroker.signAndBroadcast()` invokes `walletprocesspsbt`, `finalizepsbt`, and `sendrawtransaction`. With the current D-drive cookie and unencrypted wallet, an arbitrary same-host agent can bypass BitAgent's policy classes and call Core directly.

The model/eval process should receive only a method-allowlisted read-only RPC proxy. The wallet-owned signing broker should run in a separate process and account, accept typed prepared candidates, and never expose its cookie or generic RPC method surface.

### Logical versus live execution

`runLiveTestnetAgent()` defaults to `ReceiptBackedChainSource`, which synthesizes transaction evidence. `demo-live-testnet-agent.ts` creates a real `BitcoinCliChainSource` only when an external broker receipt is supplied and simulation is disabled. The default path is therefore prepare-only or deterministic simulation, not an end-to-end live-chain run.

### Evaluation strength

The primary agent evaluation is 51 public deterministic intent-routing cases executed in the same process as the scorer. It measures intent, tool choice, argument shape, approval boundaries, wallet-state truth, and secret handling. It does not exercise hostile UTXO proofs, transaction/outpoint substitution, chain drift, Core policy disagreement, RPC isolation, resource exhaustion, or concurrent replay.

## Recommended integration

1. Restore or implement the missing UTXORef V2 funding and reserve APIs, then pin BitAgent to an exact UTXORef commit and assert the export surface in preflight.
2. Add a BitAgent `eval:utxoref-redteam` adapter that invokes the existing `btc_testnet4_stress.js` JSON mode from a separate process.
3. Feed BitAgent's D-drive paired-node snapshots and exact-height relay into deterministic reorg, stale-confirmation, same-height-fork, and prune-boundary lanes.
4. Keep local proof and serialization mutations in isolated workers. Route sampled transaction candidates through a four-call read-only Core policy limiter.
5. Add held-out cases for approval replay, candidate mutation after approval, RPC method escalation, duplicate outpoints, proof replay, malformed values, fee/dust mismatches, stale anchors, and worker crashes.
6. Make promotion require zero false accepts, crashes, timeouts, double winners, Core-policy disagreements, or unauthorized RPC attempts. Existing functional routing scores should remain a separate metric.

BitAgent is a good control plane for the swarm, especially its authority fingerprints and paired testnet4 replay infrastructure. It is not currently a working consumer of this UTXORef checkout, and its public deterministic evaluator is not yet a security arena.
