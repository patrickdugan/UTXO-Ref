# Fast Release Design

This note documents the short-term expiry path that turns an oracle delta publication into a rapid contract roll, while keeping the canonical receipt blob hash-stable.

| Layer | Artifact | Purpose | Delta Fields | Notes |
|---|---|---|---|---|
| Oracle map | `m1_oracle_wiring_latest.json` | Binds oracle event, quorum, and adaptor signature slots | `oracleMapId`, `adaptorSignatureSlots` | Source of truth for the original DLC attestation slots |
| Delta publication | `m1_oracle_delta_publication` | Compact OP_RETURN publication for event-driven roll | `deltaSats`, `publicationId`, `nextContractId` | Off-chain publication only; Bitcoin Script does not build the transaction |
| Challenge witness | `m1_challenge_witness_latest.json` | Carries witness inputs for settlement or roll | `deltaPublication*` fields | The witness gets the publication hash and next-contract hint |
| Tally snapshot | `receipt-tally-map` | Canonical replayable balance blob | None in the canonical blob | Hash-stable; do not append runtime deltas here |
| Annotated witness blob | `m1_expiry_redemption_latest.json` | Appends exit deltas to the witness blob | `redeemedSats`, `pnlGainSats`, `pnlLossSats`, `netDeltaSats`, `settlementBreakdown` | Sidecar annotation; preserves the committed snapshot hash |
| Expiry redemption demo | `m1_expiry_redemption.js` | Builds a deposit -> redemption testnet-friendly artifact | Deposit amount + redemption amount + PnL delta | Uses the latest funding finalization and witness blob |

## Flow

1. Deposit collateral and mint receipts.
2. At expiry, read the oracle/witness blob and resolve the exit route.
3. Append the delta annotation at the edge of the witness blob.
4. Redeem the exit amount and record `redeemedSats`, `pnlGainSats`, `pnlLossSats`, and the explicit `settlementBreakdown` fields for the winner sweep and refund remainder.
5. If the route is `roll`, use the publication's `nextContractId` to start the next contract immediately.

## Commands

```powershell
node bitvm3\utxo_referee\m1_expiry_redemption.js
node bitvm3\utxo_referee\m1_fast_roll.js
```

## Constraint

The canonical `receipt-tally-map` snapshot hash must remain unchanged. Only the sidecar annotation may vary across runs.
