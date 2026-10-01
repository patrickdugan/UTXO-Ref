# UTXO Referee

> **Current security target:** use the namespaced V2 API for a Bitcoin
> testnet4 alpha. The original V1 sweep and BitVM demos are retained only as
> explicitly acknowledged unsafe prototypes.

```javascript
const referee = require('./bitvm3/utxo_referee');
const { settlement, trace, assertionGraph } = referee.v2;
```

V2 requires an allowlisted Ed25519 state checkpoint, exact ordered settlement
outputs, unique indexed payout requests, secret-safe wire reveals, a
deterministic NUMS Taproot internal key, an immediate challenger fraud path,
dual-signed delayed settlement, and a longer operator recovery delay.

Historical V1 APIs are no longer exported at the package top level. Replaying
old demonstrations requires an explicit acknowledgement:

```javascript
const legacy = referee.legacyUnsafe.load({
  acknowledgeUnsafePrototype: true
});
```

Do not use `legacyUnsafe` to custody funds.

The implemented V2 transaction flow, live testnet4 evidence, assumptions, and
remaining mainnet blockers are documented in
[`UTXOREF_V2_SECURITY_MODEL.md`](./UTXOREF_V2_SECURITY_MODEL.md).
The exact guardian-approved, reserve-backed fee-rescue transaction and Core
replacement drill are documented in
[`UTXOREF_V2_RESERVE_CPFP.md`](./UTXOREF_V2_RESERVE_CPFP.md).

BitVM3 module for verifying sweep transactions against committed settlement rules.

## Legacy V1 Scope

The UTXO Referee verifies a single statement:

> **"This sweep transaction follows the committed settlement rules."**

It does NOT verify:
- PnL computation from trades
- Oracle truth
- Full L2 state transitions
- Token economics or staking

## Integration Boundary

The referee is integration-neutral at the verification layer:
- Inputs are `epochId`, payout leaves/proofs, cap in satoshis, and residual destination.
- It does not depend on pricing, collateral, or protocol-specific accounting logic.
- TradeLayer-specific mapping assumptions are documented in `TLInt.md`.

## Architecture

```
utxo_referee/
|- types.js      # CommitmentPackage, PayoutLeaf, SweepObject
|- merkle.js     # PayoutMerkleTree with proofs
|- verify.js     # verifySweep() off-chain verification
|- circuit.js    # BitVM boolean circuit scaffolding
|- test.js       # Test suite
|- demo.js       # Usage demonstration
|- TLInt.md      # TradeLayer integration mapping notes
`- README.md     # This file
```

TradeLayer-specific projection details are kept in `TLInt.md`.

Launch sequencing for a future live custody rail is documented in
`LITECOIN_MAINNET_SHIP_PLAN.md`.
> **Scope note:** no custody rail is running today — this points at a ship
> *plan*. See `docs/PILOT_SURFACE.md` for what currently exists and
> `SECURITY_BLOCKERS.md` for what must close before any real-value custody.

## Data Structures

### Commitment Package
Published on-chain to anchor the settlement:
```javascript
{
  epochId: u64,           // Unique epoch identifier
  withdrawalRoot: bytes32, // Merkle root of payout leaves
  capSats: u64,           // Maximum sats payable this epoch
  residualDest: bytes     // scriptPubKey for residual
}
```

### Payout Leaf
A single withdrawal in the Merkle tree:
```javascript
{
  epochId: u64,               // Must match commitment
  recipientScriptPubKey: bytes,
  amountSats: u64
}
```

Leaf hash: `SHA256(TAG || epochId || amountSats || recipientScriptPubKey)`
where TAG = "UTXO_REFEREE_V1"

### Sweep Object
Simplified representation of the sweep transaction:
```javascript
{
  epochIdCommitted: u64,
  payoutOutputs: [{
    recipientScriptPubKey: bytes,
    amountSats: u64,
    merkleProof: { siblings: bytes32[], index: number }
  }],
  residualOutput: {
    recipientScriptPubKey: bytes,
    amountSats: u64
  }
}
```

## Verification Rules

1. **Epoch Binding**: `sweep.epochIdCommitted == commitment.epochId`
2. **Membership**: Each payout has a valid Merkle proof against `withdrawalRoot`
3. **Cap**: `sum(payout amounts) <= capSats`
4. **Residual**:
   - `residualOutput.amountSats == capSats - sum(payouts)`
   - `residualOutput.recipientScriptPubKey == residualDest`

## Usage

```javascript
const referee = require('./bitvm3/utxo_referee');
const legacy = referee.legacyUnsafe.load({
  acknowledgeUnsafePrototype: true
});

// Build payout tree
const leaves = [
  { epochId: 1, recipientScriptPubKey: '...', amountSats: 10000 },
  { epochId: 1, recipientScriptPubKey: '...', amountSats: 20000 }
];
const { root, proofs } = legacy.buildTreeWithProofs(leaves);

// Create commitment
const commitment = new legacy.CommitmentPackage({
  epochId: 1,
  withdrawalRoot: root,
  capSats: 100000,
  residualDest: Buffer.from('...')
});

// Build sweep
const sweep = new legacy.SweepObject({
  epochIdCommitted: 1,
  payoutOutputs: leaves.map((l, i) => ({
    recipientScriptPubKey: l.recipientScriptPubKey,
    amountSats: l.amountSats,
    merkleProof: proofs[i]
  })),
  residualOutput: {
    recipientScriptPubKey: commitment.residualDest,
    amountSats: 70000n  // 100000 - 30000
  }
});

// Verify
const result = legacy.verifySweep(commitment, sweep);
if (result.ok) {
  console.log('Sweep is valid');
} else {
  console.log('Invalid:', result.reason);
}
```

## BitAgent testnet4 compatibility

BitAgent consumes three stable CommonJS interfaces:

```javascript
const referee = require('./bitvm3/utxo_referee');
const reserveVault = require('./bitvm3/utxo_referee/taproot_reserve_vault');

const funding = referee.v2.settlement.buildFundingSetV2([{
  txid: 'aa'.repeat(32),
  vout: 0,
  amountSats: '6000',
  scriptPubKeyHex: '0014' + '11'.repeat(20)
}]);

const deposits = new referee.ReceiptDepositIndexer({
  network: 'bitcoin-testnet4',
  minConfirmations: 3
});

