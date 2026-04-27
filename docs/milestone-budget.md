# Milestone Budget

This is a milestone plan, not a grant proposal. Use it to keep the ask concrete after the technical review path is clear.

## Month 1: LDK Fixture To Adapter

Deliverables:

- Replace browser-only LDK fixture with a Node/Rust replay adapter.
- Normalize payment/channel events into `/v1/wallet-demo/adapter-feed`.
- Add tests for payment success, failed route, HTLC timeout, and channel readiness.
- Document the event shape.

Acceptance criteria:

- `npm run test:panels` passes.
- LDK replay fixture produces the same normalized feed shape as the current dashboard expects.
- One small upstream issue or discussion is opened for feedback.

## Month 2: Wallet Integration Harness

Deliverables:

- Add a local wallet-side adapter runner.
- Support LDK Node or LND profile selection behind the same endpoint.
- Add failure injection fixtures that mirror real wallet event names.
- Keep Ark/assets behind mock boundaries.

Acceptance criteria:

- Local sidecar can switch between fixture and local wallet profile.
- Dashboard labels live, mock, derived, and planned data correctly.
- Export pack includes adapter source mode.

## Month 3: Ark/Bark Cost And Exit Adapter

Deliverables:

- Replace static Ark fixture with a quote/exit adapter shim.
- Preserve deterministic replay tests.
- Add fee comparison tests for direct rebalance versus batch assignment.

Acceptance criteria:

- Ark adapter can run in fixture mode and quote mode.
- Direct-vs-batch fee math is test-covered.
- Forced-exit path stays visible in the dashboard.

## Month 4: Public Examples And Upstreamable Docs

Deliverables:

- Package the LDK event replay example.
- Publish dashboard and smoke-test instructions.
- Write concise docs for wallet developers.
- Prepare upstream PRs or issues for useful example code.

Acceptance criteria:

- Fresh checkout can run the replay tests.
- Public demo still passes.
- Non-core asset experiments remain clearly labeled as extensions.

## Budget Shape

Use a simple monthly budget. Avoid a complicated token or revenue narrative.

Recommended budget categories:

- Development time.
- Testnet infrastructure and hosted demo.
- Documentation and example polishing.
- Upstream review iteration.

Do not lead with yield farming, synthetic USD, or BitVM. Lead with LDK-facing liquidity instrumentation.
