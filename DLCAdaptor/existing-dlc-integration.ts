/**
 * Integration Example: Adapting Existing DLC to rBTC System
 * 
 * This shows how to integrate your existing DLC for interest-based lending
 * into the rBTC architecture.
 */

import { RBTCTransactionProcessor } from './rbtc-transaction-processor';
import { DLCBuilder } from './dlc-builder';
import {
  TradeLayerTxType,
  DLCDepositMint,
  DLCRegistryEntry
} from './tradelayer-tx-types';

/**
 * Example: Your existing DLC structure from the lending startup
 * (Adapt these fields to match your actual implementation)
 */
interface ExistingLendingDLC {
  // Bitcoin funding
  fundingTxId: string;
  fundingVout: number;
  fundingAmount: bigint;
  
  // Loan parameters
  principal: bigint;
  interestRate: number;      // e.g., 5 = 5% annual
  duration: number;          // in blocks
  maturityBlock: number;
  
  // Parties
  lenderPubkey: string;
  borrowerPubkey: string;
  
  // DLC specifics
  oracleKey: string;
  contractId: string;
  
  // CETs for different outcomes
  cets: {
    fullRepayment: string;   // CET if borrower repays
    partialDefault: string;  // CET if partial default
    fullDefault: string;     // CET if full default
  };
  
  // Timelock
  refundHeight: number;      // CLTV for lender refund
}

/**
 * Adapter class to convert existing DLC to rBTC format
 */
export class ExistingDLCAdapter {
  /**
   * Convert your existing lending DLC to rBTC DLC deposit transaction
   */
  static toRBTCDeposit(
    existingDLC: ExistingLendingDLC,
    recipientAddress: string,
    oraclePoolId: string = 'quorum_001'
  ): DLCDepositMint {
    // Generate rBTC-compatible DLC ID
    const dlcId = this.generateRBTCDLCId(existingDLC);
    
    // Compute contract hash
    const contractHash = this.computeContractHash(existingDLC);
    
    // Create rBTC deposit transaction
    const deposit: DLCDepositMint = {
      txType: TradeLayerTxType.TX_DLC_DEPOSIT_MINT,
      version: 1,
      
      // DLC identification
      dlcId,
      contractHash,
      
      // Bitcoin funding (reuse from existing DLC)
      fundingTxId: existingDLC.fundingTxId,
      fundingVout: existingDLC.fundingVout,
      collateralSats: existingDLC.fundingAmount,
      
      // Timelock parameters
      maturityHeight: existingDLC.maturityBlock,
      cltvRefundHeight: existingDLC.refundHeight,
      
      // Oracle configuration
      oraclePoolId,
      
      // rBTC minting (1:1 with collateral for simplicity)
      propertyId: 2147483651, // rBTC property ID
      rbtcAmount: existingDLC.fundingAmount,
      recipientAddress,
      
      // Proof and signature
      fundingProof: this.generateFundingProof(existingDLC),
      signature: '' // To be signed by lender/depositor
    };
    
    return deposit;
  }
  
  /**
   * Map your DLC outcomes to rBTC default fraction buckets
   */
  static mapOutcomesToDefaultFractions(
    existingDLC: ExistingLendingDLC
  ): Map<string, number> {
    // Your DLC has 3 outcomes, map to rBTC buckets:
    return new Map([
      [existingDLC.cets.fullRepayment, 0],    // 0% default
      [existingDLC.cets.partialDefault, 50],  // 50% default
      [existingDLC.cets.fullDefault, 100]     // 100% default
    ]);
  }
  
  /**
   * Create rBTC-compatible DLC using your existing structure
   */
  static createRBTCCompatibleDLC(
    existingDLC: ExistingLendingDLC,
    oraclePoolId: string = 'quorum_001'
  ) {
    // Build new DLC structure with rBTC outcome buckets
    const rbtcDLC = DLCBuilder.buildDLC({
      fundingAmount: existingDLC.fundingAmount,
      maturityHeight: existingDLC.maturityBlock,
      refundLocktime: existingDLC.refundHeight,
      oraclePoolId,
      oraclePublicKeys: [existingDLC.oracleKey],
      eventId: `lending_${existingDLC.contractId}`
    });
    
    // Map your existing CETs to rBTC outcomes
    // This allows your existing DLC infrastructure to work with rBTC
    const outcomeMapping = this.mapOutcomesToDefaultFractions(existingDLC);
    
    return {
      rbtcDLC,
      outcomeMapping,
      existingDLC
    };
  }
  
  // Helper methods
  
  private static generateRBTCDLCId(dlc: ExistingLendingDLC): string {
    // Combine contract ID with a prefix
    return `rbtc_${dlc.contractId}`;
  }
  
  private static computeContractHash(dlc: ExistingLendingDLC): string {
    // Hash the DLC parameters
    const crypto = require('crypto');
    const data = JSON.stringify({
      fundingTxId: dlc.fundingTxId,
      fundingVout: dlc.fundingVout,
      fundingAmount: dlc.fundingAmount.toString(),
      maturityBlock: dlc.maturityBlock,
      refundHeight: dlc.refundHeight,
      contractId: dlc.contractId
    });
    
    return crypto.createHash('sha256').update(data).digest('hex');
  }
  
  private static generateFundingProof(dlc: ExistingLendingDLC): string {
    // If you already have SPV proof generation, reuse it
    // Otherwise, placeholder for now
    return `spv_proof_${dlc.fundingTxId}`;
  }
}

