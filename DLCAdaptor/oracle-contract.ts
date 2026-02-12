import { NearBindgen, near, call, view, initialize, LookupMap, UnorderedSet } from 'near-sdk-js';
import { PublicKey } from 'near-sdk-js/lib/types';

// State report structure matching the architecture doc
interface StateReport {
  epochIndex: number;
  bitcoinHeaderRange: { start: string; end: string };
  stateRoot: string;
  timestamp: number;
  signatures: Map<string, string>; // oracleAddress -> signature
  challenged: boolean;
  invalidated: boolean;
}

// DLC outcome attestation
interface DLCOutcome {
  dlcId: string;
  defaultFraction: number; // 0-100 in 5% buckets (0, 5, 10, ..., 100)
  maturityHeight: number;
  signatures: Map<string, string>;
}

// Oracle registration
interface OracleInfo {
  stateKey: string;
  dlcKey: string;
  stake: string; // bigint as string
  active: boolean;
  slashed: boolean;
  registeredAt: number;
}

// Quorum configuration
interface Quorum {
  id: string;
  oracleKeys: string[];
  threshold: number; // e.g., 3 for 3-of-5
  totalStake: string;
  tvlCap: string; // TVL_Q = L × Stake_Q
  leverageFactor: number; // L (e.g., 5-10x)
}

@NearBindgen({})
class OracleContract {
  owner: string;
  oracles: LookupMap<OracleInfo>;
  quorums: LookupMap<Quorum>;
  stateReports: LookupMap<StateReport>;
  dlcOutcomes: LookupMap<DLCOutcome>;
  authorizedRelayers: UnorderedSet<string>;
  
  // Configuration
  minStake: string;
  challengeWindow: number; // blocks
  slashRewardPercent: number;
  
  // Aurora light client for TradeLayer verification
  auroraLightClient: string; // contract address
  
  constructor() {
    this.owner = '';
    this.oracles = new LookupMap('o');
    this.quorums = new LookupMap('q');
    this.stateReports = new LookupMap('sr');
    this.dlcOutcomes = new LookupMap('do');
    this.authorizedRelayers = new UnorderedSet('ar');
    this.minStake = '0';
    this.challengeWindow = 1000; // ~1000 blocks
    this.slashRewardPercent = 20;
    this.auroraLightClient = '';
  }

  @initialize({})
  init({ 
    owner, 
    minStake, 
    auroraLightClient 
  }: { 
    owner: string; 
    minStake: string; 
    auroraLightClient: string;
  }) {
    this.owner = owner;
    this.minStake = minStake;
    this.auroraLightClient = auroraLightClient;
  }

  // Oracle registration
  @call({})
  registerOracle({ 
    stateKey, 
    dlcKey 
  }: { 
    stateKey: string; 
    dlcKey: string;
  }) {
    const sender = near.predecessorAccountId();
    const attachedDeposit = near.attachedDeposit().toString();
    
    // Check minimum stake
    if (BigInt(attachedDeposit) < BigInt(this.minStake)) {
      throw new Error(`Insufficient stake. Minimum: ${this.minStake}`);
    }
    
    const oracle: OracleInfo = {
      stateKey,
      dlcKey,
      stake: attachedDeposit,
      active: true,
      slashed: false,
      registeredAt: near.blockHeight()
    };
    
    this.oracles.set(sender, oracle);
    near.log(`Oracle registered: ${sender} with stake: ${attachedDeposit}`);
  }

