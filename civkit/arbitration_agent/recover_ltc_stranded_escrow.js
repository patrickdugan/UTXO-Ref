const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

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
const OUT_PATH = path.join(OUT_DIR, 'ltc_ai_stranded_recovery_latest.json');
const DEFAULT_RPC_URL = process.env.LTC_RPC_URL || 'http://127.0.0.1:19332';
const DEFAULT_RPC_USER = process.env.LTC_RPC_USER || 'user';
const DEFAULT_RPC_PASS = process.env.LTC_RPC_PASS || 'pass';
const DEFAULT_WALLET = process.env.LTC_WALLET || 'tl-wallet';
const TARGET_TXID = process.env.CIVKIT_STRANDED_TXID || 'bcf4947ea4c20bc7ad210ad84f7e258989ed0779ec7b02feb6df11bdc30c759b';
const PLATFORM_FEE_SATS = 500n;
const BOOKING_FEE_SATS = 1000n;
const RESOLVER_FEE_SATS = 2500n;
const ESCROW_AMOUNT_SATS = 150000n;
const FUNDING_AMOUNT_SATS = 162000n;
const SEARCH_BACK_MS = Number(process.env.CIVKIT_RECOVER_SEARCH_BACK_MS || '120000');
const SEARCH_FORWARD_MS = Number(process.env.CIVKIT_RECOVER_SEARCH_FORWARD_MS || '5000');
const SEARCH_WORKERS = Math.max(1, Number(process.env.CIVKIT_RECOVER_WORKERS || '8'));
const PRELIMINARY_PLACEHOLDER_TXID = '99'.repeat(32);

