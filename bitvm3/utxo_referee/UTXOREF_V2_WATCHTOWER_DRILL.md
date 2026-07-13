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
node utxoref_v2_challenge_cpfp.js --artifact <public-artifact.json>
  --trust-policy <externally-pinned-policy.json>
  --state-path <watchtower-state.json> --wallet <wallet-name>
  --fee-sats 1000 --broadcast
```

The child spends only the tracked challenge output, returns the remainder to
the same script, opts into replacement itself, and preserves at least 330
sats. Core must report that the parent is unconfirmed and exactly matches the
state amount and script before the wallet signs. The exact signed child is
then preflighted before optional broadcast; no wallet coin-selection RPC is
used, so unrelated inputs cannot be added.

The child also opts into BIP125. `--replace-child` rebuilds the same exact
parent spend at a strictly higher fee, verifies the prior child is replaceable
and the raw parent still matches the tracked amount and script, then records
the superseded child in durable history.

For a graph policy with a confirmed Taproot fee reserve, the separated
guardian flow can instead construct an exact two-input CPFP. The guardian signs
the transaction and approval metadata without receiving the challenger key;
the finalizer lets the wallet sign only the challenge input and uses the
guardian/challenger reserve leaf for input 1. The combined value returns to the
unchanged challenge script.

```text
node utxoref_v2_fee_reserve_guardian.js ... --fee-sats 4000 --output approval.json
node utxoref_v2_reserve_cpfp.js ... --fee-sats 4000
  --guardian-approval approval.json --challenger-secret-file challenger.hex
  --wallet <wallet-name> --broadcast
```

`utxoref_v2_reserve_cpfp_drill.js` validates the initial spend, fresh guardian
approval, partial wallet signing, tapscript witness, higher-fee replacement,
mempool conflict winner, confirmation, and reserve lifecycle against isolated
Bitcoin Core. See `UTXOREF_V2_RESERVE_CPFP.md` for the exact transaction and
2026-07-13 drill receipt summary.

`utxoref_v2_reorg_drill.js` exercises the lifecycle against an isolated Core
regtest node. It refuses testnet and mainnet, observes a real wallet output in
the mempool and a mined block, invalidates only that newly mined block, then
requires reorg-to-mempool and reconfirmation states. This is the reproducible
reorg release drill; public testnet4 is never invalidated.

The drill passed against Bitcoin Core 31.0 on 2026-07-12. The transaction was
first confirmed at height 102 in block
`229347ed563c203a2756e971eb83d60dfded78927140d790e0b11fcf00c70b08`,
returned to the mempool after invalidation, and reconfirmed at the same height
in distinct block
`3f5f08f1851cc87176442ee117b6e20480aa9d5ed5f8eb8180270455d3679aa1`.
The secret-free receipt is
`artifacts/live/utxoref_v2_regtest_reorg_latest.json`.

The funded live testnet4 RBF and CPFP conflict drill is recorded below.

## Live Fee-Rescue Drill

The funded RBF and CPFP paths were exercised together on Bitcoin testnet4 on
2026-07-12:

- Funding assertion: `389307d5195a1fcf8854d469f34b162afc3603fea4b15ac3319df1d224851469`
- Superseded 500-sat challenge: `afaa8ddfea8d07f2a831257a9cf5cdab6e5595a57fbe9644a0a726e933b8ceec`
- 1,000-sat replacement: `96f52e7120f3ce53e349e9aa51fcf8b1ae36dfc5f5da4b51f3a9a5ff9b8a0482`
- Confirmed 500-sat CPFP child: `0a4233b97346525188e99f5214e700be0d69b0ffbeb6756f689027afb86b970d`
- Conflicted 2,000-sat CPFP replacement: `5a37264a3becf0fa11872ae5087aa44493518c585322438bfad8da9dda33ce92`

The local node accepted the 2,000-sat child replacement, but another relay
partition retained the original child. The original 500-sat child won and
confirmed with funding and the challenge in block 143,874, while the local
replacement became conflicted with `-5` wallet confirmations. The confirmed
package pays 2,500 sats across 455 virtual bytes, approximately 5.49 sat/vB.
The watcher now searches replacement history, restores the confirmed winner,
and records the losing local replacement as conflict evidence.

The secret-free receipt is
`artifacts/live/btc_testnet4_utxoref_v2_fee_rescue_latest.json`. Its status and
confirmation fields report only what Core has actually observed.

The next public block reorganized the artifact's authorization height 143,872.
The watcher distinguishes authorization from observation: an orphaned
authorization block cannot authorize construction or replacement of a
challenge, but an already tracked challenge for the same graph remains
observable in monitoring-only mode. This preserves reorg visibility without
turning an orphaned state reference into fresh spending authority.

The standalone service receives the artifact and trust policy as separate
files. Installation refuses to proceed without the policy; replacing a public
artifact cannot add a signer or graph to that policy.

## Reserve And Quorum Gates

An allowlisted graph may now pin an exact `feeReserve.reserveHash` and
`minimumFeeReserveSats` in its trust-policy entry. Such a graph requires
`--fee-reserve <manifest.json>` while its assertion is unspent. The watcher
checks the graph-bound Taproot script, live UTXO amount, confirmation-derived
funding height, and remaining CSV horizon before granting new challenge
authority.

Each watcher can emit an Ed25519 observation receipt by supplying a watcher
id, policy fault domain, coordinator round id, and isolated private-key file.
`utxoref_v2_watcher_quorum.js` accepts a threshold only when all receipts bind
the same round and chain statement and meet the configured independent-domain
count. See `UTXOREF_V2_PACKAGE_RESERVE_QUORUM.md` for the package-policy drill,
limitations, and benchmark evidence.