/**
 * Example usage: Integrating your existing DLC flow
 */
export async function integrateExistingDLC() {
  console.log('\n=== Integrating Existing Lending DLC with rBTC ===\n');
  
  // 1. Your existing DLC from the lending startup
  const existingDLC: ExistingLendingDLC = {
    fundingTxId: 'abc123...',
    fundingVout: 0,
    fundingAmount: 1000000n,      // 0.01 BTC
    principal: 1000000n,
    interestRate: 5,              // 5% annual
    duration: 52560,              // ~1 year in blocks
    maturityBlock: 800000 + 52560,
    lenderPubkey: '02abc...',
    borrowerPubkey: '03def...',
    oracleKey: '04xyz...',
    contractId: 'lending_001',
    cets: {
      fullRepayment: 'cet_repay_...',
      partialDefault: 'cet_partial_...',
      fullDefault: 'cet_default_...'
    },
    refundHeight: 800000 + 52560 + 1008
  };
  
  console.log('Existing DLC:');
  console.log(`  Contract ID: ${existingDLC.contractId}`);
  console.log(`  Principal: ${existingDLC.fundingAmount} sats`);
  console.log(`  Interest: ${existingDLC.interestRate}%`);
  console.log(`  Maturity: Block ${existingDLC.maturityBlock}`);
  console.log('');
  
  // 2. Convert to rBTC deposit
  const rbtcDeposit = ExistingDLCAdapter.toRBTCDeposit(
    existingDLC,
    'lender_alice.tl',  // TradeLayer address for lender
    'quorum_001'        // Oracle pool
  );
  
  console.log('Converted to rBTC Deposit:');
  console.log(`  DLC ID: ${rbtcDeposit.dlcId}`);
  console.log(`  Contract Hash: ${rbtcDeposit.contractHash}`);
  console.log(`  rBTC to Mint: ${rbtcDeposit.rbtcAmount} sats`);
  console.log('');
  
  // 3. Process in TradeLayer
  const processor = new RBTCTransactionProcessor();
  const result = await processor.processTransaction(rbtcDeposit);
  
  if (result.isValid) {
    console.log('✓ DLC registered in TradeLayer!');
    console.log('✓ rBTC minted to lender\'s address');
    console.log('');
    
    // 4. Create rBTC-compatible DLC structure
    const { rbtcDLC, outcomeMapping } = ExistingDLCAdapter.createRBTCCompatibleDLC(
      existingDLC,
      'quorum_001'
    );
    
    console.log('rBTC DLC Structure:');
    console.log(`  Outcomes: ${rbtcDLC.contractInfo.outcomes.length}`);
    console.log('  Outcome Mapping:');
    for (const [cet, bucket] of outcomeMapping) {
      console.log(`    ${cet.slice(0, 20)}... → ${bucket}% default`);
    }
    console.log('');
    
    // 5. Show how your existing oracle can sign outcomes
    console.log('At maturity, your oracle should:');
    console.log('  1. Determine loan outcome (repaid/defaulted)');
    console.log('  2. Map to default fraction:');
    console.log('     - Full repayment → 0% default');
    console.log('     - Partial default → 50% default');
    console.log('     - Full default → 100% default');
    console.log('  3. Sign the corresponding outcome bucket');
    console.log('  4. Submit to NEAR oracle contract');
    console.log('');
    
    // 6. Show redemption flow
    console.log('After maturity:');
    console.log('  - Lender can redeem rBTC back to BTC');
    console.log('  - Amount depends on default fraction');
    console.log('  - If 0% default: full 1,000,000 sats returned');
    console.log('  - If 50% default: 500,000 sats returned');
    console.log('  - If 100% default: 0 sats returned (lender lost principal)');
    console.log('');
    
  } else {
    console.error('✗ Failed to register DLC:', result.errorMessage);
  }
  
  console.log('=== Integration Complete ===\n');
}

/**
 * Advanced: Create a lending pool using multiple DLCs
 */
export class LendingPoolAdapter {
  private processor: RBTCTransactionProcessor;
  private dlcs: Map<string, DLCRegistryEntry>;
  
  constructor(processor: RBTCTransactionProcessor) {
    this.processor = processor;
    this.dlcs = new Map();
  }
  
  /**
   * Add multiple lending DLCs to create a pool
   */
  async addLoanToPo ol(
    existingDLC: ExistingLendingDLC,
    lenderAddress: string
  ): Promise<boolean> {
    const deposit = ExistingDLCAdapter.toRBTCDeposit(
      existingDLC,
      lenderAddress
    );
    
    const result = await this.processor.processTransaction(deposit);
    
    if (result.isValid) {
      const registeredDLC = this.processor.getDLC(deposit.dlcId);
      if (registeredDLC) {
        this.dlcs.set(deposit.dlcId, registeredDLC);
        console.log(`✓ Added loan ${existingDLC.contractId} to pool`);
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Get pool statistics
   */
  getPoolStats() {
    let totalCollateral = 0n;
    let totalRBTC = 0n;
    let activeLoans = 0;
    
    for (const [_, dlc] of this.dlcs) {
      if (dlc.status === 'active') {
        totalCollateral += dlc.collateralSats;
        totalRBTC += dlc.rbtcAmount;
        activeLoans++;
      }
    }
    
    return {
      totalCollateral,
      totalRBTC,
      activeLoans,
      loansCount: this.dlcs.size
    };
  }
}

// Run the example
if (require.main === module) {
  integrateExistingDLC().catch(console.error);
}
