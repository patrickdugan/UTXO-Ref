# Experimental L2 settlement statement V0

## Target relation

Given a locally pinned trust policy, the future prover must establish that a
canonical UTXO-Ref V2 commitment and the exact Bitcoin settlement satisfy the
agreed L2 settlement rules. Witnesses include the signed state checkpoint,
funding records, ordered payout requests and canonical unsigned transaction.

The relation must recompute the V2 commitment bytes and digest. Contract,
epoch and chain bindings in the outer statement must equal the V2 values.
Funding outpoints and payout request IDs must be unique. The ordered outputs
must match the payout set exactly; payout totals plus the fee must equal the
funding total using bounded integer arithmetic. The canonical transaction
must spend the designated assertion outpoint, use the agreed version,
sequence and locktime, and reproduce the declared TXID. The relation must
also connect the settlement's actual input value to the authorized funding
and reserve movement under the reviewed graph.

For the initial checkpoint-based relation, authenticate the checkpoint under
externally pinned keys and reproduce the V2 derivation of the permitted
payouts. A valid signature remains an assertion by that authority about L2
state. Proving full ledger transitions requires its own program and spec.
Current chain membership, freshness, reorg handling and actual unspentness
need authenticated chain observations and the spend graph's checks.

These are requirements for the future relation. The starter codec checks
field syntax and computes a commitment to supplied values only.

## Fields and encoding

Input objects contain exactly these fields:

| Field | Representation and meaning |
| --- | --- |
| `kind` | Literal `utxoref_l2_settlement_groth16_v0` |
| `version` | Numeric `0` |
| `network` | `bitcoin-regtest` or `bitcoin-testnet4` |
| `chainGenesisHash` | 32-byte lowercase hex; expected chain identity |
| `contractId` | 32-byte lowercase hex; V2 contract identity |
| `commitmentHash` | 32-byte lowercase hex; existing V2 commitment digest |
| `assertionTxid` | 32-byte lowercase hex; funded assertion transaction |
| `settlementTxid` | 32-byte lowercase hex; exact settlement transaction |
| `programHash` | 32-byte lowercase hex; pinned relation/program artifact |
| `verifyingKeyHash` | 32-byte lowercase hex; pinned canonical key artifact |
| `policyHash` | 32-byte lowercase hex; frozen trust/graph policy artifact |
| `epochId` | Canonical decimal u64 string, with no leading zeroes except `0` |
| `assertionVout` | Numeric u32, rejecting negative zero |

The **304-byte** encoding is:

```text
ASCII("UTXOREF_L2_SETTLEMENT_GROTH16_V0\0")  # 33 bytes, including NUL
u16le(0)
u8(network_code)                              # regtest=0; testnet4=1
hex_bytes(chainGenesisHash)
hex_bytes(contractId)
hex_bytes(commitmentHash)
hex_bytes(assertionTxid)
hex_bytes(settlementTxid)
hex_bytes(programHash)
hex_bytes(verifyingKeyHash)
hex_bytes(policyHash)
u64le(epochId)
u32le(assertionVout)
```

Hashes and TXIDs enter this envelope in the exact displayed byte order of
the hex string. Bitcoin transaction serialization has its own outpoint byte
order; the future transaction adapter must apply and test that conversion.
Network/genesis consistency is a verifier-policy check. Synthetic fixtures
are permitted by this syntax-only layer.

Let `d = SHA256(encoded_statement)`. The proposed Groth16 public inputs are:

```text
[ uint128_be(d[0:16]), uint128_be(d[16:32]) ]
```

Both are exported as decimal strings. The future circuit must recompute the
entire encoding and digest from constrained fields, range-check both limbs,
and preserve their order. A host-supplied digest or a validity flag cannot
stand in for that computation. Digest reduction modulo a field is not used.
Backend integration must confirm this input ABI against its actual curve and
verification-key layout before producing proofs.

## Trust pins and transaction graph

The verifier must obtain the expected program, key and policy from local
configuration fixed before accepting an assertion. Identifiers supplied by
the claimant carry no authority. Pin canonical artifact bytes and compare
all expected identities before verification. The first policy schema must
specify trusted checkpoint signers, chain parameters, fee bounds and graph
roles/delays, along with versioned serialization and hashes.

The graph must bind the same public inputs, key and exact spending conditions.
An off-chain `verify == true` result grants no Bitcoin signing authority by
itself. Preserve the existing operator/challenger requirements until a reviewed
replacement enforces equivalent conditions. State replay protection and
outpoint consumption must survive restarts and follow the chain through reorgs.

Review the commitment dependency graph before funding: an assertion TXID
cannot be embedded in a script commitment that determines that same TXID.
Keep pre-funding policy commitments and post-funding statement binding in
separate, explicitly specified steps; prove that the selected BitVM backend
supports this split. V0 is provisional until that review passes.

`commitmentHash` reuses V2's serialization. This envelope has its own version
and makes no change to V2 or the Cashu `PaymentClaimV1` wire format. Future
wire parsers must reject duplicate JSON keys before constructing the object.
