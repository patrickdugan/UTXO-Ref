# UTXORef Lightning Liquidity Adapter Demo

This package is framed for reviewers who care about Bitcoin and Lightning open-source work. It intentionally separates the Bitcoin/Lightning core from the asset and settlement experiments.

## Fast Demo

- Dashboard: https://wallet-dashboard-vercel.vercel.app
- Funding brief: https://wallet-dashboard-vercel.vercel.app/funding
- 5,000-bot stress payload: https://wallet-dashboard-vercel.vercel.app/v1/wallet-demo/stress-dashboard?bots=5000
- Layer adapter feed: https://wallet-dashboard-vercel.vercel.app/v1/wallet-demo/adapter-feed

Run the public smoke test:

```powershell
cd C:\projects\UTXORef\UTXO-Ref\integrations\wallet-dashboard-vercel
npm test
npm run test:panels
```

## Bitcoin-Only Core

The grant-facing core is an open-source Lightning liquidity adapter and test harness:

- Normalize LDK-style payment/channel events into a wallet-readable liquidity feed.
- Model inbound liquidity demand, route delivery, shortfall, and fee cost.
- Surface recovery paths for HTLC timeout, route under-delivery, and forced exit.
- Export machine-readable evidence for reviewers and future CI.

This can be useful without TLUSD, Taproot Assets, TradeLayer, or BitVM being live. Those are extension surfaces.

## Extension Surfaces

The dashboard shows advanced layers behind explicit boundaries:

- Ark/Bark: fixture replay for VTXO batch quote, assignment, and exit preparation.
- Taproot Assets: fixture replay for transfer quote and asset proof verification.
- TradeLayer tx33: fixture replay for synthetic USD quote and perp collateral check.
- BitVM: enforcement envelope for ASP shortfall and slash/exit path.

These are marked as mock, derived, planned, or fixture replay in the UI. They are not presented as live daemons.

## What Is Live

- Vercel-hosted dashboard.
- Serverless JSON endpoints.
- Deterministic 5,000-bot stress payload.
- Adapter fixture feed covering LDK, Ark, Taproot Assets, and TradeLayer.
- Panel smoke test that hits the public deployment.
- Local sidecar route for the same adapter feed.

## What Is Mocked

- LDK event stream is fixture replay, not a running LDK node.
- Ark/Bark events are fixture replay, not a live ASP.
- Taproot Assets and TradeLayer are adapter-mode fixtures.
- BitVM enforcement is an invariant/evidence model, not a full on-chain challenge execution.

## Commands

```powershell
cd C:\projects\UTXORef\UTXO-Ref\integrations\wallet-dashboard-vercel
npm test
npm run test:panels
```

Local sidecar adapter route smoke:

```powershell
node -e "const {buildAdapterFeed}=require('./integrations/wallet-dashboard-vercel/api/adapterFeed'); const f=buildAdapterFeed(); console.log(f.verification)"
```

## Current Commits Of Interest

- `6b49aa0` Add Vercel fleet dashboard package
- `55b815b` Add layer tech dashboard panels
- `9411b74` Add dashboard panel smoke test
- `74fc220` Add reviewer proof dashboard surfaces
- `d7bc241` Add layer adapter fixture feed

## Reviewer Path

1. Open the dashboard.
2. Set 5,000 bots.
3. Click through the guided demo.
4. Trigger a failure injection.
5. Inspect the invariant ledger and adapter feed.
6. Export the reviewer pack.
7. Run `npm run test:panels`.

## Next Engineering Work

The next credible step is replacing the LDK fixture with a small real LDK/LDK Node replay adapter. The rest of the advanced layers should remain behind the same adapter interface until they have live daemon-backed implementations.
