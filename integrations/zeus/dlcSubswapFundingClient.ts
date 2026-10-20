import { callSidecar, normalizeSidecarBaseUrl } from './sidecarClient';

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
  token?: string;

  constructor(baseUrl = 'http://127.0.0.1:8787', token?: string) {
    this.baseUrl = normalizeSidecarBaseUrl(baseUrl);
    this.token = token;
  }

  async getWalletView(): Promise<DlcSubswapFundingWalletView> {
    return callSidecar(this, 'DLC subswap funding view', '/v1/dlc-subswap-funding/wallet-view');
  }

  async quote(body: {
    walletNodeId?: string;
    requestedCollateralSats?: string;
    swapFeeSats?: string;
    refundBlocks?: number;
  } = {}): Promise<DlcSubswapFundingQuote> {
    return callSidecar(this, 'DLC subswap funding quote', '/v1/dlc-subswap-funding/quote', { method: 'POST', body });
  }

  async verify(request?: unknown): Promise<{ ok: boolean; reason?: string }> {
    return callSidecar(this, 'DLC subswap funding verify', '/v1/dlc-subswap-funding/verify', {
      method: 'POST',
      body: request ? { request } : {}
    });
  }
}
