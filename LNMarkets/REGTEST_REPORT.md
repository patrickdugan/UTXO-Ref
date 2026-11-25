# Bitcoin Core regtest settlement rehearsal

## Ceremony

1. Start a fresh Bitcoin Core 31.1 instance with loopback RPC and no peer
   connections. Create three descriptor wallets. The miner wallet supplies a
   confirmed native P2WPKH input to each of the independently keyed trader
   and maker wallets.
2. Both roles check the proposed PSBT against the agreed plan and Core's
   UTXO view. Each role verifies its own funding input, payout address and
   change address with its wallet. The PSBT produces the exact NUMS-keyed
   two-party Taproot script at output zero. Native SegWit inputs with empty
   scriptSigs keep the unsigned transaction's txid stable when witnesses
   are added. The finalization check enforces that equality.
3. Bind all nine CETs and the refund to that outpoint. Two one-shot research
   subprocesses generate and use their own disposable DLC keys. Each exits
   after returning its share. The coordinator validates all shares and
   assembles the fully signed refund. Each wallet role durably saves its
   public recovery package and pins and restores the refund in a separate
   process before either Core wallet signs the funding PSBT.
4. Each wallet signs only its own PSBT input. Combine the partial PSBTs,
   verify the complete proposal again, and ask Core about the finalized
   transaction. The signed state records the PSBT validation, and the
   prebroadcast guard binds policy acceptance to its exact bytes and to
   the current state. Consume that authorization on disk before broadcast.
5. Confirm funding and verify the live UTXO. Repeat public-only recovery
   with the maker wallet unloaded and both DLC signer processes gone.
   The coordinator hands the verified candidate to the existing Core
   execution guard and consumes its authorization before broadcast.
   Mine the candidate and check its output scripts and values independently
   in the decoded block and in each wallet's spendable UTXO inventory.

The script uses UTXORef's existing signed, append-only `DlcStateStore`
revisions, funding/execution prebroadcast guards, broadcast authorization
store, Bitcoin Core observer and signed watchtower journal. A local ephemeral
validator signs the state receipts for this rehearsal. Each role's public
files live in separate directories under the same operator. The root
summary includes state and watchtower checkpoints, funding and exit input
details, and the Core rejections. The workflow uploads the public JSON
files and leaves out the Core wallet directory.

## Recorded Bitcoin Core run

Recorded on 2026-11-20 with Bitcoin Core 31.1 and Node.js 24.22.1 on
Windows. The machine-readable result includes wtxids, active-chain block
hashes, prevouts and input values, output scripts, fees, recovery and
watchtower checkpoints, and the full Core rejections.
[Recorded result](evidence/core-regtest-31.1.json)

| Transaction | Height | Fee (sats) | Txid |
|---|---:|---:|---|
| Oracle funding | 103 | 1,500 | `2b267af922cf90823760a82e1f13e52557d39db4c3f79304e1c10eebf07902b9` |
| Oracle exit | 106 | 1,000 | `d53018066a864211c52ba9fe152e1f3e38d053509ad5105f7fbbbdc28f36ca84` |
| Refund funding | 108 | 1,500 | `1b90cc9c3d8e98da591fc93aa3f6029fe8b5949d344273577513663b712f037f` |
| Refund exit | 115 | 1,000 | `9a84118d4146f93ecfbf5d874a0e2bd67b8b484d8e5ded72da065d077f97b7f9` |
| CET fee child | 106 | 2,400 | `69a1bbfd24494f757dfc81df9cc53b57ffe8494dcd2f3d3ef1da590cf33bd2b9` |

Each funding transaction used two 1,000,000-sat inputs. The trader
contributed 201,330 sats and the maker 200,000 sats. Each paid 750 sats
toward funding fees. The corresponding change outputs were 797,920
and 799,250 sats. Each exit left the committed 1,000-sat miner fee.
The CET and child paid 3,400 sats combined.

