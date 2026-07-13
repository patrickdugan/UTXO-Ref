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

