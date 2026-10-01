# Lightning Local Testnet Demo

This runner documents the Lightning integration prototypes against whatever
local testnet services are reachable. It is safe by default: it probes daemons,
generates deterministic transcript artifacts, and does not broadcast funding
transactions.

## Run

```powershell
node bitvm3/utxo_referee/lightning_live_testnet_demo.js
```

Outputs:

- `bitvm3/utxo_referee/artifacts/lightning_live_testnet_demo_latest.json`
- `bitvm3/utxo_referee/artifacts/lightning_live_testnet_demo_latest.md`

## Chain RPC

Defaults use Litecoin testnet:

```powershell
$env:BITVM_CHAIN="litecoin-testnet"
$env:BITVM_RPC_URL="http://127.0.0.1:19332"
$env:BITVM_RPC_USER="user"
$env:BITVM_RPC_PASS="pass"
$env:BITVM_WALLET="tl-wallet"
```

Bitcoin testnet is also supported:

```powershell
$env:BITVM_CHAIN="bitcoin-testnet"
$env:BITVM_RPC_URL="http://127.0.0.1:18332"
```

The runner calls `getblockchaininfo`, `listwallets`, and `getwalletinfo` for
the configured wallet.

## Lightning

The runner probes:

- `lncli --network=testnet getinfo`
- `lightning-cli --testnet getinfo`

By default it does not create invoices. To create a live invoice when one of
those CLIs is configured:

```powershell
$env:LIVE_DEMO_CREATE_LN_INVOICE="1"
node bitvm3/utxo_referee/lightning_live_testnet_demo.js
```

## M1 Chain Replay

To also run the existing M1 chain demo and replay pipeline after RPC is live:

```powershell
$env:LIVE_DEMO_RUN_M1="1"
node bitvm3/utxo_referee/lightning_live_testnet_demo.js
```

The pipeline replay uses `M1_BROADCAST_FUNDING=0`.

## Interpreting The Report

The Markdown report labels each section as:

- `live`: a local daemon or CLI was reachable
- `warming`: a local chain RPC port is reachable, but Core is still returning
  `Loading block index...`
- `busy`: a local chain RPC port is reachable, but the request timed out while
  Core was doing startup/sync/index work
- `skipped`: an optional live step was not requested or a dependency was absent
- `unavailable`: the configured daemon endpoint was not reachable
- `ok`: deterministic transcript checks passed

This lets the same artifact serve two purposes: grant-review documentation now,
and a live testnet transcript once the local daemons are running.
