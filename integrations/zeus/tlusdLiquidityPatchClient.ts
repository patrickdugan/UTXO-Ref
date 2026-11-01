import { callSidecar, normalizeSidecarBaseUrl } from './sidecarClient';

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

export type WalletDemoStatus = {
  kind: 'utxoref_wallet_demo_status';
  sidecarOk: boolean;
  activeProfileId: string;
  profile: {
    id: string;
    mode: string;
    displayName: string;
    chainSourceBadge: string;
    labels: string[];
  };
  chain: {
    chain: string;
    rpcUrl: string;
    wallet: string;
    status: string;
  };
  lnd: null | {
    network: string;
    restUrl: string;
    grpcHost: string;
    macaroonConfigured: boolean;
    tlsConfigured: boolean;
  };
  artifacts: {
    lnbtcTlusdLiquidityPatch: {
      exists: boolean;
      updatedAt?: string;
      summary?: {
        ok: boolean;
        lnbtcSats: string;
        tlusdUnits: string;
        stakedTlUsdUnits: string;
        assignedInboundSats: string;
        slashableAssignments: number;
      };
    };
  };
  readiness: {
    walletViewReady: boolean;
    localLitecoinReady: boolean;
    bitcoinLndReady: boolean;
    warnings: string[];
  };
};

export class TlusdLiquidityPatchClient {
  baseUrl: string;
  token?: string;

  constructor(baseUrl = 'http://127.0.0.1:8787', token?: string) {
    this.baseUrl = normalizeSidecarBaseUrl(baseUrl);
    this.token = token;
  }

  async getBackendConfig(): Promise<WalletDemoBackendConfig> {
    return callSidecar(this, 'wallet demo config', '/v1/wallet-demo/config');
  }

  async getDemoStatus(): Promise<WalletDemoStatus> {
    return callSidecar(this, 'wallet demo status', '/v1/wallet-demo/status');
  }

  async getWalletView(): Promise<TlusdLiquidityPatchWalletView> {
    return callSidecar(this, 'TLUSD liquidity patch view', '/v1/lnbtc-tlusd-liquidity-patch/wallet-view');
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
    return callSidecar(this, 'TLUSD liquidity patch verify', '/v1/lnbtc-tlusd-liquidity-patch/verify', { method: 'POST' });
  }

  async prepareChallenge(): Promise<{
    slashable: boolean;
    challengeId: string;
    remedy: string;
    assignmentChallenges: Array<{ routeId: string; violations: string[] }>;
    violations: string[];
  }> {
    return callSidecar(this, 'TLUSD liquidity patch challenge', '/v1/lnbtc-tlusd-liquidity-patch/challenge', { method: 'POST' });
  }
}
