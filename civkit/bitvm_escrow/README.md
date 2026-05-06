# CivKit BitVM Escrow

This module is a minimal BitVM-facing escrow layer for a CivKit-style P2P market.

It does one thing well:
- turn an agreed escrow outcome into a committed Bitcoin payout set
- verify that the sweep transaction matches that payout set using `bitvm3/utxo_referee`

It does not try to prove off-chain facts such as:
- whether fiat cash actually changed hands
- whether a chat transcript is authentic
- whether an arbitrator made the right social decision

That boundary matters. BitVM can enforce Bitcoin-side settlement correctness after an outcome is chosen. It cannot directly observe the fiat leg of a P2P cash trade.

## Scope

Supported payout routes:
- `release`: seller receives escrow minus fixed fees
- `refund`: buyer receives escrow minus fixed fees, optionally gated by `expiryBlock`
- `split`: explicit buyer/seller split for dispute resolution

Supported fixed fees:
- `fixedFeeOutputs`: one or more always-on fee outputs such as platform or notary booking fees
- `resolverFeeSats`: per-decision dispute fee routed to a resolver script

## Files

- `types.js`: CivKit escrow order and decision records with deterministic hashing
- `projector.js`: projects escrow routes into referee commitments, leaves, and sweeps
- `verify.js`: wraps the UTXO referee verifier and exposes circuit helpers
- `onchain.js`: builds Taproot authorization leaves, a funding output, and settlement transaction/PSBT skeletons
- `bitvm_transition.js`: models signer quorum, timeout, and satoshi conservation as a BitVM-style escrow state transition
- `demo.js`: end-to-end example
- `test.js`: focused tests

## Quick Start

```javascript
const escrow = require('./index');

const order = new escrow.EscrowOrder({
  orderId: 'order-42',
  epochId: 42n,
  escrowAmountSats: 210000n,
  sellerPayoutScriptPubKey: '00141111111111111111111111111111111111111111',
  buyerRefundScriptPubKey: '00142222222222222222222222222222222222222222',
  fixedFeeOutputs: [
    {
      feeId: 'platform_fee',
      role: 'platform_fee',
      recipientScriptPubKey: '00143333333333333333333333333333333333333333',
      amountSats: 2000n
    }
  ],
  resolverFeeScriptPubKey: '00144444444444444444444444444444444444444444',
  expiryBlock: 900000n
});

const decision = new escrow.EscrowDecision({
  route: 'split',
  sellerAmountSats: 150000n,
  buyerAmountSats: 56000n,
  resolverFeeSats: 2000n,
  decisionId: 'dispute-7'
});

const result = escrow.verifyEscrowSettlement(order, decision, {
  currentBlock: 900010n
});

if (!result.ok) {
  throw new Error(result.reason);
}

console.log(result.settlement.commitment.hash().toString('hex'));
```

## Design Notes

- `escrowAmountSats` is the full satoshi cap for the order.
- Every valid route must conserve sats exactly:
  `seller + buyer + sum(fixedFeeOutputs) + resolverFee = escrowAmountSats`
- The on-chain package uses real Taproot leaves for route authorization and exact settlement transaction templates for fee routing. It does not pretend Script can enforce outputs by itself without a covenant.
- The BitVM-oriented transition package lets you treat `route`, `buyer/seller/notary` signer bits, timeout state, and exact satoshi outputs as challengeable circuit inputs.
- `threshold_2_of_3` Taproot authorization mode is supported for a more BitVM-centric split between authorization and payout verification.
- Spend packages can use `commitmentType: 'transition'` so the Taproot commitment leaf and OP_RETURN anchor bind the BitVM transition commitment instead of only the payout-set commitment.
- Spend packages now expose an explicit witness plan. In threshold mode the witness stack order is `[notary, buyer, seller]`, with `buyer -> refundPubkey` and `seller -> releasePubkey`.
- Custom network descriptors are supported for Litecoin flows, including `litecoin-testnet`, so smoke and artifact flows can emit `tltc1...` addresses instead of Bitcoin testnet ones.
- The current BitVM circuit is inherited from `bitvm3/utxo_referee` and still uses a placeholder hash inside the circuit path. Off-chain verification uses real SHA256 today; production circuit deployment still needs a real hash gadget.

## Run

```powershell
node civkit/bitvm_escrow/test.js
node civkit/bitvm_escrow/demo.js
```
