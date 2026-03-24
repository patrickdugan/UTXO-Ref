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
- `DLC_MIN_CONFIRMATIONS` set to `0` for smoke tests against live unconfirmed role UTXOs

Artifacts are written to:
- `bitvm3/utxo_referee/artifacts/`

## 6. Generate Funding PSBT + CET Skeletons

```powershell
node bitvm3/utxo_referee/m1_dlc_psbt_cet.js
```

Outputs:
- `bitvm3/utxo_referee/artifacts/m1_funding_psbt_latest.json`
- `bitvm3/utxo_referee/artifacts/m1_cet_skeletons_latest.json`

Current milestone-1 settlement mode:
- `flat`
- `pnl`
- `roll` as the non-interactive timeout default
- `dustCarrySats` as the explicit rounding remainder carried forward

## 7. Generate Oracle/Adaptor Wiring Placeholders

```powershell
node bitvm3/utxo_referee/m1_oracle_wiring.js
```

Output:
- `bitvm3/utxo_referee/artifacts/m1_oracle_wiring_latest.json`

This artifact binds oracle attestation placeholders to CET txids and provides
challenge-path evidence field stubs for the next integration phase.

## 8. Finalize and Broadcast Funding Transaction

```powershell
node bitvm3/utxo_referee/m1_dlc_sign_finalize.js
```

Output:
- `bitvm3/utxo_referee/artifacts/m1_funding_finalized_latest.json`

## 9. Select a Settlement Path and Emit Challenge Bundle

```powershell
$env:PATH_NAME="flat"
node bitvm3/utxo_referee/m1_select_bucket_bundle.js
```

Output:
- `bitvm3/utxo_referee/artifacts/m1_challenge_bundle_latest.json`

Expected behavior:
- If RPC is available, script prints chain/height probe.
- If RPC is missing, script falls back to deterministic mock txrefs.
- In both cases, it demonstrates:
`deposit -> receipt minted -> epoch root created`.

## 10. Emit Roll-Forward Handoff

This extracts the timeout/default path state and writes the next-epoch handoff
artifact that carries `dustCarrySats` forward.

```powershell
node bitvm3/utxo_referee/m1_roll_forward.js
```

Output:
- `bitvm3/utxo_referee/artifacts/m1_roll_forward_latest.json`

The roll-forward artifact records:
- current funding txid
- timeout locktime
- inherited collateral
- inherited dust carry
- next epoch id

## Smoke Sequence

Run these in order for the live LTCTEST smoke test:

1. `m1_ltc_wallet_provision.ps1`
2. `m1_dlc_bootstrap.js`
3. `m1_dlc_psbt_cet.js`
4. `m1_oracle_wiring.js`
5. `PATH_NAME=flat node bitvm3/utxo_referee/m1_select_bucket_bundle.js`
6. `PATH_NAME=roll node bitvm3/utxo_referee/m1_select_bucket_bundle.js`
7. `m1_dlc_sign_finalize.js`
8. `m1_roll_forward.js`