  // Create a quorum
  @call({})
  createQuorum({ 
    quorumId, 
    oracleKeys, 
    threshold, 
    leverageFactor 
  }: { 
    quorumId: string; 
    oracleKeys: string[]; 
    threshold: number; 
    leverageFactor: number;
  }) {
    this.assertOwner();
    
    // Calculate total stake and TVL cap
    let totalStake = BigInt(0);
    for (const oracleKey of oracleKeys) {
      const oracle = this.oracles.get(oracleKey);
      if (!oracle || !oracle.active || oracle.slashed) {
        throw new Error(`Invalid or inactive oracle: ${oracleKey}`);
      }
      totalStake += BigInt(oracle.stake);
    }
    
    const tvlCap = (totalStake * BigInt(leverageFactor)).toString();
    
    const quorum: Quorum = {
      id: quorumId,
      oracleKeys,
      threshold,
      totalStake: totalStake.toString(),
      tvlCap,
      leverageFactor
    };
    
    this.quorums.set(quorumId, quorum);
    near.log(`Quorum created: ${quorumId} with ${oracleKeys.length} oracles, ${threshold}-of-${oracleKeys.length} threshold`);
  }

  // Submit state report (for epoch/maturity window)
  @call({})
  submitStateReport({
    epochIndex,
    bitcoinHeaderRange,
    stateRoot,
    tradeLayerProof
  }: {
    epochIndex: number;
    bitcoinHeaderRange: { start: string; end: string };
    stateRoot: string;
    tradeLayerProof: string; // proof that this state is in TradeLayer via Aurora light client
  }) {
    const sender = near.predecessorAccountId();
    const oracle = this.oracles.get(sender);
    
    if (!oracle || !oracle.active) {
      throw new Error('Oracle not registered or inactive');
    }
    
    // Verify TradeLayer state via Aurora light client
    // This would call the Aurora light client contract to verify the proof
    // For now, we assume the proof format and do a cross-contract call
    const verified = this.verifyTradeLayerState(tradeLayerProof, stateRoot);
    if (!verified) {
      throw new Error('Invalid TradeLayer state proof');
    }
    
    const reportKey = `${epochIndex}`;
    let report = this.stateReports.get(reportKey);
    
    if (!report) {
      report = {
        epochIndex,
        bitcoinHeaderRange,
        stateRoot,
        timestamp: near.blockTimestamp(),
        signatures: new Map(),
        challenged: false,
        invalidated: false
      };
    }
    
    // Add signature
    const signature = this.signStateReport(epochIndex, stateRoot, oracle.stateKey);
    report.signatures.set(sender, signature);
    
    this.stateReports.set(reportKey, report);
    near.log(`State report submitted for epoch ${epochIndex} by ${sender}`);
  }

  // Submit DLC outcome (at maturity)
  @call({})
  submitDLCOutcome({
    dlcId,
    defaultFraction,
    maturityHeight,
    quorumId
  }: {
    dlcId: string;
    defaultFraction: number;
    maturityHeight: number;
    quorumId: string;
  }) {
    const sender = near.predecessorAccountId();
    const oracle = this.oracles.get(sender);
    
    if (!oracle || !oracle.active) {
      throw new Error('Oracle not registered or inactive');
    }
    
    // Verify oracle is in the quorum
    const quorum = this.quorums.get(quorumId);
    if (!quorum || !quorum.oracleKeys.includes(sender)) {
      throw new Error('Oracle not in specified quorum');
    }
    
    // Validate default fraction (must be in 5% buckets)
    if (defaultFraction < 0 || defaultFraction > 100 || defaultFraction % 5 !== 0) {
      throw new Error('Invalid default fraction. Must be 0-100 in 5% increments');
    }
    
    let outcome = this.dlcOutcomes.get(dlcId);
    
    if (!outcome) {
      outcome = {
        dlcId,
        defaultFraction,
        maturityHeight,
        signatures: new Map()
      };
    }
    
    // Add signature
    const signature = this.signDLCOutcome(dlcId, defaultFraction, oracle.dlcKey);
    outcome.signatures.set(sender, signature);
    
    this.dlcOutcomes.set(dlcId, outcome);
    
    // Check if threshold reached
    if (outcome.signatures.size >= quorum.threshold) {
      near.log(`DLC outcome finalized: ${dlcId} with ${defaultFraction}% default`);
    }
  }