| Contract and output | Sats | scriptPubKey |
|---|---:|---|
| Oracle funding #0, locked collateral and exit budget | 401,330 | `512082159fa5d2a7a1dcd388da4f4c3dd0d2868a5d2d6d8970fd1d875289deaeae5b` |
| Oracle funding #1, trader change | 797,920 | `00140dce9f3193da34d34420bbf5662817882a7241a1` |
| Oracle funding #2, maker change | 799,250 | `0014709e7fc38dd03776237b66806097ade22447854e` |
| Oracle exit #0, trader payout | 290,909 | `51205ebbb73489d07510d557846f7a7d46ecbc4ab9c0833a3e1a046b380254c890d2` |
| Oracle exit #1, maker payout | 109,091 | `51209f2fcbc91aaf6ddc22be79b47a2065323b356deafb47559f975382cb75d3717c` |
| Oracle exit #2, fee anchor | 330 | `5120b531a44b8178f6a74c606f9cff5a7a8ea25aa214b51a9dd2be0ab1b7e885f49b` |
| Refund funding #0, locked collateral and exit budget | 401,330 | `5120dc49e6a90b2ca05ce6b9e1b71b901c8f5c8a66efca371f760ab770e53333d8fa` |
| Refund funding #1, trader change | 797,920 | `0014074541ef895296d8a1cb673d94c3829303056dac` |
| Refund funding #2, maker change | 799,250 | `0014ff6d2d15ac2e7241df2a73add118f805633e0453` |
| Refund exit #0, trader payout | 200,000 | `5120afaec62505352678cdb09b21e4d73a7545807634ea10419d96ddf221d1d8bb3b` |
| Refund exit #1, maker payout | 200,000 | `51200503d76dd73c3316b69f5a429efaeb33bae87b8d5ee9e0c5616f7a9845e1e732` |
| Refund exit #2, fee anchor | 330 | `5120955933aaf11a00b1c30b7c180ca983a93be6e1c18df5be7dce2d25b5f735fea0` |

| Rejected candidate | Chain tip | Core reason |
|---|---:|---|
| CET absolute maturity | 104 | `non-final` |
| refund absolute lock with CSV satisfied | 104 | `non-final` |
| missing CET witness at maturity | 105 | `mempool-script-verify-flag-failed (Witness program was passed an empty witness)` |
| refund absolute lock | 111 | `non-final` |
| refund CSV with absolute lock satisfied | 112 | `non-BIP68-final` |
| refund one block before CSV eligibility | 113 | `non-BIP68-final` |

