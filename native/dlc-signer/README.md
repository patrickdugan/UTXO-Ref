# UTXORef DLC signer candidate

This crate is the isolated native signer used by UTXORef's Bitcoin testnet4 DLC integration. It reads one bounded canonical-JSON request from standard input, requires the Ed25519 validator identity to appear in an audited policy file, independently verifies its authorization, atomically consumes that authorization in its local replay store before signing, selects the key named by the authorized x-only public key, creates the adaptor pre-signature with `k256`, and signs its response with a runtime Ed25519 identity.

The host never passes a private scalar or caller-selected key handle. Each validator-signed authorization uses schema `utxoref_dlc_adaptor_sign_authorization_v3`, expires within 300 seconds, and permits at most 30 seconds of future clock skew. The signer verifies this window against its own clock before durable consumption. After consumption and before key use, it verifies a bounded history of runtime-identity-signed clock observations and rejects clock rollback beyond the same skew. Testnet4 keys are Windows DPAPI `CurrentUser` blobs in an absolute directory supplied when the process starts:

- `<x-only-pubkey>.key.dpapi` protects one 32-byte secp256k1 scalar.
- `runtime-identity.key.dpapi` protects one 32-byte Ed25519 seed.

Initialize the empty directory with `initialize-dpapi-key-directory.ps1`, then provision blobs with `protect-dpapi-key.ps1`, supplying lowercase hexadecimal on standard input. Initialization disables inherited ACLs and grants access only to the current signer account, `SYSTEM`, and `Administrators`. The signer rejects legacy `.key` files. Its fourth through sixth launch arguments are the absolute `verify-dpapi-key-access.ps1` path, its SHA-256 digest, and the expected Windows signer-account SID. The host includes this silent verifier in `codePaths`, and the signer independently verifies its digest before launching a sanitized Windows PowerShell process. The verifier rejects a different process identity, an inherited key-directory ACL, the wrong owner, or an allow rule for any other SID. The Rust process then calls Windows DPAPI directly; decrypted key bytes never cross a child-process pipe.

The second launch argument is an absolute canonical-JSON validator policy with schema `utxoref_dlc_native_validator_policy_v1`. It fixes `network` to `bitcoin-testnet4`; its sorted `validatorKeyIds` array contains SHA-256 digests of accepted Ed25519 SPKI documents, and `signerPubkeyXs` lists the x-only signing keys that may be used. The third argument is the policy file's SHA-256 digest. The process refuses a changed digest, an unpinned validator or signing key, symlinks, duplicate identities, and non-canonical policy bytes. The host must include the policy file in `codePaths`, which binds both its bytes and expected digest into the signed runtime closure.

Builds use the committed `Cargo.lock`, exact direct dependency versions, `rust-lld`, no PE timestamp, LTO, and abort-on-panic. Unsafe Rust is confined to six documented blocks around `CryptUnprotectData`, `VirtualLock`/`VirtualUnlock`, zero-and-free of its `LocalAlloc` result, and the bounded 32-byte copy. DPAPI output and the copied raw key buffer must both lock successfully before use; lock failure aborts signing, and both regions are zeroed before unlock. The Windows testnet4 harness builds twice in independent target directories and rejects different binary hashes:

```powershell
powershell -ExecutionPolicy Bypass -File eval\dlc-native-rust-signer.ps1
```

The harness deploys the verified binary to `D:\bitagent-testnet4\bin`, runs a cross-language adaptor-signature completion and extraction test, tests durable replay rejection after host restart, launches 16 signer processes against one fresh authorization and requires exactly one authenticated winner, and writes its evidence to `D:\bitagent-testnet4\btc-test-snapshots`.

This implementation is a production candidate, not an audited production signer. `productionReady` remains false until independent cryptographic, dependency, build, key-storage, and deployment review is complete. DPAPI prevents offline plaintext-key recovery but any process running as the same Windows user can request decryption. Production deployment requires a dedicated signer service account, restrictive ACLs, and an audited key service or hardware-backed design before mainnet use.
