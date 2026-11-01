# KeyAgentNet engineering handoff: 2026-11-01

Branch: research/keyagentnet-regtest-v0
Base: UTXO-Ref main 5883e03e2dd4ddc09c67f2efda8fc760b1878b42

Scope: isolated research folder, plus a dedicated offline CI workflow.
The current V2 runtime, Groth16 settlement statements, and separate
Cashu work remain unchanged.

## Verified during preparation
- Independent 2-of-3 with p=0.01 gives 0.000298 compromise probability.
- One shared 2% compromise domain over all three gives
  0.02 + 0.98 * 0.000298.
- Partner 2-of-3 has an external-only spend quorum.
- The Pareto selector returns ten three-signer candidates from five agents
  and a nonempty non-dominated frontier.
- These invariants were executed as standalone JS checks in preparation.
  GitHub CI is the next independently executed Node test.
- Bitcoin Core binaries were absent, so the live regtest remains unexecuted.

## Operator commands

    node --test key-agent-net/model.test.cjs key-agent-net/regtest.cli.test.cjs
    node key-agent-net/simulate.cjs --json
    node key-agent-net/regtest.cjs --run-isolated

Run against Bitcoin Core 31+, capture version and TXIDs, and repair
descriptor import / PSBT problems in the isolated module if they arise.
All signer wallets in this experiment share one process. Real custody
agents need separate administrators and an audited signing protocol.

## Next research gate

Represent UTXORef V2's operator-plus-guardian rule as explicit authorized
hyperedges, then measure how network-domain compromise changes that rule.
Audit whether a client-mandatory signature can coexist with delayed
emergency recovery. Include timeout/reorg and conflicting sweep races.
Preserve existing BitVM V2 and Groth16 boundaries until reviewed.