Both exit and payout assertions passed. The signed state journals verified
from draft through the applicable terminal stage. Each contract consumed
two single-use broadcast authorizations, one for funding and one for its
exit. The recorded watchtower journals include the reorg and relay-quorum
halts. See the [PR checks](https://github.com/patrickdugan/UTXO-Ref/pull/14/checks)
for the repository suites, locked evaluations and pinned Linux Core run.

## Adversarial cases

The integration requires rejection of a changed package outpoint, an omitted
CET signature, a valid package substituted from the other contract, two
oracles signing different outcomes, a duplicated attestation, and
cross-event attestation replay with the same oracle keys. The existing
offline suite also substitutes a valid package for another outpoint under
the same plan digest, which exercises the independent recovery-digest pin.

For the immature CET check, the harness deliberately publishes synthetic
attestations early and has Core evaluate the completed witness. After the
tip reaches the CET locktime, the authorized CET uses two matching
attestations and the third share is withheld from the restorer. For the
refund, the restorer receives the existing signed bytes and no oracle
attestations. The settlement contract's one-block CSV gives a separate
test of the absolute refund lock; the refund contract's seven-block CSV
gives a test of the relative lock after the absolute height passes.

The CET recovery child uses the committed 330-sat anchor and adds confirmed
trader wallet change. The signed watchtower observes Core acceptance and the
child's input-derived fee. A lone node triggers the signed two-node relay
quorum halt for an unconfirmed child. Mining confirms both transactions.
The harness disconnects their block, records the watchtower's reorg halt,
checks that both transactions returned to the mempool, then reconsiders the
block and verifies both leave the mempool again. This rehearsal uses the
default local fee floor. Existing UTXORef fee drills cover strict floors,
multi-peer propagation and pin replacement using their own fixture. See
[the UTXORef security review](../DLC_SECURITY_ARCHITECTURE_REVIEW.md).

## Evidence and open dependencies

- **Local cryptography.** The recovery CLI rebuilds the signed transaction
  set, checks the two retained pins and verifies every committed signature.
  The public CLI returns transaction bytes for Core to evaluate.
- **Bitcoin Core regtest.** Two distinct UTXOs were funded and spent under
  consensus on an isolated chain. Separate descriptor keys and separate
  signer/recovery processes exercised the role boundaries under one
  operator. The LN Markets adapter is unused throughout this rehearsal.
- **Independently operated recovery.** Repeating this ceremony requires
  distinct trader, maker, oracle and watchtower operators, authenticated
  communication, durable wallet-owned pins and recovery copies, and
  independently checked access to chain and oracle data. Before a funded
  pilot, rebuild and attest the native signer and use its pinned validator,
  one-shot authorization and signer process boundary. The rehearsal uses
  disposable JavaScript signer subprocesses. Production signing and mainnet
  broadcast remain disabled.
- **Recovery economics.** Independent relay observation, fee pressure and
  pinning tests using these exact DLC exits are still needed. Agree who can
  use the anchor and how the fee wallet stays available. Delay sizing,
  timeout operations, package retention and authenticated alert delivery
  remain pilot work.
- **Oracle policy.** Agree the public price source, observation window,
  bucket rounding, handling of missing data and disagreement, and responses
  to equivocation. The fixture operator controls all three oracle keys and
  uses synthetic prices. The Bitcoin payout remains bound to the accepted
  2-of-3 event and chosen oracle subset.

## Future Lightning funding

`utxoref_dlc_subswap_funding.js` already models a request ID, invoice/payment
hash, swap timeout, target commitment and execution proof for an older
Lightning/BitVM bundle. Reuse its request and wallet-view pattern when a
swap provider can supply an appropriate input. Its current request accepts
an older bundle and fixture-oriented proof flags, so this ceremony uses
Core's confirmed native SegWit prevout observations instead.

The smallest future adapter treats a confirmed swap claim as a contribution
UTXO owned by the appropriate funding wallet. Verify the invoice amount,
payment-hash/preimage relation, swap claim and timeout branches, exact
claim output and live confirmation on the selected network. Pass that
validated UTXO to the same PSBT negotiation. A direct claim-to-DLC route
would also have to commit the final claim txid, exact output index, script
and amount, and require both verified recovery copies before an invoice
preimage or funding broadcast becomes irrevocable. Swaps and Lightning
hold invoices are outside this rehearsal.


## Minimum LN Markets interface

Use a versioned, authenticated position record with four messages. The
names describe the proposed contract between the venue and the wallet.

| Message | Minimum signed or verified fields |
|---|---|
| **Maker quote** | Unique `quoteId` and maker identity, expiry and funding deadline, market and side, notional and entry price, both collateral amounts, oracle event/policy, and `planDigest` covering the payout table, scripts, exit fee and timeouts, plus the agreed recovery fee policy. The maker signs the canonical quote with a pinned identity key. |
| **Quote acceptance** | The authenticated trader accepts the exact quote digest with an idempotency key. The venue verifies maker authorization and expiry, then assigns a stable `tradeId` and binds it to both identities and the accepted plan. |
| **Collateral confirmation** | Both wallets acknowledge the plan and recovery digests. The record pins the Bitcoin network, funding txid/vout, scriptPubKey, amount, per-party contributions and recovery digest. The venue verifies the output and the agreed confirmation depth against its own chain view before marking the trade active. |
| **Settlement receipt** | The receipt binds `tradeId`, plan digest and funding outpoint to the spending txid, block hash/height, current depth, exact trader/maker payouts and exit type. A CET includes the outcome and independently verifiable threshold-evidence reference. A refund includes its maturity evidence. The venue verifies the spend from its own chain view and updates the position on a reorg. |

An indicative public mark can seed a quote. Maker and trader identities
authorize execution, independent oracle keys attest settlement, and Bitcoin
enforces the spend paths. The venue can display pending, active, settled,
refunded or reorg-pending status from these records while the collateral
stays in the committed contract. Normal recovery uses wallet-held material,
public oracle evidence for a CET, and a Bitcoin node.
