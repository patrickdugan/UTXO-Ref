# UTXORef V2 Reserve-Backed CPFP

## Transaction

The reserve rescue is an exact Bitcoin transaction, not an off-chain fee
claim:

```text
input 0: unconfirmed wallet-owned challenge output   [wallet witness]
input 1: confirmed graph-bound P2TR fee reserve      [guardian threshold + challenger]

output 0: challenge value + reserve value - fee
          paid to the unchanged challenge script
```

Both inputs use sequence `0xfffffffd`. The transaction has no change output,
cannot select another wallet input, and cannot redirect unused reserve value.
The fee must be positive, no greater than the reserve's `maxFeeSats`, and fully
covered by the reserve so the original challenge principal is preserved.

The legacy immediate reserve leaf remains valid and byte-compatible:

```text
<graph-hash> OP_DROP
<challenger-xonly> OP_CHECKSIGVERIFY
<guardian-xonly> OP_CHECKSIG
```

The quorum reserve uses a distinct core and manifest kind. Its immediate leaf
is:

```text
<graph-hash> OP_DROP
<challenger-xonly> OP_CHECKSIGVERIFY
<guardian-1-xonly> OP_CHECKSIG
<guardian-2-xonly> OP_CHECKSIGADD
...
<guardian-n-xonly> OP_CHECKSIGADD
<threshold> OP_NUMEQUAL
```

Guardian keys must be unique and disjoint from challenger and refund keys. The
ordered set and threshold determine the leaf, P2TR output, reserve hash, plan,
and every approval. The implementation supports 2..15 guardians and requires a
threshold of at least two.

Its witness stack is:

```text
<guardian-transaction-signature>
<challenger-transaction-signature>
<immediate-leaf-script>
<control-block>
```

For a quorum leaf, the witness contains one fixed slot per guardian in reverse
script order. A guardian that did not sign contributes an empty item. This is
followed by the challenger signature, leaf, and control block. The finalizer
rejects duplicate approvals and refuses to assemble a witness below threshold.

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

Each guardian emits one transaction signature plus a second Schnorr signature
over the approval metadata. In quorum mode, guardians run independently and
the finalizer verifies every signature, signer identity, set hash, and
threshold. It requires every approval block to remain active and no more than
six blocks old, and asks Core's wallet to sign only input 0. A wallet-provided
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
node bitvm3\utxo_referee\utxoref_v2_reserve_cpfp_drill.js --guardian-quorum
```

The 2026-07-13 quorum run funded a 30,000-sat 2-of-3 graph-bound reserve and a
100,000-sat assertion. It then:

1. broadcast challenge
   `4862b767b580b89f3d306e2490d162965cb2dd0f1f83cfe7043d3069be49d306`;
2. broadcast a 4,000-sat reserve child
   `861d9dede23579632400fbe1163a0671b3627d383fcd0a1ef21df38190874162`;
3. replaced it at 8,000 sats with
   `928cd80d333ba51a37c1823a4da56d7b38cbcd77162521a523c7f7bc209a3703`;
4. observed the original child leave the mempool; and
5. mined the replacement at height 104 and marked the reserve consumed.

Bitcoin Core accepted the actual `OP_CHECKSIGADD` witness with two guardian
signatures, one empty guardian slot, and the challenger signature. The legacy
single-guardian mode was rerun separately and completed the same replacement
and confirmation lifecycle.

These are ephemeral regtest identifiers, not public explorer evidence. The
machine-readable receipt is written under ignored `artifacts/tmp/`.

## Remaining Boundary

The on-chain script is a threshold policy, not a destination covenant. A
malicious or compromised challenger plus the guardian threshold can still sign
another transaction. Quorum removes the single-guardian compromise and outage
boundary; it does not remove signer collusion. Production use therefore still
needs independent guardian administration, auditable approval receipts, key
rotation, and tested threshold-minus-one outage and threshold-compromise
responses. The drill proves exact construction and Bitcoin consensus behavior;
it does not prove organizational independence.
