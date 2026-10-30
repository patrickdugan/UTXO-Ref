# TradeLayer Repo Family: External Security Review Status

This is a pointer document for the independent security-review PRs open against the `tradelayer-wallet` org repos. It exists so the PRs, their open questions, and the review scope live in one place that this repo's readers already watch. It does not duplicate code or findings; each PR carries its own description and per-round comments.

Scope and status notes:

- The reviews are best-effort, external, and AI-assisted. They are code inspection plus standalone test harnesses, not an audit.
- Several PRs were reviewed in repeated rounds and each round still found issues, so "no known issues" is **not** a claim anyone can make for these branches. Human maintainer review is needed before merging any of them.
- Consensus code (`tradelayer-core`) is **not compiled or run** in this work; the dependencies were unavailable. Those commits need a real build.
- Some findings in the consensus transaction dispatch path are deliberately not described in public threads. See question 4 below.

## Open PRs

| Repo | PR | Topic |
|---|---|---|
| `tradelayer-wallet` | [#47](https://github.com/tradelayer-wallet/tradelayer-wallet/pull/47) | Local-server auth token, RPC allowlist, session-bound swap protocol, seller-side PSBT guard (with tests) |
| `tl-orderbook-server` | [#4](https://github.com/tradelayer-wallet/tl-orderbook-server/pull/4) | Input validation, session-bound swap wire protocol (breaking), exact 1e-8 integer units, DoS bounds |
| `tl-relayer` | [#2](https://github.com/tradelayer-wallet/tl-relayer/pull/2) | Route auth, client-IP trust policy, SSRF fix, WS crash fixes |
| `tl-collator` | [#2](https://github.com/tradelayer-wallet/tl-collator/pull/2) | Single HTTP admission gate, client-IP resolver, rate limiting, canonical serializer |
| `TL-Extension` | [#3](https://github.com/tradelayer-wallet/TL-Extension/pull/3) | Transactional vault writes, PSBT/spend binding, popup sender check |
| `Ark-TradeLayer` | [#2](https://github.com/tradelayer-wallet/Ark-TradeLayer/pull/2) | Oracle attestation binding, registry keyed by announced R, fail-closed config |
| `tl-rpc` | [#2](https://github.com/tradelayer-wallet/tl-rpc/pull/2) | Single decode path, TLS allowlist, lossless JSON parser |
| `docs` | [#2](https://github.com/tradelayer-wallet/docs/pull/2) | Published checksums, `SECURITY.md`, removed third-party hotlink |
| `tl-explorer` | [#10](https://github.com/tradelayer-wallet/tl-explorer/pull/10) | API path-param validation, external link hardening, dev mock API fixes |
| `tradelayer-core` | [#3](https://github.com/tradelayer-wallet/tradelayer-core/pull/3) | Consensus-safety fixes for the protocol layer |
| `tradelayer-core` | [#4](https://github.com/tradelayer-wallet/tradelayer-core/pull/4) (draft) | Consensus follow-ups stacked on #3, questions for maintainers |

The earlier first-round review of `tradelayer-core` is public at <https://gist.github.com/llvm-x86/5aafd38f6d35cc28ff41821a6dbd1f23>.

## Questions for the maintainer

@patrickdugan: these are the ones only you can answer. The longer, repo-by-repo list is in the body of [tradelayer-core#4](https://github.com/tradelayer-wallet/tradelayer-core/pull/4).

1. **Core F2 activation.** Has a non-zero `BANKRUPTCY_PRICE` ever been written on mainnet, testnet, or a replayed dev chain? If yes the fix needs an activation height; if no, is a plain pre-launch fix acceptable?
2. **Core F1.** Can `CONTRACTDEX_RESERVE` / `initMargin` ever be negative?
3. **Core LEVERAGE == 0 in `takeMargin`.** Which guard do you want: reject at match time, skip the margin step, or something else?
4. **Private channel.** Where should the withheld consensus-dispatch findings go (email, Discord/Telegram, a private security advisory)? Private vulnerability reporting and issues are both disabled on `tradelayer-core`.
5. **Build and test environment** for `tradelayer-core` (Boost/BDB/depends, `make check`, functional tests), so the commits can be compile-verified.
6. **Swap legs.** Which property leg should each side commit for token-for-token and futures swaps? The wallet's seller guard refuses them until confirmed.
7. **Canonical repo.** Which repo is canonical for the product and for the docs/download pages? (This is also the first open question in [issue #6](https://github.com/patrickdugan/UTXO-Ref/issues/6).)
8. **Deployment facts:** the `TBILL` property id for the orderbook, whether `ip-api.com` over HTTP is acceptable, whether the public relayer should set `RELAYER_API_KEY`, and which service serves the explorer's `apiUrl`.

## What is intentionally not in this repo's scope

This document does not review the code in `UTXO-Ref` itself (the BitVM3 referee, DLC adaptor, watchtower). That has not been done by this work.
