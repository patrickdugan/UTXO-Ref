# DLC Security and Architecture Review

Date: 2026-09-11  
Baseline commits: UTXORef `fb6caa3`, BitAgent `421b080`  
Scope: Bitcoin testnet4 integration, the local Schnorr adaptor implementation,
oracle lifecycle, CET/refund ordering, and agent-scale hostile inputs.

## Decision

Do not discard DLCs solely because they depend on discrete logarithms. Bitcoin
Taproot and BIP340 signatures rely on the same secp256k1 discrete-log hardness
assumption. Replacing a DLC with another secp256k1 construction does not remove
that assumption.

Do replace the current DLC implementation and operational boundary before any
value is committed. The handwritten JavaScript signer, in-process oracle,
placeholder message format, single-oracle trust model, and funding lifecycle
are not suitable for production. Keep DLC execution disabled while Bitcoin
testnet4 exercises UTXORef commitments and the guarded Taproot reserve vault.

The target architecture should retain DLC semantics only through a reviewed
native implementation, an isolated stateful signer, authenticated standard
messages, threshold oracles, and a state machine that cannot sign or broadcast
funding until every CET and refund signature is verified.

Machine-readable decision: [dlc_security_decision_latest.json](bitvm3/utxo_referee/artifacts/dlc_security_decision_latest.json).

## What is actually active

BitAgent currently imports the UTXORef receipt template as metadata and builds a
bound Taproot reserve vault. It does not call `adaptorSign`, `dlcAttest`, or a
DLC execution engine. The older milestone pipeline is Litecoin-testnet code and
its oracle file explicitly creates placeholders. It is not a complete Bitcoin
testnet4 DLC protocol.

This distinction matters: the defects below are release blockers for enabling
the DLC lane, but they do not invalidate the newly added BitAgent funding-root,
deposit-indexer, or reserve-vault integration.

## Reproduced attacks

### Critical: related adaptor points recovered the signer key

The adaptor nonce hash committed to `T.x` but omitted the sign of `T.y`. An
attacker could request pre-signatures for the same transaction digest under `T`
and `-T`. These points have the same x-coordinate. At deterministic fixture
attempt 9, both requests selected the same nonce point. The two equations had
the same nonce and different challenges, allowing recovery of the normalized
BIP340 signing key.

This was a chosen-input key-extraction attack, not a theoretical side-channel.
The pre-hardening probe reports `sameNoncePoint=true` and
`signerKeyRecovered=true`.

### Critical: cross-event oracle nonce reuse recovered the oracle key

The oracle constructor accepted a raw nonce scalar. Constructing two events
with the same oracle key and nonce scalar produced the same `R`. One attestation
per object did not help: two different event messages yielded two Schnorr
equations with the same nonce, from which the oracle signing key was recovered.

The pre-hardening experiment returned:

```json
{"samePublicNonce":true,"oracleKeyRecovered":true}
```

The original oracle object also exposed adjusted private-key and nonce scalars
as `_x` and `_k`, and accepted arbitrary repeated attestations without event or
outcome policy.

### Critical: funding could be broadcast before recovery was valid

`m1_dlc_sign_finalize.js` defaulted funding broadcast on. The preceding steps
only created unsigned CET skeletons and placeholder oracle/adaptor fields; they
did not exchange or verify every CET adaptor signature or a fully signed refund
transaction. A crash, malicious counterparty, or unavailable oracle after
funding could therefore strand a 2-of-2 output.

