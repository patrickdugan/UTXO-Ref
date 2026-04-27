# Wallet Dashboard UI Plan

This annotates the six demo UI integrations that make the liquidity patching system legible to a reviewer. The goal is to show the path from LN-BTC into TLUSD staking, the Ark-assisted routing pool, and the BitVM enforcement surface without requiring a live public chain dependency.

1. Challenge drilldown modal
   - Status: implemented.
   - Surface: clicking a challenge queue item or challengeable bot opens the BitVM challenge details.
   - Demo value: makes the enforcement path concrete by showing promised liquidity, delivered liquidity, shortfall, violation tags, and the remedy.

2. Profile switch panel
   - Status: implemented as backend profile telemetry.
   - Surface: the dashboard reads `/v1/wallet-demo/status` and displays active profile, chain, RPC, wallet, LND endpoint, readiness, and loaded artifact state.
   - Demo value: lets the same UI explain whether it is running against mock, Litecoin testnet, or a future Bitcoin testnet backend.

3. Wallet mock pane
   - Status: implemented.
   - Surface: a compact wallet panel shows LN-BTC input, TLUSD output, staked TLUSD, assigned liquidity patch, verify action, and challenge-prep action.
   - Demo value: frames the feature as wallet-integrated liquidity farming instead of a raw backend artifact.

4. Stress slider
   - Status: implemented as the fleet-size selector.
   - Surface: reviewer can switch between 96, 512, 2,048, and 5,000 simulated bots.
   - Demo value: shows the Ark/BitVM routing model under stress quantities without changing the local sidecar.

5. Proof graph
   - Status: implemented.
   - Surface: the graph links LN-BTC funding, UTXORef/DLC funding, TLUSD RFQ, stake commitment, Ark allocation, BitVM challenge, and fleet dashboard artifact ids.
   - Demo value: gives a compact proof trail for how the wallet claim ties into the enforcement machinery.

6. Export report button
   - Status: implemented.
   - Surface: exports the current dashboard, backend status, and wallet view as a JSON evidence bundle.
   - Demo value: gives reviewers a durable artifact to inspect after the live walkthrough.

Packaging note: `integrations/wallet-dashboard-vercel` mirrors this UI with Vercel serverless mock endpoints so the dashboard can be deployed as a standalone subrepo while the local Litecoin/testnet sidecar remains the source of richer live-demo data.

## Layer-Tech Impression Additions

1. Protocol trace panel
   - Status: implemented.
   - Surface: shows the LN invoice, subswap HTLC, UTXORef funding, Ark VTXO, asset stake, and BitVM guard as one ordered proof path.
   - Demo value: demonstrates that the wallet concept has explicit boundaries between Lightning, swap funding, UTXO state, Ark batching, asset accounting, and enforcement.

2. Failure injection controls
   - Status: implemented.
   - Surface: lets the reviewer switch between nominal routing, ASP delay, oracle mismatch, HTLC timeout, under-delivery, and forced Ark exit.
   - Demo value: proves the system is being designed around recovery paths and invariants rather than only the happy path.

3. BOLT / LDK compatibility pane
   - Status: implemented.
   - Surface: maps invoice amount, payment hash, preimage source, CLTV delta, fee ppm, liquidity balance, and LDK event names.
   - Demo value: makes the Lightning integration legible to LDK/LN reviewers.

4. Ark batch savings simulator
   - Status: implemented.
   - Surface: fee-rate slider compares direct rebalance vbytes against Ark batched VTXO costs.
   - Demo value: shows why Ark makes the liquidity patch marginal cost plausible.

5. BitVM enforcement drilldown
   - Status: implemented.
   - Surface: displays committed state, claimed state, invariant, shortfall, bond coverage, challenge window, and exit path.
   - Demo value: frames BitVM as the governor against ASP misbehavior.

6. Taproot Assets / TradeLayer mode toggle
   - Status: implemented.
   - Surface: switches the asset backend between TLUSD mock, Taproot Asset USD, and TradeLayer synthetic USD.
   - Demo value: shows asset-agnostic routing and a path from mock TLUSD toward real asset stacks.

7. Wallet integration readiness checklist
   - Status: implemented.
   - Surface: tracks LDK Node, LND, Core Lightning, Bark/Ark, Taproot Assets, Litecoin testnet, and Bitcoin testnet adapter status.
   - Demo value: makes remaining integration work explicit and credible.

8. Operator economics panel
   - Status: implemented.
   - Surface: combines gross routing fees, Ark savings, challenge reserve, exit reserve, utilization, and modeled net yield.
   - Demo value: shows the liquidity service as an operator business, not just a protocol sketch.
