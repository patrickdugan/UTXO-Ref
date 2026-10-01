export type DlcSubswapFundingWalletView = {
  kind: 'wallet_dlc_subswap_funding_view';
  status: 'verified' | 'needs_attention';
  title: string;
  subtitle: string;
  requestId: string;
  targetContractCommitmentId: string;
  namespaceHandle: string;
  invoice: string;
  invoiceAmountSats: string;
  requestedCollateralSats: string;
  paymentHashHex: string;
  fundingCommitmentHash: string;
  targetBindingHash: string;
  execution?: {
    swapFundingTxid?: string;
    claimTxid?: string;
    refundTxid?: string;
    checks: Record<string, boolean>;
  };
  actions: Array<{ id: string; label: string }>;
  verification: { ok: boolean; reason?: string };
};

export type DlcSubswapFundingQuote = {
  request: unknown;
  walletView: DlcSubswapFundingWalletView;
};

export class DlcSubswapFundingClient {
  baseUrl: string;

  constructor(baseUrl = 'http://127.0.0.1:8787') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async getWalletView(): Promise<DlcSubswapFundingWalletView> {
    const response = await fetch(`${this.baseUrl}/v1/dlc-subswap-funding/wallet-view`);
    if (!response.ok) throw new Error(`DLC subswap funding view failed: ${response.status}`);
    return response.json();
  }

  async quote(body: {
    walletNodeId?: string;
    requestedCollateralSats?: string;
    swapFeeSats?: string;
    refundBlocks?: number;
  } = {}): Promise<DlcSubswapFundingQuote> {
    const response = await fetch(`${this.baseUrl}/v1/dlc-subswap-funding/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`DLC subswap funding quote failed: ${response.status}`);
    return response.json();
  }

  async verify(request?: unknown): Promise<{ ok: boolean; reason?: string }> {
    const response = await fetch(`${this.baseUrl}/v1/dlc-subswap-funding/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: request ? JSON.stringify({ request }) : '{}'
    });
    if (!response.ok) throw new Error(`DLC subswap funding verify failed: ${response.status}`);
    return response.json();
  }
}
