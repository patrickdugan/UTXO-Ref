import { NearBindgen, near, call, view, initialize, LookupMap, UnorderedMap } from 'near-sdk-js';

// Redemption request
interface RedemptionRequest {
  requestId: string;
  tradeLayerAddress: string;
  rbtcAmount: string; // bigint as string
  btcAddress: string;
  requestHeight: number;
  status: 'pending' | 'processing' | 'paid' | 'failed';
  btcTxId?: string; // Bitcoin transaction ID once paid
  paymentHeight?: number;
  proofOfPayment?: string;
}

// PnL settlement
interface PnLSettlement {
  settlementId: string;
  dlcId: string;
  winners: Map<string, string>; // address -> amount in BTC
  losers: Map<string, string>; // address -> defaulted amount
  processed: boolean;
  btcTxIds: string[];
}

// DLC pool tracking
interface DLCPool {
  poolId: string;
  totalCollateral: string; // total BTC in sats
  availableBTC: string; // BTC available for redemptions
  defaultedBTC: string; // BTC from defaults (used for payouts)
  activeRedemptions: string; // BTC locked in pending redemptions
}

@NearBindgen({})
class ProfitSweepsRelayer {
  owner: string;
  oracleContract: string; // reference to oracle contract
  redemptions: LookupMap<RedemptionRequest>;
  settlements: LookupMap<PnLSettlement>;
  pools: LookupMap<DLCPool>;
  
  // Bitcoin payment tracking
  paymentQueue: UnorderedMap<string>; // requestId -> btcAddress
  processedPayments: LookupMap<string>; // btcTxId -> requestId
  
  // Configuration
  minRedemption: string; // minimum rBTC for redemption
  maxRedemptionPerBlock: number;
  redemptionFee: number; // basis points (e.g., 10 = 0.1%)
  
  // Authorized relayer operators
  authorizedOperators: Set<string>;

  constructor() {
    this.owner = '';
    this.oracleContract = '';
    this.redemptions = new LookupMap('r');
    this.settlements = new LookupMap('s');
    this.pools = new LookupMap('p');
    this.paymentQueue = new UnorderedMap('pq');
    this.processedPayments = new LookupMap('pp');
    this.minRedemption = '10000'; // 0.0001 BTC
    this.maxRedemptionPerBlock = 10;
    this.redemptionFee = 10; // 0.1%
    this.authorizedOperators = new Set();
  }

  @initialize({})
  init({ 
    owner, 
    oracleContract, 
    minRedemption 
  }: { 
    owner: string; 
    oracleContract: string; 
    minRedemption: string;
  }) {
    this.owner = owner;
    this.oracleContract = oracleContract;
    this.minRedemption = minRedemption;
    this.authorizedOperators.add(owner);
  }

  // Request redemption (burns rBTC, requests BTC payout)
  @call({})
  requestRedemption({
    tradeLayerAddress,
    rbtcAmount,
    btcAddress,
    burnProof
  }: {
    tradeLayerAddress: string;
    rbtcAmount: string;
    btcAddress: string;
    burnProof: string; // proof that rBTC was burned on TradeLayer
  }) {
    // Verify minimum
    if (BigInt(rbtcAmount) < BigInt(this.minRedemption)) {
      throw new Error(`Amount below minimum: ${this.minRedemption}`);
    }
    
    // Verify burn proof (would verify via Aurora light client)
    if (!this.verifyBurnProof(burnProof, tradeLayerAddress, rbtcAmount)) {
      throw new Error('Invalid burn proof');
    }
    
    // Calculate fee
    const fee = (BigInt(rbtcAmount) * BigInt(this.redemptionFee)) / BigInt(10000);
    const netAmount = BigInt(rbtcAmount) - fee;
    
    const requestId = `redemption_${near.blockHeight()}_${tradeLayerAddress}`;
    
    const request: RedemptionRequest = {
      requestId,
      tradeLayerAddress,
      rbtcAmount: netAmount.toString(),
      btcAddress,
      requestHeight: near.blockHeight(),
      status: 'pending'
    };
    
    this.redemptions.set(requestId, request);
    this.paymentQueue.set(requestId, btcAddress);
    
    near.log(`Redemption requested: ${requestId} for ${netAmount} sats to ${btcAddress}`);
    
    return requestId;
  }

  // Process redemption (authorized operator pays BTC and submits proof)
  @call({})
  processRedemption({
    requestId,
    btcTxId,
    proofOfPayment
  }: {
    requestId: string;
    btcTxId: string;
    proofOfPayment: string; // SPV proof or similar
  }) {
    this.assertAuthorizedOperator();
    
    const request = this.redemptions.get(requestId);
    if (!request) {
      throw new Error('Redemption request not found');
    }
    
    if (request.status !== 'pending' && request.status !== 'processing') {
      throw new Error(`Invalid status: ${request.status}`);
    }
    
    // Verify BTC payment proof
    if (!this.verifyBTCPayment(btcTxId, request.btcAddress, request.rbtcAmount, proofOfPayment)) {
      throw new Error('Invalid payment proof');
    }
    
    request.status = 'paid';
    request.btcTxId = btcTxId;
    request.paymentHeight = near.blockHeight();
    request.proofOfPayment = proofOfPayment;
    
    this.redemptions.set(requestId, request);
    this.processedPayments.set(btcTxId, requestId);
    this.paymentQueue.remove(requestId);
    
    near.log(`Redemption processed: ${requestId}, BTC tx: ${btcTxId}`);
  }

