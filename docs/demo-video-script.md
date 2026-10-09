# Three-Minute Demo Script

This script is for a short screen recording. Keep it factual and avoid overselling fixture-backed pieces.

## 0:00 - 0:20 Open

Show: https://wallet-dashboard-vercel.vercel.app

Say:

```text
This is a Lightning liquidity adapter demo. The core is a wallet-facing event and invariant harness for LN liquidity operations. The advanced Ark, asset, and BitVM parts are marked as fixture or derived boundaries.
```

## 0:20 - 0:50 Stress Quantity

Action:

- Select `5,000 bots`.
- Point to fleet totals and throughput.

Say:

```text
The dashboard loads a deterministic 5,000-bot stress payload. It tracks assigned inbound liquidity, delivered liquidity, fee ppm, challengeable shortfall, and modeled Ark batch savings.
```

## 0:50 - 1:20 Guided Flow

Action:

- Click through the guided demo steps.

Say:

```text
The flow is LN-BTC in, TLUSD balance minted in the demo model, stake reserved, Ark-style rebalance batch assigned, BitVM guard prepared, and operator economics computed.
```

## 1:20 - 1:50 Failure Mode

Action:

- Click `HTLC timeout`.
- Click `Under-delivery`.

Say:

```text
The point is not the happy path. Each failure mode maps to a detector and recovery path. The LDK-style payment failure path and the BitVM shortfall path are visible in the same UI.
```

## 1:50 - 2:20 Adapter Feed

Action:

- Scroll to `Layer Adapter Feed`.
- Open `/v1/wallet-demo/adapter-feed` in a new tab.

Say:

```text
This is the next integration boundary. It normalizes LDK, Bark/Ark, Taproot Assets, and TradeLayer fixture events into one reviewer feed. The first live replacement should be the LDK event adapter.
```

## 2:20 - 2:45 Evidence

Action:

- Show invariant ledger.
- Click export pack.

Say:

```text
The invariant ledger and export pack are here so reviewers can inspect the claims directly. The smoke test hits the public deployment and checks that all panels have data.
```

## 2:45 - 3:00 Close

Action:

- Open `/funding`.

Say:

```text
The funding ask should be scoped to the Bitcoin-only core: replace the LDK fixture with a real LDK or LDK Node adapter, keep the extension layers behind explicit interfaces, and upstream the useful examples and tests.
```
