# Implementation Notes for TradeLayer Founder

## Your Specific Requirements - Implementation Status

### ✅ 1. NEAR Contracts for Oracles and Relayers

**Oracle Contract** (`oracle-contract.ts`):
- ✓ Multiple oracles can register with stake
- ✓ Quorum management (e.g., 3-of-5)
- ✓ State report submission with signatures
- ✓ DLC outcome attestation at maturity
- ✓ Aurora light client integration for TradeLayer verification
- ✓ Fraud proof system (v2 ready)
- ✓ Oracle slashing mechanism

**Profit Sweeps Relayer** (`profit-sweeps-relayer.ts`):
- ✓ Can be controlled by same or different address as oracle
- ✓ Processes rBTC → BTC redemptions
- ✓ Tracks DLC pools
- ✓ Submits payment proofs
- ✓ Authorized operator pattern for secure operations

### ✅ 2. TradeLayer Core Transaction Types

**Implemented** (`tradelayer-tx-types.ts` + `rbtc-transaction-processor.ts`):
- ✓ TX_DLC_DEPOSIT_MINT (100) - Emit rBTC based on canonical DLC hash + funding tx
- ✓ TX_REDEEM_BURN (101) - Burn rBTC and request BTC payout
- ✓ TX_REGISTER_ORACLE_CONTRACT (102) - Register NEAR oracle
- ✓ TX_REGISTER_RELAYER_CONTRACT (103) - Register NEAR relayer

**Reserved for v2**:
- ✓ TX_ORACLE_STAKE (104) - Staking transaction structure ready
- ✓ TX_FRAUD_PROOF (105) - Fraud proof transaction structure ready

### ✅ 3. Oracle Types and Confederation

**Oracle Types** (in `oracle-contract.ts`):
```typescript
// Special oracle type allows:
- Initially: Single authorized oracle address
- Later: Confederation of addresses with quorum threshold

// Example usage:
await oracleContract.registerOracle({
  stateKey: 'oracle_state_key',
  dlcKey: 'oracle_dlc_key'
});

await oracleContract.createQuorum({
  quorumId: 'quorum_001',
  oracleKeys: ['oracle1.near', 'oracle2.near', 'oracle3.near'],
  threshold: 2  // 2-of-3
});
```

**State Relay** (in `oracle-contract.ts`):
- ✓ Oracles relay TradeLayer state
- ✓ Submit state roots with signatures
- ✓ Reference specific Bitcoin block ranges
- ✓ Link to TradeLayer block heights

### ✅ 4. Aurora Light Client Integration

**Bridge Implementation** (`aurora-bridge.ts`):
```typescript
// Verify TradeLayer transactions are included in valid blocks
await bridge.verifyTradeLayerTransaction(txHash, inclusionProof);

// Verify oracle transactions using Aurora light client
const verified = await this.verifyTradeLayerState(
  proof,           // Merkle proof
  stateRoot        // State root
);

// Both profit relayer and oracle use Aurora LC to confirm:
// 1. TradeLayer transactions are in confirmed blocks
// 2. State roots are valid
// 3. No double-spending or invalid state transitions
```

## Integration with Your Semi-Working DLC

Your existing DLC for interest-based lending can be adapted:

```typescript
// Your existing DLC structure
interface YourDLC {
  fundingTxId: string;
  fundingVout: number;
  amount: bigint;
  // ... your fields
}

// Wrap it for rBTC system
function adaptExistingDLC(yourDLC: YourDLC): DLCDepositMint {
  return {
    txType: TradeLayerTxType.TX_DLC_DEPOSIT_MINT,
    version: 1,
    dlcId: generateDLCId(yourDLC),
    contractHash: computeHash(yourDLC),
    fundingTxId: yourDLC.fundingTxId,
    fundingVout: yourDLC.fundingVout,
    collateralSats: yourDLC.amount,
    // Map your DLC fields to rBTC structure
    maturityHeight: yourDLC.maturityDate,
    cltvRefundHeight: yourDLC.maturityDate + 1008,
    oraclePoolId: 'quorum_001',
    propertyId: RBTC_PROPERTY_ID,
    rbtcAmount: yourDLC.amount, // 1:1 for simplicity
    recipientAddress: 'user_address',
    fundingProof: 'your_spv_proof',
    signature: 'user_signature'
  };
}
```

## Deployment Checklist

### 1. NEAR Contracts
```bash
# Build NEAR contracts
cd near-contracts/
npm run build

# Deploy oracle
near deploy --accountId rbtc-oracle.testnet \
  --wasmFile ./build/oracle.wasm \
  --initFunction init \
  --initArgs '{"owner": "your-account.testnet", "minStake": "1000000000000000000000000", "auroraLightClient": "aurora.testnet"}'

# Deploy relayer
near deploy --accountId rbtc-relayer.testnet \
  --wasmFile ./build/relayer.wasm \
  --initFunction init \
  --initArgs '{"owner": "your-account.testnet", "oracleContract": "rbtc-oracle.testnet", "minRedemption": "10000"}'
```

### 2. TradeLayer Core
```typescript
// In your TradeLayer node
import { RBTCTransactionProcessor } from './rbtc-transaction-processor';

// Initialize processor
const rbtcProcessor = new RBTCTransactionProcessor();

// Register transaction handlers
tradeLayerNode.registerTxHandler(
  TradeLayerTxType.TX_DLC_DEPOSIT_MINT,
  (tx) => rbtcProcessor.processTransaction(tx)
);

tradeLayerNode.registerTxHandler(
  TradeLayerTxType.TX_REDEEM_BURN,
  (tx) => rbtcProcessor.processTransaction(tx)
);

// ... register other handlers
```

