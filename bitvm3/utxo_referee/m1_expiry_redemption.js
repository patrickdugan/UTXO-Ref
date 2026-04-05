/**
 * Milestone 1 - Expiry Redemption Witness Demo
 *
 * Builds a short-term expiry deposit -> redemption artifact using the
 * existing receipt ledger and an annotated witness blob.
 *
 * Run:
 *   node bitvm3/utxo_referee/m1_expiry_redemption.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const {
  ReceiptLedger,
  ReceiptTallyMap,
  buildSettlementDeltaAnnotation,
  buildWitnessBlobWithDelta
} = require('./index');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const DRAFT_PATH = path.join(ARTIFACTS_DIR, 'm1_dlc_draft_latest.json');
const FUNDING_FINAL_PATH = path.join(ARTIFACTS_DIR, 'm1_funding_finalized_latest.json');
const WITNESS_PATH = path.join(ARTIFACTS_DIR, 'm1_challenge_witness_latest.json');
const OUT_PATH = path.join(ARTIFACTS_DIR, 'm1_expiry_redemption_latest.json');

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function toBigInt(value, fallback = 0n) {
  if (value === null || value === undefined || value === '') {
    return BigInt(fallback);
  }
  return typeof value === 'bigint' ? value : BigInt(value);
}

function ensureFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing artifact: ${filePath}`);
  }
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function rpcConfigured() {
  return !!(process.env.LTC_RPC_URL && process.env.LTC_RPC_USER && process.env.LTC_RPC_PASS);
}

function rpcRequest(method, params = []) {
  return new Promise((resolve, reject) => {
    if (!rpcConfigured()) {
      reject(new Error('LTC RPC env vars are missing'));
      return;
    }

    const endpoint = new URL(process.env.LTC_RPC_URL);
    const transport = endpoint.protocol === 'https:' ? https : http;
    const body = JSON.stringify({
      jsonrpc: '1.0',
      id: `m1-expiry-${Date.now()}`,
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
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Basic ${Buffer.from(
          `${process.env.LTC_RPC_USER}:${process.env.LTC_RPC_PASS}`
        ).toString('base64')}`
      }
    };

    const req = transport.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;

        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          reject(new Error(`Invalid RPC response: ${raw.slice(0, 200)}`));
          return;
        }

        if (parsed.error) {
          reject(new Error(`RPC error (${method}): ${parsed.error.message}`));
          return;
        }

        resolve(parsed.result);
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function maybeProbeHeight() {
  if (!rpcConfigured()) {
    return { mode: 'mock', height: null, chain: null };
  }

  const [info, height] = await Promise.all([
    rpcRequest('getblockchaininfo'),
    rpcRequest('getblockcount')
  ]);

  return {
    mode: 'rpc',
    height,
    chain: info.chain
  };
}

function resolveRedemptionAmounts(witnessArtifact, fundingFinal, draft) {
  const transitionState = witnessArtifact?.witness?.transitionState || {};
  const route = witnessArtifact?.route || transitionState.route || 'roll';
  const collateralSats = toBigInt(
    transitionState.collateralSats ?? fundingFinal?.sourceCollateralSats ?? draft?.contract?.collateralSats ?? 0n
  );
  const actualPayoutSats = toBigInt(transitionState.actualPayoutSats ?? transitionState.payoutSats ?? 0n);
  const timeoutRemainderSats = toBigInt(
    transitionState.timeoutRemainderSats ?? transitionState.residualSats ?? transitionState.rolloverCollateralSats ?? 0n
  );
  const refundSats = toBigInt(transitionState.refundSats ?? timeoutRemainderSats ?? 0n);
  const rolloverCollateralSats = toBigInt(transitionState.rolloverCollateralSats ?? timeoutRemainderSats ?? refundSats ?? actualPayoutSats);
  const feeSats = toBigInt(transitionState.feeSats ?? 0n);
  const dustCarrySats = toBigInt(transitionState.dustCarrySats ?? 0n);

  const redeemedSats = route === 'roll'
    ? rolloverCollateralSats
    : actualPayoutSats;
  const pnlReferenceSats = collateralSats;
  const realizedPnlSats = route === 'roll'
    ? redeemedSats - pnlReferenceSats
    : actualPayoutSats - pnlReferenceSats;

  return {
    route,
    collateralSats,
    redeemedSats,
    pnlReferenceSats,
    realizedPnlSats,
    feeSats,
    dustCarrySats,
    timeoutRemainderSats,
    refundSats,
    rolloverCollateralSats
  };
}

async function run() {
  ensureFile(DRAFT_PATH);
  ensureFile(FUNDING_FINAL_PATH);
  ensureFile(WITNESS_PATH);

  const draft = loadJson(DRAFT_PATH);
  const fundingFinal = loadJson(FUNDING_FINAL_PATH);
  const witnessArtifact = loadJson(WITNESS_PATH);
  const chainProbe = await maybeProbeHeight();

  const ledger = new ReceiptLedger();
  const depositSats = toBigInt(
    witnessArtifact?.witness?.transitionState?.collateralSats
      || fundingFinal?.sourceCollateralSats
      || draft?.contract?.collateralSats
      || 0n
  );

  const deposit = ledger.applyDeposit({
    depositId: `expiry-deposit-${draft.canonical.epochId}`,
    accountId: 'expiry-depositor',
    amountSats: depositSats,
    chainTxRef: {
      txid: fundingFinal.txid,
      vout: 0,
      source: 'funding-finalized'
    }
  });

  const redemptionAmounts = resolveRedemptionAmounts(witnessArtifact, fundingFinal, draft);
  const redemption = ledger.applyRedemption({
    redemptionId: `expiry-redemption-${draft.canonical.epochId}`,
    accountId: 'expiry-depositor',
    amountSats: redemptionAmounts.redeemedSats
  });

  const tally = ReceiptTallyMap.fromLedger(ledger, {
    epochId: toBigInt(draft.canonical.epochId || '1'),
    challengeWindowStart: toBigInt(draft.contract.maturityHeight || 0),
    challengeWindowLength: 1n
  });

  const deltaAnnotation = buildSettlementDeltaAnnotation({
    epochId: draft.canonical.epochId,
    route: redemptionAmounts.route,
    depositedSats: deposit.mintedSats,
    redeemedSats: redemption.burnedSats,
    pnlReferenceSats: redemptionAmounts.pnlReferenceSats,
    realizedPnlSats: redemptionAmounts.realizedPnlSats,
    feeSats: redemptionAmounts.feeSats,
    maturityHeight: draft.contract.maturityHeight,
    expiryHeight: chainProbe.height,
    oracleEventId: draft.contract.eventId,
    oracleDigestHex: witnessArtifact?.witness?.transitionState?.deltaPublicationHash || null,
    note: 'expiry redemption witness blob'
  });

  const witnessBlob = buildWitnessBlobWithDelta(tally, deltaAnnotation);

  const artifact = {
    kind: 'm1_expiry_redemption',
    createdAt: new Date().toISOString(),
    chain: chainProbe,
    sourceArtifacts: {
      draftPath: DRAFT_PATH,
      fundingFinalPath: FUNDING_FINAL_PATH,
      witnessPath: WITNESS_PATH
    },
    deposit: {
      depositId: `expiry-deposit-${draft.canonical.epochId}`,
      accountId: 'expiry-depositor',
      amountSats: deposit.mintedSats.toString(),
      txid: fundingFinal.txid
    },
    redemption: {
      redemptionId: `expiry-redemption-${draft.canonical.epochId}`,
      accountId: 'expiry-depositor',
      amountSats: redemption.burnedSats.toString(),
      remainingBalanceSats: redemption.balanceSats.toString(),
      winnerSweepSats: deltaAnnotation.settlementBreakdown.winnerSweepSats,
      refundSats: deltaAnnotation.settlementBreakdown.refundSats,
      residualSats: deltaAnnotation.settlementBreakdown.residualSats,
      dustCarrySats: deltaAnnotation.settlementBreakdown.dustCarrySats,
      settlementKind: deltaAnnotation.settlementBreakdown.settlementKind
    },
    routingCommitments: {
      winnerRole: witnessArtifact?.witness?.transitionState?.winnerRole || null,
      winnerAddress: witnessArtifact?.witness?.transitionState?.winnerAddress || null,
      refundRole: witnessArtifact?.witness?.transitionState?.refundRole || null,
      refundAddress: witnessArtifact?.witness?.transitionState?.refundAddress || null,
      feeRole: witnessArtifact?.witness?.transitionState?.feeRole || null,
      feeAddress: witnessArtifact?.witness?.transitionState?.feeAddress || null,
      dustRole: witnessArtifact?.witness?.transitionState?.dustRole || null,
      dustAddress: witnessArtifact?.witness?.transitionState?.dustAddress || null
    },
    deltas: deltaAnnotation,
    settlementBreakdown: deltaAnnotation.settlementBreakdown,
    witnessBlob,
    tallySnapshot: tally.getCommittedSnapshot(),
    artifactHash: null
  };

  artifact.artifactHash = sha256Hex(JSON.stringify(artifact));
  fs.writeFileSync(OUT_PATH, JSON.stringify(artifact, null, 2));

  console.log('=== M1 Expiry Redemption ===');
  console.log(`chainMode=${chainProbe.mode}`);
  console.log(`epochId=${draft.canonical.epochId}`);
  console.log(`depositedSats=${artifact.deposit.amountSats}`);
  console.log(`redeemedSats=${artifact.redemption.amountSats}`);
  console.log(`winnerSweepSats=${artifact.settlementBreakdown.winnerSweepSats}`);
  console.log(`refundSats=${artifact.settlementBreakdown.refundSats}`);
  console.log(`dustCarrySats=${artifact.settlementBreakdown.dustCarrySats}`);
  console.log(`pnlGainSats=${deltaAnnotation.pnlGainSats}`);
  console.log(`pnlLossSats=${deltaAnnotation.pnlLossSats}`);
  console.log(`netDeltaSats=${deltaAnnotation.netDeltaSats}`);
  console.log(`artifactHash=${artifact.artifactHash}`);
  console.log(`artifactPath=${OUT_PATH}`);
}

run().catch(err => {
  console.error('Expiry redemption generation failed:', err.message);
  process.exit(1);
});
