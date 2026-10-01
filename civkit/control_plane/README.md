# CivKit Control Plane

This module is the first backend foundation layer behind the marketplace runtime.

It gives the project:
- durable case records
- a persistent job queue
- an append-only audit log
- a sync path from Nostr thread state into operational backend state
- a signer daemon path that can consume queued settlement jobs
- a pluggable store layer for file JSON and local LevelDB backends

## Scope

- case status records keyed by trade thread
- persistent signer/broadcast/arbitration job records
- audit records for runtime sync activity
- job leasing, completion, and retry bookkeeping
- integration with `civkit/nostr_agent/runtime`

## Files

- `types.js`: case, job, and audit record types
- `store.js`: async store layer with file and LevelDB backends
- `workflow.js`: thread sync and control-plane job derivation
- `signer_daemon.js`: queued signer/broadcast worker for settlement jobs
- `rpc_broadcaster.js`: JSON-RPC client and broadcast adapter for live node submission
- `worker.js`: env-configured runtime entrypoint that syncs Nostr threads and runs the signer loop
- `test.js`: focused persistence and queue tests

## Design Notes

- The worker defaults to a local `leveldb` backend under `CIVKIT_CONTROL_DATA_DIR`, while `CIVKIT_CONTROL_STORE_BACKEND=file` keeps the older JSON-file path for compatibility and tests.
- `CIVKIT_CONTROL_STORE_BACKEND=postgres` switches the same runtime onto Postgres using `CIVKIT_CONTROL_POSTGRES_URL` and `CIVKIT_CONTROL_POSTGRES_SCHEMA`.
- Job leases are worker-owned through `CIVKIT_CONTROL_WORKER_ID`, so multiple workers sharing a queue do not anonymously complete each other's jobs.
- This is still a local-process control plane, not a distributed database.
- The next natural upgrade is replacing the local backends with Postgres and a real worker queue while preserving the same case and job semantics.
- The signer daemon still defaults to a dry-run broadcaster, but `rpc_broadcaster.js` can submit signed settlements through a Bitcoin or Litecoin JSON-RPC node.

## Runtime

Run the worker once:

```powershell
$env:CIVKIT_CONTROL_ONCE='1'
$env:CIVKIT_CONTROL_STORE_BACKEND='leveldb'
$env:CIVKIT_CONTROL_WORKER_ID='worker-a'
$env:CIVKIT_NOSTR_EVENTS_PATH='C:\path\to\events.jsonl'
$env:CIVKIT_BUYER_PRIVATE_KEY_HEX='...'
$env:CIVKIT_SELLER_PRIVATE_KEY_HEX='...'
$env:CIVKIT_NOTARY_PRIVATE_KEY_HEX='...'
node control_plane/worker.js
```

Use live RPC broadcast instead of dry-run:

```powershell
$env:CIVKIT_BROADCAST_MODE='rpc'
$env:CIVKIT_RPC_URL='http://127.0.0.1:19332'
$env:CIVKIT_RPC_USER='user'
$env:CIVKIT_RPC_PASS='pass'
$env:CIVKIT_RPC_WALLET='tl-wallet'
node control_plane/worker.js
```

Use Postgres for shared worker state:

```powershell
$env:CIVKIT_CONTROL_STORE_BACKEND='postgres'
$env:CIVKIT_CONTROL_POSTGRES_URL='postgres://user:pass@127.0.0.1:5432/civkit'
$env:CIVKIT_CONTROL_POSTGRES_SCHEMA='public'
$env:CIVKIT_CONTROL_WORKER_ID='worker-a'
node control_plane/worker.js
```
