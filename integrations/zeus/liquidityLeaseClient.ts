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

  constructor(baseUrl = 'http://127.0.0.1:8787') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async getWalletView(): Promise<LiquidityLeaseWalletView> {
    const response = await fetch(`${this.baseUrl}/v1/liquidity-lease/wallet-view`);
    if (!response.ok) throw new Error(`liquidity lease view failed: ${response.status}`);
    return response.json();
  }

  async verifyLease(): Promise<{ ok: boolean; reason?: string; successEvidenceId: string }> {
    const response = await fetch(`${this.baseUrl}/v1/liquidity-lease/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    if (!response.ok) throw new Error(`liquidity lease verify failed: ${response.status}`);
    return response.json();
  }

  async prepareChallenge(): Promise<{ slashable: boolean; challengeId: string; violations: string[] }> {
    const response = await fetch(`${this.baseUrl}/v1/liquidity-lease/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    if (!response.ok) throw new Error(`liquidity lease challenge failed: ${response.status}`);
    return response.json();
  }
}
