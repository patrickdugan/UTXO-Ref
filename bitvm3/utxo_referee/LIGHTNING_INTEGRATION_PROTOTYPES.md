# Lightning Integration Prototypes

This note describes the prototype surfaces in `lightning_integration.js`.
They are deterministic transcript builders meant for grant review, demos, and
test fixtures. They do not claim to be a production Lightning implementation.

## 1. Lightning-Funded BitVM/DLC Open

`buildLightningFundedPositionOpen()` models a submarine-swap shaped contract
open:

- the user pays a Lightning hold invoice
- the swap/funding side prepares a PSBT skeleton for the BitVM/DLC funding
  output
- the Lightning payment hash is reused as the swap lock
- the funding output commits to the DLC id, epoch, collateral, refund address,
  timeout block, and BitVM commitment root

The artifact exposes an atomicity checklist so reviewers can see exactly what
is linked today and what remains a production integration task.

## 2. Lightning Payout Compression

`buildLightningPayoutCompression()` models small settlement leaves that can be
paid over Lightning instead of becoming individual on-chain outputs.

Each payout leaf commits to:

- epoch id
- account id
- amount in sats
- Lightning payment hash
- fallback scriptPubKey

Settled leaves carry preimage receipts. Unsettled leaves remain on-chain
fallback claims. `verifyLightningPayoutCompression()` checks the Merkle root,
total payout amount, and settled preimages.

## 3. Watchtower Bounty Over Lightning

`buildLightningWatchtowerBounty()` models a BitVM challenge/watchtower payment:

- a bounty invoice is bound to a challenge bundle hash
- the witness hash is part of the paid commitment
- the settled preimage becomes the receipt that the watcher was paid

This is intentionally small and operational. It gives the project a Lightning
integration that is useful even before a full swap daemon exists.

## 4. LDK/BDK-Style Contract Open API

`buildContractOpenApiPrototype()` emits an API surface that wallet developers
can reason about:

- `create_contract_offer`
- `quote_lightning_funding`
- `attach_payment_attempt`
- `finalize_funding_psbt`
- `verify_referee_commitment`

The compatibility target is LDK Node or a BOLT12 adapter on the Lightning side,
BDK for PSBT signing/broadcast, and the UTXO referee artifact bundle for
contract verification.

## 5. Lightning-Funded Rollover

`buildLightningFundedRollover()` models a user topping up collateral over
Lightning during a DLC epoch roll:

- previous collateral carries forward
- the Lightning top-up increases next-epoch collateral
- the next commitment root binds the previous contract, next contract, top-up,
  and payment hash

## Demo

```bash
node bitvm3/utxo_referee/lightning_integration_demo.js
```

This writes:

- `bitvm3/utxo_referee/artifacts/lightning_integration_latest.json`
- `bitvm3/utxo_referee/artifacts/lightning_integration_latest.md`

## Tests

```bash
node bitvm3/utxo_referee/lightning_integration.test.js
```

