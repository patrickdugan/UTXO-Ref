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

4. Milestone-1 settlement shape
- `flat` and `pnl` are the bounded settlement paths.
- `roll` is the non-interactive timeout path.
- `dustCarrySats` is the explicit satoshi remainder carried into the next epoch or residual accounting.
- `m1_roll_forward.js` emits the next-epoch handoff artifact for the roll path.

5. Path determination
- The route paths are determined with integer satoshi arithmetic only.
- The payout ratio is stored as basis points, so the branch amounts are exact `BigInt` satoshi values.
- If a ratio does not divide evenly, the leftover satoshi becomes `dustCarrySats`.
- BitVM can represent this exactly because the committed leaves and branch checks are integer constraints, not floating-point math.

6. Tally state blob
- The receipt ledger state is encoded as a canonical JSON blob called `receipt-tally-map`.
- The blob stores sorted balances, exact satoshi totals, deposit IDs, redemption IDs, and the previous snapshot hash.
- `m1_tally_map.js` is the state-machine wrapper over the ledger.
- The blob hash is the commitment target for replay and next-epoch handoff.

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

The DLC artifact generator emits:
- `flat` settlement path
- `pnl` settlement path
- `roll` timeout path
- `dustCarrySats` rounding metadata
- `m1_roll_forward_latest.json` next-epoch handoff

Smoke-test order:
1. `m1_ltc_wallet_provision.ps1`
2. `m1_dlc_bootstrap.js`
3. `m1_dlc_psbt_cet.js`
4. `m1_oracle_wiring.js`
5. `m1_select_bucket_bundle.js` with `PATH_NAME=flat`
6. `m1_select_bucket_bundle.js` with `PATH_NAME=roll`
7. `m1_roll_forward.js`
8. `m1_tally_map.test.js`
