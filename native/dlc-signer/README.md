# UTXORef DLC signer candidate

This crate is the isolated native signer used by UTXORef's Bitcoin testnet4 DLC integration. It reads one bounded canonical-JSON request from standard input, independently verifies the validator's Ed25519 authorization, atomically consumes that authorization in its local replay store before signing, selects the key named by the authorized x-only public key, creates the adaptor pre-signature with `k256`, and signs its response with a runtime Ed25519 identity.

The host never passes a private scalar or caller-selected key handle. Key files must be small regular non-symlink files in an absolute directory supplied when the process starts:

- `<x-only-pubkey>.key` contains one 32-byte secp256k1 scalar encoded as lowercase or uppercase hexadecimal.
- `runtime-identity.key` contains one 32-byte Ed25519 seed encoded as hexadecimal.

Builds use the committed `Cargo.lock`, exact direct dependency versions, `rust-lld`, no PE timestamp, LTO, abort-on-panic, and forbidden unsafe Rust. The Windows testnet4 harness builds twice in independent target directories and rejects different binary hashes:

```powershell
powershell -ExecutionPolicy Bypass -File eval\dlc-native-rust-signer.ps1
```

The harness deploys the verified binary to `D:\bitagent-testnet4\bin`, runs a cross-language adaptor-signature completion and extraction test, tests durable replay rejection after host restart, and writes its evidence to `D:\bitagent-testnet4\btc-test-snapshots`.

This implementation is a production candidate, not an audited production signer. `productionReady` remains false until independent cryptographic, dependency, build, key-storage, and deployment review is complete. The current key-directory backend is intended for testnet4 evaluation and must be replaced or isolated with an audited production key service before mainnet use.
