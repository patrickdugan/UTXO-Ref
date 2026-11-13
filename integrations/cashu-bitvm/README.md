# Cashu × BitVM payment-trigger research (Stage 0)

Standalone, **non-custodial, offline-only** experiment inside UTXO-Ref. No new repo.

## Goal

Specify a domain-separated, canonical payment assertion that could later be proven using a small direct Groth16 circuit or SP1/STARK proof wrapping, with verification results consumable by a BitVM optimistic challenge protocol and optionally by a Cashu/CDK mint.

The initial executable is a **statement/receipt consistency checker**. It does not verify Bitcoin consensus, a SNARK/STARK, Cashu tokens, adaptor signatures, or spending conditions. A passing Stage 0 test **cannot release Bitcoin or mint ecash**.

## Trust boundaries

* **Bitcoin evidence:** TXID Merkle inclusion must be checked against an authenticated block header and an explicit chain-selection/confirmation policy. A supplied Merkle root by itself is untrusted.
* **Private payment predicate:** witness needs transaction serialization, payment output, recipient opening, amount, Merkle siblings and authenticated context. Public claims bind a recipient commitment without exposing recipient address. Hiding a witness doesn't conceal on-chain payment history from outside chain observers.
* **Proof:** hard-pin proof system, circuit/program identity, verifying key, public inputs, and exact verifier version. A file hash or signed manifest is not cryptographic verification.
* **BitVM:** challenge games need a specific pre-signed transaction graph, bonds, timeouts, a live honest challenger and enforceable script paths. Stage 0 has none of these.
* **Cashu:** a federation still needs robust DKG, signing share checks and issuance accounting. Proof of a payment doesn't prove mint solvency or enforce redemption.
* **Replay:** domain separation includes chain/network, contract identifier, unique claim ID, expiry and recipient commitment. Repeated use must be rejected by the downstream state machine, not this stateless checker.

## Stage 0 contents

* `claim_v1.py`: typed, strictly parsed, SHA-256-domain-separated claim and receipt commitments. A receipt carries an explicit `unverified` status; no `verified` status can be emitted in Stage 0.
* `test_claim_v1.py`: standard-library fixtures, wrong-network, amount mutation, forged hash, wrong verifier and malformed-input rejection.
* `DESIGN.md`: exact next proof implementation milestones and a benchmark matrix.

## Run

```sh
python3 -m unittest discover -s integrations/cashu-bitvm -p 'test_*.py' -v
```

No dependencies, network access, wallet keys, runtime configuration or custody operations.

## Related repos and prior art

* [UTXO-Ref](https://github.com/patrickdugan/UTXO-Ref) (BitVM UTXO referee)
* [rust-bitcoin-zk-adapter](https://github.com/patrickdugan/rust-bitcoin-zk-adapter) (proof-sidecar isolation and verified receipt boundaries)
* [Raito-Scrypt PR #3](https://github.com/patrickdugan/Raito-Scrypt/pull/3) (real SP1 core/compressed Scrypt proof receipts, ~30 GiB proving RSS)
* [BitVM garbled-snark-verifier](https://github.com/BitVM/garbled-snark-verifier) (existing streaming Groth16 verifier and adaptor-trigger research)
* [Cashu NUTs](https://github.com/cashubtc/nuts), [CDK](https://github.com/cashubtc/cdk)