The DLC peer specification requires the accepter to provide CET and refund
signatures in `accept_dlc`, the initiator to provide its signatures in
`sign_dlc`, and funding broadcast only after those messages validate. See the
[DLC protocol specification](https://github.com/discreetlogcontracts/dlcspecs/blob/master/Protocol.md).

### High: oracle trust was singular and unauthenticated

The milestone oracle artifact contained key IDs and string placeholders rather
than a signed event descriptor, authenticated announcement, nonce commitments,
and validated attestation. An attacker able to substitute the oracle artifact
could redirect the selected outcome or force timeout.

The DLC specification requires announcements to bind the public key, event,
descriptor, maturity, and nonces, and requires clients to authenticate both
announcements and attestations. See [Oracle.md](https://github.com/discreetlogcontracts/dlcspecs/blob/master/Oracle.md)
and [Oracle-Validation.md](https://github.com/discreetlogcontracts/dlcspecs/blob/master/Oracle-Validation.md).

### High: secret-dependent JavaScript arithmetic remains

Generator multiplication is delegated to OpenSSL, but secret scalar
normalization, multiplication, addition, nonce derivation, and oracle
attestation still occur as JavaScript `BigInt` operations. JavaScript does not
provide constant-time guarantees or reliable zeroization, and secrets can be
copied by the runtime and garbage collector. Co-located hostile agents increase
the exposure to timing, memory disclosure, fault injection, and accidental
logging.

BIP340 recommends fresh auxiliary randomness, strict domain separation, and
warns that nonce reuse across schemes can reveal the key. Its reference code is
explicitly not production code. See [BIP340](https://bips.dev/340/).

### Medium: noncanonical pre-signatures bypassed object-hash identity

The verifier accepted 33-byte, zero-prefixed encodings for 32-byte point and
scalar fields. Canonical and padded objects both verified but had different
JSON hashes. A system using an object hash for replay detection, approval, or
storage identity could process the same pre-signature more than once.

### Medium: malformed public input crashed verification

An empty Schnorr signature caused `BigInt('0x')` to throw instead of returning
false. At agent scale this gives unauthenticated inputs a cheap worker-crash
primitive.

### Medium: adaptor extraction trusted an unrelated signature

`adaptorExtract` subtracted scalar fields without verifying the pre-signature,
the completed signature, the signing key/message, or the extracted point. A
caller could accept a forged decryption scalar and attach it to the wrong
oracle outcome.

### Inherent DLC risks that remain after code fixes

- A truthful signature proves what an oracle signed, not that the external
  market fact was true.
- Oracle collusion can choose an economically favorable outcome.
- Oracle silence locks collateral until refund maturity.
- Numeric-outcome disagreement can make an otherwise honest contract
  unexecutable unless bounded-error combinations are negotiated.
- Pre-signed refunds can become uneconomic at a fixed fee rate; fee bumping and
  transaction pinning need explicit design.
- Compromise of either party before negotiation completes can leak contract
  terms or create invalid signature transcripts.
- Announcement fetching and attestation-triggered broadcasts can leak which
  events a client consumes.

The DLC multi-oracle specification defines n-of-n and t-of-n constructions and
bounded disagreement for numeric outcomes, with the expected combinatorial
cost. See [MultiOracle.md](https://github.com/discreetlogcontracts/dlcspecs/blob/master/MultiOracle.md).

## Implemented containment

The local research implementation now:

1. Commits the compressed 33-byte adaptor point, including y parity, into
   adaptor nonce derivation.
2. Uses fresh, event-bound synthetic oracle nonces even when a caller repeats a
   nonce seed.
3. Returns a frozen public oracle announcement while keeping signing state out
   of enumerable object fields.
4. Signs the event ID, oracle key, nonce, and complete enumerated outcome set,
   and verifies that signature before deriving outcome points.
5. Allows one outcome per oracle event, makes an identical retry idempotent,
   and rejects a conflicting or uncommitted outcome.
6. Enforces fixed-length canonical encodings and range checks.
7. Makes malformed public verification return false.
8. Verifies both signatures and the adaptor point before returning an extracted
   scalar.
9. Disables the milestone funding broadcast path until verified CET and refund
   signatures exist.
10. Builds canonical enumerated 2-of-3 oracle subsets and validates every
    attestation before combining the adaptor scalar.
11. Persists contract transitions as append-only revisions with optimistic
    concurrency, hash-chained transcripts, and idempotency keys.
12. Requires Ed25519-signed validation receipts from keys pinned per evidence
    kind; a caller-provided boolean cannot advance the contract.
13. Refuses wallet funding signing unless the state is exactly
    `FUNDING_PSBT_APPROVED` and its receipt commits to the canonical PSBT bytes
    and Bitcoin network.
14. Defaults the crypto-provider boundary to disabled, rejects mainnet, and
    confines JavaScript secret operations to an explicit research mode.
15. Seals experimental oracle signer state with AES-256-GCM, authenticates it
    against the signed announcement, persists it before use, and restores its
    one-outcome state after restart.
16. Parses unsigned Bitcoin transactions canonically and binds every CET and
    refund to the exact funding outpoint, ordered outputs, effective locktime,
    and fee range before producing validation digests.
17. Verifies CET adaptor signatures and refund signatures against the BIP341
    sighash of those validated transactions, the funding amount and script,
    signer identity, and selected threshold-oracle subset.
18. Requires one committed CPFP anchor as the last output of every CET and the
    refund, and binds that policy into the transaction-set validation digest.
19. Evaluates read-only chain snapshots against the signed transaction set and
    exact funding outpoint, proves ancestry against the prior snapshot, and
    halts on reorgs, unknown spends, immature refunds, or stage-inconsistent
    CETs.
20. Captures stable snapshots from an injected Bitcoin Core RPC boundary,
    verifies testnet4/regtest, tip and mempool stability, checks the exact
    funding outpoint, and scans a bounded block window for its spending
    transaction without exposing any signing or broadcast method.
21. Authenticates and hash-chains offer, accept, and sign envelopes; binds them
    to the testnet4 genesis hash, validated transaction and signature digests,
    funding-witness validation, and derived contract ID; and rejects replayed
    temporary IDs, duplicated serial IDs, and noncanonical serial ordering.

The changes block the concrete exploit probes. They reduce testnet risk but do
not promote this module to a production signer.

## Scale evidence

Pre-hardening attack evidence:
[dlc_adaptor_attack_pre_hardening.json](bitvm3/utxo_referee/artifacts/dlc_adaptor_attack_pre_hardening.json).

Post-hardening eight-worker fuzz evidence:
[dlc_adaptor_fuzz_latest.json](bitvm3/utxo_referee/artifacts/dlc_adaptor_fuzz_latest.json).

Latest locked benchmark evidence:
[dlc_security_eval_scale_latest.json](bitvm3/utxo_referee/artifacts/dlc_security_eval_scale_latest.json).
The independent sweep-boundary result is
[utxo_referee_eval_scale_latest.json](bitvm3/utxo_referee/artifacts/utxo_referee_eval_scale_latest.json).

The locked agent benchmark is
[`eval/dlc_security_eval.js`](eval/dlc_security_eval.js), with the Hive prompt
and server template in [`program-dlc-security.md`](program-dlc-security.md) and
[`hive-task-config.dlc-security.example.json`](hive-task-config.dlc-security.example.json).
It emits an independent `score` for correctness, attack, threshold-oracle,
signed-state, persistence, signer-boundary, and funding-safety properties under
lite, full, and scale profiles. Keeping it
separate from the sweep benchmark prevents one score from hiding failures at a
different trust boundary.

The 2,000-contract run completed 2,000 adaptor round trips and blocked:

- 2,000 `T/-T` related-point nonce attempts;
- 6,000 malformed public inputs;
- 200 conflicting oracle attestations;
- 200 cross-event repeated-nonce-seed attempts; and
- 200 authenticated-announcement mutations.

It took 265,665 ms with eight worker threads. That performance and CPU cost are
additional evidence against using pure JavaScript curve verification in a
large agent swarm.

## Required architecture before any funded DLC

### Cryptographic boundary

- Replace the handwritten JavaScript signer with a reviewed native secp256k1
  implementation. `rust-dlc` contains transaction, manager, message,
  persistence, and fuzzing crates, although its own README still warns that it
  is early-stage and not fully specification-compliant. It is a reference
  candidate, not automatic production approval. See
  [p2pderivatives/rust-dlc](https://github.com/p2pderivatives/rust-dlc).
- Run party and oracle keys in separate signer processes or hardware-backed
  services. Agents receive typed requests and public results only.
- Persist event creation and nonce consumption atomically before returning an
  announcement or attestation. The experimental encrypted event store now
  covers a shared local store across restart and concurrent processes; the
  native signer must extend uniqueness across failover and backup restore.
- Use separate keys for oracle announcements/attestations, DLC party signing,
  wallet funding, and unrelated application messages.

### Protocol state machine

Enforce this irreversible order:

```text
DRAFT
  -> AUTHENTICATED_ORACLES
  -> CANONICAL_CETS_AND_REFUND
  -> COUNTERPARTY_SIGNATURES_VERIFIED
  -> LOCAL_SIGNATURES_PERSISTED
  -> FUNDING_PSBT_APPROVED
  -> FUNDING_BROADCAST
  -> CONFIRMED
  -> CET_EXECUTED | REFUND_EXECUTED
```

No transition may be inferred from a file existing. Each transition needs a
canonical transcript hash, prior-state hash, explicit validation receipt, and
idempotency key. Funding signing and broadcast remain separate host-owned
actions.

The local peer transcript now enforces the sequencing and serial-ID invariants
from the [published peer protocol](https://github.com/discreetlogcontracts/dlcspecs/blob/master/Protocol.md). It is an authenticated UTXORef envelope, not
the published binary wire codec: the current DLC wire specification uses ECDSA
adaptor signatures and identifies Taproot DLCs as future work, while this
research path uses BIP340. Wire interoperability therefore remains a blocker
until a Taproot DLC message format is published and cross-tested.

### Oracle policy

- Use at least 2-of-3 independent oracles for enumerated outcomes. The local
  combination primitive now enforces this shape, but production still needs
  independent operators and interoperable messages. For numeric prices,
  configure a bounded disagreement policy and test honest variance and
  collusion.
- Pin accepted oracle identities and verify announcement signatures before
  contract negotiation.
- Monitor equivocation and publish fraud proofs, but do not treat detectability
  as prevention.
- Negotiate a refund delay that bounds oracle liveness risk without enabling a
  cheap counterparty timeout strategy.

### Transaction safety

- The local validators now cover exact funding outpoints, outputs, amounts,
  fees, a committed last-output CPFP anchor, BIP341 CET adaptor signatures, and
  refund signatures, authenticated peer sequencing, and peer serial-ID rules.
  Wire the validators and independently validated funding witnesses to the
  native signer before funding authorization.
- Store and independently restore the refund transaction before broadcast.
- The read-only chain guard now detects disconnected ancestry, confirmation
  regression, unknown spends, immature refunds, and stage-inconsistent CETs.
  Its Bitcoin Core observer now stabilizes the chain and mempool views and scans
  a bounded recent-block window for the spender. Operate it as an independent
  watchtower, validate anchor ownership and spendability, test package relay,
  and simulate pinning and deep reorg recovery on regtest.
- Require independent Bitcoin Core policy checks and exact transaction decode
  immediately before signing and broadcasting.

## Alternative designs

| Design | Oracle risk | Privacy and scale | Main trade-off |
|---|---|---|---|
| Hardened DLC with threshold oracles | Reduced, not removed | Strong; many outcomes remain off-chain | Complex negotiation and signer/oracle operations |
| Taproot script branches | Still present if outcome is oracle-driven | Outcome policy becomes visible; poor for many numeric outcomes | Simpler cryptographic tooling, larger scripts/trees |
| UTXORef plus optimistic dispute | Shifts trust to challengers and evidence | Can support richer claims | Bonds, data availability, and always-online watchtowers |
| Custodial/off-chain ledger | Operator becomes the oracle and custodian | Operationally simple | Loses trust minimization and self-custody |

For the current project, UTXORef commitments plus guarded Taproot reserves are
the right testnet4 execution substrate while the DLC engine is rebuilt behind
a disabled feature gate. A future DLC engine can be introduced as a separate,
versioned settlement adapter after it passes the state-machine, native-signer,
threshold-oracle, reorg, pinning, and restore gates above.

## Verification commands

```powershell
node bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig.test.js
node bitvm3/utxo_referee/dlc_adaptor_attack_probe.js
$env:EVAL_PROFILE='full'
.\eval\dlc-security.ps1
.\eval\dlc-security-testnet4.ps1 -Profile scale
$env:DLC_FUZZ_CASES='2000'
$env:DLC_FUZZ_WORKERS='8'
node bitvm3/utxo_referee/dlc_adaptor_fuzz.js
$env:BROADCAST_FUNDING='1'
node bitvm3/utxo_referee/m1_dlc_sign_finalize.js
```

The last command must fail before loading a wallet or making an RPC request.
