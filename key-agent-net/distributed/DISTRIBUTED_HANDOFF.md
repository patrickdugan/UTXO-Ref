# KeyAgentNet v0.1: distributed signing handoff

Branch `research/keyagentnet-distributed-v01`, based on `research/keyagentnet-regtest-v0` at `a959c0f` (PR #12). Implementation commit: `74454019376078e5ce6867d6b5fb26fc0fa1408e`.

KeyAgentNet v0 ran every signer inside one Core process. v0.1 moves Custodian A to a separate Linux VPS with its own key, policy validator and journal, and drives a 2-of-3 regtest vault from a Windows coordinator across the network. Everything is regtest: every key, TLS credential and wallet is created for one run and destroyed with it.

## Layout

| Path | What it is |
|---|---|
| `signer/kan_signer.py` | Custodian A service (Python 3 standard library only): HTTPS with mutual TLS 1.3, bound to `127.0.0.1:18999`. It signs through its own Core wallet, journals every decision, and replays the journal on start. |
| `signer/kan_policy.py` | The pure request validator the service runs before signing. |
| `signer/test_kan_policy.py` | Offline policy tests. |
| `payment-gate/` | Rust `kan-payment-gate`: the Gate 5 check of an M16 final proof and its payment statement (GPL-3.0-only, built separately). |
| `deploy/vps-signer.sh` | VPS lifecycle as root: `init`, `install-policy`, `start`, `stop`, `kill`, `status`, `journal`, `bypass-sign`, `destroy`. |
| `coordinator/lib.cjs` | Local regtest Core, the SSH admin and tunnel channels, the mutual-TLS client, request construction, and receipts with a key-material guard. |
| `coordinator/run.cjs` | Runs Gates 1–3 end to end and writes `receipts/`. |
| `coordinator/lib.test.cjs` | Offline tests, including a scan of every committed receipt. |
| `receipts/*.json` | One machine-readable receipt per scenario, plus `summary.json`. |

## Architecture

Local coordinator (Windows, Bitcoin Core 31.1 regtest in a temporary datadir):
- the wallets `kan-client`, `kan-custodian-b`, `kan-custodian-c`, `kan-payee`, `kan-attacker` and `kan-miner`;
- the watch-only vaults `kan-vault-1` = `wsh(sortedmulti(2, client, A, B))` and its successor `kan-vault-2` = `wsh(sortedmulti(2, client, B, C))`;
- PSBT construction, the fault scenarios, and the receipts.

VPS, Custodian A (Linux, Bitcoin Core 31.1):
- **Service account:** the unprivileged account `kansigner` (no login shell), which runs a private regtest Core with no peers and RPC bound to `127.0.0.1:18998`.
- **Key:** the wallet `custodian-a`, created on the VPS. Its private key never leaves the VPS.
- **Signer:** a systemd unit with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `Restart=always`, and write access only to `/var/lib/kan-signer`.
- **Files:**
  - code in `/opt/kan-signer`, owned by root;
  - configuration and policy in `/etc/kan-signer`, owned by root; the TLS key is group-readable by the service only;
  - the journal at `/var/lib/kan-signer/journal.jsonl`, opened append-only and `fsync`ed per entry.

Channels:
- **Signing channel:** the coordinator reaches the signer through an SSH local forward to `127.0.0.1:18999`, with mutual TLS 1.3 inside it.
  - The signer requires a client certificate from the coordinator CA it was given.
  - The coordinator pins the signer's self-signed certificate by SHA-256 fingerprint.
  - The private TLS keys stay on their own machines.
- **Admin channel:** the VPS administrator installs the policy over SSH. The signing channel has no route that reads or changes the policy.

## Signing-request protocol (version 1)

`POST /v1/sign` takes a JSON object with exactly these fields; anything else is refused as `malformed`:

    version, request_id, network, vault_id, vault_descriptor_checksums,
    intended_outputs: [{address, sats}], fee_ceiling_sats, expiry, psbt

The signer runs `decodepsbt` and `analyzepsbt` on its own Core. It signs only if all of these hold:
- **Binding:** `network`, `vault_id` and both vault descriptor checksums equal the pinned policy.
- **Expiry:** the request is unexpired, and expires at most `max_request_lifetime_s` (900 s) ahead.
- **Inputs:** every input has a `witness_utxo` paying a vault address (receive and change branches, indices 0–99). Every input uses SIGHASH_ALL and carries a BIP32 derivation for A's fingerprint.
- **Outputs:** they equal `intended_outputs` exactly (count, order, address, satoshis). Each pays a vault address, a successor-vault address or a listed payee.
- **Fee:** positive, at most `fee_ceiling_sats`, which is at most the policy's 20,000 sats. The fee rate is at most 50 sat/vB, from `analyzepsbt` `estimated_vsize`.
- **Locktime:** at most the policy maximum (0).
- **Request id:** new. The same id and body returns the journaled decision (`replayed: true`); the same id with another body is `request_id_reused`.
- **Outpoints:** none of the inputs was already signed in a different unsigned transaction (`conflicting_spend`).

After signing, the service checks that its own partial signature is present on every input. The reply carries the signed PSBT, its digest, the unsigned txid, the fee, the request digest and the journal sequence number. It never carries key material.

## Setup

VPS (Ubuntu with Bitcoin Core 31.1 in `/usr/local/bin`, Python 3, OpenSSL, sudo): nothing to install. The coordinator copies `signer/` and `deploy/vps-signer.sh` to `/tmp/kan-src`, then runs `vps-signer.sh` under `sudo` for each step.

Windows local:
- Bitcoin Core 31.1 in `%LOCALAPPDATA%\Programs\BitcoinCore\bitcoin-31.1\bin`, or another location set with `BITCOIN_BIN_DIR`.
- Node.js 22 or later.
- `ssh`, `scp` and `openssl` on `PATH` (Git for Windows provides all three).
- An SSH key the VPS accepts for an account with sudo.

Run from the repository root:

    node key-agent-net/distributed/coordinator/run.cjs --host ubuntu@<vps> --key <ssh-private-key-path>

A run does all of this:
1. Destroys any previous VPS state.
2. Creates a fresh `kansigner` account, Core wallet and TLS key, and reads A's public descriptor key and certificate.
3. Creates the coordinator CA, a client certificate and an unauthorized certificate.
4. Builds both vaults and installs the policy.
5. Funds eight vault UTXOs and runs every scenario.
6. Destroys the VPS state again: the account, keys, journal and units.

`--keep-vps` skips that last step so the state can be inspected.

Offline checks:

    python3 -m unittest discover -s key-agent-net/distributed/signer -p "test_*.py"
    node --test key-agent-net/distributed/coordinator/lib.test.cjs key-agent-net/model.test.cjs key-agent-net/regtest.cli.test.cjs
    bash -n key-agent-net/distributed/deploy/vps-signer.sh

## Acceptance evidence (run of 2026-11-01, 07:29–07:31 UTC)

Local Bitcoin Core 310100 regtest. VPS host `zk` (Ubuntu, Linux 7.0, Bitcoin Core 31.1). Custodian A fingerprint `24ff6473`, policy digest `071e5e82…e2b9`. The 18-entry signer journal has digest `1951f808…c13c`, recorded in `summary.json`. After the run the VPS had no `kansigner` account, `kan-*` units or directories, and no `bitcoind` process.

| Criterion | Receipt | Observed |
|---|---|---|
| Cross-machine PSBT signing | `gate1-distributed-signing` | Unsigned PSBT `4bd0549a…1ea9`; client partial `c3864578…8686`; A partial from the VPS `e4ebb17c…5adf`, journal seq 1. |
| Core confirms the authorized spend | `gate1-distributed-signing` | `testmempoolaccept` allowed it. Txid `d642214a…8e60`, confirmed in block `05a93de3…ca34`. |
| Unauthorized policy mutations rejected | `gate2-modified-output-address`, `gate2-modified-amount-or-fee`, `gate2-stale-request`, `gate2-coordinator-credentials` | `destination_not_in_policy`, `outputs_differ_from_intent` (address, amount), `fee_above_ceiling`, `fee_ceiling_above_policy`, `fee_rate_above_policy`, `expired`, `expiry_too_far`. A policy write over the signing channel got `unknown_path`. |
| Replay and duplicates auditable | `gate2-duplicate-request`, `gate2-process-restart` | A duplicate returns the journaled signature with `replayed: true` and a new journal sequence number. The same id with another body is `request_id_reused`. After SIGKILL and a systemd restart (`NRestarts=1`), the replay returns the identical signed-PSBT digest. |
| VPS unavailable | `gate2-vps-unavailable` | With the service stopped, the request fails with `ECONNRESET` and nothing is signed. After a restart the same request is signed. |
| Conflicting PSBTs for one UTXO | `gate2-conflicting-psbts` | The first is signed. A second, distinct spend of that outpoint is `conflicting_spend`. |
| Coordinator credentials | `gate2-coordinator-credentials` | A certificate outside the CA fails the handshake (`ERR_SSL_TLSV1_ALERT_UNKNOWN_CA`). No certificate gives `ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED`. A valid but stolen credential attempting theft is `destination_not_in_policy`. |
| B colludes with A's operator | `gate2-collusion-a-operator-b` | The VPS administrator signs with A's Core wallet directly (`bypass-sign`), skipping the service. With B's signature, a spend to the attacker confirms as `31a7809b…75ee1`. |
| Recovery after A disappears | `gate3-custodian-a-disappears` | A's signer is stopped and the tunnel closed. Client + B sweep the remaining UTXO into `kan-vault-2` (client, B, C) as `03cf7dd5…7593`, confirmed; the successor holds 0.99 regtest BTC. |
| Conflicting quorum spends classified | `gate3-conflicting-quorum-race` | The client + B recovery `be73aa9c…cee0` (2 sat/vB) was broadcast first. A (operator bypass) + B then broadcast `0787c057…16c9` at 20 sat/vB. Full RBF evicted the recovery from the mempool, and the raid confirmed. |
| No private key material in receipts | `coordinator/lib.test.cjs` | `writeReceipt` refuses extended private keys, WIF and PEM private keys. Receipts hold digests and txids, never PSBTs, and the test scans every committed receipt. |
| Existing offline tests still pass | local run | 17/17 Node tests (the 14 existing plus 3 new) and 10/10 Python policy tests. |

## Gate 4: mapping onto the UTXO-Ref V2 guardian-quorum reserve

`bitvm3/utxo_referee/utxoref_v2_guardian_quorum_reserve.js` builds a P2TR output on a deterministic NUMS internal key, so there is no key path. It has exactly two authorized script paths:

1. **`immediate-operator-guardian-quorum`:** `<binding> DROP <operator> CHECKSIGVERIFY <g1> CHECKSIG <g2> CHECKSIGADD … <k> NUMEQUAL`. The operator signature AND exactly k of n guardian signatures.
2. **`recovery-refund-csv`:** `<binding> DROP <csv> CHECKSEQUENCEVERIFY DROP <recovery> CHECKSIG`. The recovery key alone, once the output is `recoveryCsvDelay` blocks old.

The template refuses an operator key that is also a guardian, a recovery key that is also a guardian, and an operator key equal to the recovery key. This handoff proposes no change to either leaf. KeyAgentNet's custodian signer maps onto V2 as a guardian signing service, an off-chain control in front of one guardian key.

| Measured KeyAgentNet behavior | In V2 |
|---|---|
| A 2-of-3 lets two custodians spend without the client (`gate2-collusion-a-operator-b`). | Guardians alone cannot spend: the immediate leaf also needs the operator signature. Guardian collusion needs the operator too. The recovery leaf needs the recovery key and the CSV delay. |
| The signer policy blocks a compromised coordinator but not A's host administrator. | The same holds for a guardian signing service. The operator-signature requirement still has to be met on chain, so a guardian host compromise alone moves nothing. |
| A disappears; the surviving quorum recovers. | With n−1 ≥ k guardians left, operator + guardians spend on the immediate leaf. Otherwise only the recovery key after `recoveryCsvDelay` can. |
| A pending recovery is replaced by a higher-fee conflicting quorum spend (`gate3-conflicting-quorum-race`). | Before the CSV matures, only operator + guardians can spend, so the recovery leaf cannot race. After it matures, both paths are valid and the higher-fee replacement wins under full RBF. Recovery is only as final as the first confirmation. |
| One signature per outpoint (`conflicting_spend`). | This rule prevents a guardian service from signing two different immediate-leaf spends of one reserve UTXO. It also blocks fee bumps through that guardian: a replacement needs a different signer set or a policy rule for same-output replacements. |

The Groth16 settlement statements and BitVM V2 files are unchanged. This work touches only `key-agent-net/` and the CI workflow.

## Gate 5: payment-gated release

A policy may carry a `payment_gate` section. Custodian A then signs only a request that carries a final proof of the nova-bitvm3 M16 guest: a Nova proof of the Bitcoin header chain from genesis, with an SPV payment under its tip. The proven payment must pay a script the coordinator registered, with at least n confirmations, under a tip with at least the policy's chainwork.

The check is the Rust `payment-gate/` crate (`kan-payment-gate`); [its README](payment-gate/README.md) lists every rule and reason code. The signer runs it as a separate process on the request's `payment_proof` (`proof_b64`, `statement_hex`) before any PSBT check. The proof is verified with `m13-verify` as a library, pinned at garbled-snark-verifier `d4aefcd`.

The signer journals each released payment outpoint, so one proven payment releases one request (`payment_already_used`), across restarts. A replayed request (same id and body) returns its journaled decision without running the gate again. A request whose body exceeds 4 MiB is refused.

`run.cjs --gate-bin PATH` runs Gate 5 after Gate 3's race:
- it installs the gated policy;
- it runs every scenario below;
- it restores the plain policy before the disappearance scenario.

`--wsl DISTRO` runs Custodian A in a local WSL distribution instead of a VPS, through the same deploy script. `--bitcoin-src DIR` names its Bitcoin Core binaries.

| Receipt | Proof used | Expected |
|---|---|---|
| `gate5-payment-proof-required` | none | `payment_proof_required` |
| `gate5-payment-tampered-proof` | M16 final proof with one bit flipped | `proof_rejected` |
| `gate5-payment-wrong-program` | guest A's real final proof (a chain record, another program) | `proof_wrong_program` |
| `gate5-payment-accepted` | M16 final proof | signed, and the 2-of-3 spend confirms |
| `gate5-payment-replay` | the same proof on a second request | `payment_already_used` |
| `gate5-payment-wrong-script` | M16 final proof, policy registers another script | `script_not_registered` |
| `gate5-payment-too-few-confirmations` | M16 final proof, policy asks for one more confirmation | `too_few_confirmations` |
| `gate5-payment-wrong-genesis` | M16 final proof, policy pins the other network's genesis | `wrong_genesis` |

The M16 proof is the guest's mainnet final proof of 2026-11-11 (`payment-gate/fixtures/m16-payment.json`). It covers the header chain from genesis to 975,072 and a 940,000-sat payment, output 0 of `a652ab0c…0045`, in block 975,067 with 6 confirmations. The run's gated policy:
- registers that output's script, with a 940,000-sat minimum;
- requires 6 confirmations;
- sets the chainwork floor to Bitcoin Core's `chainwork` at 975,072.

Without that fixture the runner writes the last five receipts as `not_run` (`pass: null`); the offline receipt test accepts that state but never counts it as a pass.

The same rules are tested offline on real data:
- the statement and policy on the real block-170 statement the M16 guest committed when executed, and on the mainnet statement the M16 final proof commits;
- the proof layer on the M16 final proof and on guest A's real final proof.

**Run of 2026-11-11, 02:33–02:34 UTC.** The receipts in `receipts/` are from this run. They replaced those of 2026-11-09 (in git at `fc69bba`), which had the five payment scenarios `not_run`.

Custodian A ran in the local WSL distribution Ubuntu-24.04 (`--wsl`) again, with Bitcoin Core 31.1 from `/root/opt/bitcoin-31.1/bin`. The setup:
- A's fingerprint `f0f55d7b`, policy digest `164f8a31…6fe6`;
- local Core 310100;
- gate binary `2344753b…`, built from this crate's source at `fc69bba`;
- a 26-entry journal with digest `74e4232e…7028`.

Results: all 20 scenarios passed.
- All 12 Gate 1–3 scenarios passed, as before.
- Gate 5, in journal order:
  - no proof gave `payment_proof_required` (seq 19);
  - the M16 proof with one bit flipped gave `proof_rejected`, from the BLAKE3 PCS opening check (seq 20);
  - guest A's valid proof under the M16 pin gave `proof_wrong_program`, naming `5df3760f…` (seq 21);
  - the M16 proof released A's signature on payment `a652ab0c…0045:0` (seq 22). The client + A spend `e4552a01…319a` passed `testmempoolaccept` and confirmed.
  - the same proof on a second request gave `payment_already_used`, naming the first request (seq 23);
  - a policy registering another script gave `script_not_registered` (seq 24);
  - a policy asking for 7 confirmations gave `too_few_confirmations` (`6 < 7`, seq 25);
  - a policy pinning testnet4's genesis gave `wrong_genesis` (seq 26).

After the run WSL had no `kansigner` account, and nothing was listening on 18998 or 18999.

The first attempt that day stopped after Gate 3 with `connect ECONNREFUSED 127.0.0.1:18999`. `install-policy` returns once the restarted signer listens inside the distribution, but WSL's localhost relay forwarded the new listener later. Gate 5 now retries `/v1/identity` for up to 20 s after each policy install, as the Gate 2 restart scenario already did.

Offline:
- the 3 Node tests pass on these receipts;
- the gate crate's 15 statement and policy tests and 8 proof tests pass on Rust 1.90.0, the CI toolchain (2 and 2 of them new, on the M16 statement and proof);
- the 17 Python policy tests pass (unchanged).

## Remaining vulnerabilities and open items

1. **No independent administration.** One administrator holds the coordinator machine, the VPS SSH key and sudo on the VPS. The run itself installs the policy and uses `bypass-sign` through that account. Geographic separation does not establish independent custody; the collusion receipt measures exactly this.
2. **Any 2-of-3 quorum spends.** A + B spend without the client under consensus (v0 and v0.1). A client veto needs a different script, for example V2's operator AND guardian-quorum leaf.
3. **Recovery can be preempted.** Any quorum that can sign can replace a pending recovery with a higher fee (measured). Mitigations live in script design, such as timelocked recovery leaves, not in the signer.
4. **Fee bumps.** The outpoint lock refuses a fee bump through A. Client + B can still re-sign, as Gate 3 showed. A same-outputs, higher-fee replacement rule is not implemented.
5. **No velocity limit.** A valid coordinator credential can request any number of policy-compliant spends to listed payees and successor vaults, up to the vault balance. Per-period amount limits are not implemented.
6. **Amount inputs.** A has no chain view. It checks amounts from `witness_utxo`; BIP143 commits each signature to its own input's amount, but not to other inputs'. A multi-input PSBT with a misstated amount on another input could make A misjudge the fee. Requiring `non_witness_utxo` for every input, or moving to taproot, closes this. Every PSBT in this run had a single input.
7. **Trust in the journal.** Replay and conflict protection depend on the journal file. A's administrator can edit it, and nothing externally anchors or attests it.
8. **Clock.** Expiry uses the VPS wall clock.
9. **TLS lifecycle.** The signer certificate is self-signed for 30 days and pinned by fingerprint. The coordinator certificate can be revoked only by replacing the CA. WireGuard was not used; the transport is an SSH forward plus mutual TLS.
11. **Payment gate:**
    - The regtest vault spend is unrelated to the mainnet payment: the run tests the release rule, not a mainnet deposit flow.
    - One real M16 proof exists. Each new payment needs its own M16 proof; this one was 34.1 × 10^9 SP1 instructions, proved on GPU.
    - The chainwork floor and the registered scripts are set by whoever installs the policy, which is the same single administrator as item 1.
    - The gate runs with the signer service's privileges.
10. **Not run:** a reorg during recovery, and a network partition during signing (the tunnel was closed, but no packet-level partition was injected). The CI workflow runs the offline checks only; the cross-machine run needs the VPS and is not in CI.
