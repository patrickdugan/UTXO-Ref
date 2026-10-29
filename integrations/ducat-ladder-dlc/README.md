# DUCAT-style threshold ladder / DLC / UTXORef V2 prototype

Research-only deterministic Node.js experiment. Separate from the existing DLC security, TradeLayer PnL, and UTXORef V2 code.

```sh
node --test integrations/ducat-ladder-dlc/*.test.js
node integrations/ducat-ladder-dlc/demo.js
node integrations/ducat-ladder-dlc/joint_dlc_demo.js
```

## Flow

1. Generate the DUCAT price ladder: 865 BIP340 tagged-hash commitments, from ratios 1.36 to 10.00 at 0.01 intervals. For each rate, the threshold is `ceil(basePriceUsd * 1.35 / rate)`. The commitment is SHA256(tag || tag || oracleXonly || network UTF8 || basePrice u32BE || baseStamp u32BE || thresholdPrice u32BE), with tag SHA256("ducat/price_contract_commit"). Test-only HMAC-derived secrets commit by HASH160. The signed snapshot covers every ladder entry.
2. Authenticate the reveal and its price observation against the committed barrier, network, oracle identity, secret hash, and freshness. One breach produces separate *risk receipts* for each precommitted contract bound to that barrier. A breach signal never unilaterally exercises a continuous financial option.
3. Select the DLC-style CET *template* using a separately signed expiry-price attestation. The full grid of possible payout rows is fixed and hashed before observation. Prices outside the outcome grid fail closed.
4. Calculate a collateralized put/call collar in integer sats, checking every future grid outcome for solvency and dust:

```
putSats  = floor(notionalSats * max(putStrikeUsd - priceUsd, 0) / putStrikeUsd)
callSats = floor(notionalSats * max(priceUsd - callStrikeUsd, 0) / callStrikeUsd)
holderSats = baseHolderSats + putSats - callSats
writerSats = fundingSats - feeSats - holderSats
```

This is a bounded, strike-converted satoshi quanto for prototype accounting. The BTC value of a precise USD-settled option requires a more complete payout conversion and collateral model.

5. Reserve reconciliation checks unique outpoints, exact match to funded collateral, previously consumed claims, distinct full-UTXO exits, and an independent challenge fee reserve. It produces an auditable epoch hash and an off-chain mismatch witness.
6. `buildV2Handoff` calls the existing `bitvm3/utxo_referee/utxoref_v2.js:buildUtxoRefCommitmentV2` using the *selected* CET payment vector and exact funding outpoint. A separately verified and externally pinned state checkpoint hash, genesis hash, and operator/challenger public keys are required.

## Security boundaries

- The original snapshot, breach, and expiry-price simulator uses test-only Ed25519 signatures. The separate `barrier_adaptor.js` slice uses actual secp256k1/BIP340 Schnorr point bindings, adaptor pre-signatures, and completed Bitcoin key-path CET signatures over real BIP341 sighashes. These prove a cryptographic mechanism in synthetic transactions, not a deployed authenticated oracle or bilateral DLC.
- The 32-byte oracle identity in the original fixture is a tagged-hash identifier. In the adaptor bridge, the x-only identity is an actual Schnorr oracle pubkey and its point-binding signature is checked. All private scalars and price data are test fixtures; no RPC connections, broadcast, or mainnet funds are used. The bridge rejects non-test networks.
- The expiry attestation is a separate oracle statement. A correct DUCAT threshold preimage establishes that the oracle revealed an agreed secret, while price-feed integrity depends on oracle trust.
- UTXORef remains responsible for the authenticated state checkpoint, complete reserve UTXO evidence, global double-spend history, script execution, and independently operated challengers.
- A candidate epoch can only be checked against an independently recomputed trusted epoch. The mismatch witness is a **description for an off-chain challenger**; it is not a Bitcoin-enforceable BitVM fraud proof.
- The expiry CET manifest and UTXORef handoff are payment templates. The new barrier bridge generates a real Schnorr signature and serialized SegWit transaction for a **single-signer P2TR keypath fixture**. That key holder can bypass the oracle and spend independently. A production DLC needs jointly enforced control of the funding UTXO, all committed CET outcomes, and a pre-signed recovery/refund path. Bitcoin Core preflight, chain monitoring, and a full BitVM challenge circuit remain integration gates.

## Review points

