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

Before allowing untrusted swarm workers on the host, run the fail-closed host
preflight. Its default mode requires restricted datadir, cookie, configuration,
and wallet ACLs plus a watch-only wallet. `-TrustedCoordinator` permits a loaded
private-key wallet for a read-only coordinator check, but is not an agent-sandbox
claim:

```powershell
powershell -ExecutionPolicy Bypass -File eval\bitcoin-testnet4-host-preflight.ps1 -Json
powershell -ExecutionPolicy Bypass -File eval\bitcoin-testnet4-host-preflight.ps1 -TrustedCoordinator -Json
```

Create the separate swarm wallet with an inspection-only run followed by the
explicit apply run. It imports public descriptors, disables private keys, waits
for the rescan, and requires exact confirmed-UTXO parity at a stable tip:

```powershell
powershell -ExecutionPolicy Bypass -File eval\provision-testnet4-watchonly-wallet.ps1
powershell -ExecutionPolicy Bypass -File eval\provision-testnet4-watchonly-wallet.ps1 -Apply
powershell -ExecutionPolicy Bypass -File eval\bitcoin-testnet4-host-preflight.ps1 -WalletName utxoref-swarm-watchonly -Json
```

The backup-first ACL tool prints its target set without changing it unless
`-Apply` is present. Review the dry run and keep the emitted `icacls` backup:

```powershell
powershell -ExecutionPolicy Bypass -File eval\lockdown-bitcoin-testnet4-acl.ps1
powershell -ExecutionPolicy Bypass -File eval\lockdown-bitcoin-testnet4-acl.ps1 -Apply
```

After the host ACL and account separation preflight passes, expose Core to swarm
workers only through `btc_testnet4_readonly_rpc_proxy.js`. The proxy token must be
stored in a bounded regular file readable by the worker account; the Core cookie
remains readable only by the trusted coordinator. Verify the live deny boundary
without signing or broadcasting:

```powershell
node eval\bitcoin-testnet4-readonly-rpc-probe.js
```

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
