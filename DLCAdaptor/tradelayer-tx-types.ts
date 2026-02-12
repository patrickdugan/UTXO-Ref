/**
 * TradeLayer rBTC Transaction Types
 * 
 * New transaction types for DLC-backed rBTC system:
 * - TX_DLC_DEPOSIT_MINT: Register DLC and mint rBTC
 * - TX_REDEEM_BURN: Burn rBTC and request BTC payout
 * - TX_REGISTER_ORACLE_CONTRACT: Register NEAR oracle contract
 * - TX_REGISTER_RELAYER_CONTRACT: Register NEAR relayer contract
 * - TX_ORACLE_STAKE: Oracle staking (reserved for v2)
 * - TX_FRAUD_PROOF: Submit fraud proof (reserved for v2)
 */

export enum TradeLayerTxType {
  // Existing TradeLayer types would be here (0-99)
  
  // rBTC DLC types (starting at 100)
  TX_DLC_DEPOSIT_MINT = 100,
  TX_REDEEM_BURN = 101,
  TX_REGISTER_ORACLE_CONTRACT = 102,
  TX_REGISTER_RELAYER_CONTRACT = 103,
  TX_ORACLE_STAKE = 104,        // Reserved for v2
  TX_FRAUD_PROOF = 105,          // Reserved for v2
  TX_PNL_SETTLEMENT = 106,       // Protocol-level PnL realization
}

/**
 * DLC Deposit/Mint Transaction
 * Registers a DLC funding UTXO and mints rBTC
 */
export interface DLCDepositMint {
  txType: TradeLayerTxType.TX_DLC_DEPOSIT_MINT;
  version: number;
  
  // DLC identification
  dlcId: string;                    // Unique DLC identifier
  contractHash: string;             // Hash of DLC ContractInfo + OracleAnnouncement
  
  // Bitcoin funding
  fundingTxId: string;              // Bitcoin transaction ID
  fundingVout: number;              // Output index
  collateralSats: bigint;           // Amount locked in DLC
  
  // DLC parameters
  maturityHeight: number;           // Bitcoin block height when CETs become valid
  cltvRefundHeight: number;         // CLTV refund height
  
  // Oracle/Router
  routerId?: string;                // Optional router ID
  oraclePoolId: string;             // Which oracle quorum backs this DLC
  
  // rBTC minting
  propertyId: number;               // rBTC token property ID
  rbtcAmount: bigint;               // How many rBTC to mint
  recipientAddress: string;         // TradeLayer address to receive rBTC
  
  // Signatures and proofs
  fundingProof: string;             // SPV proof that funding tx is confirmed
  signature: string;                // Signature from depositor
}

/**
 * Redeem/Burn Transaction
 * Burns rBTC and requests BTC payout
 */
export interface RedeemBurn {
  txType: TradeLayerTxType.TX_REDEEM_BURN;
  version: number;
  
  // Burn details
  propertyId: number;               // rBTC property ID
  rbtcAmount: bigint;               // Amount to burn
  senderAddress: string;            // TradeLayer address burning rBTC
  
  // BTC payout details
  btcAddress: string;               // Bitcoin address for payout
  
  // Reference to NEAR relayer
  relayerContract: string;          // NEAR relayer contract address
  requestId?: string;               // Reference ID for tracking
  
  signature: string;
}

/**
 * Register Oracle Contract
 * Registers a NEAR oracle contract as canonical source
 */
export interface RegisterOracleContract {
  txType: TradeLayerTxType.TX_REGISTER_ORACLE_CONTRACT;
  version: number;
  
  // NEAR contract details
  contractAddress: string;          // NEAR oracle contract account
  contractCodeHash: string;         // Hash of contract code (for verification)
  
  // Configuration
  quorumIds: string[];              // Quorum IDs this contract manages
  isActive: boolean;                // Whether this oracle is active
  
  // Admin
  registeredBy: string;             // TradeLayer address registering
  signature: string;
}

/**
 * Register Relayer Contract
 * Registers a NEAR profit sweeps relayer contract
 */
export interface RegisterRelayerContract {
  txType: TradeLayerTxType.TX_REGISTER_RELAYER_CONTRACT;
  version: number;
  
  // NEAR contract details
  contractAddress: string;          // NEAR relayer contract account
  contractCodeHash: string;         // Hash of contract code
  
  // Configuration
  oracleContract: string;           // Associated oracle contract
  poolIds: string[];                // DLC pool IDs this relayer manages
  isActive: boolean;
  
  // Admin
  registeredBy: string;
  signature: string;
}

/**
 * PnL Settlement (protocol-level)
 * Records DLC maturity outcome and PnL realization
 */
export interface PnLSettlement {
  txType: TradeLayerTxType.TX_PNL_SETTLEMENT;
  version: number;
  
  // DLC reference
  dlcId: string;
  maturityHeight: number;
  
  // Outcomes
  defaultFraction: number;          // 0-100 in 5% buckets
  oracleSignatures: Map<string, string>; // Oracle signatures on outcome
  
  // Affected balances
  losers: Map<string, bigint>;      // address -> defaulted amount
  winners: Map<string, bigint>;     // address -> realized PnL
  
  // State root reference
  stateRoot: string;                // NEAR oracle state root
  epochIndex: number;
}

/**
 * Oracle Stake (reserved for v2)
 */
export interface OracleStake {
  txType: TradeLayerTxType.TX_ORACLE_STAKE;
  version: number;
  
  oracleAddress: string;
  nearContract: string;
  stakeAmount: bigint;
  stakeProof: string;               // Proof of stake in NEAR contract
  signature: string;
}

/**
 * Fraud Proof (reserved for v2)
 */
export interface FraudProof {
  txType: TradeLayerTxType.TX_FRAUD_PROOF;
  version: number;
  
  // Disputed state
  epochIndex: number;
  stateRoot: string;
  
  // Fraud type
  fraudType: 'REDEEM_NOT_PAID' | 'IMPOSSIBLE_DEFAULT' | 'DOUBLE_USE_DLC';
  
  // Proof content
  merkleProof: string;
  contradictingData: string;        // Bitcoin txs, TL txs, or state data
  
  // Challenger
  challengerAddress: string;
  signature: string;
}

// Union type for all rBTC transactions
export type RBTCTransaction = 
  | DLCDepositMint 
  | RedeemBurn 
  | RegisterOracleContract 
  | RegisterRelayerContract
  | PnLSettlement
  | OracleStake
  | FraudProof;

/**
 * Transaction validation result
 */
export interface TxValidationResult {
  isValid: boolean;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * DLC Registry Entry (stored in TradeLayer state)
 */
export interface DLCRegistryEntry {
  dlcId: string;
  contractHash: string;
  fundingTxId: string;
  fundingVout: number;
  collateralSats: bigint;
  maturityHeight: number;
  cltvRefundHeight: number;
  oraclePoolId: string;
  rbtcAmount: bigint;
  recipientAddress: string;
  status: 'active' | 'matured' | 'refunded' | 'settled';
  registeredAt: number;             // Block height
  settledAt?: number;
}

/**
 * rBTC Supply Tracking
 */
export interface RBTCSupplyState {
  totalMinted: bigint;
  totalBurned: bigint;
  currentSupply: bigint;
  totalCollateral: bigint;          // Sum of all active DLC collateral
  defaultedCollateral: bigint;      // Collateral from defaulted DLCs
  invariantCheck: boolean;          // totalMinted <= totalCollateral - defaultedCollateral
}
