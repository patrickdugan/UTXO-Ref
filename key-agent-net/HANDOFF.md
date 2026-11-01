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
- Bitcoin Core 31.0 was downloaded and verified by two signer-agreed
  SHA256SUMS in a GitHub Actions job; the actual regtest exercise passed.
  [Verified run 41281816903](https://github.com/patrickdugan/UTXO-Ref/actions/runs/41281816903),
  core-regtest job. Bitcoin Core reported version 310000.
- Confirmed spending TXIDs in the isolated, ephemeral regtest datadir:
  - client + agent A: `c47b113939c4587081697bd86cf833e42a001b61ad4c91f58fff8d7a4190bab4`
  - external A + B without client: `eaf8066aa63737c2faa28be3089c72e8906892c9a7b7bf9ac1a07a2a81fdb482`
  - rekey sweep client + B: `0bc4b8bca3afbb378afefbabd8616dcc96fcc2b98b68f0aa1dec26d153ed8b8c`
  - confirmed successor vault balance: 0.75 regtest BTC.
- All 14 offline Node tests and four Core regtest checks passed in CI.

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
