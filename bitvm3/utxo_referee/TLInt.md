# TradeLayer Integration Notes (`TLInt`)

This file captures TradeLayer-specific assumptions and mapping into the generic `utxo_referee` verifier.

## Purpose

Keep the referee core protocol-neutral while documenting how TradeLayer settlement data is projected into referee inputs.

## Mapping Contract

1. Epoch mapping
- TradeLayer settlement epoch maps to `CommitmentPackage.epochId` and `SweepObject.epochIdCommitted`.
- Epoch values must be deterministic and consistent between commitment and sweep construction.

2. Amount mapping
- TradeLayer payout units map to satoshis before entering referee logic.
- Referee paths only consume integer satoshi amounts (`BigInt`); no floating-point values.

3. Recipient mapping
- TradeLayer withdrawal destination maps to Bitcoin `recipientScriptPubKey`.
- Residual destination maps to `CommitmentPackage.residualDest`.

4. Membership mapping
- TradeLayer payout set for an epoch is transformed into `PayoutLeaf[]`.
- Leaves are hashed and committed as `withdrawalRoot`.
- Claimed sweep payouts must carry matching Merkle proofs.

5. Send-to-DLC mapping
- TradeLayer/state-oracle logic tracks token sends and decides whether the sent
  address is also registered as the funder for a follow-on DLC.
- If a match exists, the route adapter rewrites the user-facing send address into
  the mapped DLC funding address before building payout leaves.
- The BitVM transition does not parse TradeLayer JSON or scan account state. It
  verifies exact integer arithmetic for `sendBps` and then checks that the sweep
  outputs match the committed output scripts.

## Integration Pipeline

1. Build payout leaves from finalized TradeLayer withdrawal set.
2. Build Merkle tree and set `withdrawalRoot`.
3. Publish `CommitmentPackage` (`epochId`, `withdrawalRoot`, `capSats`, `residualDest`).
4. Construct sweep candidate with payout outputs and proofs.
5. Run `verifySweep(commitment, sweep)` before acceptance/challenge flow.

## Non-Goals Inside Referee

- Price discovery or oracle validation.
- Trade/PnL correctness.
- Collateral or tokenomics logic.
- General TradeLayer state transition validity.
- Full address/DLC registry lookup inside the circuit.

## Minimal Integration Example

```javascript
const leaves = tlWithdrawals.map(w => ({
  epochId: tlEpochId,
  recipientScriptPubKey: w.scriptPubKey,
  amountSats: BigInt(w.sats)
}));

const { root, proofs } = referee.buildTreeWithProofs(leaves);
const commitment = new referee.CommitmentPackage({
  epochId: tlEpochId,
  withdrawalRoot: root,
  capSats: BigInt(tlCapSats),
  residualDest: tlResidualScriptPubKey
});
```
