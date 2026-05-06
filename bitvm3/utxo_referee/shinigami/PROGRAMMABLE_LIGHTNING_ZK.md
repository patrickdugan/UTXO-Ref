# Programmable Lightning ZK Watchtower and ASP Policies

This module turns an opaque Lightning payment fact into two programmable
sidecar receipts:

- a watchtower program that accepts or challenges an Ark/UTXORef transition
- an ASP policy that settles, slashes, or forces exit for Ark-backed inbound
  Lightning liquidity

The core bridge is a public Lightning payment receipt bound to Ark ZK
miniscript proof receipts. The public receipt commits to the payment hash,
amount, invoice hash, and preimage-witness commitment, but does not expose the
route or preimage.

## Surfaces

`buildProgrammableWatchtower` binds a Lightning payment proof to the Ark ZK
role `utxoref_challenge_publication`. If the observed transition hash differs
from the payment-conditioned program hash, or the receipt is not verified, the
watchtower emits a challenge artifact.

`buildProgrammableAspPolicy` binds the same payment proof to:

- `cooperative_round` for normal ASP settlement
- `asp_forfeit_guard` for the slash/force-exit path

The ASP policy checks delivered inbound sats, fee ceiling, CLTV ceiling, exit
path availability, and forfeit path availability.

`buildProgrammableLightningZkBundle` packages both surfaces against one shared
Lightning payment proof.

## Run

From the UTXORef repo root:

```powershell
node bitvm3\utxo_referee\shinigami\lightning_zk_programs.js
```

The command reads the latest Ark ZK miniscript receipt summary:

```text
bitvm3\utxo_referee\artifacts\ark_zk_miniscript\ark_zk_miniscript_receipts_latest.json
```

and writes:

```text
bitvm3\utxo_referee\shinigami\artifacts\lightning_zk_programs\programmable_lightning_zk_latest.json
bitvm3\utxo_referee\shinigami\artifacts\lightning_zk_programs\programmable_lightning_zk_latest.md
```

Current generated bundle:

```text
92ecd80d8f10764833d16df5c0eee90fe381214bd96c9fe2f9d241f90f0f6f6f
```

## Boundary

This is not a BOLT extension and does not change Lightning commitment
transaction enforcement. It is a sidecar policy shape for wallets, LSPs, ASPs,
watchtowers, or DLC monitors that need payment-conditioned evidence without
revealing the LN route.

Production needs authenticated watchtower subscriptions, ASP signatures, real
route observations, VTXO membership proofs, and concrete challenge transaction
construction.

## Checks

```powershell
node --check bitvm3\utxo_referee\shinigami\lightning_zk_programs.js
node bitvm3\utxo_referee\shinigami\lightning_zk_programs.test.js
```
