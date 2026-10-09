# CivKit P2P Platform Framework

This folder is a practical framework for a Bitcoin-based P2P marketplace in the CivKit milieu.

The operating assumption is the one you called out:
- escrow decisions are delegated to curated whitelist notaries or keysigners
- they are selected from a registry
- they earn fees for availability, signing, and dispute work
- Bitcoin settlement is enforced by the `civkit/bitvm_escrow` layer

## What This Framework Covers

Application layer:
- marketplace fee policy
- curated notary registry
- offer metadata for payment method, region, and fiat pricing
- trade session creation with separate platform and notary booking fees
- dispute settlement planning with optional resolver fee

Bitcoin verification layer:
- project the chosen outcome into a committed payout set
- verify the payout sweep with the existing BitVM UTXO referee

## Mental Model

1. Seller posts an offer.
2. Buyer accepts and the platform chooses an eligible notary from a curated registry.
3. The trade opens with an escrow order that already commits:
   - seller payout destination
   - buyer refund destination
   - platform fee output
   - notary booking fee output
   - notary resolver destination for future dispute fees
4. Later, one of three routes is selected:
   - `release`
   - `refund`
   - `split`
5. That route is projected into Bitcoin outputs and checked by `bitvm_escrow`.

## Files

- `types.js`: policy, notary, and offer records
- `fees.js`: deterministic fee quoting
- `registry.js`: curated notary eligibility and selection
- `workflow.js`: trade session lifecycle and settlement helpers
- `demo.js`: end-to-end example
- `test.js`: focused tests

## Framework Rules

- Notaries must be on the required whitelist tag.
- Notaries must support the trade's payment method and region.
- Notaries can earn two fee classes:
  - booking fee: always-on compensation for being the delegated signer/notary
  - resolver fee: only paid when a dispute route consumes it
- Platform fees and notary booking fees are represented as separate fixed fee outputs in escrow.
- Resolver fees are routed to the selected notary's settlement script only when a dispute decision uses them.

## Production Gaps

- No Nostr event schema is defined yet for offers, acceptances, evidence, or notary attestations.
- No threshold notary panel logic is implemented yet; the current framework assumes one delegated curated notary per trade.
- The inherited BitVM circuit still needs a production in-circuit hash implementation.
