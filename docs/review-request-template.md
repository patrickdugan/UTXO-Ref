# Technical Review Request Template

Subject:

```text
Feedback request: LDK-facing liquidity event replay and dashboard harness
```

Body:

```text
Hi,

I am preparing a small open-source Lightning liquidity adapter project and would value technical feedback before I turn it into a formal funding request.

The Bitcoin-only core is an LDK-facing event replay and dashboard harness:

- Normalize payment/channel events into a wallet-readable liquidity feed.
- Track requested inbound liquidity, delivered liquidity, failed paths, and fee cost.
- Expose an invariant ledger and exportable reviewer evidence.
- Keep advanced Ark/assets/BitVM pieces behind explicit fixture boundaries.

Live demo:
https://wallet-dashboard-vercel.vercel.app

Funding brief:
https://wallet-dashboard-vercel.vercel.app/funding

Adapter feed:
https://wallet-dashboard-vercel.vercel.app/v1/wallet-demo/adapter-feed

Smoke test:
cd integrations/wallet-dashboard-vercel
npm test
npm run test:panels

The current adapter feed is fixture replay. It covers LDK-like events, Bark/Ark batch events, Taproot Assets proof events, and TradeLayer tx33 events. My proposed first real step is replacing only the LDK fixture with an LDK or LDK Node event adapter, while keeping the other layers clearly marked as extension experiments.

The feedback I need is narrow:

1. Is this LDK-style event shape useful for wallet liquidity automation tests?
2. Which event names or fields are missing?
3. Would this be better as an LDK example, an LDK Node example, or a standalone test harness?
4. What should be removed to keep the scope useful to Lightning developers?

Thanks,
Patrick
```

Notes:

- Send this as a feedback request, not a money ask.
- Do not attach a long proposal in the first email.
- Lead with the Bitcoin-only core.
- Mention assets/Ark/BitVM only as clearly marked extension boundaries.
