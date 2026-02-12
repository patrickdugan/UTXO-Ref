# TradeLayer rBTC Implementation

A Bitcoin-native synthetic BTC (rBTC) system built on TradeLayer, backed by real BTC locked in Discreet Log Contracts (DLCs), with NEAR-based oracles for state attestation and profit sweeps.

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Bitcoin Layer                            │
│  • DLC Funding Transactions (Taproot, CLTV refunds)             │
│  • Contract Execution Transactions (CETs)                        │
│  • Self-custodial: Users can always reclaim via CLTV            │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────────────────┐
│                      TradeLayer Protocol                         │
│  • DLC Registry (dlcId → funding UTXO, maturity, rBTC amount)  │
│  • rBTC Token Ledger (mint/burn operations)                     │
│  • New Transaction Types:                                        │
│    - TX_DLC_DEPOSIT_MINT    (register DLC, mint rBTC)          │
│    - TX_REDEEM_BURN          (burn rBTC, request BTC)           │
│    - TX_REGISTER_ORACLE      (register NEAR oracle)             │
│    - TX_REGISTER_RELAYER     (register NEAR relayer)            │
│    - TX_PNL_SETTLEMENT       (DLC maturity outcomes)            │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ↓ (Aurora Light Client)
┌─────────────────────────────────────────────────────────────────┐
│                        NEAR Contracts                            │
│  ┌───────────────────────────┐  ┌─────────────────────────────┐│
│  │   Oracle Contract         │  │  Profit Sweeps Relayer      ││
│  │  • State attestation      │  │  • Process redemptions      ││
│  │  • DLC outcome signing    │  │  • Pay BTC to redeemers     ││
│  │  • Quorum management      │  │  • Track DLC pools          ││
│  │  • Fraud proof handling   │  │  • PnL settlement           ││
│  └───────────────────────────┘  └─────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## 📦 Components

### 1. **TradeLayer Core** (`rbtc-transaction-processor.ts`)
- Processes new rBTC transaction types
- Maintains DLC registry and rBTC supply state
- Validates deposits, redemptions, and settlements
- Enforces supply invariants

### 2. **NEAR Oracle Contract** (`oracle-contract.ts`)
- Manages oracle quorums (e.g., 3-of-5 multisig)
- Signs DLC outcomes at maturity (default fraction buckets)
- Submits state reports with TradeLayer state roots
- Handles fraud proofs and oracle slashing (v2)

### 3. **NEAR Profit Sweeps Relayer** (`profit-sweeps-relayer.ts`)
- Processes rBTC → BTC redemption requests
- Routes BTC payments to users
- Manages DLC pool balances
- Handles PnL settlements

### 4. **Aurora Light Client Bridge** (`aurora-bridge.ts`)
- Verifies TradeLayer transactions in NEAR contracts
- Submits DLC deposits/redemptions to NEAR
- Fetches oracle outcomes for settlement
- Cross-chain state verification

### 5. **DLC Builder** (`dlc-builder.ts`)
- Constructs DLC contracts with outcome buckets
- Generates CETs for each default fraction (0%, 5%, ..., 100%)
- Creates CLTV refund paths
- Computes contract hashes

## 🔄 Complete Lifecycle

### Phase 1: Deposit & Mint
```typescript
// 1. User creates DLC on Bitcoin
const dlc = DLCBuilder.buildDLC({
  fundingAmount: 1000000n,      // 0.01 BTC
  maturityHeight: 800100,
  refundLocktime: 800200,
  oraclePoolId: 'quorum_001',
  // ...
});

// 2. Register DLC on TradeLayer, mint rBTC
const deposit: DLCDepositMint = {
  txType: TX_DLC_DEPOSIT_MINT,
  dlcId: dlc.id,
  fundingTxId: 'btc_tx_...',
  collateralSats: 1000000n,
  rbtcAmount: 1000000n,        // 1:1 mint ratio
  // ...
};

await tlProcessor.processTransaction(deposit);
// Result: 1,000,000 rBTC minted to user's address
```

