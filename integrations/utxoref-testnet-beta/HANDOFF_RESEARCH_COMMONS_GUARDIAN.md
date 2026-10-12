# Handoff: bring the `research-commons-independent` guardian back online

Written 2026-10-12 for a Claude agent on Patrick's **old PC**, which probably ran
this guardian. Read all of it before running anything.

## Where things stand

- The testnet4 node, the beta service and the bridge RPC proxy now run on
  Patrick's **new PC**. The public beta `https://api.layerwallet.com/utxoref-beta/`
  reaches it through reverse SSH tunnels from the new PC to the VPS
  (`172.81.181.19`, LunaNode VM `orderbook`): VPS `127.0.0.1:8793` → beta and
  VPS `127.0.0.1:48332` → bridge proxy.
- On the VPS, the V2 watchtower runs `main` (`0b32bfc`) and the guardian
  `orderbook-independent` heartbeats every 60 s and is fresh.
- `artifacts/guardian_registry_testnet4.json` pins two guardians with a quorum of
  **2**. The second one is silent, so the public status reports
  `guardians.fresh: 1`, `quorumHealthy: false`:

  | Field | Value |
  |---|---|
  | label | `research-commons-independent` |
  | guardianId | `e0e53a7d87a6da57b8142c1e` |
  | guardianXonly | `1b3e7a404ebd38d97d2914e44877428b97b1bbb338a77740720ae2eb1b704bb0` |
  | graphHash | `34dfe4a3d05264fa54cd6d99e9a07ac784c22f3011b7704847337a0543d02eee` |

The job: find this guardian's **existing** keys on the old PC and keep its
heartbeat agent running against the public beta.

## Do not, on the old PC

- **Do not run `bitvm3/utxo_referee/deploy/start_utxoref_v2_watchtower_bridge.ps1`.**
  It rewrites `/etc/utxoref-v2-watchtower.env` on the VPS with the old proxy
  credentials and tries to open tunnels on VPS ports the new PC now holds. That
  breaks the watchtower.
- **Do not start the old beta service, testnet node tunnel or bridge proxy.**
  They now live on the new PC.
- **Do not run `guardianAgent.py init`.** New keys would not match the registry
  or the guardian custody reserve (`artifacts/guardian_quorum_reserve_testnet4.json`
  commits to the existing secp256k1 key). Replacing a guardian key is a
  decision for Patrick: it needs a new registry entry and a re-issued reserve.
- Do not copy `heartbeat_ed25519.pem` or `guardian_secp256k1.hex` anywhere,
  print them, or commit them.

## Steps

1. **Find the state directory.** It holds `identity.json`,
   `heartbeat_ed25519.pem`, `guardian_secp256k1.hex`, `sequence.json` and
   `latest_receipt.json`. Search for an `identity.json` containing the guardianId:

   ```powershell
   Get-PSDrive -PSProvider FileSystem | ForEach-Object { Get-ChildItem -Path $_.Root -Recurse -Filter identity.json -ErrorAction SilentlyContinue } | Select-String -SimpleMatch 'e0e53a7d87a6da57b8142c1e' -List | Select-Object Path
   ```

   Likely places: `D:\BitcoinTestnet\key-backups\…`, a UTXO-Ref checkout's
   `integrations/utxoref-testnet-beta/runtime/`, the user profile, or a WSL
   distro (`wsl -l -v`, then search `/var/lib`, `/home`, `/root`). Also look for
   how it ran before, and reuse that: Task Scheduler entries mentioning
   `guardianAgent`, or a WSL systemd unit like `utxoref-beta-guardian.service`.

2. **Check it is the right identity.** `identity.json` must show the
   `guardianId`, `label` and `guardianXonly` from the table, and both private
   key files must exist. If nothing matches, **stop and report to Patrick**; do
   not generate new keys.

3. **Prepare the code.** In a UTXO-Ref checkout, `git fetch` and check out
   `main`. Python 3 with the `cryptography` package is the only dependency
   (`python -m pip install cryptography` if `import cryptography` fails).

4. **Send one heartbeat.**

   ```powershell
   python integrations\utxoref-testnet-beta\guardianAgent.py once --state-dir <STATE_DIR> --base-url https://api.layerwallet.com/utxoref-beta --graph-hash 34dfe4a3d05264fa54cd6d99e9a07ac784c22f3011b7704847337a0543d02eee
   ```

   Expect a receipt with `"accepted": true`. The beta on the new PC started
   with an empty heartbeat history, so any sequence number is accepted.
   - `unknown_guardian` or `guardian_identity_mismatch`: wrong state dir.
   - `stale_guardian_heartbeat`: fix the PC clock.
   - HTTP 5xx: the new PC or tunnel is down. Retry later; don't change anything.

5. **Keep it running.** Use `run` with the same arguments plus `--interval 60`,
   under whatever ran it before. Otherwise use a Task Scheduler task that starts
   at logon and restarts on failure, or a WSL systemd service modelled on
   `deploy/utxoref-beta-guardian.service`. The agent retries on its own after
   errors, so one long-running process is enough.

6. **Verify from outside.**

   ```powershell
   (Invoke-RestMethod https://api.layerwallet.com/utxoref-beta/v1/beta/status).guardians | ConvertTo-Json -Depth 3
   ```

   Done when both guardians show `fresh: true` and `quorumHealthy: true`.

7. **Report back to Patrick:** where the state dir was, how it now runs, and
   the status output. Do not commit anything from the state dir.
