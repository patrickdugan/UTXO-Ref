# Bitcoin Testnet Staging Frame

The dashboard should not depend on a named alternate testnet in its public framing. The current sidecar substrate is modular: it can be backed by a local testnet harness now and by Bitcoin testnet once the node profile is wired.

## Target Shape

```text
Bitcoin testnet pruned node
  -> LND / LDK Node wallet profile
  -> wallet-demo sidecar
  -> normalized adapter feed
  -> network map dashboard
```

## Pruned Node Requirements

- Bitcoin Core testnet or signet.
- Pruned mode enabled.
- RPC credentials available to the sidecar.
- Wallet or descriptor setup for test funding.
- LND or LDK Node connected to the same chain backend.

## Local Node

The local Bitcoin Core node can use Bitcoin Core's default datadir, or a local override through `BTCTEST_DATADIR`.

```powershell
.\integrations\wallet-demo\start_bitcoin_testnet4.ps1
```

Useful direct probes:

```powershell
bitcoin-cli -chain=testnet4 getblockchaininfo
bitcoin-cli -chain=testnet4 getnetworkinfo

# Optional local override:
$env:BTCTEST_DATADIR="<local-testnet-dir>"
bitcoin-cli -datadir=$env:BTCTEST_DATADIR -chain=testnet4 getblockchaininfo
```

Current local RPC shape:

- Data dir: Bitcoin Core default, unless `BTCTEST_DATADIR` is set locally
- Chain data dir: `<datadir>\testnet4`
- RPC: `http://127.0.0.1:48332`
- P2P: `48333`
- Prune target: `2000 MiB`

## Demo Transaction Anchor

Create or load the `utxoref-testnet` wallet, fund the printed address from a Bitcoin testnet4 faucet, then broadcast the demo anchor:

```powershell
.\integrations\wallet-demo\run_bitcoin_testnet4_demo_txs.ps1
```

When the wallet is unfunded the script exits with a JSON funding prompt that includes the receive address, testnet4 explorer link, and faucet links. Once funded, it broadcasts a small testnet4 transaction with an OP_RETURN marker:

```text
UTXORef LN-BTC BitVM liquidity demo
```

The script prints the resulting mempool.space testnet4 transaction URL for the email/demo packet.

## Sidecar Profile

The sidecar already has a Bitcoin testnet LND profile shape. The public dashboard should keep saying `modular testnet` until this path is live.

Expected environment shape:

```powershell
$env:WALLET_DEMO_PROFILE="bitcoin-testnet-lnd"
$env:BTC_RPC_URL="http://127.0.0.1:48332"
$env:BTC_WALLET="utxoref-testnet"
$env:LND_GRPC_HOST="127.0.0.1:10009"
$env:LND_REST_URL="https://127.0.0.1:8080"
$env:LND_MACAROON_PATH="C:\path\to\admin.macaroon"
$env:LND_TLS_CERT_PATH="C:\path\to\tls.cert"
node integrations\lightning-liquidity-lease-sidecar\server.js
```

## Acceptance Criteria

- Dashboard first viewport remains the network map.
- The chain badge reports Bitcoin testnet or signet only after the profile is actually live.
- The adapter feed continues to work in fixture mode while the wallet node is wired.
- No public-facing copy implies the substrate is fixed to a specific non-Bitcoin testnet.
