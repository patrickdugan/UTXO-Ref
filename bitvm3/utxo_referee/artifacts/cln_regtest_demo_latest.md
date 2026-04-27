# Core Lightning Regtest Demo

Created: 2026-04-27T22:36:07Z

## Live Nodes

- Bitcoin: Bitcoin Core daemon version v29.0.0
- Core Lightning: v26.04.1
- Network: regtest
- Block height: 113
- Run directory: `/home/duganist/.local/utxoref-lightning/run/regtest-demo`

## Channel

- Alice id: `02fa3d24494a5710e2ef19b440fad62928c6fa4c2a5512561edb7ed6ffaad26416`
- Bob id: `0276d0c3a8d8d0c73005a023abd6d2a00d3cdfea92690abf99024eea3ab54da837`
- Alice funding txid: `ed2b7c869a0998cb1e334494bbd6262388e29179d99677f7978162e46c5c5681`
- Channel txid: `e93cfd911f1d4c67667b6b79bf58092e03d37ce02345a1497099cd14b8aa6f76`
- Channel state: CHANNELD_NORMAL
- Channel amount: 500000sat

## Payment Receipt

- Invoice amount: 25000msat
- Payment status: complete
- Payment hash: `80cbce547c20a26c4d2a8ab46eaf3b3ecbcff639f068f02276a01ef62d1a705a`
- Payment preimage: `cfc8c6a319f4b892dcbb4c5f84d81180634940f382f1b19c6c37d2c7f165f598`
- BOLT11: `lnbcrt250n1p57lex4sp5sr2sccfgryzxkgy7u2q6ax4696a2jaugv6ldfjl7s4h0dzzg4huqpp5sr9uu4ruyz3xcnf2326xatem8m9ula3e7p50qgnk5q00vtg6wpdqdpc2429sn6jv4nzqsnfw3ty6t6yf3pjqnrfva58gmnfdenjqun9vdjkjur5xqyjw5qcqp29qxpqysgq0pkq42z24vshqy7yhtn6hpngqfccm8nhl4tf4z7rnufn2u4qty9pg77s7ff6dp0qy4vxq9famy5sq3jdxxp0gwsjtpkwm62ly7a6s3sp7xt6h4`

## Useful Commands

```bash
source "/home/duganist/.local/utxoref-lightning/run/regtest-demo/env.sh"
lightning-cli --lightning-dir="/home/duganist/.local/utxoref-lightning/run/regtest-demo/alice" --network=regtest getinfo
lightning-cli --lightning-dir="/home/duganist/.local/utxoref-lightning/run/regtest-demo/alice" --network=regtest listpeerchannels
lightning-cli --lightning-dir="/home/duganist/.local/utxoref-lightning/run/regtest-demo/bob" --network=regtest listinvoices
```