### Phase 2: Trading
- Users trade rBTC-denominated perpetuals/options on TradeLayer
- PnL accumulates in rBTC balances
- BTC stays locked in DLCs until maturity

### Phase 3: Maturity & Settlement
```typescript
// 1. Oracle computes default fraction at maturity
// Based on: TL balances, positions, price feeds
const outcome = await bridge.fetchDLCOutcomes(dlcId, maturityHeight);
// outcome.defaultFraction = 10 (10% of collateral defaults)

// 2. Process settlement on TradeLayer
const settlement: PnLSettlement = {
  dlcId,
  defaultFraction: 10,
  losers: Map([['bob', 100000n]]),    // Bob's DLC 10% defaulted
  winners: Map([['alice', 100000n]]), // Alice gets paid
  // ...
};

await tlProcessor.processTransaction(settlement);
// Result: Losers' rBTC burned, winners can redeem BTC
```

### Phase 4: Redemption
```typescript
// User burns rBTC, requests BTC payout
const redemption: RedeemBurn = {
  txType: TX_REDEEM_BURN,
  rbtcAmount: 100000n,
  btcAddress: 'bc1q...',
  // ...
};

await tlProcessor.processTransaction(redemption);
// NEAR relayer pays BTC to user's address
```

## 🛡️ Safety Properties

### v1 (Trust-but-Verify)
- ✅ **CLTV Refunds**: Depositors can always reclaim BTC after timeout
- ✅ **Observable Oracles**: All oracle actions visible on-chain
- ✅ **Supply Invariant**: rBTC supply ≤ total BTC collateral

### v2 (Staking + Fraud Proofs)
- ✅ **Oracle Staking**: Oracles post stake (TLBTC) to participate
- ✅ **TVL Caps**: TVL_Q ≤ L × Stake_Q (e.g., 10x leverage factor)
- ✅ **Fraud Proofs**: Challenge invalid state reports
  - `REDEEM_NOT_PAID`: Claimed redemption but no BTC paid
  - `IMPOSSIBLE_DEFAULT`: Default bucket contradicts state
  - `DOUBLE_USE_DLC`: DLC reused across epochs
- ✅ **Slashing**: Fraudulent oracles lose stake and get banned

### v3 (VTXO/State Roots)
- Efficiency improvements without changing core logic
- Compressed on-chain footprint
- Same security guarantees as v2

## 🚀 Getting Started

### Prerequisites
```bash
# Node.js & TypeScript
node --version  # v18+
npm install -g typescript

# NEAR CLI (for deploying contracts)
npm install -g near-cli

# Bitcoin Core (for DLC operations)
# Download from bitcoin.org
```

### Installation
```bash
# Install dependencies
npm install near-sdk-js bitcoinjs-lib

# Compile TypeScript
tsc --build
```

### Running the Demo
```bash
# Run complete system demonstration
ts-node demo.ts
```

Expected output:
```
╔════════════════════════════════════════════════════════════════╗
║     TradeLayer rBTC - Complete System Demonstration          ║
╚════════════════════════════════════════════════════════════════╝

━━━ Phase 1: System Initialization ━━━
✓ Oracle contract registered: rbtc-oracle.near
✓ Relayer contract registered: rbtc-relayer.near

━━━ Phase 2: DLC Construction ━━━
DLC Created: a1b2c3d4e5f6
Funding Amount: 1,000,000 sats
Outcomes: 21
...
```

## 📝 Transaction Types

### TX_DLC_DEPOSIT_MINT (100)
Registers a DLC and mints rBTC.

**Fields:**
- `dlcId`: Unique DLC identifier
- `fundingTxId`, `fundingVout`: Bitcoin UTXO
- `collateralSats`: Amount locked
- `rbtcAmount`: Amount to mint
- `oraclePoolId`: Which oracle quorum
- `maturityHeight`, `cltvRefundHeight`: Timelocks

**Validation:**
- ✓ DLC not already registered
- ✓ Funding proof valid (SPV)
- ✓ Oracle pool exists
- ✓ rBTC ≤ collateral
- ✓ CLTV > maturity