const template = reserveVault.buildTaprootReserveVaultTemplate({
  network: 'bitcoin-testnet4',
  operatorXonly: '...',
  guardianXonly: '...',
  recoveryXonly: '...',
  recoveryCsvDelay: 2016,
  bindingHash: '...'
});
```

Run `node bitvm3/utxo_referee/bitagent_compatibility.test.js` to verify the
interface, deterministic funding root, confirmation threshold, and bound P2TR
reserve template. The test uses synthetic data and does not sign or broadcast.

The DLC implementation remains research-only. See
[`DLC_SECURITY_ARCHITECTURE_REVIEW.md`](../../DLC_SECURITY_ARCHITECTURE_REVIEW.md)
for reproduced key-extraction attacks, containment, fuzz evidence, and the
required native-signer and protocol-state-machine redesign.

The hardened research API is available under `referee.dlc`. It includes the
signed contract state machine, append-only state store, enumerated threshold
oracle combinations, encrypted restart-safe oracle state, and a crypto provider
that defaults to disabled. Canonical Bitcoin transaction and BIP341 signature
validators bind CET/refund evidence to the funding outpoint before signed state
can advance. Each spend has a unique transaction ID and committed last-output
anchor. Boundary V23 supports the legacy version-2 owned CPFP anchor and a
version-3 TRUC policy with an exact zero-sat P2A `51024e73` anchor. The TRUC
policy commits Core's 10,000-vB settlement limit, 1,000-vB recovery-child limit,
and two-transaction unconfirmed cluster limit. Every signed fee policy fixes the
absolute recovery-fee ceiling, feerate ceiling, and relay-peer quorum. The read-only
chain guard binds snapshots to that signed transaction set and halts on reorgs,
unknown spends, immature refunds, and stage-inconsistent CETs. A synchronous,
injected Bitcoin Core observer captures stable chain/mempool snapshots using
read-only RPC calls. The boundary persists those evaluations in an
Ed25519-signed, append-only watchtower journal whose alerts and tamper evidence
survive restart. It also authenticates and hash-chains the peer offer/accept/sign
transcript, derives the contract ID, and enforces global serial-ID uniqueness
and funding-witness validation receipts. It also evaluates authenticated anchor
observations against the exact committed outpoint, signed budgets, relay quorum,
and observed replacement policy before a fee-pin rescue can proceed. Anchor
observations come directly from stable Core chain and mempool views; relay counts
carry uniquely named same-tip node views and mempool sequences in the signed
journal. The observer derives proposal txid, wtxid, vsize, RBF signaling, and
fee from the Core-decoded raw transaction and its observed inputs. Every
pre-broadcast proposal also carries a stable, read-only Core
`testmempoolaccept` result. Recovery halts when Core rejects the exact txid/wtxid,
when its version differs from the signed policy, or when a TRUC child exceeds
1,000 vB. Observed recoveries need the signed relay quorum. An atomic
peer session store preserves temporary-ID and transcript replay protection
across restart.

Native signer candidates remain non-production. A candidate capability manifest
must now be signed by an operator-pinned Ed25519 audit key, binding the reviewed
binary and audit digests plus the constant-time, zeroization, and process
isolation claims. Self-declared native capability flags are rejected.
The provider no longer exposes raw adaptor signing. Each adaptor signature
requires a one-shot Ed25519 authorization from the contract's pinned local-CET
validator. That authorization binds the authenticated CET-set digest, exact
BIP341 sighash, adaptor point, current record hash, and transcript at
`COUNTERPARTY_SIGNATURES_VERIFIED`; replay, stage drift, and request mutation
fail closed. Signing additionally requires a `SigningAuthorizationStore`. It
creates and fsyncs an exclusive consumption record before invoking the signer,
so restart and concurrent processes sharing the store cannot consume the same
authorization twice. An incomplete crash marker fails closed for manual
recovery.

The native provider interface accepts only
`utxoref_dlc_native_adaptor_sign_request_v2`. The host supplies the signed
authorization payload, validator public key, contract commitments, approved
signer x-only public key, sighash, and adaptor point. It cannot supply a secret
scalar or key handle. The signer service must independently verify that payload,
select its internally held key by the authorized public key, and return a
pre-signature that the host verifies before accepting.
`NativeSignerProcessClient` enforces the process boundary instead of accepting
an object that merely claims isolation. Its audited digest covers the executable,
argument vector, and auxiliary code files and is recomputed for each request.
The child receives a bounded JSON request under a stripped environment, has a
hard timeout, and must return an Ed25519 identity signature over a fresh host
challenge, the request digest, and the pre-signature digest. Runtime drift,
timeouts, oversized or malformed output, stale challenges, and identity
substitution fail closed.

Boundary V31 includes the Rust `k256` signer candidate under
`native/dlc-signer`. Its direct dependencies are exactly pinned, unsafe Rust is
forbidden, and the testnet4 build harness rejects byte differences between two
independent Windows target directories. The cross-language test completes the
adaptor pre-signature into a BIP340 signature, extracts the adaptor scalar, and
checks both host and signer-local durable replay rejection. Its audited runtime
closure includes a canonical validator allowlist and expected digest; the
integration test proves that a validator absent from that policy cannot sign.
The same policy pins the exact x-only signing keys and the integration rejects
an authorization for a key absent from the policy. Secret scalar, auxiliary
randomness, nonce, response, and serialized secret intermediates use
zeroize-on-drop guards across success and error paths.
The signer-local replay store is also exercised by 16 simultaneous native
processes using the same valid authorization. Evidence is accepted only when
one authenticated pre-signature succeeds and all other consumers fail closed.
Every validator-signed adaptor authorization carries an issuance time and
expiry. Its lifetime cannot exceed 300 seconds, future issuance is limited to
30 seconds of clock skew, and the host rechecks freshness immediately before
execution. The Rust signer independently verifies the signed time window before
creating its durable consumption marker; direct-process tests reject expired
and future-dated authorizations. The signer host clock is a trusted input;
production deployment still needs protected time synchronization or a reviewed
monotonic-clock service to resist an administrator-level clock rollback.
Across ordinary restarts, the signer persists canonical clock observations
signed by its runtime identity. It verifies every observation before key use and
fails closed when the current clock falls more than 30 seconds below the signed
floor. The bounded 4,096-record store requires reviewed rotation instead of
silently discarding rollback evidence. An attacker who can delete the clock
store remains outside this candidate's protection. Testnet4 signing and
runtime-identity keys are stored only as Windows DPAPI `CurrentUser` blobs; the
native signer rejects legacy plaintext `.key` files and verifies the pinned
unwrap helper before key use. The runtime closure binds the expected Windows
account SID, and the helper rejects identity mismatch, inherited ACLs, owner
mismatch, or key-directory access granted outside the signer account, `SYSTEM`,
and `Administrators`. DPAPI decryption now occurs directly inside the Rust
signer through seven documented FFI blocks. The DPAPI allocation and copied raw
key buffer are locked against paging before use, with fail-closed lock errors
and zero-before-unlock cleanup. The PowerShell access verifier is
silent, so decrypted keys no longer traverse a child-process stdout pipe.
Before request parsing, the signer restricts DLL search to System32 and
enables fail-closed dynamic-code, extension-point, Microsoft-signature, remote
image, and low-integrity image mitigations, then reads each policy back.
DPAPI protects offline key material, while another
process under the same Windows account can still request decryption. A dedicated
signer service account, restrictive ACLs, and external key-storage review remain
required.
Boundary V32 also binds the audited signer executable SHA-256 into the capability
attestation, launch arguments, and runtime-identity-signed response. The signer
hashes its current executable before it accepts a request and fails closed on a
mismatch. This identity check is a prerequisite for moving the signer behind a
dedicated Windows service account; it does not replace that account separation.
Boundary V33 adds signer-account-local keyset provisioning. The provisioner
generates the DLC scalar and runtime identity with the Windows CSPRNG, protects
both byte arrays immediately with DPAPI `CurrentUser`, clears the raw arrays,
and obtains a public-only description from the native signer. No private key is
accepted on standard input, a command line, or a provisioning file.
Boundary V34 adds a bounded Windows named-pipe broker for cross-account
deployment. The broker authorizes one configured client SID, pins the signer
runtime closure, and forwards only the already signed public request envelope.
The protected pipe DACL and a second SID check reject unauthorized clients. The
attested runtime closure binds the public transport descriptor and broker-side
digests. The broker never opens DPAPI blobs, and BitAgent still verifies the
native runtime identity signature and executable digest on the returned
pre-signature.
Boundary V35 serializes signed clock-floor updates with an OS-backed file lock.
The lock is released by Windows if a signer dies, and the integration launches
16 distinct valid authorizations concurrently and requires all 16 authenticated
responses to verify while preserving the one-winner replay race.
Boundary V36 validates the signer clock and signed authorization time window
before creating the durable replay marker. Expired or future-dated requests now
fail without burning an authorization that may become valid later, while every
accepted authorization is still consumed before the signing key is unprotected.
Boundary V37 binds testnet4 evaluation to a stable tip, mempool sequence, wallet
cursor, and sorted `txid:vout` coin set. Same-height forks produce different
epochs, caller-owned buffers are copied at protocol-object construction, and the
untrusted-agent preflight fails closed on permissive datadir ACLs or a wallet
with private keys enabled. The optional ACL tool records a restore backup before
changing permissions.
Boundary V38 stores trusted commitment and payout-leaf state in private fields,
freezes those objects, and returns byte copies from public accessors. Exported
domain and zero-hash constants, Merkle roots, and proof siblings are detached
from internal hashing state so an evaluator cannot substitute a commitment by
mutating a shared `Buffer` after construction.
Boundary V39 adds a loopback Bitcoin Core capability firewall for low-privilege
swarm workers. It authenticates a bounded bearer capability, permits only nine
parameter-validated read or policy methods, limits request, response, timeout,
and concurrency resources, and rejects wallet, signing, broadcast, node-control,
and network-control RPCs before reading the Core cookie or forwarding a request.
Boundary V40 provisions a separate private-key-disabled descriptor wallet from
the source wallet's public descriptors. The backup wallet is never changed; the
provisioner performs no signing or broadcast and requires the target's confirmed
UTXO set to match the source at one stable testnet4 tip before writing evidence.
Boundary V41 adds a token-bucket ceiling of 120 authenticated proxy requests per
minute and caps the loopback server at 16 sockets. Clock rollback cannot refill
the bucket, limiting sustained policy-RPC load from a compromised swarm worker.
Boundary V42 makes the untrusted-agent preflight require a distinct, non-admin
Windows identity and a protected 256-bit proxy-token file. The worker must have
read access to that token but no write access; Core data remains restricted to
the coordinator, SYSTEM, and Administrators. Nested membership in privileged
local groups is rejected while purpose-built non-privileged sandbox groups are
allowed.
Boundary V43 revalidates the protected 256-bit proxy-token file on every request.
Replacing or deleting the file rotates or revokes a running proxy immediately;
token comparison buffers are cleared after constant-time comparison.
Boundary V44 binds cookie and token reads to one opened file identity, rejects
hard links and changes between metadata inspection and reading, and clears the
raw read buffer. The host gate also requires the worker to lack create, write,
and delete rights on the token's protected parent directory.
Boundary V45 pins the Authenticode signer and SHA-256 digests of Bitcoin Core
31.1's daemon and CLI. The preflight parses the actual Windows listening socket,
requires every RPC listener to be loopback-only, and binds its sole owning PID
to the pinned `bitcoind.exe` path.
Boundary V46 refuses compatibility and scale evidence from a dirty worktree and
requires the source commit and clean status to remain unchanged across the full
evaluation. Evidence can no longer attribute uncommitted code to `HEAD`.
Boundary V47 removes the saved watch-only wallet JSON from the compatibility
trust boundary. BitAgent runs a fresh read-only Core audit, requires both wallets
to be loaded already, and verifies exact public-descriptor and confirmed-UTXO
parity at one stable tip. The audit fails if it would need to create or load a
wallet or import a descriptor.
Boundary V48 requires the fully signed refund to be stored before local
signatures are marked persistent. The append-once recovery store binds the
contract transcript and validated transaction set, parses the canonical SegWit
transaction, verifies its SIGHASH_DEFAULT Taproot key-path witness, flushes the
record before returning, and revalidates it after an independent restore.
Boundary V49 requires fresh Bitcoin Core decode and mempool-policy evidence for
the exact finalized funding bytes. The signed receipt binds the approved PSBT
and current contract transcript, and the state transition rejects transaction
substitution. The guard cannot sign or broadcast.
Boundary V50 applies the same exact-byte Core policy gate to CET and refund
execution. It binds the selected committed settlement, threshold-oracle or
refund-maturity evidence, stable chain view, and current contract transcript.
Core and the local parser must agree on transaction identity and serialized
size metrics; neither execution path can sign or broadcast.
Boundary V51 limits every signed prebroadcast policy to at most 30 seconds and
requires `DlcBroadcastAuthorizationStore` to consume it durably before an
external broadcaster receives authority. Consumption revalidates the complete
state transition and exact transaction bytes. Cross-process replay, stale or
future capabilities, incomplete markers, and linked records fail closed.
Boundary V52 applies the same filesystem identity discipline to consumed
adaptor-signing authorizations. Records are bounded to 32 KiB, may have exactly
one link, are opened without following links, and must retain the same device,
inode, size, and timestamps across open. Read buffers are cleared, and both the
temporary and renamed final record are flushed before the authorization is
treated as consumed.
Boundary V53 moves contract-state revisions, sealed oracle events, peer-session
claims and commits, and watchtower observations onto a shared durable JSON
primitive. Reads bind both file and parent-directory identity, reject links and
oversized records, and clear temporary buffers. Publication uses an exclusive
link operation so it cannot replace an existing record, then flushes the final
single-link file. State-store contract IDs are SHA-256 mapped before revision
and lock paths are constructed, and lock cleanup never recursively deletes a
path.
Boundary V54 moves signing-authorization consumption, refund recovery, and
broadcast-authorization consumption onto that same primitive. Every one-shot
security record now binds parent-directory identity, publishes without
replacing an existing record, clears temporary JSON buffers, and flushes the
final single-link file before reporting durable success.
Boundary V55 hashes every native signer runtime file through an identity-bound
descriptor read. It rejects hard links and fails if the opened file, its path
entry, or its parent directory changes while hashing; transient hash buffers are
cleared after use. The runtime closure remains checked before and after each
signer execution, while host ACLs protect the interval between hashing and the
Windows path launch.
Boundary V56 revalidates each durable record's pathname after descriptor reads
and after the final publication flush. A record swapped by rename can no longer
be accepted or reported durable merely because the old open descriptor and the
parent directory kept stable identities. Durable record directories must also
resolve without traversing symlinks or junctions.
Boundary V57 adds deterministic external checkpoints for contract state, oracle
events, peer sessions, and watchtower journals. A checkpoint commits the store
key, record count, and head hash. Restart verification requires the surviving
history to contain that exact hash at the pinned count, so tail deletion and a
longer fork are rejected. Store checkpoints outside the journal directory under
an independently protected operator or coordinator trust boundary.
Boundary V58 extends the same checkpoint contract to signing-authorization
consumption, signed-refund recovery, and broadcast-authorization consumption.
Checkpoint inputs are copied into frozen plain-data snapshots before validation,
so accessors or proxies cannot change a count, store key, or head hash between
validation and comparison.
Boundary V59 moves contract records, signed receipt metadata, peer messages,
and durable record hashes onto one bounded canonical-data implementation. It
accepts only dense plain arrays and plain objects with enumerable data
properties, binds own `__proto__` data, and rejects accessors, symbol fields,
exotic prototypes, cycles, negative zero, excess depth, and excess size. Every
normalized object and array is deeply frozen before it reaches a signature or
hash boundary.
Boundary V60 rejects Proxy inputs before invoking any object trap and encodes
canonical containers with an internal recursive encoder. Inherited or polluted
`toJSON` hooks are never consulted, so application-wide prototype mutation
cannot execute callbacks or replace DLC signature or hash inputs through JSON
serialization hooks.
Boundary V61 adds Ed25519 operator signatures to external journal checkpoints.
The signature binds the complete normalized checkpoint and the SHA-256 identity
of the signer's canonical SPKI. Every durable store exposes
`verifySignedCheckpoint`, which requires an explicitly pinned trusted-key set
before checking the journal. Use signed checkpoints whenever the checkpoint
file itself is stored outside an independently integrity-protected boundary.
Boundary V62 prevents replay of an older but valid signed checkpoint. The
coordinator retains the SHA-256 hash returned for the current signed envelope
in a separate trusted monotonic boundary and supplies it to every
`verifySignedCheckpoint` call. Verification rejects a mismatched envelope
before accepting its signer or comparing journal history. Never store this
small current-envelope pin beside the untrusted checkpoint it protects.
Boundary V63 normalizes contract records and transition requests before any
semantic field access, snapshots receipt arguments from own data-property
descriptors, and rejects accessors or Proxy objects without executing them.
Contract state reloaded from the append-only store is returned as a deeply
frozen canonical snapshot.
Boundary V64 requires every contract consumer to retain and use that canonical
snapshot. This includes composed Bitcoin Core observer and watchtower paths, so
an external RPC callback cannot mutate the caller-owned record between
validation, policy evaluation, and journal publication.
Boundary V65 applies the same rule to validated transaction sets. Funding, fee
policy, CET, refund, output, and oracle-subset containers are deeply frozen;
all production consumers retain the normalized set across external Core calls
and watchtower publication.
Boundary V66 snapshots raw transaction-set construction input from property
descriptors before destructuring or nested field access. The bounded snapshot
supports Bitcoin amount `bigint` values while rejecting accessors, Proxy traps,
symbols, exotic prototypes, sparse arrays, cycles, and oversized input.
Boundary V67 descriptor-snapshots signer authorization call arguments,
canonicalizes the signed authorization envelope, and snapshots adaptor points
with bounded `bigint` support. The frozen authorization is retained through the
delayed `execute()` call so caller mutation cannot redirect a signature.
Boundary V68 descriptor-snapshots provider and native-client construction,
canonicalizes launch arrays, transport descriptors, capability manifests, and
trusted audit keys, and accepts only exact, privately constructed, frozen
authorization stores. An unverified implementation is rejected by private
client identity before its properties are read, so configuration callbacks
cannot run inside the signer trust boundary.
Boundary V69 snapshots authorized native requests before runtime hashing or
process launch, descriptor-snapshots response-attestation arguments, and
canonicalizes returned pre-signatures. Signing-consumption arguments and stored
records are also canonicalized before field access, preventing callbacks or
caller mutation from crossing into durable authorization state.
Boundary V70 descriptor-snapshots the adaptor point and pre-signature objects
used by signing, verification, completion, and extraction. Point coordinates
retain bounded `bigint` support, verification fails closed on callback-bearing
objects, and newly created pre-signatures are frozen before returning.
Boundary V71 extends this rule to oracle construction, announcement envelopes,
outcome arrays, and sealed signer-state restore inputs. Outcome buffers are
copied into a bounded canonical snapshot, consumers retain that snapshot, and
getter-bearing or proxied inputs fail before attacker callbacks can execute.
The host accepts only bounded regular runtime files whose resolved paths do not
traverse filesystem links. It hashes the complete runtime closure before and
after every signer execution, so deletion or mutation during the process
invalidates the response even when its runtime signature is otherwise valid.
BitAgent independently hashes the production DLC JavaScript closure, funding
helpers, Rust source and build lock, and checked signer evidence. Text line
endings are normalized before hashing so the same reviewed surface has one
cross-platform digest. A modified sibling checkout fails compatibility before
its exports are loaded.
The manifest walks every literal relative CommonJS dependency reachable from
the exact `index.js` and reserve-vault entry points, then adds the standalone
funding tools, Rust build inputs, and signer evidence. This prevents an omitted
transitive module from escaping the source pin.
The exact `Cargo.lock` is also scanned by pinned `cargo-audit` 0.22.2 with
`--deny warnings` for Windows x86-64. The gate rejects known vulnerabilities,
unmaintained or unsound crates, notices, and yanked dependencies. BitAgent binds
the lockfile hash, RustSec database revision, zero finding counts, audit harness,
and checked evidence into the critical surface. This result is point-in-time;
rerun it whenever the lockfile or advisory database changes.
The checked result
is recorded in `artifacts/dlc_native_rust_signer_latest.json` and
`artifacts/dlc_native_rust_dependency_audit_latest.json`. This evidence
does not replace an independent cryptographic, dependency, key-storage, and
deployment audit; `productionReady` remains false.

Run:

```powershell
node bitvm3\utxo_referee\dlc_infra_hardening.test.js
.\eval\dlc-security.ps1 -Profile full
.\eval\dlc-regtest-recovery.ps1
.\eval\dlc-truc-p2a-regtest.ps1
.\eval\dlc-native-rust-signer.ps1
.\eval\dlc-native-rust-dependency-audit.ps1
```

The milestone funding finalizer also requires `DLC_STATE_PATH` to reference a
valid `FUNDING_PSBT_APPROVED` record whose signed receipt matches the exact
Bitcoin PSBT. Litecoin artifacts and mainnet signing are rejected.

## Threat Model

### What the Referee Prevents

1. **Unauthorized payouts**: Only leaves in the committed tree can be claimed
2. **Epoch replay**: epochId in leaf prevents reusing proofs across epochs
3. **Over-withdrawal**: Cap check prevents draining beyond committed limit
4. **Residual theft**: Residual must go to committed destination

### What the Referee Does NOT Prevent

1. **Invalid commitment**: The referee trusts the commitment is correctly computed
2. **Missing payouts**: Not all leaves need to be claimed in a sweep
3. **Operator malfeasance before commitment**: Building an incorrect tree

### Trust Assumptions

- The commitment package is correctly published and finalized
- The Merkle tree was built correctly from valid withdrawal requests
- SHA256 is collision-resistant

## Circuit Implementation

The circuit scaffolding in `circuit.js` expresses the rules as boolean constraints:

- Equality checks (64-bit epoch, 256-bit hashes)
- Merkle proof verification (hash chain)
- Sum accumulation with comparison

**Current status**: Uses a real SHA256 pair-hash circuit for Merkle path verification in the referee and transition paths.
The remaining production work is circuit cost optimization, not hash correctness.

## TODOs

- [ ] Full Bitcoin transaction parsing
- [x] SHA256 circuit implementation for fixed 32-byte pair hashing
- [ ] Integration with BitVM challenge protocol
- [ ] Batch verification for multiple epochs
- [ ] Witness generation for circuit inputs

## Running Tests

```bash
node bitvm3/utxo_referee/test.js
```

## Running Demo

```bash
node bitvm3/utxo_referee/demo.js
```

## Lightning / Taproot Assets Stablecoin Prototypes

The Lightning integration demos include a Taproot Assets stablecoin/RFQ bundle
that links:

- Taproot Asset descriptor and proof commitment
- Edge-node RFQ terms for asset/BTC conversion
- BTC Lightning settlement evidence
- BitVM-backed liquidity lease evidence and challenge case

Generate the current artifact:

```bash
node bitvm3/utxo_referee/lightning_taproot_assets_stablecoin_demo.js
```

This writes:
- `bitvm3/utxo_referee/artifacts/lightning_taproot_assets_stablecoin_latest.json`
- `bitvm3/utxo_referee/artifacts/lightning_taproot_assets_stablecoin_latest.md`

The sidecar exposes the wallet view at:

```text
GET http://127.0.0.1:8787/v1/taproot-assets-stablecoin/wallet-view
```

This is an evidence-shape prototype. Production integration should verify real
`tapd` proofs, `litd`/RFQ messages, and LDK/LND channel state directly.

## Ark Liquidity Graft Prototype

Ark can be modeled as a fast liquidity graft for LN edge routing: an ASP makes
an Ark VTXO available to the edge/LSP, the LN settlement proves the payment
side, and the BitVM liquidity lease remains the external challenge layer.

Generate the current artifact:

```bash
node bitvm3/utxo_referee/lightning_ark_liquidity_graft_demo.js
```

This writes:
- `bitvm3/utxo_referee/artifacts/lightning_ark_liquidity_graft_latest.json`
- `bitvm3/utxo_referee/artifacts/lightning_ark_liquidity_graft_latest.md`

The sidecar exposes:

```text
GET  http://127.0.0.1:8787/v1/ark-liquidity-graft/wallet-view
POST http://127.0.0.1:8787/v1/ark-liquidity-graft/verify
POST http://127.0.0.1:8787/v1/ark-liquidity-graft/challenge
```

## Ark Liquidity Graft Manager Prototype

The manager prototype coordinates multiple Ark VTXO grafts across Lightning
route demand. It commits inventory, route constraints, allocation, settlement
observations, and BitVM/UTXORef challenge evidence into one operator-facing
bundle.

Generate the current artifact:

```bash
node bitvm3/utxo_referee/ark_liquidity_graft_manager_demo.js
```

This writes:

- `bitvm3/utxo_referee/artifacts/ark_liquidity_graft_manager_latest.json`
- `bitvm3/utxo_referee/artifacts/ark_liquidity_graft_manager_latest.md`

The sidecar exposes:

```text
GET  http://127.0.0.1:8787/v1/ark-liquidity-graft-manager/latest
GET  http://127.0.0.1:8787/v1/ark-liquidity-graft-manager/wallet-view
POST http://127.0.0.1:8787/v1/ark-liquidity-graft-manager/verify
POST http://127.0.0.1:8787/v1/ark-liquidity-graft-manager/challenge
```

This is still an evidence-shape prototype. It shows how a serving wallet or LSP
could farm routing yield by allocating pledged Ark liquidity, while BitVM acts
as the check against ASP pathing failures.

## LN-BTC to tlUSD Liquidity Patch Prototype

The end-to-end liquidity patch prototype composes the current pieces into one
wallet/operator flow:

- LN-BTC funds UTXORef through the submarine-swap-shaped funding proof.
- The BTC-backed position is externalized as `TLUSD` using the Taproot
  Assets/RFQ evidence shape.
- The wallet stakes `TLUSD` into a liquidity patch pool.
- Ark assigns cheap temporary VTXO liquidity to LN routes.
- BitVM/UTXORef keeps ASP/LSP path failures challengeable.

Generate the current artifact:

```bash
node bitvm3/utxo_referee/lnbtc_tlusd_liquidity_patch_demo.js
```

This writes:

- `bitvm3/utxo_referee/artifacts/lnbtc_tlusd_liquidity_patch_latest.json`
- `bitvm3/utxo_referee/artifacts/lnbtc_tlusd_liquidity_patch_latest.md`

The sidecar exposes:

```text
GET  http://127.0.0.1:8787/v1/lnbtc-tlusd-liquidity-patch/latest
GET  http://127.0.0.1:8787/v1/lnbtc-tlusd-liquidity-patch/wallet-view
POST http://127.0.0.1:8787/v1/lnbtc-tlusd-liquidity-patch/verify
POST http://127.0.0.1:8787/v1/lnbtc-tlusd-liquidity-patch/challenge
```

This is the adoption-facing story: users can hold a BTC-based dollar asset in a
Lightning wallet while opt-in staking supplies fee-optimized routing liquidity.

## Ark / UTXORef Governor Throughput Bench

The Rust harness in `integrations/ark-liquidity-governor-bench` models the
asset-agnostic LN routing hot path: Ark VTXOs make liquidity pathing cheap, while
UTXORef/BitVM verifies ASP pathing promises and only escalates slashable batches.

Run it from the harness directory:

```powershell
$env:CARGO_TARGET_DIR='D:\codex-target\ark-liquidity-governor-bench'
cargo run --release -- --obligations 5000 --work-factor 128 --bad-every 0
```

This writes:

- `bitvm3/utxo_referee/artifacts/ark_liquidity_governor_bench_latest.json`

The sidecar exposes the latest report at:

```text
GET http://127.0.0.1:8787/v1/ark-liquidity-graft/governor-bench/latest
```

Use `--bad-every 1000` to inject slashable obligations and verify that serial
and parallel checks agree.

The same harness also benchmarks real `rust-secp256k1` ECDSA signing and
verification for 5,000 CET-like messages, so raw curve throughput can be
separated from DLC/BitVM protocol overhead.

## Ark DLC Settlement Prototype

The Ark DLC settlement prototype moves the DLC happy path off-chain: outcomes are
committed as virtual CETs, but the oracle-selected outcome settles by Ark VTXO
transfer instead of broadcasting an on-chain CET. UTXORef/BitVM is the governor
against ASP power: it checks whether the ASP routed the oracle-selected virtual
CET, exposed user exit paths, and retained the forfeit path.

Generate the current artifact:

```bash
node bitvm3/utxo_referee/ark_dlc_settlement_demo.js
```

This writes:

- `bitvm3/utxo_referee/artifacts/ark_dlc_settlement_latest.json`
- `bitvm3/utxo_referee/artifacts/ark_dlc_settlement_latest.md`

The sidecar exposes:

```text
GET  http://127.0.0.1:8787/v1/ark-dlc-settlement/latest
GET  http://127.0.0.1:8787/v1/ark-dlc-settlement/wallet-view
POST http://127.0.0.1:8787/v1/ark-dlc-settlement/verify
POST http://127.0.0.1:8787/v1/ark-dlc-settlement/challenge
```

This is not a production Ark round implementation. Production needs ASP
signatures, VTXO tree proofs, connector tracking, and forfeit/exit validation.

## Ark Taproot / Miniscript Proof Manifest

The Ark proof-manifest module commits the Taproot policy shape shared by the
Ark, DLC, Shinigami, and UTXORef bundles:

- cooperative Ark round leaf
- owner CSV exit leaf
- ASP forfeit guard leaf
- DLC virtual CET settlement leaf
- UTXORef challenge-publication leaf

Build and verify the manifest directly:

```bash
node bitvm3/utxo_referee/ark_taproot_miniscript_proof_manifest.test.js
```

The manifest is a deterministic policy/proof contract, not a Bitcoin descriptor
compiler and not a STARK verifier. Bitcoin enforces the Taproot spend path;
UTXORef/BitVM consumes the manifest ID, selected leaf hash, Miniscript policy
hash, and public-input digest for challenge and publication evidence. The real
Shinigami/Stwo proof can replace the current `manifest_only` proof package
without changing the Ark/LN/DLC bundle contract.

The artifact includes a marginal cost model comparing repeated LN
open/close/splice/rebalance operations with Ark round-share, ASP fee, expected
exit cost, and BitVM challenge reserve. Under the demo assumptions, the Ark path
has lower per-graft marginal cost and lower total cost after batching.

## Visualization

Generate a gate-count and DLC flow report:

```bash
node bitvm3/utxo_referee/m1_visualize.js
```

This writes:
- `bitvm3/utxo_referee/artifacts/m1_visualization_latest.json`
- `bitvm3/utxo_referee/artifacts/m1_visualization_latest.md`

## Milestone 1 Demo

```bash
node bitvm3/utxo_referee/m1_ltc_testnet_demo.js
```

Litecoin testnet RPC setup is documented in `LTC_TESTNET_SETUP.md`.

## DLC funding prebroadcast gate

`dlc_funding_prebroadcast_guard.js` performs the final read-only Bitcoin Core
check for a fully signed funding transaction. It requires the
`FUNDING_PSBT_APPROVED` state, calls `decoderawtransaction` and
`testmempoolaccept` inside a stable tip/mempool bracket, and returns signed
receipt metadata bound to the raw transaction, txid, wtxid, approved PSBT, and
contract transcript. The `FUNDING_BROADCAST` transition rejects transaction
substitution. This module cannot sign or broadcast, and the funding finalizer
continues to reject broadcast requests.
`dlc_execution_prebroadcast_guard.js` applies the same boundary before a CET or
refund execution receipt can advance the signed contract state.
`DlcBroadcastAuthorizationStore` must then consume the signed transition within
its short validity window. It records intent before broadcast and returns the
validated next contract state, but never sends a transaction itself.

## Bitcoin testnet4 live smoke

The active Bitcoin environment is the local Core node at `D:\BitcoinTestnet`:

```powershell
node bitvm3\utxo_referee\btc_testnet4_smoke.js
node bitvm3\utxo_referee\btc_testnet4_smoke.js --require-synced --json
```

This is read-only and never broadcasts. Setup and operating commands are documented in `BTC_TESTNET4_SETUP.md`.

For concurrent red-team stress backed by live wallet UTXOs:

```powershell
node bitvm3\utxo_referee\btc_testnet4_stress.js --agents=8 --iterations=11000 --rpc-probes=100 --require-synced --unsigned-mempool-probe
```

The sanitized baseline and release blockers are recorded in `../../BTC_TESTNET4_REDTEAM_REPORT.md`.

The live funding scripts now accept `BITVM_CHAIN` so the same workflow can be pointed at:
- `litecoin-mainnet`
- `litecoin-testnet`
- `bitcoin-mainnet`
- `bitcoin-testnet`

For safety and backward compatibility, the current default remains `litecoin-testnet` unless `BITVM_CHAIN` is set explicitly.

## M1 Transition Function

The current router is implemented as an integer-satoshi transition helper:

```javascript
const referee = require('./bitvm3/utxo_referee');
const next = referee.applyBinarySettlementTransition(
  { epochId: 1n, collateralSats: 762000n, pnlPayoutBps: 3333 },
  { route: 'flat' }
);
```

Route semantics:
- `flat` and `pnl` are exact satoshi branches computed from basis points
- `roll` is the timeout branch and defaults non-interactively
- `dustCarrySats` captures any remainder from integer division

## M1 Transition Circuit

The same router can be emitted as a circuit scaffold:

```javascript
const referee = require('./bitvm3/utxo_referee');
const built = referee.generateTransitionCircuit({ bitWidth: 64 });
```

This checks:
- one-hot route selection
- exact satoshi conservation
- floor-division bounds for the payout ratio
- roll-forward epoch increment

## Receipt Tally Map

The receipt-token state machine is represented by a canonical JSON blob:

```javascript
const referee = require('./bitvm3/utxo_referee');
const tally = new referee.ReceiptTallyMap({ epochId: 1n });
tally.applyDeposit({ depositId: 'd1', accountId: 'alice', amountSats: 100n });
const blob = tally.toBlob();
const hash = tally.snapshotHashHex();
```

The blob is:
- versioned
- sorted
- exact-satoshi
- replayable
- hash-committed for next-epoch handoff

The committed envelope can be retrieved with `tally.getCommittedSnapshot()`.
The transition witness/circuit now carries `balanceRoot` from `tally.getBalanceMerkleRootHex()` instead of the flat JSON hash, while the JSON hash remains available for persistence and replay checks.

To prove one account, use `tally.getBalanceProof(accountId)`. The proof shape is:
`{ accountId, balanceSats, leafHash, index, siblings, root, epochId }`, and `ReceiptTallyMap.verifyBalanceProof(proof, root)` checks it against the committed root.

For a serialized bundle, use `tally.getBalanceClaim(accountId)`. That returns the proof plus root and snapshot metadata as a JSON-friendly object, and `ReceiptTallyMap.verifyBalanceClaim(claim, root)` validates it off-chain.

The transition witness can carry `balanceClaim` alongside `balanceClaimEpochId`, `balanceClaimBalanceSats`, `balanceClaimLeafHash`, and `balanceClaimRoot` so the account-specific proof bundle stays attached to the route transition.
The current circuit scaffold consumes a bounded `balanceClaimIndex` plus `balanceClaimSiblings` array at depth 16 to verify membership against the committed balance root.
The same bundle now carries `challengeWindowStart`, `challengeWindowLength`, and `challengeWindowEnd`, so redemption timing can be bounded separately from the claim's epoch.

The default template in `m1_spec.js` now exposes `settlement.challengeWindowLength` so the window size can be fixed at contract-definition time.

For expiry redemptions, use the sidecar witness blob instead of mutating the canonical tally snapshot:

```javascript
const referee = require('./bitvm3/utxo_referee');
const delta = referee.buildSettlementDeltaAnnotation({
  epochId: 1n,
  route: 'roll',
  depositedSats: 798100n,
  redeemedSats: 783735n,
  pnlReferenceSats: 798100n,
  realizedPnlSats: -14365n
});
```

That keeps the committed `receipt-tally-map` hash stable while still carrying `redeemedSats`, `pnlGainSats`, `pnlLossSats`, and `netDeltaSats` in the witness output.
The same sidecar now also names the settlement remainder explicitly:
- `winnerSweepSats` for the primary payout
- `refundSats` / `residualSats` for the returned remainder
- `winnerPnlSats` and `loserPnlSats` for the economic attribution
- `dustCarrySats` for rounding carry into the next epoch or residual bucket
- `timeoutRemainderSats` for the non-carried roll-path remainder when the timeout branch needs it as a first-class field
- `winnerAddress`, `refundAddress`, `feeAddress`, and `dustAddress` as first-class recipient commitments on each settlement path

For exact output verification, use the routing verifier:

```javascript
const referee = require('./bitvm3/utxo_referee');
const legacy = referee.legacyUnsafe.load({ acknowledgeUnsafePrototype: true });
const result = legacy.verifySettlementRouting(
  {
    route: 'roll',
    collateralSats: 798100n,
    rolloverCollateralSats: 783735n,
    feeSats: 0n,
    dustCarrySats: 0n,
    winnerAddress: 'tltc1q...',
    refundAddress: 'tltc1q...'
  },
  {
    outputs: [
      { role: 'winner-sweep', address: 'tltc1q...', amountSats: 783735n },
      { role: 'refund-remainder', address: 'tltc1q...', amountSats: 14365n }
    ]
  }
);
```

To validate the latest draft/witness/expiry/proof artifacts together, run:

```bash
node bitvm3/utxo_referee/m1_validate_latest_settlement.js
```

For a testnet-friendly expiry artifact, run:

```bash
node bitvm3/utxo_referee/m1_expiry_redemption.js
```

For event-driven rolls, the repo also includes an OP_RETURN delta-publication artifact:

```javascript
const referee = require('./bitvm3/utxo_referee');
const pub = referee.buildOracleDeltaPublication({
  oracleBinding: {
    eventId: 'm1_oracle_event_123',
    quorumId: 'quorum_1of1',
    keyId: 'oracle_key_1',
    oracleMapId: 'abcd1234ef567890'
  },
  selectedPath: {
    pathId: 'roll',
    residualSats: 758195n,
    adaptorSignaturePlaceholder: 'adaptor_sig_for_roll'
  }
});
```

That publication is an off-chain trigger that maps the original DLC oracle slot to the next contract handoff. It does not mean Bitcoin Script is constructing the new transaction on its own.

To generate the fast-roll artifact, run:

```bash
node bitvm3/utxo_referee/m1_fast_roll.js
```

To emit the wallet-facing procedural sync summary from the latest BitVM
artifacts, run:

```bash
node bitvm3/utxo_referee/m1_procedural_sync.js
```

This writes:
- `bitvm3/utxo_referee/artifacts/bitvm_procedural_sync_latest.json`

To build a parallel UTXO index from the latest funding, CET, expiry, and timeout
artifacts, run:

```bash
node bitvm3/utxo_referee/m1_parallel_utxo_index.js
```

This writes:
- `bitvm3/utxo_referee/artifacts/m1_parallel_utxo_index_latest.json`

To build BitVM-facing search-manifold experiments from the latest challenge,
procedural, and anchor artifacts, run:

```bash
node bitvm3/utxo_referee/m1_bitvm_search_manifolds.js
```

This writes:
- `bitvm3/utxo_referee/artifacts/m1_bitvm_search_manifolds_latest.json`
- `bitvm3/utxo_referee/artifacts/m1_bitvm_search_manifolds_latest.md`

The current manifold bench covers:
- transcript multiplicity for controlled alias families versus dangerous digest collapse
- identifier bifurcation for txid-like anchor search around a stable settlement core

These are overlay/search experiments, not claims that the repo already emits
real alternative Bitcoin txids for the same witness core.

## Lightning Integration Prototypes

To generate deterministic Lightning-facing BitVM/DLC prototype artifacts, run:

```bash
node bitvm3/utxo_referee/lightning_integration_demo.js
```

This covers:
- Lightning-funded BitVM/DLC position opening via a submarine-swap-shaped transcript
- Lightning payout compression with preimage receipts and on-chain fallbacks
- Watchtower bounty payment receipts over Lightning
- LDK/BDK-style contract-open API surface
- Lightning-funded roll-forward collateral top-ups

This writes:
- `bitvm3/utxo_referee/artifacts/lightning_integration_latest.json`
- `bitvm3/utxo_referee/artifacts/lightning_integration_latest.md`

Details are in `LIGHTNING_INTEGRATION_PROTOTYPES.md`.

To probe local testnet chain/Lightning daemons and document what is live, run:

```bash
node bitvm3/utxo_referee/lightning_live_testnet_demo.js
```

This writes:
- `bitvm3/utxo_referee/artifacts/lightning_live_testnet_demo_latest.json`
- `bitvm3/utxo_referee/artifacts/lightning_live_testnet_demo_latest.md`

Details are in `LIGHTNING_LIVE_TESTNET_DEMO.md`.

For a wallet-fork demo that uses Bitcoin testnet as a remote/proof-backed UI
target while keeping Litecoin testnet as the local live chain harness, see
`TESTNET_WALLET_DEMO_PLAN.md`.

To start a local Core Lightning regtest sandbox and pay a real invoice over a
live Alice-to-Bob channel, run:

```powershell
wsl -d Ubuntu --exec /bin/bash /mnt/c/projects/UTXORef/UTXO-Ref/bitvm3/utxo_referee/cln_regtest_demo.sh
```

This writes:
- `bitvm3/utxo_referee/artifacts/cln_regtest_demo_latest.json`
- `bitvm3/utxo_referee/artifacts/cln_regtest_demo_latest.md`

Details are in `LIGHTNING_CLN_REGTEST_DEMO.md`.

To run the live regtest submarine-swap-shaped funding bridge into an actual
BitVM/DLC commitment output, run:

```bash
node bitvm3/utxo_referee/lightning_subswap_dlc_demo.js
```

This writes:
- `bitvm3/utxo_referee/artifacts/lightning_subswap_dlc_latest.json`
- `bitvm3/utxo_referee/artifacts/lightning_subswap_dlc_latest.md`

To layer a BitVM-backed liquidity lease over the latest HTLC/subswap proof, run:

```bash
node bitvm3/utxo_referee/lightning_liquidity_lease_demo.js
```

This writes:
- `bitvm3/utxo_referee/artifacts/lightning_liquidity_lease_latest.json`
- `bitvm3/utxo_referee/artifacts/lightning_liquidity_lease_latest.md`

To generate a BTC-only bilateral Lightning DLC where a TradeLayer tx14
OP_RETURN oracle-price publication is the trigger, run:

```bash
node bitvm3/utxo_referee/lightning_tradelayer_oracle_dlc_demo.js
```

This writes:
- `bitvm3/utxo_referee/artifacts/lightning_tradelayer_oracle_dlc_latest.json`
- `bitvm3/utxo_referee/artifacts/lightning_tradelayer_oracle_dlc_latest.md`

To generate integration artifacts for LDK Server and ZEUS-style wallet demos,
run:

```bash
node bitvm3/utxo_referee/lightning_wallet_integration_demo.js
```

This writes:
- `bitvm3/utxo_referee/artifacts/lightning_wallet_integration_latest.json`
- `bitvm3/utxo_referee/artifacts/lightning_wallet_integration_latest.md`

The sidecar API can be served with:

```bash
node integrations/lightning-liquidity-lease-sidecar/server.js
```

To generate a Spiral/LDK-facing value-add brief that maps the Lightning
prototype to public LDK commit themes, run:

```bash
node bitvm3/utxo_referee/spiral_ldk_value_add_demo.js
```

This writes:
- `bitvm3/utxo_referee/artifacts/spiral_ldk_value_add_latest.json`
- `bitvm3/utxo_referee/artifacts/spiral_ldk_value_add_latest.md`

Details are in `SPIRAL_LDK_VALUE_ADD.md`.

To regenerate the full funded-epoch artifact chain in one command, run:

```bash
node bitvm3/utxo_referee/m1_pipeline.js
```

Defaults:
- runs in `M1_PIPELINE_MODE=fresh`, which requires Litecoin RPC for `bootstrap -> psbt -> finalize`
- `M1_PIPELINE_MODE=replay` skips those live wallet steps and reuses the current `*_latest.json` artifacts
- selects the `roll` path unless `M1_PATH_NAME` or `M1_BUCKET_PCT` is set
- finalizes funding with `BROADCAST_FUNDING=0` unless `M1_BROADCAST_FUNDING=1`
- runs `m1_validate_latest_settlement.js` only when `m1_expiry_timeout_testnet_proof.json` exists and still matches the latest regenerated expiry artifact, unless `M1_FORCE_SETTLEMENT_VALIDATION=1`

This writes:
- `bitvm3/utxo_referee/artifacts/m1_pipeline_latest.json`

