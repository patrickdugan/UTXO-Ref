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