function rpcFactory({ rpcUrl, rpcUser, rpcPass, wallet }) {
  const endpoint = new URL(rpcUrl);
  const transport = endpoint.protocol === 'https:' ? https : http;

  return async function rpc(method, params = [], walletOverride = wallet) {
    const walletPath = walletOverride ? `/wallet/${encodeURIComponent(walletOverride)}` : '';
    const pathname = endpoint.pathname && endpoint.pathname !== '/' ? endpoint.pathname : '';
    const targetPath = `${walletPath}${pathname || ''}` || '/';
    const payload = JSON.stringify({
      jsonrpc: '1.0',
      id: `civkit-recover-${method}`,
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

function addressToScriptPubKey(address, network) {
  return bitcoin.address.toOutputScript(address, escrow.onchain.normalizeNetwork(network));
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

function buildLiveSession(addresses, chainHeight, offerId) {
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
    offerId,
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

function buildCandidateTaproot({ addresses, ts, height, keyset, network }) {
  const session = buildLiveSession(addresses, height, `ltc-live-offer-${ts}`);
  const decision = new escrow.EscrowDecision({
    route: 'split',
    sellerAmountSats: 71460n,
    buyerAmountSats: 74540n,
    resolverFeeSats: RESOLVER_FEE_SATS,
    decisionId: `ai-split:${session.tradeId}`
  });
  const settlement = escrow.projector.buildEscrowSettlement(session.escrowOrder, decision, {
    currentBlock: BigInt(height)
  });
  const bitvm = escrow.buildEscrowBitvmChallengeBundle(session.escrowOrder, decision, {
    signerSet: {
      buyerSigned: true,
      sellerSigned: false,
      notarySigned: true
    },
    currentBlock: BigInt(height),
    splitRequiresNotary: true
  });
  const leaves = escrow.buildEscrowTapLeaves({
    releasePubkey: keyset.releasePubkey,
    refundPubkey: keyset.refundPubkey,
    notaryPubkey: keyset.notaryPubkey,
    expiryBlock: settlement.order.expiryBlock,
    commitmentHash: Buffer.from(bitvm.binding.transitionCommitmentHashHex, 'hex'),
    commitmentSignerPubkey: keyset.notaryPubkey,
    authorizationMode: escrow.AUTHORIZATION_MODES.threshold2of3
  });
  const taproot = escrow.buildEscrowTaprootContract({
    network,
    leaves
  });

  return {
    ts,
    height,
    session,
    decision,
    taproot
  };
}

function buildPreliminaryReceiptHash({ session, keyset, network, height }) {
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
    fundingOutpoint: {
      txid: PRELIMINARY_PLACEHOLDER_TXID,
      vout: 0,
      valueSats: FUNDING_AMOUNT_SATS
    },
    network,
    currentBlock: BigInt(height),
    chainContext: {
      mode: 'rpc',
      network,
      chain: 'test',
      height
    }
  });
  return preliminary.receipt.receiptHashHex;
}

function loadCurrentAddresses() {
  try {
    const currentArtifact = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'artifacts', 'ltc_ai_live_settlement_latest.json'), 'utf8')
    );
    return currentArtifact.addresses || {};
  } catch {
    return {};
  }
}

async function getAddressesByLabel(rpc, label) {
  const result = await rpc('getaddressesbylabel', [label]);
  return Object.keys(result || {});
}

async function deriveRecoveryAddresses(rpc) {
  const current = loadCurrentAddresses();
  const sellerCandidates = await getAddressesByLabel(rpc, 'civkit-live-seller');
  const buyerCandidates = await getAddressesByLabel(rpc, 'civkit-live-buyer');
  const platformCandidates = await getAddressesByLabel(rpc, 'civkit-live-platform');
  const notaryCandidates = await getAddressesByLabel(rpc, 'civkit-live-notary');

  function pickOlder(candidates, currentAddress, label) {
    const filtered = candidates.filter((address) => address !== currentAddress);
    if (filtered.length !== 1) {
      throw new Error(`Could not derive unique recovery address for ${label}`);
    }
    return filtered[0];
  }

  return {
    sellerAddress: pickOlder(sellerCandidates, current.sellerAddress, 'seller'),
    buyerAddress: pickOlder(buyerCandidates, current.buyerAddress, 'buyer'),
    platformAddress: pickOlder(platformCandidates, current.platformAddress, 'platform'),
    notaryAddress: pickOlder(notaryCandidates, current.notaryAddress, 'notary')
  };
}

function chunkRange(start, end, chunks) {
  const size = end - start + 1;
  const chunkSize = Math.ceil(size / chunks);
  const ranges = [];
  for (let index = 0; index < chunks; index += 1) {
    const chunkStart = start + index * chunkSize;
    const chunkEnd = Math.min(end, chunkStart + chunkSize - 1);
    if (chunkStart <= chunkEnd) {
      ranges.push({ start: chunkStart, end: chunkEnd });
    }
  }
  return ranges;
}

async function searchForMatch(searchConfig) {
  const ranges = chunkRange(searchConfig.startMs, searchConfig.endMs, searchConfig.workers);
  return new Promise((resolve, reject) => {
    let settled = false;
    let remaining = ranges.length;
    const workers = ranges.map((range) => new Worker(__filename, {
      workerData: {
        mode: 'search',
        searchConfig: {
          ...searchConfig,
          startMs: range.start,
          endMs: range.end
        }
      }
    }));

    function finalize(value, error = null) {
      if (settled) {
        return;
      }
      settled = true;
      for (const worker of workers) {
        worker.terminate().catch(() => {});
      }
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    }

    for (const worker of workers) {
      worker.on('message', (message) => {
        if (message && message.type === 'match') {
          finalize(message.payload);
          return;
        }
        if (message && message.type === 'done') {
          remaining -= 1;
          if (remaining === 0) {
            finalize(null);
          }
        }
      });
      worker.on('error', (error) => finalize(null, error));
      worker.on('exit', (code) => {
        if (code !== 0 && !settled) {
          finalize(null, new Error(`Search worker exited with code ${code}`));
        }
      });
    }
  });
}

async function main() {
  const rpc = rpcFactory({
    rpcUrl: DEFAULT_RPC_URL,
    rpcUser: DEFAULT_RPC_USER,
    rpcPass: DEFAULT_RPC_PASS,
    wallet: DEFAULT_WALLET
  });

  const tx = await rpc('gettransaction', [TARGET_TXID, true, true]);
  const chainInfo = await rpc('getblockchaininfo', [], null);
  const walletInfo = await rpc('getwalletinfo');
  const currentHeight = await rpc('getblockcount', [], null);
  const targetAddress = tx.details[0].address;
  const targetReceiptHashHex = String(tx.to || '').toLowerCase();
  const fundingOutpoint = {
    txid: tx.txid,
    vout: Number(tx.details[0].vout),
    valueSats: BigInt(Math.round(Math.abs(Number(tx.details[0].amount)) * 1e8))
  };
  const recoveryAddresses = await deriveRecoveryAddresses(rpc);
  const startMs = Number(process.env.CIVKIT_RECOVER_START_MS || (tx.time * 1000 - SEARCH_BACK_MS));
  const endMs = Number(process.env.CIVKIT_RECOVER_END_MS || (tx.time * 1000 + SEARCH_FORWARD_MS));
  const heights = (process.env.CIVKIT_RECOVER_HEIGHTS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => Number(entry));
  const candidateHeights = heights.length > 0
    ? heights
    : [tx.decoded.locktime, tx.decoded.locktime - 1, tx.decoded.locktime - 2];
  const keyset = {
    releasePubkey: nostr.derivePubkeyHex(fixedPrivateKey(0x11)),
    refundPubkey: nostr.derivePubkeyHex(fixedPrivateKey(0x22)),
    notaryPubkey: nostr.derivePubkeyHex(fixedPrivateKey(0x33))
  };
  const searchConfig = {
    addresses: recoveryAddresses,
    keyset,
    network: 'litecoin-testnet',
    targetAddress,
    targetReceiptHashHex,
    heights: candidateHeights,
    startMs,
    endMs,
    workers: SEARCH_WORKERS
  };

  const match = await searchForMatch(searchConfig);
  if (match == null) {
    throw new Error(`No contract match found for ${targetAddress} in ${startMs}-${endMs}`);
  }

  const session = buildLiveSession(recoveryAddresses, match.height, match.offerId);
  const spendPackage = platform.buildTradeSpendPackage(session, match.decision, {
    keyset,
    fundingOutpoint,
    network: 'litecoin-testnet',
    currentBlock: BigInt(match.height),
    splitRequiresNotary: true
  });
  const psbt = spendPackage.psbt.psbt;
  psbt.signInput(0, makeTaprootSigner(fixedPrivateKey(0x22)), [bitcoin.Transaction.SIGHASH_DEFAULT]);
  psbt.signInput(0, makeTaprootSigner(fixedPrivateKey(0x33)), [bitcoin.Transaction.SIGHASH_DEFAULT]);
  finalizeWithWitnessPlan(psbt, spendPackage, keyset);

  const finalTx = psbt.extractTransaction();
  const finalHex = finalTx.toHex();
  const mempoolAccept = await rpc('testmempoolaccept', [[finalHex]], null);
  if (!Array.isArray(mempoolAccept) || !mempoolAccept[0] || mempoolAccept[0].allowed !== true) {
    throw new Error(`Recovery tx rejected by testmempoolaccept: ${JSON.stringify(mempoolAccept)}`);
  }

  const recoveryTxid = await rpc('sendrawtransaction', [finalHex], null);
  const decodedRecovery = await rpc('decoderawtransaction', [finalHex], null);

  const artifact = {
    kind: 'civkit_ai_ltc_stranded_recovery',
    createdAt: new Date().toISOString(),
    wallet: {
      walletName: DEFAULT_WALLET,
      balance: walletInfo.balance,
      rpcUrl: DEFAULT_RPC_URL
    },
    chain: {
      chain: chainInfo.chain,
      height: currentHeight,
      network: 'litecoin-testnet'
    },
    strandedFunding: {
      txid: TARGET_TXID,
      address: targetAddress,
      outpoint: {
        txid: fundingOutpoint.txid,
        vout: fundingOutpoint.vout,
        valueSats: fundingOutpoint.valueSats.toString()
      },
      walletCommentTo: tx.to
    },
    recoveredMatch: {
      offerId: match.offerId,
      offerTimestampMs: match.ts,
      height: match.height,
      tradeId: match.tradeId,
      addresses: recoveryAddresses
    },
    settlement: {
      txid: recoveryTxid,
      txHex: finalHex,
      decoded: {
        txid: decodedRecovery.txid,
        hash: decodedRecovery.hash,
        vsize: decodedRecovery.vsize,
        weight: decodedRecovery.weight,
        locktime: decodedRecovery.locktime
      },
      mempoolAccept: mempoolAccept[0],
      selectedLeaf: spendPackage.psbt.selectedLeaf.name,
      witnessPlan: spendPackage.authorization.witnessPlan,
      binding: spendPackage.binding,
      outputs: spendPackage.txTemplate.outputs.map((output) => ({
        role: output.role,
        amountSats: output.amountSats.toString(),
        scriptPubKeyHex: output.scriptPubKeyHex
      }))
    }
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(artifact, null, 2));

  console.log('=== CivKit LTC Stranded Recovery ===');
  console.log(`strandedTxid=${TARGET_TXID}`);
  console.log(`recoveryTxid=${recoveryTxid}`);
  console.log(`offerId=${match.offerId}`);
  console.log(`tradeId=${match.tradeId}`);
  console.log(`artifactPath=${OUT_PATH}`);
}

function workerSearch() {
  const {
    addresses,
    keyset,
    network,
    targetAddress,
    targetReceiptHashHex,
    heights,
    startMs,
    endMs
  } = workerData.searchConfig;

  for (const height of heights) {
    for (let ts = startMs; ts <= endMs; ts += 1) {
      const candidate = buildCandidateTaproot({
        addresses,
        ts,
        height,
        keyset,
        network
      });
      if (candidate.taproot.address === targetAddress) {
        if (targetReceiptHashHex) {
          const receiptHashHex = buildPreliminaryReceiptHash({
            session: candidate.session,
            keyset,
            network,
            height
          });
          if (receiptHashHex !== targetReceiptHashHex) {
            continue;
          }
        }
        parentPort.postMessage({
          type: 'match',
          payload: {
            ts,
            height,
            offerId: `ltc-live-offer-${ts}`,
            tradeId: candidate.session.tradeId,
            decision: {
              route: candidate.decision.route,
              sellerAmountSats: candidate.decision.sellerAmountSats.toString(),
              buyerAmountSats: candidate.decision.buyerAmountSats.toString(),
              resolverFeeSats: candidate.decision.resolverFeeSats.toString(),
              decisionId: candidate.decision.decisionId
            }
          }
        });
        return;
      }
    }
  }

  parentPort.postMessage({ type: 'done' });
}

if (!isMainThread) {
  try {
    workerSearch();
  } catch (error) {
    throw error;
  }
} else {
  main().catch((error) => {
    console.error('LTC stranded recovery failed:', error.message);
    process.exit(1);
  });
}
