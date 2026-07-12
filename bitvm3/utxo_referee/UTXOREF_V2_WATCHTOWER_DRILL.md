# UTXORef V2 Watchtower And Fraud-Seizure Drill

## Roles

The watcher only consumes the public ceremony artifact. It verifies the
allowlisted state checkpoint, exact payout commitment, NUMS Taproot tree,
authorization height, and live assertion outpoint.

The VPS watcher should not hold a challenger secret in the normal operating
model. On a fraud finding it writes a challenge-sign request. A separately
administered local challenger signer reviews that request, signs the committed
disprove leaf, and returns the witness transaction for broadcast.

For a disposable testnet drill only, the watcher may receive a test challenger
secret through a root-readable environment file or a mounted file. Never use
that arrangement for live funds.

## Deployment Shape

```text
local Bitcoin Core RPC <- authenticated reverse tunnel -> VPS watcher
                                                        -> alert/request log
local challenger signer <- public challenge request ---/
```

The reverse tunnel keeps the node RPC bound to localhost. The local bridge
uses Core's rotating cookie and exposes only `getblockchaininfo`,
`getblockhash`, `gettxout`, and `testmempoolaccept`; it does not permit remote
broadcast or wallet RPC. The server receives only proxy credentials, never the
local Core cookie.

Install the standalone service from `deploy/` under `/opt/utxoref-v2-watchtower`
and store credentials in `/etc/utxoref-v2-watchtower.env` with mode `0600`.
The included `deploy/install_utxoref_v2_watchtower.sh` creates the service
account, state directory, environment file, and systemd unit but does not
enable the service until its RPC access has been configured.

On the local node, `deploy/start_utxoref_v2_watchtower_bridge.ps1` starts the
localhost-only method-filtering proxy, creates an SSH reverse tunnel, installs
the VPS environment file, and enables the service. It stores its generated
proxy credential and process IDs outside the repository under the Bitcoin
testnet key-backup directory.

## Local Smoke Check

Set temporary testnet RPC variables and run one public-only tick:

```powershell
$env:BTC_RPC_URL='http://127.0.0.1:48332'
$env:BTC_RPC_USER='<rpc-user>'
$env:BTC_RPC_PASS='<rpc-pass>'
node bitvm3\utxo_referee\utxoref_v2_watchtower.js --once
```

An honest live graph reports `monitoring` while its assertion is unspent, or
`assertion_spent` after its cooperative settlement. Neither result permits any
spend construction.

## Funded Fraud Drill

1. Stage a separate assertion with an intentional fraud mode. This does not
   broadcast or spend funds:

   ```powershell
   node bitvm3\utxo_referee\btc_testnet4_utxoref_v2_live.js --fraud-mode gate --artifact bitvm3\utxo_referee\artifacts\tmp\utxoref_v2_gate_drill.json
   ```

   Use `--fraud-mode input` to exercise the input-binding path instead.
2. Broadcast the assertion funding transaction and wait for one confirmation.
3. Run the VPS watcher without a secret. It must emit
   `challenge_signature_required` with the exact public evidence.
4. Review the request on the local challenger host and run the signer with the
   isolated test key. It must produce a disprove witness matching a committed
   leaf.
5. Use `testmempoolaccept`, broadcast the disprove, and confirm the challenger
   output reaches the expected destination.
6. Archive public txids, graph hash, leaf id, evidence hash, Core preflight,
   and confirmation height. Delete all test secret material from the server.

The funded drill is a release gate for a limited pilot, not a substitute for a
full external review or for the production watchtower controls in
`UTXOREF_V2_SECURITY_MODEL.md`.

## Live Gate-Fraud Drill

The gate path was funded and challenged on Bitcoin testnet4 on 2026-07-12:

- Assertion funding: [047c46864b5b0b3d634391323ab30e6af63fbd679dc56e2224ae7c93aba1a155](https://mempool.space/testnet4/tx/047c46864b5b0b3d634391323ab30e6af63fbd679dc56e2224ae7c93aba1a155)
- Immediate disprove: [5aefff774e67c6b95f9d8ba89437e96dbcf97bdd3bbe44d072479be0b8132750](https://mempool.space/testnet4/tx/5aefff774e67c6b95f9d8ba89437e96dbcf97bdd3bbe44d072479be0b8132750)
- Committed invalid row: `AND(1, 1) = 0`
- Committed leaf: `gate:0:11:0`
- Result: the 6,000-sat assertion paid 5,000 sats to the challenger with a
  1,000-sat fee, without waiting for the settlement CSV.

The public receipt is
`artifacts/live/btc_testnet4_utxoref_v2_gate_fraud_latest.json`.
