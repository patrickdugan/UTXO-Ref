# UTXORef — Tokenized Deposit/Withdrawal Referee: Build Summary

This summarizes the end-to-end build of the TradeLayer UTXO tokenization
deposit → withdrawal → settlement system, from the solvency referee through a
full on-chain BitVM fraud-proof referee. Every cryptographic layer is
implemented from scratch on Node built-ins (the repo is **zero-dependency**),
anchored to published spec test vectors, and every on-chain claim is a confirmed
Litecoin testnet (LTCTEST) txid.

## Trust model

- **Deposit/withdrawal accounting**: 1 sat = 1 receipt unit; the referee verifies
  committed payout execution, not price.
- **Settlement**: oracle attestation + adaptor signatures over a 2-of-2 MuSig2
  taproot output (a real DLC — neither party spends alone, nothing settles until
  the oracle attests).
- **Referee correctness** (solvency, final-output): enforced by BitVM-style
  fraud proofs — the operator bonds a claim; any faked input or inconsistent
  computation is punished on-chain; otherwise the operator reclaims after a
  CSV timeout.
  > **Scope note:** "trustless" describes the Script/circuit mechanics, not
  > the current deployment. Every on-chain disprove/timeout to date was run
  > with the operator also acting as the challenger (self-play). A persistent
  > watchtower daemon now exists, but it has not been run by an
  > independent challenger and does not yet auto-broadcast every possible
  > disprove spend. See `SECURITY_BLOCKERS.md` #3, #5, and #6, and
  > `docs/ADVERSARIAL_SIGNET_PLAN.md` for the rehearsal required before
  > this claim holds operationally, not just mechanically.

## Layer map (all modules under `bitvm3/utxo_referee/`)

Reserve / referee (off-chain evidence + commitments):
- `tradelayer_reserve_reconciliation_referee.js` — `cap <= reserve` solvency
  commitment + insolvency challenge.
- `tradelayer_withdrawal_queue_referee.js` — fail-closed withdrawal queue.
- `tradelayer_live_reserve_adapter.js` — live `listunspent` → credited reserve.
- `tradelayer_bitvm_stack.js`, `tradelayer_utxoref_live_path.js` — bundle +
  evidence with the solvency gate folded into the stack/dashboard.

DLC settlement (cryptography from scratch, vector-validated):
- `tradelayer_dlc_adaptor_sig.js` — secp256k1 + BIP340 Schnorr + Schnorr adaptor
  signatures (cross-checked vs Node libsecp256k1 + BIP340 vector).
- `tradelayer_taproot.js` — BIP341 keypath tweak + `SIGHASH_DEFAULT` sighash
  (vs BIP341 wallet vectors).
- `tradelayer_musig2.js` — MuSig2 (BIP327) keyagg + x-only tweak + partial sign +
  adaptor offset (vs BIP327 vectors).

BitVM fraud-proof referee (from scratch):
- `tradelayer_taproot_script.js` — script-path tweak/sighash/control block
  (vs BIP341 vectors).
- `tradelayer_taproot_tree.js` — multi-leaf taproot tree + merkle-path control
  blocks (vs BIP341 multi-leaf vectors).
- `tradelayer_bitvm_gadgets.js` — bit commitment + equivocation punishment.
- `tradelayer_bitvm_circuit.js` — wires + AND/OR/XOR/NAND/NOT gate disprove leaves.
- `tradelayer_bitvm_comparator.js` — `cap <= reserve` as a 93-gate full subtractor.
- `tradelayer_bitvm_dispute.js` — CSV timeout leaf + dispute tree.
- `tradelayer_bitvm_solvency_referee.js` — input binding to the real reconciliation.
- `tradelayer_bitvm_sha256.js` — SHA256 as a ~108k-gate circuit (vs NIST vectors).

## Confirmed on-chain (LTCTEST)

Settlement path:

| What | Funding txid | Spend/CET txid | Block |
|---|---|---|---|
| UTXORef sweep (decode→broadcast) | — | `3e8d784e…cfd001d7` | 4,761,067 |
| 2-of-2 DLC fund + CET | `f2f1191b…7ffa101a` | `28976fd5…3876e121` | 4,761,076 |
| Oracle-attested route-derived CET | `9b1d9e48…ad32dc83` | `5e232095…e198d442` | 4,761,083 |
| Taproot adaptor DLC (single-key) | `276b600b…08069045` | `ce9e7273…6d3f0366` | 4,761,191 |
| 2-party MuSig2 adaptor DLC | `bfe988a4…9fe9bd37` | `8b8d18f4…2cfc9e5463` | 4,761,258 |

BitVM referee:

| What | Funding txid | Disprove/spend txid | Block |
|---|---|---|---|
| Equivocation punishment | `46180ba8…2fd25895` | `aa3cd2fc…63c8163a` | 4,761,263 |
| Single gate disprove (`1 AND 1 = 0`) | `985914a4…1a7e1971` | `2be77c16…9d3e5d78` | 4,761,431 |
| Comparator circuit (308 leaves) disprove | `80151561…a96fee46` | `05d9d2b2…ee299d08` | 4,761,436 |
| Dispute CSV timeout reclaim | `935a5690…d2064eea` | `581020bf…52e1840d` | 4,761,442 |
| Solvency input-binding disprove | `b189825d…763c2565` | `134f2048…31746970` | 4,761,536 |
| SHA256 circuit (447k leaves) disprove | `4c2962f4…b7a33c9f` | `21d753ce…03f2baf0` | 4,761,545 |

Live reserve (off-chain evidence): 42 `tl-wallet` UTXOs = 17,164,718 sats credited
and reconciled against the withdrawal cap.

## Verify

Tests (all pass; the SHA256 test wants a little heap):

```powershell
node bitvm3/utxo_referee/run_utxoref_all.js
```

Regenerate a live artifact (node on RPC 19332):

```powershell
node bitvm3/utxo_referee/tradelayer_live_reserve_demo.js `
  --rpc-url http://127.0.0.1:19332 --rpc-user user --rpc-pass pass --wallet tl-wallet
```

Live on-chain demos (each funds + spends; see file headers; `--broadcast` to send):
`tradelayer_musig2_dlc_demo.js`, `tradelayer_bitvm_circuit_demo.js`,
`tradelayer_bitvm_timeout_demo.js`, `tradelayer_bitvm_solvency_demo.js`,
`node --max-old-space-size=4096 tradelayer_bitvm_sha256_demo.js`.

Node startup: `litecoind -testnet -server -rpcport=19332 -rpcuser=user
-rpcpassword=pass -datadir=D:\testnetwallet -txindex=1`.

## Honest scope / remaining (productionization, not new capability)

- SHA256 circuit is single-block; multi-block + gate-count reduction for larger
  output vectors.
- Independent watchtower deployment, auto-disprove broadcast, fee/RBF/CPFP and
  reorg hardening, operator runbooks.
- The reserve's binding to the *actual* UTXO set at the consensus layer (the
  reconciliation currently takes a credited-deposit snapshot).
