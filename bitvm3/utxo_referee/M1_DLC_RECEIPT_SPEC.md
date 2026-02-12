# Milestone 1: DLC Template + Receipt Token Spec

This document defines the milestone-1 contract shape and canonical schemas.

## Objective

Lock the contract shape and 1:1 receipt model:

- Deposits are denominated in satoshis.
- Receipt balances are off-chain accounting balances.
- Mint ratio is fixed at `1 sat deposited = 1 receipt unit`.
- Redemption burns receipts at `1:1` back to satoshi-denominated claims.

## Canonical Definitions

1. `epochId`
- Unsigned 64-bit integer (`uint64`).

2. Payout leaf schema
- `(epochId, recipientScriptPubKey, amountSats)`

3. Commitment package schema
- `(epochId, withdrawalRoot, capSats, residualDest)`

Code implementation is in `bitvm3/utxo_referee/m1_spec.js`.

## Deterministic Receipt Ledger Rules

1. Deposit event
- Input: `(depositId, accountId, amountSats, chainTxRef)`
- Effect: increase `accountId` receipt balance by `amountSats`.
- Constraint: `depositId` must be unique.

2. Redemption event
- Input: `(redemptionId, accountId, amountSats, targetScriptPubKey)`
- Effect: decrease `accountId` receipt balance by `amountSats`.
- Constraint: balance must be sufficient and `redemptionId` unique.

3. Ledger determinism
- Apply events in insertion order.
- Keep `BigInt` satoshi accounting.
- Canonical snapshots sort accounts lexicographically before hashing.

## Milestone-1 Demo Target

`deposit -> receipt minted -> epoch root created`

Planned runtime artifact:
- `node bitvm3/utxo_referee/m1_ltc_testnet_demo.js`

The demo supports two modes:
- Mocked txrefs (default)
- Litecoin testnet RPC probe when RPC env vars are configured

