# UTXORef V2 Reserve-Backed CPFP

## Transaction

The reserve rescue is an exact Bitcoin transaction, not an off-chain fee
claim:

```text
input 0: unconfirmed wallet-owned challenge output   [wallet witness]
input 1: confirmed graph-bound P2TR fee reserve      [guardian + challenger]

output 0: challenge value + reserve value - fee
          paid to the unchanged challenge script
```

Both inputs use sequence `0xfffffffd`. The transaction has no change output,
cannot select another wallet input, and cannot redirect unused reserve value.
The fee must be positive, no greater than the reserve's `maxFeeSats`, and fully
covered by the reserve so the original challenge principal is preserved.

The immediate reserve leaf is:

```text
<graph-hash> OP_DROP
<challenger-xonly> OP_CHECKSIGVERIFY
<guardian-xonly> OP_CHECKSIG
```

Its witness stack is:

```text
<guardian-transaction-signature>
<challenger-transaction-signature>
<immediate-leaf-script>
<control-block>
```

Both Schnorr transaction signatures bind all prevouts, amounts, scripts,
sequences, and the single output under BIP341 `SIGHASH_DEFAULT`.

## Separated Approval

The guardian command accepts the guardian secret but no challenger secret and
does not broadcast. It independently verifies:

- artifact, state, graph, trust-policy, reserve hash, and reserve outpoint
  agreement;
- the live unconfirmed challenge output;
- the live confirmed reserve amount, script, funding height, and recovery
  horizon;
- the exact two-input plan and fee cap; and
- the current chain height and block hash.

It emits one transaction signature plus a second Schnorr signature over the
approval metadata. The finalizer reconstructs the plan, verifies both
signatures, requires the approval block to remain active and no more than six
blocks old, and asks Core's wallet to sign only input 0. A wallet-provided
reserve witness is rejected.

## Replacement And Lifecycle

A replacement must spend the same challenge and reserve outpoints, return to
the same script, and pay a strictly higher fee. Because the reserve input is
already consumed by the unconfirmed child, replacement preflight verifies the
tracked child and the confirmed reserve funding transaction instead of
misreporting the reserve as independently available. A fresh guardian approval
and fresh challenger signature are required.

Watchtower state records `committed_to_cpfp`,
`committed_to_replacement`, `consumed_confirmed`, and unresolved reorg/spend
states. Superseded approvals and transaction ids remain in replacement history.

## Core Drill

Run:

```powershell
node bitvm3\utxo_referee\utxoref_v2_reserve_cpfp_drill.js
```

The 2026-07-13 Bitcoin Core regtest run funded a 30,000-sat graph-bound reserve
and a 100,000-sat assertion. It then:

1. broadcast challenge
   `fe22db2b35701e8e876cb934dc36911582546ee6e81f3b91c0486e3a2169cc13`;
2. broadcast a 4,000-sat reserve child
   `4b030b156c59e592161423d8a3d6b8ccfcb6ab96b226954743d26af2c6a1bfc7`;
3. replaced it at 8,000 sats with
   `543fc85f73fb718fe7cc9bc13d132168592ff081b33fcbfa6fbda76b158fd781`;
4. observed the original child leave the mempool; and
5. mined the replacement at height 104 and marked the reserve consumed.

These are ephemeral regtest identifiers, not public explorer evidence. The
machine-readable receipt is written under ignored `artifacts/tmp/`.

## Remaining Boundary

The on-chain script is a two-key policy, not a destination covenant. A malicious
or compromised guardian and challenger can still jointly sign another
transaction. Production use therefore still needs isolated guardian policy,
auditable approval receipts, threshold or independent guardian deployment, key
rotation, and a tested response when one signer is unavailable. The current
drill proves exact construction and Bitcoin consensus behavior; it does not
prove organizational independence.
