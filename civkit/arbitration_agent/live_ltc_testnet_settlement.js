const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const bitcoin = require('../../node-dlc/packages/messaging/node_modules/bitcoinjs-lib/src');
const tinysecp = require('../../node-dlc/packages/messaging/node_modules/tiny-secp256k1');
const schnorr = require('../../node-dlc/packages/messaging/node_modules/bip-schnorr');
const { witnessStackToScriptWitness } = require('../../node-dlc/packages/messaging/node_modules/bitcoinjs-lib/src/psbt/psbtutils');
const { tapleafHash } = require('../../node-dlc/packages/messaging/node_modules/bitcoinjs-lib/src/payments/bip341');

const platform = require('../p2p_platform');
const escrow = require('../bitvm_escrow');
const nostr = require('../nostr_agent');
const arbitration = require('./index');

const OUT_DIR = path.join(__dirname, 'artifacts');
const OUT_PATH = path.join(OUT_DIR, 'ltc_ai_live_settlement_latest.json');
const DEFAULT_RPC_URL = process.env.LTC_RPC_URL || 'http://127.0.0.1:19332';
const DEFAULT_RPC_USER = process.env.LTC_RPC_USER || 'user';
const DEFAULT_RPC_PASS = process.env.LTC_RPC_PASS || 'pass';
const DEFAULT_WALLET = process.env.LTC_WALLET || 'tl-wallet';
const ESCROW_AMOUNT_SATS = BigInt(process.env.CIVKIT_LIVE_ESCROW_SATS || '150000');
const FUNDING_FEE_RESERVE_SATS = BigInt(process.env.CIVKIT_LIVE_FUNDING_RESERVE_SATS || '12000');
const PLATFORM_FEE_SATS = BigInt(process.env.CIVKIT_LIVE_PLATFORM_FEE_SATS || '500');
const BOOKING_FEE_SATS = BigInt(process.env.CIVKIT_LIVE_BOOKING_FEE_SATS || '1000');
const RESOLVER_FEE_SATS = BigInt(process.env.CIVKIT_LIVE_RESOLVER_FEE_SATS || '2500');

