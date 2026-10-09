# Bitcoin-Only Core Scope

The safest funding frame is not a token product. It is a Lightning liquidity adapter and test harness that can stand alone as Bitcoin/Lightning infrastructure.

## Core Deliverable

Build an adapter layer that turns Lightning wallet/node events into liquidity operations:

- Ingest LDK-style payment and channel events.
- Track requested inbound liquidity, delivered liquidity, and failed paths.
- Model fee-aware rebalance decisions.
- Emit a normalized event feed for wallet UIs and tests.
- Provide deterministic replay fixtures and public smoke tests.

## Why This Is Useful

Wallets need reliable liquidity instrumentation before they can safely automate rebalancing, leases, just-in-time liquidity, or external liquidity providers. A small event adapter plus replay harness helps make those flows testable.

## Out Of Core Scope

These are useful experiments, but not required for the Bitcoin/Lightning core:

- TLUSD or any synthetic asset UX.
- Taproot Assets settlement.
- TradeLayer tx33 settlement.
- BitVM challenge execution.
- Ark ASP production integration.

## Extension Boundary

Extensions must enter through the same adapter shape:

```text
source event -> normalized event -> invariant check -> dashboard/export evidence
```

That keeps the grant deliverable focused even while the demo shows the larger architecture.

## Acceptance Criteria

- A replay fixture produces normalized events for payment success, claimable payment, failed route, and HTLC failure.
- A wallet-facing endpoint exposes the event feed.
- A dashboard consumes the feed.
- A public smoke test verifies every panel has data.
- Documentation states which integrations are live, mocked, or planned.
