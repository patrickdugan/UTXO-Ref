import { callSidecar, normalizeSidecarBaseUrl } from './sidecarClient';

export type LiquidityLeaseWalletView = {
  kind: 'wallet_liquidity_lease_view';
  status: 'verified' | 'needs_attention';
  title: string;
  subtitle: string;
  amountSats: string;
  maxFeePpm: number;
  maxCltvDelta: number;
  penaltySats: string;
  paymentHashHex: string;
  leaseOfferId: string;
  successEvidenceId: string;
  channelOutpoint: string;
  fundingCommitmentHash: string;
  htlc: {
    swapFundingTxid?: string;
    claimTxid?: string;
    refundTxid?: string;
  };
  actions: Array<{ id: string; label: string }>;
};

export class LiquidityLeaseClient {
  baseUrl: string;
  token?: string;

  constructor(baseUrl = 'http://127.0.0.1:8787', token?: string) {
    this.baseUrl = normalizeSidecarBaseUrl(baseUrl);
    this.token = token;
  }

  async getWalletView(): Promise<LiquidityLeaseWalletView> {
    return callSidecar(this, 'liquidity lease view', '/v1/liquidity-lease/wallet-view');
  }

  async verifyLease(): Promise<{ ok: boolean; reason?: string; successEvidenceId: string }> {
    return callSidecar(this, 'liquidity lease verify', '/v1/liquidity-lease/verify', { method: 'POST' });
  }

  async prepareChallenge(): Promise<{ slashable: boolean; challengeId: string; violations: string[] }> {
    return callSidecar(this, 'liquidity lease challenge', '/v1/liquidity-lease/challenge', { method: 'POST' });
  }
}
