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
- Status: boundary extractor implemented for parsed TradeLayer tx/history rows.
- It filters consensus-valid tx type 2 sends, expands multi-send rows, includes
  send txid, property id, sender, recipient, amount units, deposit units,
  snapshot height, source hash, and state-root handle.
- The e2e runner supports `--tl-consensus-input <path>` to build the state-oracle
  blob before route verification.
- Remaining: point this at the live TradeLayer listener/RPC response shape and
  lock the final state-root source once the wallet/parser endpoint is stable.

3. Sweep PSBT construction and broadcast path
- Status: deterministic sweep planner implemented.
- It converts the resolved route plan into exact input/output/fee accounting,
  Bitcoin Core `createrawtransaction` and `createpsbt` command templates, and an
  observed-output verifier against the committed payout leaves.
- The e2e artifact now includes `sweepTx` and `observedSweep` sections.
- Remaining: feed the command template to the live wallet signer and attach the
  broadcast txid/final PSBT in a real run.

4. Fraud challenge packaging
- Status: deterministic challenge bundle implemented.
- It packages bad send inclusion, invalid send omission, bad DLC-funder mapping,
  bad ratio arithmetic, wrong destination, wrong fee, and wrong refund remainder
  artifacts.
- Every challenge binds the exact oracle blob hash, selected send hash, registry
  hash, route plan hash, withdrawal root, and commitment hash.
- The e2e artifact now includes `fraudChallenges` and
  `fraudChallengeVerification`.
- Remaining: wire these package ids to concrete BitVM challenge transactions
  once the live sweep signer/broadcaster is attached.

5. Wallet-facing flow object
- Status: compact wallet flow model implemented.
- It exposes the four UI stages:
  TL send -> state oracle -> DLC mapping -> BitVM/UTXORef sweep.
- It labels destination kind as normal address, DLC funding output, or refund
  remainder, and surfaces hashes, expected outputs, verifier status, and live
  txid/PSBT status.
- The e2e artifact now includes `walletFlow` and `walletFlowVerification`.

6. Production policy checks
- Status: production policy gate implemented.
- It checks challenge window policy, fee caps, dust limits, registry freshness,
  allowed oracle addresses/key ids, route verification, sweep verification, and
  optional oracle signature enforcement.
- Failed checks produce `walletAction: pause_spend` by default so wallet spend
  attempts can stop before creating/broadcasting a sweep.
- The e2e artifact now includes `productionPolicy` and
  `productionPolicyVerification`.