  // Submit fraud proof
  @call({})
  submitFraudProof({
    epochIndex,
    fraudType,
    proof
  }: {
    epochIndex: number;
    fraudType: 'REDEEM_NOT_PAID' | 'IMPOSSIBLE_DEFAULT' | 'DOUBLE_USE_DLC';
    proof: string; // Merkle proof + relevant transactions
  }) {
    const challenger = near.predecessorAccountId();
    const reportKey = `${epochIndex}`;
    const report = this.stateReports.get(reportKey);
    
    if (!report) {
      throw new Error('State report not found');
    }
    
    if (report.invalidated) {
      throw new Error('Report already invalidated');
    }
    
    // Check challenge window
    const blocksPassed = near.blockHeight() - report.timestamp / 1000000000;
    if (blocksPassed > this.challengeWindow) {
      throw new Error('Challenge window expired');
    }
    
    // Verify fraud proof (simplified - would need full implementation)
    const isValid = this.verifyFraudProof(fraudType, proof, report);
    
    if (isValid) {
      report.challenged = true;
      report.invalidated = true;
      this.stateReports.set(reportKey, report);
      
      // Slash oracles that signed the invalid report
      this.slashOracles(report.signatures, challenger);
      
      near.log(`Fraud proof accepted for epoch ${epochIndex}. Type: ${fraudType}`);
    } else {
      throw new Error('Invalid fraud proof');
    }
  }

  // View functions
  @view({})
  getOracle({ address }: { address: string }): OracleInfo | null {
    return this.oracles.get(address);
  }

  @view({})
  getQuorum({ quorumId }: { quorumId: string }): Quorum | null {
    return this.quorums.get(quorumId);
  }

  @view({})
  getStateReport({ epochIndex }: { epochIndex: number }): StateReport | null {
    return this.stateReports.get(`${epochIndex}`);
  }

  @view({})
  getDLCOutcome({ dlcId }: { dlcId: string }): DLCOutcome | null {
    return this.dlcOutcomes.get(dlcId);
  }

  // Helper functions
  private assertOwner() {
    if (near.predecessorAccountId() !== this.owner) {
      throw new Error('Only owner can call this method');
    }
  }

  private verifyTradeLayerState(proof: string, stateRoot: string): boolean {
    // Would make cross-contract call to Aurora light client
    // to verify that the TradeLayer state root is valid
    // For now, placeholder
    return true;
  }

  private signStateReport(epochIndex: number, stateRoot: string, stateKey: string): string {
    // In production, this would use proper cryptographic signing
    // For now, placeholder
    return `sig_${epochIndex}_${stateRoot.slice(0, 8)}`;
  }

  private signDLCOutcome(dlcId: string, defaultFraction: number, dlcKey: string): string {
    // In production, this would use DLC adaptor signatures
    // For now, placeholder
    return `dlc_sig_${dlcId}_${defaultFraction}`;
  }

  private verifyFraudProof(
    fraudType: string, 
    proof: string, 
    report: StateReport
  ): boolean {
    // Simplified fraud proof verification
    // In production, this would:
    // 1. Parse the Merkle proof
    // 2. Verify against stateRoot
    // 3. Check invariants based on fraudType
    return true;
  }

  private slashOracles(signatures: Map<string, string>, challenger: string) {
    const rewardPerOracle = BigInt(this.slashRewardPercent);
    
    for (const [oracleAddress, _] of signatures) {
      const oracle = this.oracles.get(oracleAddress);
      if (oracle && !oracle.slashed) {
        oracle.slashed = true;
        oracle.active = false;
        
        const stake = BigInt(oracle.stake);
        const slashAmount = (stake * rewardPerOracle) / BigInt(100);
        
        // Transfer slash reward to challenger
        // In production: near.promiseBatchCreate and transfer
        
        oracle.stake = (stake - slashAmount).toString();
        this.oracles.set(oracleAddress, oracle);
        
        near.log(`Oracle slashed: ${oracleAddress}, amount: ${slashAmount}`);
      }
    }
  }
}
