# UTXORef DLC signer candidate

This crate is the isolated native signer used by UTXORef's Bitcoin testnet4 DLC integration. It reads one bounded canonical-JSON request from standard input, requires the Ed25519 validator identity to appear in an audited policy file, independently verifies its authorization, atomically consumes that authorization in its local replay store before signing, selects the key named by the authorized x-only public key, creates the adaptor pre-signature with `k256`, and signs its response with a runtime Ed25519 identity.

The host never passes a private scalar or caller-selected key handle. Key files must be small regular non-symlink files in an absolute directory supplied when the process starts:

- `<x-only-pubkey>.key` contains one 32-byte secp256k1 scalar encoded as lowercase or uppercase hexadecimal.
- `runtime-identity.key` contains one 32-byte Ed25519 seed encoded as hexadecimal.

The second launch argument is an absolute canonical-JSON validator policy with schema `utxoref_dlc_native_validator_policy_v1`. It fixes `network` to `bitcoin-testnet4`; its sorted `validatorKeyIds` array contains SHA-256 digests of accepted Ed25519 SPKI documents, and `signerPubkeyXs` lists the x-only signing keys that may be used. The third argument is the policy file's SHA-256 digest. The process refuses a changed digest, an unpinned validator or signing key, symlinks, duplicate identities, and non-canonical policy bytes. The host must include the policy file in `codePaths`, which binds both its bytes and expected digest into the signed runtime closure.

Builds use the committed `Cargo.lock`, exact direct dependency versions, `rust-lld`, no PE timestamp, LTO, abort-on-panic, and forbidden unsafe Rust. The Windows testnet4 harness builds twice in independent target directories and rejects different binary hashes:

```powershell
powershell -ExecutionPolicy Bypass -File eval\dlc-native-rust-signer.ps1
```

The harness deploys the verified binary to `D:\bitagent-testnet4\bin`, runs a cross-language adaptor-signature completion and extraction test, tests durable replay rejection after host restart, launches 16 signer processes against one fresh authorization and requires exactly one authenticated winner, and writes its evidence to `D:\bitagent-testnet4\btc-test-snapshots`.

This implementation is a production candidate, not an audited production signer. `productionReady` remains false until independent cryptographic, dependency, build, key-storage, and deployment review is complete. The current key-directory backend is intended for testnet4 evaluation and must be replaced or isolated with an audited production key service before mainnet use.
