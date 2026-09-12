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
and wallet ACLs plus a watch-only wallet. It also pins the signed Bitcoin Core
31.1 binaries and verifies the actual RPC listener is owned by that daemon and
bound only to loopback. `-TrustedCoordinator` permits a loaded
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
powershell -ExecutionPolicy Bypass -File eval\provision-testnet4-watchonly-wallet.ps1 -Audit
powershell -ExecutionPolicy Bypass -File eval\bitcoin-testnet4-host-preflight.ps1 -WalletName utxoref-swarm-watchonly -Json
```

`-Audit` is read-only and fails when the target wallet is absent, unloaded, or
would need a descriptor import. Compatibility capture uses this live audit and
does not trust the prior D-drive wallet evidence file.

The untrusted-agent gate also requires the dedicated worker identity and its
protected proxy token. Supply an account name or SID and the absolute token path:

```powershell
powershell -ExecutionPolicy Bypass -File eval\bitcoin-testnet4-host-preflight.ps1 `
  -WalletName utxoref-swarm-watchonly `
  -AgentIdentity BitAgentSwarm `
  -ProxyTokenFile D:\bitagent-testnet4\secrets\readonly-rpc.token `
  -Json
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
without signing or broadcasting. The proxy permits at most 120 authenticated
requests per minute, four concurrent requests, and 16 connected sockets:
The token is 64 lowercase hexadecimal characters and is re-read for every
request, so an atomic replacement rotates it and deletion revokes the proxy.
The token's parent directory must also be protected and non-writable by the
worker; rotation is performed by the trusted coordinator while preserving ACLs.

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

The DLC funding boundary separately requires
`validateFundingPrebroadcastPolicy`. It re-decodes the exact finalized funding
transaction and calls `testmempoolaccept` while the Core tip and mempool
sequence remain stable. Its signed receipt metadata must match the transaction
digest used by the `FUNDING_BROADCAST` transition. The check is read-only;
`sendrawtransaction` is absent and funding broadcast remains disabled.
The same rule applies to CET and refund transactions through
`validateExecutionPrebroadcastPolicy`. It locally checks the committed signed
settlement, binds the oracle-attestation or maturity evidence, and requires
Core to agree on transaction identity and serialized size metrics before the
execution-state receipt is accepted.
Every funding, CET, or refund prebroadcast result expires within 30 seconds.
The external broadcaster must call `DlcBroadcastAuthorizationStore.consume`
with the exact raw transaction and signed transition request immediately before
its host-owned send. The append-once consumption marker is written first, so
parallel workers cannot reuse the same authorization.
Adaptor-signing authorization consumption uses a separate append-once store.
Boundary V52 requires each `consumed.json` marker to remain a single-link,
bounded regular file with stable filesystem identity while it is opened. This
prevents a swarm worker from aliasing or swapping a durable replay marker at
the final signing boundary.
Boundary V53 extends identity-bound persistence to contract state, sealed
oracle events, peer negotiation sessions, and watchtower observations. Existing
records are published with no-replace semantics and cannot be accepted through
a hard link, symlink directory, oversized file, or raw contract-ID path alias.
Boundary V54 applies the same durable-record implementation to signer
authorization consumption, signed-refund recovery, and external broadcast
authorization. These one-shot records therefore cannot be replaced during
publication or accepted after parent-directory identity changes.
Boundary V55 additionally requires identity-bound native signer runtime reads.
Every executable and code file must have one filesystem link, and its opened
identity, path entry, and parent directory must remain stable while it is hashed.
Keep the pinned runtime closure read-only to the signer and coordinator accounts
because Windows still launches the executable by path after the hash completes.
Boundary V56 closes rename-based record substitution during durable reads and
publication. The store revalidates the final path against the opened descriptor
after reading and after fsync, and rejects record directories reached through a
symlink or junction.
Boundary V57 exposes external journal checkpoints for contract state, oracle
events, peer sessions, and watchtower observations. Persist each returned
checkpoint outside its journal directory and call the corresponding
`verifyCheckpoint` method before resuming after restart. A checkpoint stored
beside the journal cannot protect against rollback of that entire directory.
Boundary V58 includes the three one-shot records in this checkpoint workflow:
signing consumption, refund recovery, and broadcast consumption. Treat every
checkpoint as untrusted input until `normalizeJournalCheckpoint` or the store's
`verifyCheckpoint` method returns successfully.
Boundary V59 uses a single bounded canonical-data serializer for signed
receipts, peer transcripts, contract state, and durable records. It snapshots
only enumerable data properties on dense plain objects and arrays, deeply
freezes the result, and rejects accessors, symbols, sparse arrays, exotic
prototypes, cycles, negative zero, and oversized or over-deep input.
Boundary V60 also rejects JavaScript Proxy objects before any Proxy trap can
run. Canonical object and array encoding does not call inherited `toJSON`
methods, preventing prototype pollution elsewhere in a host process from
changing signed or hashed DLC data.
Boundary V61 supports operator-authenticated external checkpoints. Sign a
checkpoint with `signJournalCheckpoint`, retain only the trusted Ed25519 public
SPKI in the coordinator policy, and resume through the store's
`verifySignedCheckpoint` method. An unsigned checkpoint remains suitable only
when an independent boundary guarantees its integrity.
Boundary V62 additionally requires the expected value from
`signedJournalCheckpointHash` on every signed verification. Retain that 32-byte
hash in trusted monotonic coordinator state outside the checkpoint storage
domain. Replaying any other valid signed envelope then fails before the journal
can resume.
Boundary V63 rejects accessor-bearing and Proxy contract inputs before semantic
validation can execute callbacks. Durable contract reads are canonicalized and
deeply frozen before they leave the state store.
Boundary V64 retains the canonical contract snapshot across Bitcoin Core RPC
calls and watchtower publication. Never pass a caller-owned mutable record on
to a later policy or authorization step after validating it.
Boundary V65 also normalizes and deeply freezes validated transaction sets.
Core RPC callbacks cannot swap a funding outpoint, CET, refund, or fee policy
between commitment verification and the final observation or journal record.
Boundary V66 also snapshots raw transaction construction arguments before any
semantic field access. Getter-bearing and Proxy input fails without executing
attacker callbacks, including on nested funding and payout objects.
Boundary V67 applies descriptor snapshots to signer authorization creation and
consumption. The signed authorization is canonicalized and retained through
`execute()`, preventing a caller from changing its sighash or adaptor point
after the session is approved.
Boundary V68 applies the same callback-free input rule to provider and native
signer-client construction. Launch specifications, native capabilities, and
trusted audit keys are immutable snapshots; proxied or subclassed stores and unverified
implementations fail before any attacker-controlled property access.

## Agent isolation

Do not give untrusted swarm workers shell access to this data directory. Cookie RPC is unrestricted, and the current wallet contains unencrypted private keys. Run arbitrary agents behind an allowlisted read-only RPC proxy or against a separate walletless node owned by a dedicated Windows account. The included stress runner keeps mutation agents in worker threads and performs allowlisted RPC calls in its coordinator.

## Stop

```powershell
& $cli -datadir=D:\BitcoinTestnet -chain=testnet4 stop
```
