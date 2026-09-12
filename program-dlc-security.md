# UTXORef DLC Security Benchmark

Harden the experimental secp256k1 adaptor-signature and DLC oracle boundary while preserving valid completion and extraction behavior.

## Objective

Maximize the `score` emitted by `bash eval/dlc-security.sh`. A score of `1.0` means every correctness, nonce-safety, parsing, extraction, oracle-authentication, state, funding-safety, and scale check passed.

## Mutable implementation

- `bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig.js`
- `bitvm3/utxo_referee/m1_dlc_sign_finalize.js`

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

