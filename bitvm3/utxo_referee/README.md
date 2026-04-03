# UTXO Referee

BitVM3 module for verifying sweep transactions against committed settlement rules.

## Scope

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

// Build payout tree
const leaves = [
  { epochId: 1, recipientScriptPubKey: '...', amountSats: 10000 },
  { epochId: 1, recipientScriptPubKey: '...', amountSats: 20000 }
];
const { root, proofs } = referee.buildTreeWithProofs(leaves);

// Create commitment
const commitment = new referee.CommitmentPackage({
  epochId: 1,
  withdrawalRoot: root,
  capSats: 100000,
  residualDest: Buffer.from('...')
});

// Build sweep
const sweep = new referee.SweepObject({
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
const result = referee.verifySweep(commitment, sweep);
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

**Current status**: Uses placeholder hash function. Production requires:
- Full SHA256 implementation (~22k gates per compression)
- Or alternative circuit-friendly hash (Poseidon ~300 constraints)

## TODOs

- [ ] Full Bitcoin transaction parsing
- [ ] SHA256 circuit implementation
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