The existing UTXORef V2 signed state and exact funding/output commitments are reused in the handoff. This subfolder leaves the active `security-review-fixes` PR alone, and does not change wallet, signer, challenge, or watchtower implementation.

Tests cover 865 ladder entries, shared barrier fanout, oracle tampering/staleness, unauthorized rows, satoshi conservation, replayed and overlapping UTXOs, the real V2 commitment builder, BIP340 point announcement authentication, real BIP341 CET adaptor signing and completion for two distinct contracts, transaction substitution, off-curve points, and rejection of mainnet signing.

## Stage 1: DUCAT preimage to DLC adaptor signature

This experiment uses the oracle's 32-byte HMAC-derived threshold secret `t` as a secp256k1 scalar. Before funding, the oracle signs a point announcement `T = t*G` under the **same BIP340 x-only key named in the signed ladder**. The signed message commits to the ladder snapshot ID, the exact threshold commit hash, `HASH160(t)`, and both coordinates of `T`.

A contract party then prepares an adaptor pre-signature on a specific BIP341 SIGHASH_DEFAULT for an unsigned Bitcoin CET. That CET spends the contract's committed outpoint and pays the selected, independently pinned manifest row. Before reveal, the pre-signature cannot be used as a BIP340 spend signature. After a valid signed breach event reveals `t`, `adaptorComplete` yields a valid Schnorr signature for **that one CET**. Each independently funded contract can bind its own pre-signature to the same `T` and be unlocked by one reveal. The bridge tests this with two separate synthetic Bitcoin funding outpoints.

The bridge's `prepareBarrierCET` requires an explicit, precommitted `rowHash` for a **fixed barrier-triggered payout**. It does **not** exercise the continuous expiry-value put/collar automatically. Spot-dependent expiry settlement continues to require separately authenticated expiry-price outcomes and a properly constructed multi-outcome DLC.

The test transaction uses a bare single-signer Taproot keypath. The private-key owner has an unconditional bypass. **Never fund these generated transactions.** A real contract must bind the complete transaction set, both parties' signing receipts, oracle point, unilateral/refund paths, and BitVM reserve/challenge policy before locking collateral. The signed point announcement also needs an externally witnessed pre-funding publication timestamp; a signature alone establishes identity and bytes, not publication chronology.

To exercise the integration:

```sh
node --test integrations/ducat-ladder-dlc/barrier_adaptor.test.js
node --test integrations/ducat-ladder-dlc/index.integration.test.js
```

## Stage 2: two-party NUMS Taproot funding and pre-signed refund

The next isolated adapter, `joint_dlc.js`, uses the existing UTXORef
`dlc_funding_output`, `dlc_transaction_validator` and
`dlc_signature_validator` modules. Its funding output has a deterministic
NUMS internal key, a **two-party CET tapscript leaf**, and a **two-party
CSV refund tapscript leaf**. The test-only code produces two independently
validated presignatures, one from each party. A single DUCAT secret can
complete a CET for each *distinct* funding outpoint.

Before funding, both parties must provide normal Schnorr signatures on
the refund. The assembled signed refund stays valid without further
oracle communication. Its earliest candidate block height is checked using
both the input sequence's relative CSV delay and the transaction's
absolute height nLockTime. The co-approval signature also pins the
externally checked construction tip height so a past-height refund
cannot masquerade as a future-dated timeout. This checker trusts an external source for
funding confirmation height and prospective chain height.

The adapter also requires a separate BIP340 oracle authorization over
the funding/option/fee/refund agreement. That second key approves the
contract **before funding**; it does not supply a second adaptor scalar.
The current UTXORef native signer requires authenticated threshold-oracle
nonce/outcome announcements, so Stage 2 is a separate research pathway
and **must not be used as a production native-signer policy**.

The signing gate recomputes the original precommitted option economics
and compares every CET/refund output even when the supplied transaction
set contains internally consistent cryptographic hashes. Every
contract has exactly one barrier-exercisable payout; the continuous
put/call expiry grid still needs an independent oracle outcome protocol.

See **[JOINT_DLC_STAGE2.md](JOINT_DLC_STAGE2.md)** for all trust
boundaries, numeric satoshi examples, signing steps, refund timing,
and outstanding regtest / Bitcoin Core / BitVM acceptance gates.
The generated funding outpoints are **synthetic** and no test or
demo broadcasts Bitcoin transactions.
