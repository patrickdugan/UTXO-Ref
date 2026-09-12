# Bitcoin testnet4 on D:\

This is the active live-chain target for UTXORef testing.

## Local installation

- Bitcoin Core: `D:\Tools\BitcoinCore-31.1\bitcoin-31.1\bin`
- Data directory: `D:\BitcoinTestnet`
- Chain: `testnet4`
- RPC: `127.0.0.1:48332`
- Wallet: `utxoref-testnet`

The configuration uses cookie authentication and binds RPC only to localhost. Do not copy the `.cookie` value into scripts or artifacts.

## Start safely

Start offline first so chain and wallet identity can be checked before connecting:

```powershell
Start-Process `
  -FilePath 'D:\Tools\BitcoinCore-31.1\bitcoin-31.1\bin\bitcoind.exe' `
  -ArgumentList @('-datadir=D:\BitcoinTestnet', '-chain=testnet4', '-server=1', '-networkactive=0', '-listen=0') `
  -WindowStyle Hidden
```

Inspect and then enable networking:

```powershell
$cli = 'D:\Tools\BitcoinCore-31.1\bitcoin-31.1\bin\bitcoin-cli.exe'
& $cli -datadir=D:\BitcoinTestnet -chain=testnet4 getblockchaininfo
& $cli -datadir=D:\BitcoinTestnet -chain=testnet4 -rpcwallet=utxoref-testnet getwalletinfo
& $cli -datadir=D:\BitcoinTestnet -chain=testnet4 setnetworkactive true
```

## Read-only UTXORef smoke

```powershell
node bitvm3\utxo_referee\btc_testnet4_smoke.js
node bitvm3\utxo_referee\btc_testnet4_smoke.js --require-synced --json
```

With `--require-synced`, the smoke script requires chain identity and full header sync. It brackets wallet UTXO discovery with the chain tip and mempool sequence, confirms every selected coin through `gettxout`, and runs a logical UTXORef commitment/proof probe. The logical probe does not prove that a relayable Bitcoin transaction exists. The script does not create, sign, or broadcast a transaction.

## Red-team swarm stress

Run parallel verifier agents and concurrent live-UTXO freshness probes:

```powershell
node bitvm3\utxo_referee\btc_testnet4_stress.js `
  --agents=8 `
  --iterations=11000 `
  --rpc-probes=100 `
  --require-synced `
  --unsigned-mempool-probe
```

The unsigned policy lane creates raw candidates and checks them with `testmempoolaccept`; every candidate remains unsigned and nothing is broadcast. The optional `--signed-mempool-probe` creates and signs one self-spend candidate, checks it and parseable mutations, and discards every raw transaction without broadcasting. Use it only from a trusted coordinator. Add `--require-clean` when verifier violations should make the process fail.

## Agent isolation

Do not give untrusted swarm workers shell access to this data directory. Cookie RPC is unrestricted, and the current wallet contains unencrypted private keys. Run arbitrary agents behind an allowlisted read-only RPC proxy or against a separate walletless node owned by a dedicated Windows account. The included stress runner keeps mutation agents in worker threads and performs allowlisted RPC calls in its coordinator.

## Stop

```powershell
& $cli -datadir=D:\BitcoinTestnet -chain=testnet4 stop
```