### TX_REDEEM_BURN (101)
Burns rBTC and requests BTC payout.

**Fields:**
- `rbtcAmount`: Amount to burn
- `btcAddress`: Where to send BTC
- `relayerContract`: NEAR relayer

**Validation:**
- ✓ Sufficient rBTC balance
- ✓ Relayer registered

### TX_REGISTER_ORACLE_CONTRACT (102)
Registers a NEAR oracle contract.

**Fields:**
- `contractAddress`: NEAR account
- `quorumIds`: Managed quorums

### TX_PNL_SETTLEMENT (106)
Records DLC maturity outcome.

**Fields:**
- `dlcId`: Which DLC matured
- `defaultFraction`: 0-100 in 5% buckets
- `oracleSignatures`: Quorum attestations
- `winners`, `losers`: Balance changes

## 🔧 Configuration

### Oracle Quorum Setup
```typescript
// In NEAR oracle contract
await oracleContract.createQuorum({
  quorumId: 'quorum_001',
  oracleKeys: ['oracle1.near', 'oracle2.near', 'oracle3.near'],
  threshold: 2,           // 2-of-3
  leverageFactor: 10      // 10x TVL cap
});
```

### DLC Parameters
```typescript
// Typical configuration
const DLC_CONFIG = {
  maturityWindow: 1008,      // ~1 week in blocks
  refundBuffer: 1008,        // Additional 1 week for refund
  minCollateral: 10000n,     // 0.0001 BTC minimum
  defaultBuckets: [0, 5, 10, ..., 100] // 5% increments
};
```

## 📊 Supply Invariant

At all times:
```
currentSupply ≤ totalCollateral - defaultedCollateral
```

Enforced in `RBTCTransactionProcessor.checkSupplyInvariant()`.

## 🔒 Security Considerations

### v1 Trust Assumptions
- Oracles honestly report TradeLayer state
- Relayers pay BTC for valid redemptions
- Observable but not enforced via cryptoeconomics

### v2 Hardening
- Economic security via staking
- Fraud proofs enable anyone to challenge
- Per-quorum TVL caps limit blast radius

### Failure Modes
| Mode | v1 Mitigation | v2 Mitigation |
|------|---------------|---------------|
| Oracle silence | CLTV refunds | CLTV refunds + slashing |
| Incorrect default % | Observable on-chain | Fraud proofs + slashing |
| Unpaid redemption | Social pressure | Fraud proofs + slashing |
| Protocol outage | CLTV refunds | CLTV refunds |

## 🗺️ Roadmap

### v1 (Current)
- ✅ DLC + mint/redeem
- ✅ Single or small oracle confederation
- ✅ Observable but trusted

### v2 (In Progress)
- 🚧 Oracle staking (TX_ORACLE_STAKE)
- 🚧 Fraud proofs (TX_FRAUD_PROOF)
- 🚧 TVL caps per quorum
- 🚧 Slashing mechanism

### v3 (Future)
- ⏳ VTXO/state roots for efficiency
- ⏳ Compressed on-chain settlement
- ⏳ Same semantics as v1/v2

## 🤝 Contributing

This is an early implementation of the architecture described in `tl_rbtc_architecture.pdf`. Key areas for contribution:

1. **Bitcoin DLC Library**: Full implementation with rust-dlc
2. **SPV Proofs**: Robust Bitcoin light client proofs
3. **NEAR Integration**: Production Aurora light client bridge
4. **Fraud Proof System**: Complete v2 fraud proof types
5. **Testing**: Comprehensive test suite

## 📄 License

MIT License - see LICENSE file for details

## 📧 Contact

For questions or collaboration:
- TradeLayer: [website/docs]
- NEAR Oracle Contracts: [NEAR account]

---

**Note**: This is a demonstration implementation. Production deployment requires:
- Audited smart contracts
- Robust SPV proof verification  
- Bitcoin node integration
- Comprehensive testing
- Economic analysis of staking parameters
