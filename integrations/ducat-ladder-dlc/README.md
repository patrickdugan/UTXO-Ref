# DUCAT-style threshold ladder / DLC / UTXORef V2 prototype

Research-only deterministic Node.js experiment. Separate from the existing DLC security, TradeLayer PnL, and UTXORef V2 code.

```sh
node --test integrations/ducat-ladder-dlc/index.test.js
node integrations/ducat-ladder-dlc/demo.js
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

- Signatures in this harness use ephemeral test-only Ed25519 keys. They are **not** Chainlink CRE attestations, Nostr Schnorr signatures, DLC adaptor scalars, or Bitcoin transaction signatures.
- The 32-byte oracle identity is a tagged-hash fixture identifier. The test secret seed is generated only in-memory. No production signing secrets, chain RPC connections, broadcasts, or mainnet funds are involved.
- The expiry attestation is a separate oracle statement. A correct DUCAT threshold preimage establishes that the oracle revealed an agreed secret, while price-feed integrity depends on oracle trust.
- UTXORef remains responsible for the authenticated state checkpoint, complete reserve UTXO evidence, global double-spend history, script execution, and independently operated challengers.
- A candidate epoch can only be checked against an independently recomputed trusted epoch. The mismatch witness is a **description for an off-chain challenger**; it is not a Bitcoin-enforceable BitVM fraud proof.
- The CET manifest is a payment template. Real funding/adaptor signatures, a complete outcome grid and expiry refunds, Bitcoin Core transaction preflight, chain monitoring, and a full BitVM challenge circuit remain integration gates.

## Review points

The existing UTXORef V2 signed state and exact funding/output commitments are reused in the handoff. This subfolder leaves the active `security-review-fixes` PR alone, and does not change wallet, signer, challenge, or watchtower implementation.

Tests include 865 commitments, cross-contract barrier fanout, oracle tampering and staleness, signature mismatch, incorrect preimages, unauthorized option rows, exact satoshi conservation, undercollateralization/dust, replayed outpoints, duplicate funding UTXOs, exit collisions, and an injected V2 input-shape checker.
