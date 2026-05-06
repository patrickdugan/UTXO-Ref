const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const bitcoin = require('../../node-dlc/packages/messaging/node_modules/bitcoinjs-lib/src');
const platform = require('../p2p_platform');
const escrow = require('../bitvm_escrow');
const nostr = require('../nostr_agent');
const arbitration = require('./index');

const ARTIFACTS_DIR = path.join(__dirname, '../../bitvm3/utxo_referee/artifacts');
const OUT_DIR = path.join(__dirname, 'artifacts');
const OUT_PATH = path.join(OUT_DIR, 'ltc_ai_arbitration_smoke_latest.json');

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, fileName), 'utf8'));
}

function rpcConfigured() {
  return !!(process.env.LTC_RPC_URL && process.env.LTC_RPC_USER && process.env.LTC_RPC_PASS);
}

function rpcFactory() {
  const endpoint = new URL(process.env.LTC_RPC_URL);
  const transport = endpoint.protocol === 'https:' ? https : http;

  return async function rpc(method, params = []) {
    const payload = JSON.stringify({
      jsonrpc: '1.0',
      id: 'civkit-ai-arbitration-smoke',
      method,
      params
    });

    const options = {
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
      path: endpoint.pathname || '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Basic ${Buffer.from(
          `${process.env.LTC_RPC_USER}:${process.env.LTC_RPC_PASS}`
        ).toString('base64')}`
      }
    };

    return new Promise((resolve, reject) => {
      const req = transport.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (error) {
            reject(new Error(`Invalid RPC response for ${method}`));
            return;
          }
          if (parsed.error) {
            reject(new Error(`RPC ${method} failed: ${parsed.error.message}`));
            return;
          }
          resolve(parsed.result);
        });
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  };
}

async function detectChainContext(draft, funding) {
  if (!rpcConfigured()) {
    return {
      mode: 'artifact',
      network: 'litecoin-testnet',
      chain: draft.chain.network,
      height: draft.chain.blockHeight,
      fundingTxid: funding.txid
    };
  }

  try {
    const rpc = rpcFactory();
    const [chainInfo, height] = await Promise.all([
      rpc('getblockchaininfo'),
      rpc('getblockcount')
    ]);
    return {
      mode: 'rpc',
      network: 'litecoin-testnet',
      chain: chainInfo.chain,
      height,
      fundingTxid: funding.txid
    };
  } catch (error) {
    return {
      mode: 'artifact',
      network: 'litecoin-testnet',
      chain: draft.chain.network,
      height: draft.chain.blockHeight,
      fundingTxid: funding.txid,
      note: error.message
    };
  }
}

function addressToScriptPubKey(address, network) {
  return bitcoin.address.toOutputScript(address, escrow.onchain.normalizeNetwork(network));
}

function fixedPrivateKey(byte) {
  return Buffer.alloc(32, byte).toString('hex');
}

async function run() {
  const draft = readJson('m1_dlc_draft_latest.json');
  const funding = readJson('m1_funding_finalized_latest.json');
  const cets = readJson('m1_cet_skeletons_latest.json');
  const chainContext = await detectChainContext(draft, funding);
  const network = 'litecoin-testnet';

  const platformFeeScriptPubKey = addressToScriptPubKey(
    draft.contract.outputs.operatorAddress,
    network
  );
  const arbitratorSettlementScriptPubKey = addressToScriptPubKey(
    draft.roleSet.addresses.oracle,
    network
  );
  const sellerPayoutScriptPubKey = addressToScriptPubKey(
    draft.roleSet.addresses.alice,
    network
  );
  const buyerRefundScriptPubKey = addressToScriptPubKey(
    draft.roleSet.addresses.bob,
    network
  );

  const marketplacePolicy = new platform.MarketplacePolicy({
    policyId: 'ltc-ai-arb-smoke',
    platformFeeScriptPubKey,
    platformFeeBps: 0,
    platformFlatFeeSats: 500n,
    escrowExpiryBlocks: 288n,
    requiredWhitelistTag: 'ltc-testnet-ai-arb',
    minNotaryReputation: 80,
    maxResolverFeeBps: 400,
    allowedPaymentMethods: ['cash_deposit'],
    allowedRegions: ['LTC-TESTNET']
  });
  const registry = new platform.NotaryRegistry([
    {
      notaryId: 'ai-arbitrator-ltc-testnet',
      nostrPubkey: nostr.derivePubkeyHex(fixedPrivateKey(0x33)),
      settlementScriptPubKey: arbitratorSettlementScriptPubKey,
      bookingFlatFeeSats: 1000n,
      resolverFlatFeeSats: 2500n,
      resolverFeeBps: 0,
      supportedPaymentMethods: ['cash_deposit'],
      supportedRegions: ['LTC-TESTNET'],
      whitelistTags: ['ltc-testnet-ai-arb'],
      reputationScore: 99
    }
  ]);
  const offer = new platform.MarketOffer({
    offerId: 'ltc-smoke-offer-1',
    epochId: BigInt(draft.canonical.epochId),
    sellerId: 'seller-alice',
    amountSats: BigInt(cets.fundingOutpoint.valueSats),
    fiatCurrency: 'USD',
    fiatAmountMinor: 125000n,
    paymentMethod: 'cash_deposit',
    region: 'LTC-TESTNET',
    sellerPayoutScriptPubKey,
    buyerRefundScriptPubKey
  });
  const session = platform.openTradeSession({
    policy: marketplacePolicy,
    registry,
    offer,
    startBlock: BigInt(chainContext.height)
  });

  const result = arbitration.runArbitratedTrade({
    session,
    policy: {
      policyId: 'bounded-ai-ltc-v1',
      minSubAgentConfidenceBps: 6200,
      minDecisionConfidenceBps: 7000,
      splitBandBps: 1400,
      splitRequiresNotary: true
    },
    evidence: [
      {
        evidenceId: 'funding',
        kind: 'chain_funding_confirmed',
        submittedBy: 'system',
        reliabilityBps: 9800,
        summary: `Funding tx ${funding.txid} observed for LTC smoke`
      },
      {
        evidenceId: 'buyer-receipt',
        kind: 'fiat_receipt_match',
        submittedBy: 'buyer',
        reliabilityBps: 7800,
        summary: 'Buyer uploaded cash deposit slip consistent with quoted amount'
      },
      {
        evidenceId: 'receipt-mismatch',
        kind: 'receipt_mismatch',
        submittedBy: 'seller',
        reliabilityBps: 8600,
        summary: 'Deposit slip metadata mismatched branch reference'
      },
      {
        evidenceId: 'seller-denial',
        kind: 'seller_denial',
        submittedBy: 'seller',
        reliabilityBps: 8300,
        summary: 'Seller denies that funds were available at collection window'
      },
      {
        evidenceId: 'offer-match',
        kind: 'payment_method_match',
        submittedBy: 'system',
        reliabilityBps: 7600,
        summary: 'Trade metadata still matches listed cash deposit offer'
      }
    ],
    arbitratorId: 'ai_arbitrator_ltc_testnet',
    keyset: {
      releasePubkey: nostr.derivePubkeyHex(fixedPrivateKey(0x11)),
      refundPubkey: nostr.derivePubkeyHex(fixedPrivateKey(0x22)),
      notaryPubkey: nostr.derivePubkeyHex(fixedPrivateKey(0x33))
    },
    fundingOutpoint: {
      txid: funding.txid,
      vout: 0,
      valueSats: BigInt(cets.fundingOutpoint.valueSats)
    },
    network,
    currentBlock: BigInt(chainContext.height),
    chainContext
  });

  const artifact = {
    kind: 'civkit_ai_arbitration_smoke',
    createdAt: new Date().toISOString(),
    chainContext,
    fundingArtifactTxid: funding.txid,
    session: {
      tradeId: session.tradeId,
      authorizationMode: session.authorizationMode,
      expiryBlock: session.expiryBlock.toString(),
      feeQuote: {
        platformFeeSats: session.feeQuote.platformFeeSats.toString(),
        bookingFeeSats: session.feeQuote.bookingFeeSats.toString(),
        resolverFeeSats: session.feeQuote.resolverFeeSats.toString()
      }
    },
    subAgentReviews: result.reviews.map((review) => review.toJSON()),
    decision: {
      route: result.decisionSummary.route,
      reasonCode: result.decisionSummary.reasonCode,
      trustedToSign: result.decisionSummary.trustedToSign,
      confidenceBps: result.decisionSummary.decisionConfidenceBps,
      minSubAgentConfidenceBps: result.decisionSummary.minSubAgentConfidenceBps,
      averageReleaseScoreBps: result.decisionSummary.averageReleaseScoreBps,
      averageRefundScoreBps: result.decisionSummary.averageRefundScoreBps
    },
    receipt: {
      receiptHashHex: result.receipt.receiptHashHex,
      ...result.receipt.receipt.toJSON()
    },
    spendPackage: {
      network,
      taprootAddress: result.spendPackage.taproot.address,
      selectedLeaf: result.spendPackage.psbt.selectedLeaf.name,
      txId: result.spendPackage.txTemplate.txId,
      commitmentType: result.spendPackage.commitmentType,
      binding: result.spendPackage.binding,
      witnessPlan: result.spendPackage.authorization.witnessPlan,
      outputs: result.spendPackage.txTemplate.outputs.map((output) => ({
        role: output.role,
        amountSats: output.amountSats.toString(),
        scriptPubKeyHex: output.scriptPubKeyHex
      }))
    },
    bitvmChallenge: {
      route: result.bitvmChallengeBundle.route,
      verification: result.bitvmChallengeBundle.verification,
      binding: result.bitvmChallengeBundle.binding,
      signerSet: result.bitvmChallengeBundle.signerSet
    }
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(artifact, null, 2));

  console.log('=== CivKit AI Arbitration LTC Smoke ===');
  console.log(`chainMode=${chainContext.mode}`);
  console.log(`network=${network}`);
  console.log(`fundingTxid=${funding.txid}`);
  console.log(`route=${result.decisionSummary.route}`);
  console.log(`trustedToSign=${result.decisionSummary.trustedToSign}`);
  console.log(`taprootAddress=${result.spendPackage.taproot.address}`);
  console.log(`selectedLeaf=${result.spendPackage.psbt.selectedLeaf.name}`);
  console.log(`artifactPath=${OUT_PATH}`);
}

run().catch((error) => {
  console.error('AI arbitration smoke failed:', error.message);
  process.exit(1);
});
