# Upstream Contribution Targets

This is the practical list of places to turn the dashboard work into open-source Lightning contributions. Start small and bias toward tests, examples, and adapter contracts before proposing large protocol changes.

## Target 1: LDK Event Replay Example

Goal: a small example that replays payment/channel events into a normalized wallet liquidity feed.

Candidate contribution shape:

- Example fixture file with LDK-like events.
- Normalizer for `PaymentClaimable`, `PaymentClaimed`, `PaymentPathFailed`, `ChannelReady`, and HTLC failure.
- Assertions that the normalized feed preserves payment hash, amount, status, and recovery path.

Why it helps: it gives wallet developers a concrete test surface for liquidity automation without requiring a full node in every test.

## Target 2: LDK Node Liquidity Dashboard Adapter

Goal: map LDK Node event streams into the same feed used by the demo dashboard.

Candidate contribution shape:

- Minimal adapter crate or example app.
- JSON output endpoint for local UI/debugging.
- Documentation showing how a wallet can consume the feed.

Why it helps: it turns the mock boundary into a replaceable adapter.

## Target 3: Bark / Ark Quote Fixture

Goal: standardize a tiny fixture for Ark batch quote and exit-prep events.

Candidate contribution shape:

- `quoteBatch`, `assignVtxo`, `prepareExit` interface sketch.
- Deterministic fixture replay.
- Fee comparison tests against direct on-chain rebalances.

Why it helps: it keeps Ark integration about cost and exit safety rather than speculative yield.

## Target 4: Taproot Assets Transfer-Proof Fixture

Goal: define the transfer-proof shape the wallet dashboard expects.

Candidate contribution shape:

- Transfer quote fixture.
- Asset proof verification fixture.
- Mapping into a normalized liquidity stake event.

Why it helps: it makes the asset extension optional and auditable.

## Target 5: TradeLayer tx33 Fixture

Goal: keep the synthetic USD experiment isolated from the Lightning core.

Candidate contribution shape:

- tx33 quote fixture.
- perp collateral verification fixture.
- Explicit warning that this is not required for the Bitcoin-only core.

Why it helps: it prevents the grant story from turning into an unfocused asset proposal.

## First Issue To Open

Open a small issue or discussion around this question:

```text
Would an LDK-style payment/channel event replay fixture be useful for testing wallet liquidity automation?

I have a prototype dashboard and normalized JSON feed. I would like feedback on whether the event shape is useful before turning it into an example or adapter.
```

Attach:

- Dashboard URL.
- Adapter feed URL.
- Smoke-test command.
- Clear note that non-LDK layers are fixture boundaries.
