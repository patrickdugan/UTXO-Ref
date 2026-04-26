export type WalletDemoBackendConfig = {
  kind: 'utxoref_wallet_demo_backend_config';
  activeProfileId: 'litecoin-testnet-local' | 'bitcoin-testnet-lnd' | string;
  activeProfile: {
    id: string;
    mode: string;
    chainSourceBadge: string;
    displayName: string;
    purpose: string;
    sidecarBaseUrl: string;
    sidecarEndpoints: {
      walletView: string;
      verify: string;
      challenge: string;
      latestArtifact: string;
    };
    bitvm: {
      chain: string;
      rpcUrl: string;
      wallet: string;
      liveProbeCommand: string;
    };
    lightning: unknown;
    lnd?: {
      network: 'testnet' | string;
      restUrl: string;
      grpcHost: string;
      macaroonPath: string;
      tlsCertPath: string;
      requiredEnv: string[];
    };
    labels: string[];
  };
  availableProfiles: string[];
  switchPlan: {
    currentDemo: string;
    goLive: string;
    invariant: string;
  };
  warnings: string[];
  verification?: { ok: boolean; reason?: string };
};

export type TlusdLiquidityPatchWalletView = {
  kind: 'wallet_lnbtc_tlusd_liquidity_patch_view';
  status: 'verified' | 'needs_attention';
  title: string;
  subtitle: string;
  bundleId: string;
  conversion: {
    lnbtcSats: string;
    tlusdUnits: string;
    assetTicker: string;
    assetId: string;
    rfqQuoteId: string;
    settlementId: string;
    subswapFundingTxid?: string;
    dlcFundingTxid?: string;
  };
  stake: {
    stakeCommitmentId: string;
    poolId: string;
    stakedTlUsdUnits: string;
    routingNotionalSats: string;
    lockBlocks: number;
    targetYieldPpm: number;
    slashReserveUnits: string;
  };
  liquidityPatch: {
    mandateId: string;
    policyId: string;
    allocationId: string;
    totals: {
      requestedInboundSats: string;
      assignedInboundSats: string;
      deliveredInboundSats: string;
      slashableAssignments: number;
      settledAssignments: number;
    };
    assignments: Array<{
      routeId: string;
      status: 'settled' | 'slashable' | 'assigned' | string;
      promisedInboundSats: string;
      deliveredInboundSats: string;
      quoteId: string;
      slashable: boolean;
      violations: string[];
    }>;
    challenge: {
      slashable: boolean;
      challengeId: string;
      remedy: string;
      violations: string[];
    };
    costModel: {
      baselinePerGraftSats: string;
      arkPerGraftSats: string;
      savingsSats: string;
      saferMarginalCost: boolean;
    };
  };
};

export class TlusdLiquidityPatchClient {
  baseUrl: string;

  constructor(baseUrl = 'http://127.0.0.1:8787') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async getBackendConfig(): Promise<WalletDemoBackendConfig> {
    const response = await fetch(`${this.baseUrl}/v1/wallet-demo/config`);
    if (!response.ok) throw new Error(`wallet demo config failed: ${response.status}`);
    return response.json();
  }

  async getWalletView(): Promise<TlusdLiquidityPatchWalletView> {
    const response = await fetch(`${this.baseUrl}/v1/lnbtc-tlusd-liquidity-patch/wallet-view`);
    if (!response.ok) throw new Error(`TLUSD liquidity patch view failed: ${response.status}`);
    return response.json();
  }

  async verifyPatch(): Promise<{
    ok: boolean;
    reason?: string;
    lnbtcSats: string;
    tlusdUnits: string;
    stakedTlUsdUnits: string;
    assignedInboundSats: string;
    slashableAssignments: number;
  }> {
    const response = await fetch(`${this.baseUrl}/v1/lnbtc-tlusd-liquidity-patch/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    if (!response.ok) throw new Error(`TLUSD liquidity patch verify failed: ${response.status}`);
    return response.json();
  }

  async prepareChallenge(): Promise<{
    slashable: boolean;
    challengeId: string;
    remedy: string;
    assignmentChallenges: Array<{ routeId: string; violations: string[] }>;
    violations: string[];
  }> {
    const response = await fetch(`${this.baseUrl}/v1/lnbtc-tlusd-liquidity-patch/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    if (!response.ok) throw new Error(`TLUSD liquidity patch challenge failed: ${response.status}`);
    return response.json();
  }
}
