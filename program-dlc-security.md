# UTXORef DLC Security Benchmark

Harden the experimental secp256k1 adaptor-signature and DLC oracle boundary while preserving valid completion and extraction behavior.

## Objective

Maximize the `score` emitted by `bash eval/dlc-security.sh`. A score of `1.0` means every correctness, nonce-safety, parsing, extraction, oracle-authentication, state, funding-safety, and scale check passed.

## Mutable implementation

- `bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig.js`
- `bitvm3/utxo_referee/m1_dlc_sign_finalize.js`
- `bitvm3/utxo_referee/dlc_contract_state.js`
- `bitvm3/utxo_referee/dlc_state_store.js`
- `bitvm3/utxo_referee/dlc_threshold_oracle.js`
- `bitvm3/utxo_referee/dlc_crypto_provider.js`
- `bitvm3/utxo_referee/dlc_oracle_event_store.js`
- `bitvm3/utxo_referee/dlc_transaction_validator.js`
- `bitvm3/utxo_referee/dlc_signature_validator.js`
- `bitvm3/utxo_referee/dlc_chain_guard.js`
- `bitvm3/utxo_referee/dlc_bitcoin_core_observer.js`
- `bitvm3/utxo_referee/dlc_peer_transcript.js`
- `bitvm3/utxo_referee/dlc_peer_session_store.js`
- `bitvm3/utxo_referee/dlc_watchtower_journal.js`
- `bitvm3/utxo_referee/dlc_anchor_recovery_guard.js`

Treat `eval/`, `program-dlc-security.md`, and `prepare.sh` as locked benchmark infrastructure.

## Security contract

- A valid adaptor pre-signature must verify, complete only with its committed scalar, produce a valid BIP340 signature, and reveal that scalar through validated extraction.
- Nonce derivation must bind the complete compressed adaptor point, including parity, so `T` and `-T` cannot force reuse.
- Scalars, points, signatures, and pre-signatures must use canonical ranges and encodings. Malformed verifier input must return false instead of throwing.
- An oracle announcement must authenticate the event identifier, public nonce, and complete outcome set.
- The oracle must reject uncommitted outcomes and conflicting second attestations while allowing an identical retry.
- Reusing an oracle nonce seed across distinct events must not reuse the public nonce.
- Public oracle objects must not expose secret key or nonce scalars or allow cloned public data to act as signer state.
- The milestone funding finalizer must reject a broadcast request before reading artifacts, contacting RPC, or invoking `sendrawtransaction` until every CET adaptor signature and a fully signed refund are verified.
- A 2-of-3 enumerated oracle set must produce the three expected combined adaptor points and require individually valid attestations from the selected subset.
- Contract progress must follow the ordered, hash-chained state machine with explicit validation receipts, idempotency keys, append-only revisions, and stale-write rejection.
- Every validation receipt must be signed by the Ed25519 validator key pinned for that evidence kind and bind the contract, digest, stages, and idempotency key.
- Wallet funding signing must require a `FUNDING_PSBT_APPROVED` record whose receipt commits to the exact canonical PSBT bytes and Bitcoin network.
- DLC crypto must default disabled, reject mainnet, and require an explicit research flag for the JavaScript implementation. Native providers must authenticate constant-time, zeroization, isolation, binary, and audit capabilities. Raw adaptor signing must remain hidden behind an authorization bound to the pinned local-CET validator, authenticated contract transcript, CET-set digest, signer x-only public key, exact BIP341 sighash, and adaptor point. Consumption must be written durably before signing and admit exactly one worker across restart and concurrent processes. Native requests must contain only authenticated public data, reject host-supplied secrets and key handles, be independently verified by the signer, and have their returned pre-signatures independently verified by the host.
- Oracle nonce and attestation state must be authenticated at rest, persisted before use, restorable after restart, one-outcome, and append-only.
- Every unsigned CET and refund must use canonical Bitcoin encoding, spend exactly the committed funding outpoint, have a unique transaction ID, match the committed ordered outputs and locktime, activate nonzero locktime through sequence, remain inside the allowed fee range, and contain exactly one committed CPFP anchor as the last output.
- The signed transaction transition must bind the anchor policy, maximum recovery fee, maximum recovery feerate, and minimum relay-peer quorum as a dedicated validation receipt.
- Every CET adaptor signature and refund signature must verify against the BIP341 sighash of the already validated transaction, funding amount, funding script, signer key, and exact threshold-oracle subset.
- Chain monitoring must bind the exact signed transaction set and funding outpoint, prove ancestry against the prior snapshot, and halt on reorgs, unknown spends, immature refunds, or CETs inconsistent with contract state.
- The Bitcoin Core observer must verify network, chain tip, and mempool stability around every snapshot and use only read-only RPC methods. Anchor observations must derive the exact outpoint state, spender fee and vsize, full-RBF setting, and incremental relay fee from Core; relay counts must bind unique configured node IDs to stable views of the same tip and mempool. Proposed recovery txid, wtxid, vsize, RBF signaling, and fee must be derived from the Core-decoded raw transaction, the committed anchor amount, and observed additional inputs.
- Watchtower observations must be independently signed, append-only, hash-chained, transaction-set-bound, restart-verifiable, and preserve every halt alert.
- Offer, accept, and sign messages must form an authenticated hash-chained transcript; bind the testnet4 chain hash, validated transaction set, signature-validation digests, funding witnesses, and derived contract ID; and enforce globally unique, canonically ordered u64 serial IDs.
- Temporary contract IDs and completed transcript digests must be claimed atomically, survive restart, reject conflicting reuse, and remain idempotent for identical retries.
- Anchor recovery evaluation must bind the exact committed settlement outpoint, apply the signed fee limits before broadcast and relay quorum after observation, halt confirmed uncommitted spends, and require observed full-RBF policy or an RBF-signaling conflict plus the incremental replacement-fee delta before authorizing a fee-pin rescue.

This benchmark uses synthetic keys, has no network dependency, and must never broadcast a transaction.

## Run

```bash
bash prepare.sh
EVAL_PROFILE=lite bash eval/dlc-security.sh
EVAL_PROFILE=full bash eval/dlc-security.sh
EVAL_PROFILE=scale bash eval/dlc-security.sh
```

Use `lite` during iteration, `full` before submission, and `scale` for a longer attack run. Change the deterministic fixture seed with `EVAL_SEED`. CI can append `--require-perfect` directly to the Node evaluator.

This is an experimental JavaScript boundary benchmark. A perfect score does not qualify it as a production signer; the architecture review requires an audited native secp256k1 implementation and isolated, durable nonce state before value-bearing use.