  // Register DLC pool
  @call({})
  registerDLCPool({
    poolId,
    initialCollateral
  }: {
    poolId: string;
    initialCollateral: string;
  }) {
    this.assertAuthorizedOperator();
    
    const pool: DLCPool = {
      poolId,
      totalCollateral: initialCollateral,
      availableBTC: initialCollateral,
      defaultedBTC: '0',
      activeRedemptions: '0'
    };
    
    this.pools.set(poolId, pool);
    near.log(`DLC pool registered: ${poolId} with ${initialCollateral} sats`);
  }

  // Update pool after DLC maturity/settlement
  @call({})
  updatePoolAfterSettlement({
    poolId,
    dlcId,
    defaultedAmount,
    repaidAmount
  }: {
    poolId: string;
    dlcId: string;
    defaultedAmount: string;
    repaidAmount: string;
  }) {
    this.assertAuthorizedOperator();
    
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new Error('Pool not found');
    }
    
    // Add defaulted BTC to pool (can be used for winner payouts)
    const newDefaulted = BigInt(pool.defaultedBTC) + BigInt(defaultedAmount);
    
    // Subtract repaid amount from collateral
    const newTotal = BigInt(pool.totalCollateral) - BigInt(repaidAmount);
    
    pool.defaultedBTC = newDefaulted.toString();
    pool.totalCollateral = newTotal.toString();
    pool.availableBTC = (BigInt(pool.availableBTC) + BigInt(defaultedAmount)).toString();
    
    this.pools.set(poolId, pool);
    
    near.log(`Pool updated: ${poolId}, defaulted: ${defaultedAmount}, repaid: ${repaidAmount}`);
  }

  // Process PnL settlement (pay winners from defaulted BTC)
  @call({})
  processPnLSettlement({
    settlementId,
    dlcId,
    winners,
    losers,
    paymentProofs
  }: {
    settlementId: string;
    dlcId: string;
    winners: Array<[string, string]>; // [address, amount]
    losers: Array<[string, string]>;
    paymentProofs: string[]; // BTC transaction IDs
  }) {
    this.assertAuthorizedOperator();
    
    const settlement: PnLSettlement = {
      settlementId,
      dlcId,
      winners: new Map(winners),
      losers: new Map(losers),
      processed: true,
      btcTxIds: paymentProofs
    };
    
    this.settlements.set(settlementId, settlement);
    
    // Verify payments for each winner
    for (const [address, amount] of winners) {
      near.log(`Winner payout: ${address} receives ${amount} sats`);
    }
    
    near.log(`PnL settlement processed: ${settlementId} for DLC ${dlcId}`);
  }

  // Get pending redemptions (for operators)
  @view({})
  getPendingRedemptions({ limit }: { limit: number }): RedemptionRequest[] {
    const pending: RedemptionRequest[] = [];
    let count = 0;
    
    for (const [requestId, _] of this.paymentQueue) {
      if (count >= limit) break;
      
      const request = this.redemptions.get(requestId);
      if (request && request.status === 'pending') {
        pending.push(request);
        count++;
      }
    }
    
    return pending;
  }

  @view({})
  getRedemption({ requestId }: { requestId: string }): RedemptionRequest | null {
    return this.redemptions.get(requestId);
  }

  @view({})
  getPool({ poolId }: { poolId: string }): DLCPool | null {
    return this.pools.get(poolId);
  }

  @view({})
  getSettlement({ settlementId }: { settlementId: string }): PnLSettlement | null {
    return this.settlements.get(settlementId);
  }

  // Admin functions
  @call({})
  addAuthorizedOperator({ address }: { address: string }) {
    this.assertOwner();
    this.authorizedOperators.add(address);
    near.log(`Authorized operator added: ${address}`);
  }

  @call({})
  removeAuthorizedOperator({ address }: { address: string }) {
    this.assertOwner();
    this.authorizedOperators.delete(address);
    near.log(`Authorized operator removed: ${address}`);
  }

  // Helper functions
  private assertOwner() {
    if (near.predecessorAccountId() !== this.owner) {
      throw new Error('Only owner can call this method');
    }
  }

  private assertAuthorizedOperator() {
    const sender = near.predecessorAccountId();
    if (!this.authorizedOperators.has(sender)) {
      throw new Error('Not authorized operator');
    }
  }

  private verifyBurnProof(
    proof: string, 
    address: string, 
    amount: string
  ): boolean {
    // Would verify via Aurora light client that the burn transaction
    // is included in a valid TradeLayer block
    // For now, placeholder
    return true;
  }

  private verifyBTCPayment(
    txId: string,
    address: string,
    amount: string,
    proof: string
  ): boolean {
    // Would verify Bitcoin SPV proof or similar
    // Check that txId pays `amount` to `address`
    // For now, placeholder
    return true;
  }
}