function rpcFactory({ rpcUrl, rpcUser, rpcPass, wallet }) {
  const endpoint = new URL(rpcUrl);
  const transport = endpoint.protocol === 'https:' ? https : http;

  return async function rpc(method, params = [], walletOverride = wallet) {
    const walletPath = walletOverride ? `/wallet/${encodeURIComponent(walletOverride)}` : '';
    const pathname = endpoint.pathname && endpoint.pathname !== '/' ? endpoint.pathname : '';
    const targetPath = `${walletPath}${pathname || ''}` || '/';
    const payload = JSON.stringify({
      jsonrpc: '1.0',
      id: `civkit-live-${method}`,
      method,
      params
    });

    const options = {
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
      path: targetPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Basic ${Buffer.from(`${rpcUser}:${rpcPass}`).toString('base64')}`
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

function satsToCoinsString(value) {
  const normalized = BigInt(value);
  const sign = normalized < 0n ? '-' : '';
  const absolute = normalized < 0n ? -normalized : normalized;
  const whole = absolute / 100000000n;
  const fraction = absolute % 100000000n;
  return `${sign}${whole}.${fraction.toString().padStart(8, '0')}`;
}

function fixedPrivateKey(byte) {
  return Buffer.alloc(32, byte).toString('hex');
}

function compressedPubkeyFromPrivateKeyHex(privateKeyHex) {
  const point = tinysecp.pointFromScalar(Buffer.from(privateKeyHex, 'hex'), true);
  if (!point) {
    throw new Error('Failed to derive compressed pubkey');
  }
  return Buffer.from(point);
}

function addressToScriptPubKey(address, network) {
  return bitcoin.address.toOutputScript(address, escrow.onchain.normalizeNetwork(network));
}

function makeTaprootSigner(privateKeyHex) {
  return {
    publicKey: compressedPubkeyFromPrivateKeyHex(privateKeyHex),
    signSchnorr(hash) {
      return Buffer.from(schnorr.sign(privateKeyHex, hash));
    }
  };
}

function asBuffer(value, label) {
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  const text = String(value || '');
  if (!/^[0-9a-fA-F]+$/.test(text) || text.length % 2 !== 0) {
    throw new Error(`${label} must be a Buffer or hex string`);
  }
  return Buffer.from(text, 'hex');
}

async function waitForFundingOutpoint(rpc, txid, expectedScriptHex, attempts = 20, delayMs = 1000) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const tx = await rpc('getrawtransaction', [txid, true], null);
    const vout = (tx.vout || []).find((output) => {
      const scriptHex = output.scriptPubKey && output.scriptPubKey.hex;
      return scriptHex === expectedScriptHex;
    });

    if (vout) {
      return {
        txid,
        vout: Number(vout.n),
        valueSats: BigInt(Math.round(Number(vout.value) * 1e8)),
        scriptPubKeyHex: vout.scriptPubKey.hex,
        confirmations: Number(tx.confirmations || 0)
      };
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`Funding output for script ${expectedScriptHex} not found in tx ${txid}`);
}

async function createWalletAddresses(rpc) {
  const [sellerAddress, buyerAddress, platformAddress, notaryAddress] = await Promise.all([
    rpc('getnewaddress', ['civkit-live-seller', 'bech32']),
    rpc('getnewaddress', ['civkit-live-buyer', 'bech32']),
    rpc('getnewaddress', ['civkit-live-platform', 'bech32']),
    rpc('getnewaddress', ['civkit-live-notary', 'bech32'])
  ]);

  return {
    sellerAddress,
    buyerAddress,
    platformAddress,
    notaryAddress
  };
}

function finalizeWithWitnessPlan(psbt, spendPackage, keyset) {
  const input = psbt.data.inputs[0];
  const tapLeaf = input.tapLeafScript[0];
  const targetLeafHash = tapleafHash({
    output: tapLeaf.script,
    version: tapLeaf.leafVersion
  });
  const signatures = new Map(
    (input.tapScriptSig || [])
      .filter((entry) => entry.leafHash.equals(targetLeafHash))
      .map((entry) => [entry.pubkey.toString('hex'), entry.signature])
  );
  const witnessStack = spendPackage.authorization.witnessPlan.signatureSlots.map((slot) => {
    if (!slot.signed || slot.keyField == null) {
      return Buffer.alloc(0);
    }
    const signature = signatures.get(asBuffer(keyset[slot.keyField], slot.keyField).toString('hex'));
    if (!signature) {
      throw new Error(`Missing taproot signature for ${slot.signerRole}`);
    }
    return signature;
  });
  witnessStack.push(tapLeaf.script, tapLeaf.controlBlock);

  psbt.finalizeTaprootInput(0, targetLeafHash, () => ({
    finalScriptWitness: witnessStackToScriptWitness(witnessStack)
  }));
}

function buildLiveSession(addresses, chainHeight) {
  const network = 'litecoin-testnet';
  const marketplacePolicy = new platform.MarketplacePolicy({
    policyId: 'ltc-ai-arb-live',
    platformFeeScriptPubKey: addressToScriptPubKey(addresses.platformAddress, network),
    platformFeeBps: 0,
    platformFlatFeeSats: PLATFORM_FEE_SATS,
    escrowExpiryBlocks: 288n,
    requiredWhitelistTag: 'ltc-testnet-ai-arb',
    minNotaryReputation: 80,
    maxResolverFeeBps: 400,
    allowedPaymentMethods: ['cash_deposit'],
    allowedRegions: ['LTC-TESTNET']
  });
  const registry = new platform.NotaryRegistry([
    {
      notaryId: 'ai-arbitrator-ltc-live',
      nostrPubkey: nostr.derivePubkeyHex(fixedPrivateKey(0x33)),
      settlementScriptPubKey: addressToScriptPubKey(addresses.notaryAddress, network),
      bookingFlatFeeSats: BOOKING_FEE_SATS,
      resolverFlatFeeSats: RESOLVER_FEE_SATS,
      resolverFeeBps: 0,
      supportedPaymentMethods: ['cash_deposit'],
      supportedRegions: ['LTC-TESTNET'],
      whitelistTags: ['ltc-testnet-ai-arb'],
      reputationScore: 99
    }
  ]);
  const offer = new platform.MarketOffer({
    offerId: `ltc-live-offer-${Date.now()}`,
    epochId: BigInt(chainHeight),
    sellerId: 'seller-ai-live',
    amountSats: ESCROW_AMOUNT_SATS,
    fiatCurrency: 'USD',
    fiatAmountMinor: 125000n,
    paymentMethod: 'cash_deposit',
    region: 'LTC-TESTNET',
    sellerPayoutScriptPubKey: addressToScriptPubKey(addresses.sellerAddress, network),
    buyerRefundScriptPubKey: addressToScriptPubKey(addresses.buyerAddress, network)
  });

  return platform.openTradeSession({
    policy: marketplacePolicy,
    registry,
    offer,
    startBlock: BigInt(chainHeight)
  });
}

function buildDecisionEvidence(fundingTxid) {
  return [
    {
      evidenceId: 'funding',
      kind: 'chain_funding_confirmed',
      submittedBy: 'system',
      reliabilityBps: 9900,
      summary: `Funding tx ${fundingTxid} created for live LTC settlement`
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
  ];
}

async function run() {
  const rpc = rpcFactory({
    rpcUrl: DEFAULT_RPC_URL,
    rpcUser: DEFAULT_RPC_USER,
    rpcPass: DEFAULT_RPC_PASS,
    wallet: DEFAULT_WALLET
  });
  const chainInfo = await rpc('getblockchaininfo', [], null);
  const chainHeight = await rpc('getblockcount', [], null);
  const walletInfo = await rpc('getwalletinfo');
  const network = 'litecoin-testnet';

  const addresses = await createWalletAddresses(rpc);
  const session = buildLiveSession(addresses, chainHeight);
  const fundingAmountSats = session.offer.amountSats + FUNDING_FEE_RESERVE_SATS;
  const keyset = {
    releasePubkey: nostr.derivePubkeyHex(fixedPrivateKey(0x11)),
    refundPubkey: nostr.derivePubkeyHex(fixedPrivateKey(0x22)),
    notaryPubkey: nostr.derivePubkeyHex(fixedPrivateKey(0x33))
  };
  const placeholderFundingOutpoint = {
    txid: '99'.repeat(32),
    vout: 0,
    valueSats: fundingAmountSats
  };

  const preliminary = arbitration.runArbitratedTrade({
    session,
    policy: {
      policyId: 'bounded-ai-ltc-live-v1',
      minSubAgentConfidenceBps: 6200,
      minDecisionConfidenceBps: 7000,
      splitBandBps: 1400,
      splitRequiresNotary: true
    },
    evidence: buildDecisionEvidence('pending'),
    arbitratorId: 'ai_arbitrator_ltc_live',
    keyset,
    fundingOutpoint: placeholderFundingOutpoint,
    network,
    currentBlock: BigInt(chainHeight),
    chainContext: {
      mode: 'rpc',
      network,
      chain: chainInfo.chain,
      height: chainHeight
    }
  });

  const fundingTxid = await rpc('sendtoaddress', [
    preliminary.spendPackage.taproot.address,
    Number(satsToCoinsString(fundingAmountSats)),
    'civkit live escrow funding',
    preliminary.receipt.receiptHashHex,
    false
  ]);
  const fundingOutpoint = await waitForFundingOutpoint(
    rpc,
    fundingTxid,
    preliminary.spendPackage.taproot.outputHex
  );

  const liveResult = arbitration.runArbitratedTrade({
    session,
    policy: preliminary.policy,
    evidence: buildDecisionEvidence(fundingTxid),
    arbitratorId: 'ai_arbitrator_ltc_live',
    keyset,
    fundingOutpoint,
    network,
    currentBlock: BigInt(chainHeight),
    chainContext: {
      mode: 'rpc',
      network,
      chain: chainInfo.chain,
      height: chainHeight,
      fundingTxid
    }
  });

  const buyerSigner = makeTaprootSigner(fixedPrivateKey(0x22));
  const notarySigner = makeTaprootSigner(fixedPrivateKey(0x33));
  const psbt = liveResult.spendPackage.psbt.psbt;
  psbt.signInput(0, buyerSigner, [bitcoin.Transaction.SIGHASH_DEFAULT]);
  psbt.signInput(0, notarySigner, [bitcoin.Transaction.SIGHASH_DEFAULT]);
  finalizeWithWitnessPlan(psbt, liveResult.spendPackage, keyset);

  const finalTx = psbt.extractTransaction();
  const finalHex = finalTx.toHex();
  const mempoolAccept = await rpc('testmempoolaccept', [[finalHex]], null);
  if (!Array.isArray(mempoolAccept) || !mempoolAccept[0] || mempoolAccept[0].allowed !== true) {
    throw new Error(`Settlement tx rejected by testmempoolaccept: ${JSON.stringify(mempoolAccept)}`);
  }

  const settlementTxid = await rpc('sendrawtransaction', [finalHex], null);
  const decodedSettlement = await rpc('decoderawtransaction', [finalHex], null);

  const settlementEvent = nostr.buildSettlementDecisionEvent({
    privateKeyHex: fixedPrivateKey(0x33),
    session,
    decisionLike: liveResult.decisionSummary.decision,
    spendPackage: liveResult.spendPackage,
    signerSet: liveResult.bitvmChallengeBundle.signerSet,
    authorizationMode: session.authorizationMode,
    splitRequiresNotary: true,
    currentBlock: BigInt(chainHeight)
  });

  const artifact = {
    kind: 'civkit_ai_live_ltc_settlement',
    createdAt: new Date().toISOString(),
    wallet: {
      walletName: DEFAULT_WALLET,
      balance: walletInfo.balance,
      rpcUrl: DEFAULT_RPC_URL
    },
    chain: {
      chain: chainInfo.chain,
      height: chainHeight,
      network
    },
    addresses,
    session: {
      tradeId: session.tradeId,
      expiryBlock: session.expiryBlock.toString(),
      authorizationMode: session.authorizationMode,
      feeQuote: {
        platformFeeSats: session.feeQuote.platformFeeSats.toString(),
        bookingFeeSats: session.feeQuote.bookingFeeSats.toString(),
        resolverFeeSats: session.feeQuote.resolverFeeSats.toString()
      }
    },
    arbitration: {
      route: liveResult.decisionSummary.route,
      reasonCode: liveResult.decisionSummary.reasonCode,
      trustedToSign: liveResult.decisionSummary.trustedToSign,
      confidenceBps: liveResult.decisionSummary.decisionConfidenceBps,
      receiptHashHex: liveResult.receipt.receiptHashHex,
      receipt: liveResult.receipt.receipt.toJSON(),
      subAgentReviews: liveResult.reviews.map((review) => review.toJSON())
    },
    funding: {
      txid: fundingTxid,
      outpoint: {
        txid: fundingOutpoint.txid,
        vout: fundingOutpoint.vout,
        valueSats: fundingOutpoint.valueSats.toString(),
        confirmations: fundingOutpoint.confirmations
      },
      address: liveResult.spendPackage.taproot.address
    },
    settlement: {
      txid: settlementTxid,
      txHex: finalHex,
      decoded: {
        txid: decodedSettlement.txid,
        hash: decodedSettlement.hash,
        vsize: decodedSettlement.vsize,
        weight: decodedSettlement.weight,
        locktime: decodedSettlement.locktime
      },
      mempoolAccept: mempoolAccept[0],
      selectedLeaf: liveResult.spendPackage.psbt.selectedLeaf.name,
      witnessPlan: liveResult.spendPackage.authorization.witnessPlan,
      commitmentType: liveResult.spendPackage.commitmentType,
      binding: liveResult.spendPackage.binding,
      outputs: liveResult.spendPackage.txTemplate.outputs.map((output) => ({
        role: output.role,
        amountSats: output.amountSats.toString(),
        scriptPubKeyHex: output.scriptPubKeyHex
      }))
    },
    nostrSettlementEvent: settlementEvent
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(artifact, null, 2));

  console.log('=== CivKit AI Live LTC Settlement ===');
  console.log(`wallet=${DEFAULT_WALLET}`);
  console.log(`fundingTxid=${fundingTxid}`);
  console.log(`settlementTxid=${settlementTxid}`);
  console.log(`route=${liveResult.decisionSummary.route}`);
  console.log(`selectedLeaf=${liveResult.spendPackage.psbt.selectedLeaf.name}`);
  console.log(`taprootAddress=${liveResult.spendPackage.taproot.address}`);
  console.log(`artifactPath=${OUT_PATH}`);
}

run().catch((error) => {
  console.error('Live LTC settlement failed:', error.message);
  process.exit(1);
});
