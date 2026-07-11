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

The reverse tunnel keeps the node RPC bound to localhost. The VPS must use a
dedicated, low-privilege RPC account; do not copy the local Core cookie to the
server.

Install the standalone service from `deploy/` under `/opt/utxoref-v2-watchtower`
and store credentials in `/etc/utxoref-v2-watchtower.env` with mode `0600`.

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
