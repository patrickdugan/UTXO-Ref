# TradeLayer Send + BitVM Launch Goals

Date: 2026-05-01

This parks the hardening work that should happen after the current e2e route
artifact is live-testable.

## Current E2E Scope

The current architecture is:

1. TradeLayer/state-oracle send blob
2. selected send record
3. DLC-funder registry lookup
4. exact `sendBps` derivation
5. UTXORef payout commitment
6. expected sweep outputs
7. verifier result

This is enough to run a deterministic live test with real TradeLayer send data
and later attach a real sweep txid or signed PSBT.

## Deferred Hardening Goals

1. Real oracle signature verification
- Status: initial Ed25519 verifier implemented for the current state-oracle
  payload shape.
- The signed message binds `oracleBlobHash`, `selectedSendHash`, and
  `dlcFunderRegistryHash`.
- The e2e runner supports `--require-oracle-signature` so signed live blobs can
  fail closed.
- Remaining: swap or extend the verifier for the final Bitcoin/Schnorr oracle
  policy if that becomes the production key format.

2. Real TradeLayer consensus extraction
- Build the state-oracle send blob directly from parsed TradeLayer consensus
  state, not from a hand-assembled JSON payload.
- Include send txid, property id, sender, recipient, amount units, deposit units,
  snapshot height, and state root.
- Preserve enough source material for fraud challenges.

3. Sweep PSBT construction and broadcast path
- Convert the resolved route plan into a Bitcoin/Litecoin transaction skeleton.
- Build a signed PSBT or finalized raw transaction from the DLC UTXO.
- Attach the live txid after broadcast and verify observed outputs against the
  committed payout leaves.

4. Fraud challenge packaging
- Package challenge artifacts for bad send inclusion, invalid send omission,
  bad DLC-funder mapping, bad ratio arithmetic, wrong destination, wrong fee, and
  wrong refund remainder.
- Bind each challenge to the exact oracle blob hash and registry hash.

5. Wallet-facing flow object
- Expose a compact flow model for UI:
  TL send -> state oracle -> DLC mapping -> BitVM/UTXORef sweep.
- Make clear when the recipient is a normal address versus a DLC funding output.
- Surface hashes, expected outputs, verifier status, and live txid/PSBT status.

6. Production policy checks
- Add challenge window policy, fee caps, dust limits, registry freshness, and
  allowed-oracle/key rotation rules.
- Define how failed verification pauses or blocks wallet spend attempts.