### 3. Register Contracts
```typescript
// After deploying NEAR contracts, register them in TradeLayer
const registerOracle: RegisterOracleContract = {
  txType: TradeLayerTxType.TX_REGISTER_ORACLE_CONTRACT,
  version: 1,
  contractAddress: 'rbtc-oracle.testnet',
  contractCodeHash: '0xabcd...', // Hash of deployed WASM
  quorumIds: ['quorum_001'],
  isActive: true,
  registeredBy: 'admin.tl',
  signature: 'admin_sig'
};

await broadcastToTradeLayer(registerOracle);
```

## Configuration Examples

### Single Oracle (v1 - Trust Model)
```typescript
// Just one oracle initially
await oracleContract.registerOracle({
  stateKey: 'founder.near',
  dlcKey: 'founder-dlc.near'
});

// Create quorum with single oracle
await oracleContract.createQuorum({
  quorumId: 'quorum_001',
  oracleKeys: ['founder.near'],
  threshold: 1,
  leverageFactor: 5  // Conservative for v1
});
```

### Oracle Confederation (v1 → v2 Transition)
```typescript
// Add more oracles
await oracleContract.registerOracle({
  stateKey: 'oracle2.near',
  dlcKey: 'oracle2-dlc.near'
});

await oracleContract.registerOracle({
  stateKey: 'oracle3.near',
  dlcKey: 'oracle3-dlc.near'
});

// Update quorum to multi-oracle
await oracleContract.createQuorum({
  quorumId: 'quorum_002',
  oracleKeys: [
    'founder.near',
    'oracle2.near',
    'oracle3.near'
  ],
  threshold: 2,  // 2-of-3
  leverageFactor: 10
});
```

## Aurora Light Client Verification Flow

```
┌─────────────────┐
│  TradeLayer TX  │ (DLC deposit, burn, etc.)
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│ Create Merkle   │ (Transaction → Merkle proof)
│ Inclusion Proof │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│  Submit to NEAR │ (Cross-chain via Aurora LC)
│ Oracle Contract │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│ Verify via      │ (Check Merkle proof + block headers)
│ Aurora LC       │
└────────┬────────┘
         │
         ↓
┌─────────────────┐
│ Accept/Reject   │ (Oracle processes if valid)
│ Transaction     │
└─────────────────┘
```

## Testing Strategy

### 1. Unit Tests
```bash
# Test each component individually
npm test -- oracle-contract.test.ts
npm test -- profit-sweeps-relayer.test.ts
npm test -- rbtc-transaction-processor.test.ts
```

### 2. Integration Tests
```bash
# Test cross-chain communication
npm test -- aurora-bridge.test.ts

# Test complete flow
npm test -- end-to-end.test.ts
```

### 3. Local Testnet
```bash
# Run local NEAR testnet
near-sandbox

# Deploy contracts locally
./scripts/deploy-local.sh

# Run demo
npm run demo:local
```

## Production Considerations

### Security
1. **Oracle Key Management**: Use hardware wallets or MPC for oracle keys
2. **Smart Contract Audits**: Audit NEAR contracts before mainnet
3. **Rate Limiting**: Implement rate limits on redemptions
4. **Monitoring**: Set up alerts for:
   - Unusual redemption volumes
   - Oracle downtime
   - Supply invariant violations

### Performance
1. **Batch Operations**: Batch multiple redemptions in single BTC transaction
2. **State Compression**: Use Merkle trees efficiently
3. **Caching**: Cache frequently accessed DLC states

### Economics
1. **Fee Structure**: Determine redemption fees (currently 0.1% = 10 bps)
2. **Staking Amounts**: Set minimum oracle stakes
3. **TVL Caps**: Set per-quorum TVL limits based on risk tolerance

## Common Integration Issues

### Issue 1: Bitcoin SPV Proofs
**Problem**: Verifying Bitcoin transactions on-chain is expensive.

**Solution**: Implemented in `aurora-bridge.ts`:
```typescript
async verifyBitcoinFundingProof(
  txId: string,
  vout: number,
  expectedAmount: bigint,
  proof: string
): Promise<boolean>
```

### Issue 2: Cross-Chain State Sync
**Problem**: TradeLayer state must be verifiable in NEAR.

**Solution**: Aurora light client integration:
```typescript
async verifyTradeLayerState(
  proof: string,
  stateRoot: string
): Promise<boolean>
```

### Issue 3: Oracle Coordination
**Problem**: Multiple oracles must agree on outcomes.

**Solution**: Quorum-based attestation:
```typescript
// Require threshold signatures
if (outcome.signatures.size >= quorum.threshold) {
  // Outcome is valid
}
```

## Next Steps for You

1. **Review the code**: Start with `demo.ts` to see the full flow
2. **Test locally**: Run `npm run demo` to see it work
3. **Customize**: Adjust parameters in configs
4. **Deploy testnet**: Deploy NEAR contracts to testnet
5. **Integrate**: Connect to your existing TradeLayer node
6. **Test end-to-end**: Full cycle from deposit to redemption
7. **Production**: Audit, test more, then mainnet

## Contact Points for Support

If you need help with:
- **DLC Construction**: See `dlc-builder.ts`
- **NEAR Contracts**: See `oracle-contract.ts` and `profit-sweeps-relayer.ts`
- **TradeLayer Integration**: See `rbtc-transaction-processor.ts`
- **Cross-Chain**: See `aurora-bridge.ts`
- **Full Flow**: See `demo.ts`

All code is well-commented and follows TypeScript best practices for easy modification.
