# Pure BitVM Meets Lightning Showcase

Created: 2026-04-27

## What Is Live Now

This package separates the Bitcoin testnet4 proof path from the Lightning receipt path.

- Bitcoin testnet4 is synced locally at `D:\BitcoinTestnet`.
- Wallet `utxoref-testnet` currently has `0.00208008 BTC` testnet spendable.
- Core Lightning regtest Alice/Bob nodes are running in WSL.
- Alice opened a channel to Bob and paid a Bob BOLT11 invoice.
- The dashboard is deployed at `https://lightningutxref.vercel.app/dashboard`.

## Bitcoin Testnet4 Evidence

Journey entry, not the BitVM showcase:

- `bf3694aaf87eda0df0230e421775be6d5c0ee40b1e701aadbc7a61417682c0c0`
- Explorer: `https://mempool.space/testnet4/tx/bf3694aaf87eda0df0230e421775be6d5c0ee40b1e701aadbc7a61417682c0c0`
- Role: staged submarine swap HTLC funding output.
- HTLC address: `tb1q30j7htje6q2nm006y89mujlhywnp4xs3mp8g5th2yzha4k8dqm5q3plwxm`
- Amount: `25000 sats`
- Payment hash: `366161841ab76122518ed383bc37b22d61d7ca9eb3ee122fc2aacc656c8617c3`
- CLTV expiry height: `132857`
- Supersedes earlier marker tx: `58ff891cf904aaa6b85f8f34e20637d8b6ef7fbc7baa2cfeff41fd9bf6481d7f`

BitVM showcase anchor path:

- `9fac61dba0503ed228c75bceb436698946107c698d4db0bd389d11a93aeadebb`
- Explorer: `https://mempool.space/testnet4/tx/9fac61dba0503ed228c75bceb436698946107c698d4db0bd389d11a93aeadebb`
- Role: TAP/circuit anchor path for the router enforcement model.

Off-chain proof rows:

- `ln-route-commitment`
- `ark-vtxo-commitment`
- `bitvm-router-circuit`

## Lightning Receipt

Fresh Core Lightning local route:

- Network: `regtest`
- Alice node: `02fa3d24494a5710e2ef19b440fad62928c6fa4c2a5512561edb7ed6ffaad26416`
- Bob node: `0276d0c3a8d8d0c73005a023abd6d2a00d3cdfea92690abf99024eea3ab54da837`
- Channel txid: `e93cfd911f1d4c67667b6b79bf58092e03d37ce02345a1497099cd14b8aa6f76`
- Channel amount: `500000sat`
- Channel state: `CHANNELD_NORMAL`
- Invoice amount: `25000msat`
- Payment status: `complete`
- Payment hash: `80cbce547c20a26c4d2a8ab46eaf3b3ecbcff639f068f02276a01ef62d1a705a`
- Payment preimage: `cfc8c6a319f4b892dcbb4c5f84d81180634940f382f1b19c6c37d2c7f165f598`

BOLT11:

```text
lnbcrt250n1p57lex4sp5sr2sccfgryzxkgy7u2q6ax4696a2jaugv6ldfjl7s4h0dzzg4huqpp5sr9uu4ruyz3xcnf2326xatem8m9ula3e7p50qgnk5q00vtg6wpdqdpc2429sn6jv4nzqsnfw3ty6t6yf3pjqnrfva58gmnfdenjqun9vdjkjur5xqyjw5qcqp29qxpqysgq0pkq42z24vshqy7yhtn6hpngqfccm8nhl4tf4z7rnufn2u4qty9pg77s7ff6dp0qy4vxq9famy5sq3jdxxp0gwsjtpkwm62ly7a6s3sp7xt6h4
```

Full receipt artifacts:

- `bitvm3/utxo_referee/artifacts/cln_regtest_demo_latest.json`
- `bitvm3/utxo_referee/artifacts/cln_regtest_demo_latest.md`

## Live Inspection Commands

```bash
source "/home/duganist/.local/utxoref-lightning/run/regtest-demo/env.sh"
lightning-cli --lightning-dir="/home/duganist/.local/utxoref-lightning/run/regtest-demo/alice" --network=regtest listpeerchannels
lightning-cli --lightning-dir="/home/duganist/.local/utxoref-lightning/run/regtest-demo/bob" --network=regtest listinvoices
```

From PowerShell:

```powershell
wsl -d Ubuntu --exec /usr/bin/env LD_LIBRARY_PATH=/home/duganist/.local/utxoref-lightning/lib /home/duganist/.local/utxoref-lightning/bin/lightning-cli --lightning-dir=/home/duganist/.local/utxoref-lightning/run/regtest-demo/alice --network=regtest listpeerchannels
```

## What Remains For A Real Testnet4 LN Route

The same-machine Bitcoin testnet4 node is ready, but the Lightning daemon is not installed/configured on Windows for testnet4 yet.

Minimum next setup:

- Install LND or run Core Lightning testnet4 in WSL.
- Restart Bitcoin Core testnet4 with ZMQ notifications enabled.
- Fund two small channels around `80k-100k sats` each.
- Route one invoice through the router node.
- Bind that invoice hash/preimage to the existing `bitvm-router-circuit` proof object in the dashboard.

Recommended extra funding: another `100k sats` testnet, giving roughly `308k sats` total. That is enough for two small channels plus retry/fee reserve.
