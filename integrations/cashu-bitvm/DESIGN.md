# PaymentClaimV1 design and acceptance gates

## Stage 0 canonical statement

A `PaymentClaimV1` contains: version, Bitcoin network, bytes32 contract ID, bytes32 unique claim ID, bytes32 recipient commitment, positive amount in sats, bytes32 authenticated-block reference (header hash), minimum confirmations, expiry height and bytes32 payment policy digest.

The statement hash is `SHA256("UTXOREF-CASHU-BITVM-CLAIM-V1\0" || canonical binary encoding)`. All integer values are unsigned big-endian with explicit widths; hashes are bytes32 hex (lowercase, no prefix). `mainnet`, `testnet4`, `signet` and `regtest` have distinct discriminants. **Note:** the hash commits to claimed fields; it does not authenticate the block or prove payment.

A Stage 0 `ProofReceiptV1` binds that statement to a proof artifact digest, proof-system identifier, verifier-key digest and program/circuit digest, and explicitly reports `unverified`. Later adapters must issue a separately versioned verified receipt only after cryptographic verification and public-input matching; the Stage 0 receipt type deliberately forbids `verified`.

## Intended future relation

For public statement P and private witness W, prove:
1. a transaction in W has canonical Bitcoin serialization and its TXID is included in a transaction Merkle tree rooted in the authenticated header bound by P;
2. a committed recipient predicate matches the designated payment output, under a specified recipient-commitment scheme;
3. the sum of **distinct selected outputs** matches or exceeds the required sats without integer overflow;
4. the payment policy is bound to the chain/network, unique claim, permitted scripts and expiration;
5. the chosen chain-validation policy authenticates the header and confirmations outside the circuit, or the circuit additionally proves those assertions with an explicit checkpoint assumption.

Neither outputs on an otherwise valid transaction nor a valid Merkle branch alone establishes who currently controls those coins. No Bitcoin money moves without a separate enforceable contract.

## Implementation gates

G0 (here): canonical statement encoding, mock-free explicit unverified receipts and mutation tests.

G1: reference Bitcoin transaction/output/Merkle predicate plus external Bitcoin Core authentication; prove exact witness against genuine testnet4/regtest vector. Reject forged amounts and reorged headers.

G2: independent direct Groth16 (BN254) prover/verifier and SP1/STARK -> Groth16 wrapper; bind the verified statement to the identical public input bytes in both pathways. No placeholder file-hash proofs.

G3: reproducible RAM measurements: `/usr/bin/time -v`, `memory.peak` cgroup, producer and verifier separately; peak host RSS, elapsed seconds, proof size, verification time. Under 8 GiB producer RSS is a **target**, not an achieved result; compare against upstream BitVM garbled SNARK baselines, which measure a different operation.

G4: BitVM optimistic challenge simulation with pinned Groth16 verifier key, adversarial false claims, timeouts, bonds, settlement/refund pre-signed transaction graph and documented honest-challenger liveness assumption. Distinguish simulation from enforceable Bitcoin Script and broadcast receipts.

G5: optional Cashu/CDK integration as independent adapter; mint issuance must require a finalized authenticated proof result plus atomic spent-claim database and threshold signer authorization. Malicious threshold collusion remains a custody risk.

## Threat matrix

| Case | Expected result |
| --- | --- |
| Same value different network | distinct statement digests |
| Altered amount or recipient commitment | distinct digest |
| Malformed hash, zero amount, unknown network, overflow | reject |
| Claimed verified Stage 0 receipt | reject |
| Payment proof against unauthenticated header | reject at G1+ verifier |
| Wrong verifying key, proof, or public inputs | reject at G2+ verifier |
| Replayed valid claim | reject at G5 mint state |
| Absent BitVM challenger | documented liveness risk at G4 |
| Byzantine custody threshold | explicitly out of scope for solvency guarantees |
