# Quick Start Guide

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Compile TypeScript:**
   ```bash
   npm run build
   ```

3. **Run the demo:**
   ```bash
   npm run demo
   ```

## File Structure

```
tradelayer-rbtc/
├── package.json                      # Project dependencies
├── tsconfig.json                     # TypeScript configuration
├── README.md                         # Full documentation
├── QUICKSTART.md                     # This file
│
├── oracle-contract.ts                # NEAR oracle contract
├── profit-sweeps-relayer.ts         # NEAR relayer contract
├── tradelayer-tx-types.ts           # Transaction type definitions
├── rbtc-transaction-processor.ts    # TradeLayer core logic
├── aurora-bridge.ts                  # Cross-chain integration
├── dlc-builder.ts                    # DLC construction utilities
└── demo.ts                           # Complete demo script
```

## Key Contracts

### 1. NEAR Oracle Contract (`oracle-contract.ts`)
- Manages oracle quorums
- Signs DLC outcomes at maturity
- Handles fraud proofs (v2)

**Deploy to NEAR:**
```bash
near deploy --accountId rbtc-oracle.near --wasmFile contract.wasm
```

### 2. NEAR Relayer Contract (`profit-sweeps-relayer.ts`)
- Processes redemptions (rBTC → BTC)
- Routes BTC payments
- Tracks DLC pools

**Deploy to NEAR:**
```bash
near deploy --accountId rbtc-relayer.near --wasmFile relayer.wasm
```

### 3. TradeLayer Core (`rbtc-transaction-processor.ts`)
- Processes DLC deposits/mints
- Handles redemptions/burns
- Enforces supply invariants

**Integration:** Include in TradeLayer protocol node

## Example Usage

### 1. Create a DLC
```typescript
import { DLCBuilder } from './dlc-builder';

const dlc = DLCBuilder.buildDLC({
  fundingAmount: 1000000n,      // 0.01 BTC
  maturityHeight: 800100,
  refundLocktime: 800200,
  oraclePoolId: 'quorum_001',
  oraclePublicKeys: ['oracle1.near', 'oracle2.near', 'oracle3.near'],
  eventId: 'rbtc_epoch_42'
});
```

### 2. Deposit & Mint rBTC
```typescript
import { RBTCTransactionProcessor } from './rbtc-transaction-processor';
import { DLCDepositMint } from './tradelayer-tx-types';

const processor = new RBTCTransactionProcessor();

const deposit: DLCDepositMint = {
  txType: 100,
  dlcId: dlc.id,
  fundingTxId: 'bitcoin_tx_id',
  collateralSats: 1000000n,
  rbtcAmount: 1000000n,
  // ... other fields
};

await processor.processTransaction(deposit);
// Result: 1,000,000 rBTC minted
```

### 3. Redeem to BTC
```typescript
import { RedeemBurn } from './tradelayer-tx-types';

const redemption: RedeemBurn = {
  txType: 101,
  rbtcAmount: 500000n,
  btcAddress: 'bc1q...',
  relayerContract: 'rbtc-relayer.near',
  // ... other fields
};

await processor.processTransaction(redemption);
// NEAR relayer will pay BTC to the address
```

## Testing

### Run tests:
```bash
npm test
```

### Test DLC construction:
```typescript
import { demonstrateDLCConstruction } from './dlc-builder';
demonstrateDLCConstruction();
```

### Test full integration:
```typescript
import { demonstrateIntegration } from './aurora-bridge';
await demonstrateIntegration();
```

## Configuration

### Oracle Quorum Setup
```typescript
// In your NEAR oracle contract
await oracleContract.createQuorum({
  quorumId: 'quorum_001',
  oracleKeys: ['oracle1.near', 'oracle2.near', 'oracle3.near'],
  threshold: 2,           // 2-of-3
  leverageFactor: 10      // 10x TVL cap
});
```

### TradeLayer Integration
```typescript
// In TradeLayer protocol node
import { RBTCTransactionProcessor } from './rbtc-transaction-processor';

const rbtcProcessor = new RBTCTransactionProcessor();

// Register with TradeLayer transaction handler
tradeLayer.registerTxProcessor('rbtc', rbtcProcessor);
```

## Next Steps

1. **Review Architecture:** Read the full [README.md](README.md)
2. **Run Demo:** Execute `npm run demo` to see the complete flow
3. **Deploy NEAR Contracts:** Deploy oracle and relayer to NEAR testnet
4. **Integration Testing:** Test with TradeLayer testnet
5. **Production Prep:** 
   - Audit smart contracts
   - Implement production SPV proofs
   - Set up Bitcoin node integration
   - Deploy to mainnet

## Common Issues

### TypeScript Errors
```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

### NEAR Contract Deployment
```bash
# Login to NEAR
near login

# Create account
near create-account rbtc-oracle.testnet --masterAccount your-account.testnet

# Deploy
near deploy --accountId rbtc-oracle.testnet --wasmFile contract.wasm
```

### Bitcoin Integration
- Ensure Bitcoin Core is running
- Configure RPC access in `.env`
- Test SPV proof generation

## Support

- Documentation: See [README.md](README.md)
- Issues: [GitHub Issues]
- Discussions: [Discord/Telegram]

## Resources

- [TradeLayer Docs](https://docs.tradelayer.io)
- [DLC Specifications](https://github.com/discreetlogcontracts/dlcspecs)
- [NEAR Docs](https://docs.near.org)
- [Aurora Bridge](https://aurora.dev)
