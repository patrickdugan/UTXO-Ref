# UTXORef Testnet Beta

Invite-gated Bitcoin testnet4 console for a real UTXORef referee graph, a bounded test-sat faucet, and repeatable graph-verification stress runs.

The service deliberately has no generic wallet or RPC endpoint. Faucet signing remains inside the local Bitcoin Core wallet. Invite tokens are stored only as hashes, requester IPs are stored as salted hashes, and every claim is written to disk before Bitcoin Core is asked to broadcast. Destination addresses remain in receipts because they become public when a claim is broadcast.

## Beta surface

- `GET /healthz`: process liveness only.
- `GET /v1/beta/status`: chain sync, strict graph verification, assertion outpoint, and faucet budget.
- `POST /v1/faucet/claim`: one fixed-size native SegWit or Taproot claim.
- `POST /v1/stress/verify`: bounded worker-thread referee verification with a durable receipt.
- `GET /v1/runs/:runId`: retrieve one stress receipt by id.

The checked-in graph is `btc_testnet4_utxoref_v2_latest.json`, governed by `utxoref_v2_watchtower_trust_policy.json`. The current graph may already be settled; status reports that state and still verifies its signed graph and commitment package.

## Local run

Requirements:

- Node.js 20 or newer.
- Bitcoin Core 30.x on `testnet4`, fully synced.
- Loaded wallet `utxoref-testnet` with enough test sats above the configured reserve floor.
- Cookie auth under `BTCTEST_DATADIR`, or explicit `BTC_RPC_USER` and `BTC_RPC_PASS`.

On this Windows workstation the defaults use `D:\BitcoinTestnet` and RPC port `48332`:

```powershell
cd C:\projects\UTXORef\UTXO-Ref\integrations\utxoref-testnet-beta
npm test
npm start
```

Open `http://127.0.0.1:8790`. Generate an invitation in another terminal:

```powershell
npm run invite -- --label reviewer-01 --max-claims 1 --max-stress-runs 10 --expires-at 2026-07-21T00:00:00Z
```

Only the generated bearer token is shared with that invitee. The plaintext token is never written to the journal.

## Faucet safety

Default policy:

- 1,000 sats per claim.
- 250,000-sat wallet reserve floor plus a 1,000-sat fee buffer.
- 50,000 sats per UTC day.
- One claim per source IP per UTC day and one lifetime claim per destination.
- One claim per invitation unless the operator explicitly raises it.
- Native SegWit v0 or Taproot destinations only.

The journal statuses are `sending`, `broadcast`, `broadcast_unknown`, and `not_broadcast`. An RPC timeout after submission is never retried automatically. Reconcile it against wallet history:

```powershell
npm run reconcile -- --claim 0123456789abcdef01234567
```

If no matching wallet transaction exists and node/wallet health has been checked, release the reservation explicitly:

```powershell
npm run reconcile -- --claim 0123456789abcdef01234567 --mark-not-broadcast
```

## Stress tests

Browser stress runs use worker threads, are persisted before execution, and are limited per invitation and across the service. An external status/load receipt can be generated with:

```powershell
npm run load -- --requests 500 --concurrency 25 --mode status
```

For verifier load, raise `BETA_POSTS_PER_MINUTE` only in a controlled operator session:

```powershell
$env:BETA_INVITE_TOKEN='ubeta_...'
npm run load -- --requests 10 --concurrency 2 --mode verify --iterations 5
```

Receipts are written under ignored `runtime/`; publish selected receipts only after reviewing them.

The sanitized local acceptance run is checked in at `artifacts/testnet4_acceptance_2026-07-14.json`. It binds the live faucet txid, graph hash, 500-request status load, and status responsiveness during a worker verification run without including an invitation or RPC secret.

## Public deployment

Keep both this service and Bitcoin Core RPC on loopback. Put TLS and request limits in a reverse proxy. `deploy/Caddyfile.example` and `deploy/utxoref-testnet-beta.service` are starting templates; update the hostname, repository path, service account, and Bitcoin datadir.

1. Create a dedicated unprivileged `utxoref-beta` account and `/var/lib/utxoref-beta` owned by it.
2. Install the repository read-only under `/opt/utxoref/UTXO-Ref`.
3. Install `.env.example` as mode `0600` at `/etc/utxoref-beta.env`.
4. Set `BETA_PUBLIC_ORIGIN` to the exact HTTPS origin and enable `BETA_TRUST_PROXY=1` only when direct access to port `8790` is blocked.
5. Start Core, load the faucet wallet, start the service, then verify `/v1/beta/status` reports `betaReady: true`.
6. Run the 500-request status test and one self-claim before issuing invitations.

Do not deploy the service on a stateless platform: the faucet requires local Core RPC and a durable claim journal. Back up the state file; it is required for idempotency and abuse limits, but it contains no invite plaintext or wallet keys.
