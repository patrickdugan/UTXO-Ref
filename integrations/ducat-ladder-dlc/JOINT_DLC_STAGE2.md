# Stage 2: jointly controlled DUCAT ladder → DLC CET

This folder is an isolated, test-only prototype. The implementation is
`joint_dlc.js`; tests are in `joint_dlc.test.js`. The Bitcoin transaction
primitives are imported from the existing UTXORef referee, with zero copies
of its signing or script-validation code.

## Spending paths

The funding output is built by
`bitvm3/utxo_referee/dlc_funding_output.js:buildDlcFundingOutput`.

```text
Internal key: deterministic NUMS point (no known key-path secret)
Taproot P2TR funding outpoint (one UTXO per contract)
  CET leaf:    <Alice x-only> CHECKSIGVERIFY <Bob x-only> CHECKSIG
  Refund leaf: <144> CSV DROP <Alice x-only> CHECKSIGVERIFY <Bob x-only> CHECKSIG
```

All scripts and Taproot Merkle/control data come from the production-tree
builder. Both signatures are over the Bitcoin BIP341 script-path
SIGHASH_DEFAULT for the *exact unsigned transaction*. The transaction-set
validator re-derives the funding script from the sorted party public keys,
pins the funding outpoint, checks the CET and refund locktimes and enforces
a single committed CPFP anchor output.

## Signing sequence

1. Independently pin the signed ladder, BIP340 point announcement, option
   manifest, funding outpoint, and chosen **one** barrier-triggered payout row.
2. The DUCAT oracle signs `(snapshot ID, barrier commitment, HASH160(t), tG)`.
   The hash preimage `t` remains private until a threshold breach.
3. A distinct, pinned BIP340 **co-approval oracle** signs a message binding the
   manifest hash, option row hash, funding outpoint, pair of public keys,
   threshold point binding, CET/refund locktimes, refund CSV delay, and anchor
   policy. This is pre-funding authorization, *not* a second adaptor scalar.
4. `buildJointTemplate` creates exactly one CET transaction and one refund.
   It calls `validateDlcTransactionSet`, producing canonical funding/CET/refund
   commitments. Both CET and refund spend the same funding outpoint.
5. Each party independently recomputes the **option economics** and all
   payout scripts from the complete pinned manifest before signing. The
   `researchSignJointOffer` helper is restricted to explicit
   `testOnly:true` fixtures and uses synthetic test scalars.
6. Each party creates an adaptor pre-signature under `T=tG` for the fixed CET,
   and a normal Schnorr signature for the refund. `verifyJointOffers`
   validates both parties' signatures using the existing DLC
   `validateCetAdaptorSignatures`, `validateRefundSignature`,
   `assembleSignedSettlement`, and `verifySettlementWitness` functions.
   Funding must not proceed before the **fully signed refund transaction** is
   durable and its exact funding output is verified externally.
7. Once an independently verified price breach publishes `t`,
   `completeJointBarrierCET` validates the signed breach and verifies
   `HASH160(t)` and `tG=T`. It completes each party's adaptor signature and
   assembles a valid two-signature Taproot script-path CET witness.
   One published preimage can complete CETs for distinct UTXOs that chose
   the same barrier, while each UTXO has **one** fixed payout.
8. If no CET settles, the pre-signed refund is available after its
   **relative CSV delay** and absolute height locktime. The
   `refundMaturity` helper computes conservative block-height eligibility
   from externally supplied trusted confirmation and candidate block heights.
   Refund assembly and signature validation work without contacting the
   oracle again.

## Satoshi conservation

For the tested 25,000,000-sat funding outpoint:

| Item | Amount (sats) |
| --- | ---: |
| Holder CET payout at $60,000 BTC | 12,500,000 |
| Writer CET payout at $60,000 BTC | 12,499,000 |
| Dedicated CPFP anchor | 330 |
| Bitcoin miner fee | 670 |
| **Total funded** | **25,000,000** |

The 1,000-sat fee budget is split between the 330-sat anchor and the
670-sat miner fee. The refund restores the original baseline split and uses
the same miner fee/anchor schedule. Outputs are derived from the manifest
and rechecked independently before signing. A forged transaction set with
internally consistent hashes and matching secondary-oracle approval still
fails if its refund or CET amounts differ from the agreed manifest.

## Limitations and next acceptance gates

- **No chain execution yet.** The tests validate serialized Bitcoin
  transactions and BIP341 Schnorr/script witness data using UTXORef's own
  validators. A real funded regtest UTXO, `testmempoolaccept`, mining through
  the CSV window, competing CET/refund broadcasts and reorg trials are pending.
- **No wallet or node broadcast capability** is present in this subfolder.
- The stage-0 price snapshots and breach records still use **simulation-only
  Ed25519 signatures**. The BIP340 adaptor-point announcement and independent
  co-approval signature are real crypto on **test keys**. The co-approver
  does not add an independent reveal gate.
- The metadata records two authorized oracle keys to meet the structural
  transaction-set schema. The existing native DLC signer requires a threshold
  set of signed **BIP340 nonce/outcome announcements**, which this custom
  HASH160 preimage bridge does not supply. Do not route this template to the
  native signer or describe it as a native two-oracle DLC policy.
- The co-approval signature certifies a pre-funding agreement, but the model
  needs independent observation and timestamping of publication to stop
  post-hoc commitment substitution.
- The single CET is bound to one barrier-triggered, fixed payout. The
  continuous-value put/call collar requires a separate expiry-price oracle,
  full outcome commitments, refunds, and real fee/price conversions.
- A NUMS internal key and script-path validation depend on the internal
  deterministic hash-to-curve construction having no known discrete log. The
  test suite does not replace independent audit of Bitcoin Script and the
  original UTXORef primitives.
- Height arithmetic comes from caller-supplied values. Live deployments
  require independently verified funding confirmations, chain-tip freshness,
  sequence locks, mempool acceptance, fee bump policy and reorg monitoring.
- No complete BitVM reserve commitment or permissionless fraud challenge is
  produced. A signed refund and CET for the same UTXO conflict on-chain, while
  global reserve conservation and double-claim exclusion remain UTXORef's
  broader challenge-system obligations.

## Commands

```bash
node --test integrations/ducat-ladder-dlc/*.test.js
node --test integrations/ducat-ladder-dlc/joint_dlc.test.js
node integrations/ducat-ladder-dlc/demo.js
```

Any proposal to fund a real output must first graduate to a separate security
review with the existing native signer, peer transcript, chain observer, and
independently administered watchtower.
