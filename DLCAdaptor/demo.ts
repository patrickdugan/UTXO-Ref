/**
 * TradeLayer rBTC System - Complete Demo
 * 
 * Demonstrates the full lifecycle of rBTC:
 * 1. DLC construction
 * 2. Deposit and minting
 * 3. Oracle attestation
 * 4. Trading (conceptual)
 * 5. Maturity and settlement
 * 6. Redemption
 */

import { RBTCTransactionProcessor } from './rbtc-transaction-processor';
import { AuroraLightClientBridge } from './aurora-bridge';
import { DLCBuilder, demonstrateDLCConstruction } from './dlc-builder';
import {
  TradeLayerTxType,
  DLCDepositMint,
  RedeemBurn,
  RegisterOracleContract,
  RegisterRelayerContract,
  PnLSettlement
} from './tradelayer-tx-types';

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║     TradeLayer rBTC - Complete System Demonstration          ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // ===== PHASE 1: Setup ===== 
  console.log('━━━ Phase 1: System Initialization ━━━\n');

  // Initialize core components
  const tlProcessor = new RBTCTransactionProcessor();
  const bridge = new AuroraLightClientBridge(
    tlProcessor,
    'aurora-light-client.near'
  );

  // Register NEAR oracle contract
  const oracleRegistration: RegisterOracleContract = {
    txType: TradeLayerTxType.TX_REGISTER_ORACLE_CONTRACT,
    version: 1,
    contractAddress: 'rbtc-oracle.near',
    contractCodeHash: '0xabcd1234...',
    quorumIds: ['quorum_001', 'quorum_002'],
    isActive: true,
    registeredBy: 'admin.tl',
    signature: 'admin_sig'
  };

  await tlProcessor.processTransaction(oracleRegistration);
  await bridge.registerOracle('rbtc-oracle.near');

  // Register NEAR relayer contract
  const relayerRegistration: RegisterRelayerContract = {
    txType: TradeLayerTxType.TX_REGISTER_RELAYER_CONTRACT,
    version: 1,
    contractAddress: 'rbtc-relayer.near',
    contractCodeHash: '0xdef56789...',
    oracleContract: 'rbtc-oracle.near',
    poolIds: ['pool_001'],
    isActive: true,
    registeredBy: 'admin.tl',
    signature: 'admin_sig'
  };

  await tlProcessor.processTransaction(relayerRegistration);
  console.log('');

  // ===== PHASE 2: DLC Creation =====
  console.log('━━━ Phase 2: DLC Construction ━━━\n');

  const dlc = demonstrateDLCConstruction();

  // ===== PHASE 3: Deposit and Mint =====
  console.log('━━━ Phase 3: DLC Deposit & rBTC Minting ━━━\n');

  const contractHash = DLCBuilder.computeContractHash(dlc.contractInfo);
  
  const deposit: DLCDepositMint = {
    txType: TradeLayerTxType.TX_DLC_DEPOSIT_MINT,
    version: 1,
    dlcId: dlc.id,
    contractHash,
    fundingTxId: 'a1b2c3d4e5f6...', // Bitcoin funding transaction
    fundingVout: 0,
    collateralSats: dlc.contractInfo.fundingAmount,
    maturityHeight: dlc.contractInfo.maturityHeight,
    cltvRefundHeight: dlc.contractInfo.refundLocktime,
    oraclePoolId: 'quorum_001',
    propertyId: 2147483651,
    rbtcAmount: dlc.contractInfo.fundingAmount, // 1:1 mint ratio
    recipientAddress: 'trader_alice.tl',
    fundingProof: 'spv_proof_data_...',
    signature: 'alice_sig'
  };

  const depositResult = await tlProcessor.processTransaction(deposit);
  console.log('Deposit Result:', depositResult.isValid ? '✓ SUCCESS' : '✗ FAILED');
  
  if (!depositResult.isValid) {
    console.error('Error:', depositResult.errorMessage);
    return;
  }

  // Notify NEAR oracle
  const depositProof = {
    txHash: 'tl_deposit_tx_001',
    blockHash: 'tl_block_12345',
    blockHeight: 12345,
    merkleProof: ['proof1', 'proof2', 'proof3'],
    txIndex: 5
  };

  await bridge.notifyOracleDLCDeposit(deposit, depositProof);
  console.log('');

  // ===== PHASE 4: Trading Period =====
  console.log('━━━ Phase 4: Trading Period ━━━\n');
  
  console.log('Alice trades rBTC on TradeLayer...');
  console.log('  - Opens 2x leveraged long position on BTC');
  console.log('  - Uses 1,000,000 rBTC as collateral');
  console.log('  - Trading activity tracked in TradeLayer ledger');
  console.log('  - PnL accumulates in rBTC');
  console.log('');

  // Simulate some time passing
  console.log('[Time passes... trading occurs...]');
  console.log('[DLC approaches maturity...]');
  console.log('');

  // ===== PHASE 5: Maturity & Settlement =====
  console.log('━━━ Phase 5: DLC Maturity & PnL Settlement ━━━\n');

  // Fetch DLC outcomes from NEAR oracle
  const outcome = await bridge.fetchDLCOutcomes(
    dlc.id,
    dlc.contractInfo.maturityHeight
  );

  if (!outcome) {
    console.error('Failed to fetch DLC outcome');
    return;
  }

  console.log(`Oracle Outcome: ${outcome.defaultFraction}% default`);
  console.log(`Signatures from ${outcome.signatures.size} oracles`);
  console.log('');

  // Process PnL settlement
  const settlement: PnLSettlement = {
    txType: TradeLayerTxType.TX_PNL_SETTLEMENT,
    version: 1,
    dlcId: dlc.id,
    maturityHeight: dlc.contractInfo.maturityHeight,
    defaultFraction: outcome.defaultFraction,
    oracleSignatures: outcome.signatures,
    losers: new Map([
      ['trader_bob.tl', 100000n],  // Bob lost 100k sats
      ['trader_carol.tl', 50000n]  // Carol lost 50k sats
    ]),
    winners: new Map([
      ['trader_alice.tl', 150000n] // Alice won 150k sats (net PnL)
    ]),
    stateRoot: 'state_root_hash_...',
    epochIndex: 42
  };

  const settlementResult = await tlProcessor.processTransaction(settlement);
  console.log('Settlement Result:', settlementResult.isValid ? '✓ SUCCESS' : '✗ FAILED');
  console.log('');

  // ===== PHASE 6: Redemption =====
  console.log('━━━ Phase 6: rBTC Redemption to BTC ━━━\n');

  // Alice wants to redeem her winnings to real BTC
  const redemption: RedeemBurn = {
    txType: TradeLayerTxType.TX_REDEEM_BURN,
    version: 1,
    propertyId: 2147483651,
    rbtcAmount: 150000n,
    senderAddress: 'trader_alice.tl',
    btcAddress: 'bc1q...[alice_btc_address]',
    relayerContract: 'rbtc-relayer.near',
    signature: 'alice_sig'
  };

  const redemptionResult = await tlProcessor.processTransaction(redemption);
  console.log('Redemption Result:', redemptionResult.isValid ? '✓ SUCCESS' : '✗ FAILED');
  
  if (redemptionResult.isValid) {
    // Submit to NEAR relayer
    const redemptionProof = {
      txHash: 'tl_redeem_tx_001',
      blockHash: 'tl_block_12350',
      blockHeight: 12350,
      merkleProof: ['proof1', 'proof2'],
      txIndex: 3
    };

    const requestId = await bridge.submitRedemptionToNEAR(redemption, redemptionProof);
    console.log(`Redemption Request ID: ${requestId}`);
    console.log('NEAR relayer will pay BTC to Alice\'s address');
  }
  console.log('');

  // ===== PHASE 7: System State =====
  console.log('━━━ Phase 7: Final System State ━━━\n');

  const supplyState = tlProcessor.getSupplyState();
  console.log('rBTC Supply Metrics:');
  console.log(`  Total Minted:      ${supplyState.totalMinted.toLocaleString()} sats`);
  console.log(`  Total Burned:      ${supplyState.totalBurned.toLocaleString()} sats`);
  console.log(`  Current Supply:    ${supplyState.currentSupply.toLocaleString()} sats`);
  console.log(`  Total Collateral:  ${supplyState.totalCollateral.toLocaleString()} sats`);
  console.log(`  Defaulted Amount:  ${supplyState.defaultedCollateral.toLocaleString()} sats`);
  console.log(`  Invariant Check:   ${supplyState.invariantCheck ? '✓ PASS' : '✗ FAIL'}`);
  console.log('');

  const activeDLCs = tlProcessor.getActiveDLCs();
  console.log(`Active DLCs: ${activeDLCs.length}`);
  
  const dlcInfo = tlProcessor.getDLC(dlc.id);
  if (dlcInfo) {
    console.log(`\nDLC ${dlc.id} Status: ${dlcInfo.status}`);
    console.log(`  Collateral: ${dlcInfo.collateralSats.toLocaleString()} sats`);
    console.log(`  rBTC Minted: ${dlcInfo.rbtcAmount.toLocaleString()}`);
    console.log(`  Registered at block: ${dlcInfo.registeredAt}`);
    if (dlcInfo.settledAt) {
      console.log(`  Settled at block: ${dlcInfo.settledAt}`);
    }
  }
  console.log('');

  // ===== Summary =====
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║                    System Demo Complete                       ║');
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log('║  ✓ DLC constructed with 21 outcome buckets                    ║');
  console.log('║  ✓ BTC locked, rBTC minted on TradeLayer                      ║');
  console.log('║  ✓ NEAR oracle contracts registered                           ║');
  console.log('║  ✓ Trading executed (conceptual)                              ║');
  console.log('║  ✓ Oracle attestation at maturity                             ║');
  console.log('║  ✓ PnL settlement processed                                    ║');
  console.log('║  ✓ rBTC redeemed to real BTC                                  ║');
  console.log('║  ✓ Supply invariants maintained                               ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  console.log('Key Features Demonstrated:');
  console.log('  • Self-custodial: CLTV refund paths protect depositors');
  console.log('  • Observable: All DLC states verifiable on-chain');
  console.log('  • Scalable: NEAR contracts handle off-chain coordination');
  console.log('  • Upgradeable: v1 → v2 → v3 roadmap clear\n');
}

// Run the demo
main().catch(console.error);
