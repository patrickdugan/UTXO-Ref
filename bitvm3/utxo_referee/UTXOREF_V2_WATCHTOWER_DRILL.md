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

## Live Fraud Drills

The gate path was funded and challenged on Bitcoin testnet4 on 2026-07-12:

- Assertion funding: [047c46864b5b0b3d634391323ab30e6af63fbd679dc56e2224ae7c93aba1a155](https://mempool.space/testnet4/tx/047c46864b5b0b3d634391323ab30e6af63fbd679dc56e2224ae7c93aba1a155)
- Immediate disprove: [5aefff774e67c6b95f9d8ba89437e96dbcf97bdd3bbe44d072479be0b8132750](https://mempool.space/testnet4/tx/5aefff774e67c6b95f9d8ba89437e96dbcf97bdd3bbe44d072479be0b8132750)
- Committed invalid row: `AND(1, 1) = 0`
- Committed leaf: `gate:0:11:0`
- Result: the 6,000-sat assertion paid 5,000 sats to the challenger with a
  1,000-sat fee, without waiting for the settlement CSV.
- Confirmation: funding and disprove confirmed together in block 143,851.

The public receipt is
`artifacts/live/btc_testnet4_utxoref_v2_gate_fraud_latest.json`.

The input-binding path was then exercised independently:

- Assertion funding: [12678731dcc0f815dc0545cbc00a1c023df65de62e2d3ddde6c1779178679f05](https://mempool.space/testnet4/tx/12678731dcc0f815dc0545cbc00a1c023df65de62e2d3ddde6c1779178679f05)
- Immediate disprove: [eef1e750eed567e4ec1e32955af9964433abd92c0a3d381ad7b3c4f77d3d078c](https://mempool.space/testnet4/tx/eef1e750eed567e4ec1e32955af9964433abd92c0a3d381ad7b3c4f77d3d078c)
- Committed expectation: `state_checkpoint_valid = 1`
- Revealed fraudulent input: `state_checkpoint_valid = 0`
- Committed leaf: `input:state_checkpoint_valid:0`
- Confirmation: funding and disprove confirmed together in block 143,852.

Its public receipt is
`artifacts/live/btc_testnet4_utxoref_v2_input_fraud_latest.json`.

## Fee And Reorg Policy

The challenger signer accepts a bounded fee ladder:

```text
--fee-sats 1000 --fee-step-sats 500 --max-fee-sats 5000
```

It advances to the next candidate only when Core reports a fee-policy
rejection. Script, input, or other semantic failures stop immediately. Every
candidate preserves at least the 330-sat challenge-output floor, and a policy
may contain at most 32 attempts.

After broadcast, the state file tracks the challenge txid and output. Using
only the filtered `gettxout` and `getblockhash` RPC methods, subsequent ticks
report `challenge_in_mempool`, `challenge_confirmed`,
`challenge_reconfirmed`, `challenge_reorged`, or
`challenge_output_spent_or_missing`. The two live challenge outputs resolve to
their recorded confirmation heights and block hashes through this path.

An unconfirmed challenge can be replaced explicitly by its separately
administered signer:

```text
--replace-challenge --broadcast --challenger-secret-file <path>
--fee-sats 1000 --fee-step-sats 500 --max-fee-sats 5000
```

The disprove input opts into BIP125 with sequence `0xfffffffd`. Replacement
keeps the assertion outpoint, committed fraud leaf, and challenge destination
unchanged. It selects only fees above the tracked fee and records each
superseded txid in the durable state. Because a conflicting replacement does
not have a useful independent `testmempoolaccept` preflight, this action is
restricted to the signer/broadcaster and records every RPC rejection. A
semantic rejection stops immediately; only fee-policy failures advance the
bounded ladder.

For a challenge paid to a wallet-owned native P2WPKH or P2TR output, the local
wallet signer can construct an exact one-input CPFP child:

```text
node utxoref_v2_challenge_cpfp.js --state-path <watchtower-state.json>
  --wallet <wallet-name> --fee-sats 1000 --broadcast
```

The child spends only the tracked challenge output, returns the remainder to
the same script, opts into replacement itself, and preserves at least 330
sats. Core must report that the parent is unconfirmed and exactly matches the
state amount and script before the wallet signs. The exact signed child is
then preflighted before optional broadcast; no wallet coin-selection RPC is
used, so unrelated inputs cannot be added.

A forced live RBF, CPFP, and reorg drill remains a separate release gate.
