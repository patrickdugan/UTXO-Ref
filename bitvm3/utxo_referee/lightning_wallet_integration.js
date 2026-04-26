const crypto = require('crypto');
const { canonicalStringify } = require('./m1_spec');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value) {
  return sha256Hex(canonicalStringify(value));
}

function buildWalletIntegrationManifest({ leaseBundle, subswapProof }) {
  if (!leaseBundle || leaseBundle.kind !== 'bitvm_lightning_liquidity_lease_bundle') {
    throw new Error('leaseBundle must be a bitvm_lightning_liquidity_lease_bundle');
  }

  const walletView = {
    kind: 'wallet_liquidity_lease_view',
    status: leaseBundle.verification && leaseBundle.verification.ok ? 'verified' : 'needs_attention',
    title: 'Inbound Liquidity Lease',
    amountSats: leaseBundle.offer.terms.promisedInboundSats,
    maxFeePpm: leaseBundle.offer.terms.maxFeePpm,
    maxCltvDelta: leaseBundle.offer.terms.maxCltvDelta,
    penaltySats: leaseBundle.offer.terms.penaltySats,
    paymentHashHex: leaseBundle.offer.terms.paymentHashHex,
    channelOutpoint: leaseBundle.successEvidence.evidenceCore.channelOutpoint,
    fundingCommitmentHash: leaseBundle.successEvidence.evidenceCore.fundingCommitmentHash,
    htlcClaimTxid: subswapProof && subswapProof.dlcFunding && subswapProof.dlcFunding.claimTxid,
    htlcRefundTxid: subswapProof && subswapProof.refundPath && subswapProof.refundPath.refundTxid
  };

  const manifestCore = {
    leaseBundleId: leaseBundle.bundleId,
    offerId: leaseBundle.offer.offerId,
    walletStatus: walletView.status,
    ldkProto: 'integrations/ldk-server/liquidity_lease.proto',
    zeusScreen: 'integrations/zeus/LiquidityLeaseScreen.tsx',
    zeusTlusdPatchScreen: 'integrations/zeus/TlusdLiquidityPatchScreen.tsx',
    zeusTlusdPatchClient: 'integrations/zeus/tlusdLiquidityPatchClient.ts',
    walletBackendProfiles: 'integrations/wallet-demo/walletBackendProfiles.js',
    sidecar: 'integrations/lightning-liquidity-lease-sidecar/server.js'
  };

  return {
    kind: 'lightning_wallet_liquidity_lease_integration_manifest',
    manifestId: hashCanonical(manifestCore),
    manifestCore,
    walletView,
    ldkServer: {
      target: 'lightningdevkit/ldk-server',
      integrationMode: 'sidecar first, then native gRPC service',
      protoFile: manifestCore.ldkProto,
      methods: [
        'QuoteLiquidityLease',
        'GetLiquidityLease',
        'VerifyLiquidityLease',
        'PrepareLiquidityLeaseChallenge'
      ]
    },
    zeus: {
      target: 'ZeusLN/zeus',
      integrationMode: 'React Native screens consuming sidecar REST API',
      screenFile: manifestCore.zeusScreen,
      clientFile: 'integrations/zeus/liquidityLeaseClient.ts',
      tlusdPatch: {
        screenFile: manifestCore.zeusTlusdPatchScreen,
        clientFile: manifestCore.zeusTlusdPatchClient,
        backendProfiles: manifestCore.walletBackendProfiles,
        demoProfile: 'litecoin-testnet-local',
        goLiveProfile: 'bitcoin-testnet-lnd',
        endpoints: [
          'GET /v1/wallet-demo/config',
          'GET /v1/lnbtc-tlusd-liquidity-patch/wallet-view',
          'POST /v1/lnbtc-tlusd-liquidity-patch/verify',
          'POST /v1/lnbtc-tlusd-liquidity-patch/challenge'
        ]
      }
    },
    lightningLabs: {
      target: 'lightninglabs/pool or lightning-terminal',
      integrationMode: 'Pool-style lease proof adapter',
      mapping: {
        promisedInboundSats: 'lease amount',
        leaseBlocks: 'lease duration',
        penaltySats: 'failure bond',
        channelOutpoint: 'delivered channel/splice evidence'
      }
    }
  };
}

function verifyWalletIntegrationManifest(manifest) {
  if (!manifest || manifest.kind !== 'lightning_wallet_liquidity_lease_integration_manifest') {
    return { ok: false, reason: 'wrong manifest kind' };
  }
  if (manifest.manifestId !== hashCanonical(manifest.manifestCore)) {
    return { ok: false, reason: 'manifest id mismatch' };
  }
  if (!manifest.ldkServer.methods.includes('VerifyLiquidityLease')) {
    return { ok: false, reason: 'missing LDK verify method' };
  }
  if (!manifest.zeus.screenFile.endsWith('LiquidityLeaseScreen.tsx')) {
    return { ok: false, reason: 'missing ZEUS screen' };
  }
  if (!manifest.zeus.tlusdPatch || !manifest.zeus.tlusdPatch.screenFile.endsWith('TlusdLiquidityPatchScreen.tsx')) {
    return { ok: false, reason: 'missing ZEUS TLUSD patch screen' };
  }
  if (manifest.zeus.tlusdPatch.goLiveProfile !== 'bitcoin-testnet-lnd') {
    return { ok: false, reason: 'missing bitcoin testnet LND go-live profile' };
  }
  return { ok: true };
}

module.exports = {
  buildWalletIntegrationManifest,
  verifyWalletIntegrationManifest
};
