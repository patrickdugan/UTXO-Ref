# Litecoin Testnet Setup (Milestone 1 Demo)

This setup is optional. The milestone-1 demo can run in mock mode without RPC.

## 1. Configure Litecoin Core

Example `litecoin.conf`:

```ini
testnet=1
server=1
txindex=1
rpcuser=rpcuser
rpcpassword=rpcpass
rpcallowip=127.0.0.1
rpcbind=127.0.0.1
rpcport=19332
```

Start daemon:

```powershell
litecoind -daemon -testnet
```

## 2. Export RPC Environment Variables

```powershell
$env:LTC_RPC_URL="http://127.0.0.1:19332"
$env:LTC_RPC_USER="rpcuser"
$env:LTC_RPC_PASS="rpcpass"
```

## 3. Run Milestone-1 Demo

```powershell
node bitvm3/utxo_referee/m1_ltc_testnet_demo.js
```

## 4. Provision Segregated Role Addresses

This provisions fresh `operator`, `oracle`, `alice`, `bob`, and `residual` addresses
in `tl-wallet` and funds them from `tl`.

```powershell
powershell -File bitvm3/utxo_referee/m1_ltc_wallet_provision.ps1 `
  -RpcUrl "http://127.0.0.1:19332" `
  -RpcUser "user" `
  -RpcPass "pass" `
  -SourceWallet "tl" `
  -DestinationWallet "tl-wallet"
```

The script prints JSON containing the generated addresses, funding txid, and wallet balances.
Use `-CreateOnly` to generate segregated addresses without funding.

## 5. Bootstrap a DLC Draft from Live Wallet State

This discovers the latest full role set in the destination wallet and emits a
deterministic JSON DLC draft artifact with selected funding UTXOs.

```powershell
node bitvm3/utxo_referee/m1_dlc_bootstrap.js
```

Optional env overrides:
- `LTC_RPC_URL`
- `LTC_RPC_USER`
- `LTC_RPC_PASS`
- `LTC_WALLET`
- `DLC_EPOCH_ID`
- `DLC_MATURITY_BLOCKS`
- `DLC_REFUND_DELAY_BLOCKS`

Artifacts are written to:
- `bitvm3/utxo_referee/artifacts/`

Expected behavior:
- If RPC is available, script prints chain/height probe.
- If RPC is missing, script falls back to deterministic mock txrefs.
- In both cases, it demonstrates:
`deposit -> receipt minted -> epoch root created`.
