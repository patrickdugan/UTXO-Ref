#!/usr/bin/env node

const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  paymentHashFromPreimageHex,
  payInvoiceViaLndRest,
  lookupPaymentViaLndRest
} = require('./lndRestClient');
const { buildWalletDemoConfig, verifyWalletDemoConfig } = require('../wallet-demo/walletBackendProfiles');
const { HttpError, sendJson: sendJsonBody, readJsonBody, boundedInteger, writeAtomicPrivate } = require('../shared/service');
const { buildStressDashboard, verifyStressDashboard } = require('../wallet-demo/stressDashboard');
const { buildAdapterFeed } = require('../wallet-dashboard-vercel/api/adapterFeed');
const {
  buildDlcSubswapFundingRequest,
  verifyDlcSubswapFundingRequest,
  buildDlcSubswapFundingWalletView
} = require('../../bitvm3/utxo_referee/utxoref_dlc_subswap_funding');
const {
  buildBitvmChannelRouterBundle,
  verifyBitvmChannelRouterBundle,
  verifyBitvmChannelRouterPlan
} = require('../../bitvm3/utxo_referee/bitvm_channel_router');

const repoRoot = path.join(__dirname, '..', '..');
const artifactDir = path.join(repoRoot, 'bitvm3', 'utxo_referee', 'artifacts');
const leasePath = path.join(artifactDir, 'lightning_liquidity_lease_latest.json');
const subswapPath = path.join(artifactDir, 'lightning_subswap_dlc_latest.json');
const dlcPath = path.join(artifactDir, 'lightning_tradelayer_oracle_dlc_latest.json');
const dlcSubswapFundingPath = path.join(artifactDir, 'utxoref_dlc_subswap_funding_latest.json');
const stablecoinPath = path.join(artifactDir, 'lightning_taproot_assets_stablecoin_latest.json');
const arkGraftPath = path.join(artifactDir, 'lightning_ark_liquidity_graft_latest.json');
const arkGovernorBenchPath = path.join(artifactDir, 'ark_liquidity_governor_bench_latest.json');
const arkDlcSettlementPath = path.join(artifactDir, 'ark_dlc_settlement_latest.json');
const arkLiquidityGraftManagerPath = path.join(artifactDir, 'ark_liquidity_graft_manager_latest.json');
const lnbtcTlusdLiquidityPatchPath = path.join(artifactDir, 'lnbtc_tlusd_liquidity_patch_latest.json');
const bitvmChannelRouterPath = path.join(artifactDir, 'bitvm_channel_router_latest.json');
const walletDemoDir = path.join(repoRoot, 'integrations', 'wallet-demo');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonIfExists(filePath) {
  return fs.existsSync(filePath) ? readJson(filePath) : null;
}

function artifactStatus(name, filePath, summarize) {
  if (!fs.existsSync(filePath)) {
    return { name, exists: false };
  }
  const stat = fs.statSync(filePath);
  const artifact = readJson(filePath);
  return {
    name,
    exists: true,
    path: filePath,
    updatedAt: stat.mtime.toISOString(),
    bytes: stat.size,
    summary: summarize ? summarize(artifact) : undefined
  };
}

function walletDemoStatus() {
  const config = buildWalletDemoConfig(process.env);
  const patchArtifact = artifactStatus('lnbtc_tlusd_liquidity_patch', lnbtcTlusdLiquidityPatchPath, patch => ({
    ok: Boolean(patch.verification && patch.verification.ok),
    lnbtcSats: patch.conversion.conversionCore.lnbtcSats,
    tlusdUnits: patch.conversion.conversionCore.tlusdUnits,
    stakedTlUsdUnits: patch.stake.stakeCore.stakedTlUsdUnits,
    assignedInboundSats: patch.mandate.manager.allocation.totals.assignedInboundSats,
    slashableAssignments: patch.mandate.manager.allocation.totals.slashableAssignments
  }));
  const routerArtifact = artifactStatus('bitvm_channel_router', bitvmChannelRouterPath, router => ({
    ok: Boolean(router.verification && router.verification.ok),
    routerId: router.plan.routerId,
    targetAmountSats: router.walletView.targetAmountSats,
    assignedSats: router.walletView.assignedSats,
    selectedShards: router.walletView.selectedChannels.length
  }));
  const profile = config.activeProfile;
  const lnd = profile.lnd
    ? {
        network: profile.lnd.network,
        restUrl: profile.lnd.restUrl,
        grpcHost: profile.lnd.grpcHost,
        macaroonConfigured: Boolean(profile.lnd.macaroonPath),
        tlsConfigured: Boolean(profile.lnd.tlsCertPath)
      }
    : null;
  const bitcoinLndReady = Boolean(
    profile.id === 'bitcoin-testnet-lnd' &&
      lnd &&
      lnd.macaroonConfigured &&
      lnd.tlsConfigured
  );

  return {
    kind: 'utxoref_wallet_demo_status',
    service: 'utxoref-liquidity-lease-sidecar',
    sidecarOk: true,
    activeProfileId: config.activeProfileId,
    profile: {
      id: profile.id,
      mode: profile.mode,
      displayName: profile.displayName,
      chainSourceBadge: profile.chainSourceBadge,
      labels: profile.labels
    },
    chain: {
      chain: profile.bitvm.chain,
      rpcUrl: profile.bitvm.rpcUrl,
      wallet: profile.bitvm.wallet,
      status: 'configured'
    },
    lnd,
    artifacts: {
      lnbtcTlusdLiquidityPatch: patchArtifact,
      bitvmChannelRouter: routerArtifact
    },
    readiness: {
      walletViewReady: patchArtifact.exists && Boolean(patchArtifact.summary && patchArtifact.summary.ok),
      localLitecoinReady: profile.id === 'litecoin-testnet-local',
      bitcoinLndReady,
      warnings: config.warnings
    }
  };
}

// The bearer token gates every POST route. It is read once from a file that must not be group or world accessible.
// Windows has no mode bits (stat reports 0o666 for any writable file whatever its ACL), so there the check is
// skipped and the file's ACL is what protects it: keep it under the operator's own profile.
function loadSidecarApiToken(env = process.env) {
  if (!env.SIDECAR_API_TOKEN_FILE) return '';
  if (process.platform !== 'win32' && (fs.statSync(env.SIDECAR_API_TOKEN_FILE).mode & 0o077)) {
    throw new Error(`${env.SIDECAR_API_TOKEN_FILE} must not be group or world accessible (use mode 0600)`);
  }
  return fs.readFileSync(env.SIDECAR_API_TOKEN_FILE, 'utf8').trim();
}

const sidecarApiToken = loadSidecarApiToken();

function postAuthorized(req) {
  if (!sidecarApiToken) return false;
  const expected = Buffer.from(`Bearer ${sidecarApiToken}`);
  const given = Buffer.from(String(req.headers.authorization || ''));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Only read-only GETs are readable cross-origin; the preflight for writes gets no CORS grant.
function sendJson(res, status, payload) {
  const cors = res.req && res.req.method === 'GET' ? { 'access-control-allow-origin': '*' } : {};
  sendJsonBody(res, status, payload, cors);
}

function sendFile(res, filePath, contentType) {
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  res.end(body);
}

function walletView(lease, subswap) {
  const bundle = lease.verification ? lease : { ...lease, verification: { ok: true } };
  return {
    kind: 'wallet_liquidity_lease_view',
    status: bundle.verification.ok ? 'verified' : 'needs_attention',
    title: 'Inbound Liquidity Lease',
    subtitle: `${bundle.offer.terms.promisedInboundSats} sats for ${bundle.offer.terms.leaseBlocks} blocks`,
    amountSats: bundle.offer.terms.promisedInboundSats,
    maxFeePpm: bundle.offer.terms.maxFeePpm,
    maxCltvDelta: bundle.offer.terms.maxCltvDelta,
    penaltySats: bundle.offer.terms.penaltySats,
    paymentHashHex: bundle.offer.terms.paymentHashHex,
    leaseOfferId: bundle.offer.offerId,
    successEvidenceId: bundle.successEvidence.evidenceId,
    channelOutpoint: bundle.successEvidence.evidenceCore.channelOutpoint,
    fundingCommitmentHash: bundle.successEvidence.evidenceCore.fundingCommitmentHash,
    htlc: {
      swapFundingTxid: subswap && subswap.swap && subswap.swap.fundingTxid,
      claimTxid: subswap && subswap.dlcFunding && subswap.dlcFunding.claimTxid,
      refundTxid: subswap && subswap.refundPath && subswap.refundPath.refundTxid
    },
    actions: [
      { id: 'verify_success', label: 'Verify lease evidence' },
      { id: 'prepare_challenge', label: 'Prepare challenge' },
      { id: 'show_htlc', label: 'Show HTLC proof' }
    ]
  };
}

function stablecoinWalletView(stablecoin, lease, subswap) {
  const bundle = stablecoin.verification ? stablecoin : { ...stablecoin, verification: { ok: true } };
  const quote = bundle.rfqQuote.quoteCore;
  const asset = bundle.asset.descriptorCore;
  const settlement = bundle.settlementEvidence.settlementCore;
  return {
    kind: 'wallet_taproot_assets_stablecoin_view',
    status: bundle.verification.ok ? 'verified' : 'needs_attention',
    title: `${asset.ticker} Lightning Stablecoin RFQ`,
    subtitle: `${quote.assetAmountUnits} units routes as ${quote.btcRouteSats} sats over Lightning`,
    assetTicker: asset.ticker,
    assetId: asset.assetId,
    assetAmountUnits: quote.assetAmountUnits,
    decimalDisplay: asset.decimalDisplay,
    edgeNodeId: quote.edgeNodeId,
    quoteId: bundle.rfqQuote.quoteId,
    maxSpreadPpm: quote.maxSpreadPpm,
    quotedSpreadPpm: quote.quotedSpreadPpm,
    maxRoutingFeePpm: quote.maxRoutingFeePpm,
    quotedRoutingFeePpm: quote.quotedRoutingFeePpm,
    btcRouteSats: quote.btcRouteSats,
    deliveredBtcSats: settlement.deliveredBtcSats,
    paymentHashHex: quote.paymentHashHex,
    assetProofId: bundle.assetProof.proofId,
    universeRoot: bundle.assetProof.proofCore.universeRoot,
    anchorOutpoint: bundle.assetProof.proofCore.anchorOutpoint,
    liquidityLeaseBundleId: settlement.liquidityLeaseBundleId,
    channelOutpoint: settlement.channelOrSpliceOutpoint,
    htlc: {
      swapFundingTxid: subswap && subswap.swap && subswap.swap.fundingTxid,
      claimTxid: subswap && subswap.dlcFunding && subswap.dlcFunding.claimTxid,
      refundTxid: subswap && subswap.refundPath && subswap.refundPath.refundTxid
    },
    checks: bundle.settlementEvidence.checks,
    actions: [
      { id: 'verify_stablecoin_rfq', label: 'Verify RFQ settlement' },
      { id: 'show_asset_proof', label: 'Show Taproot Asset proof' },
      { id: 'prepare_stablecoin_challenge', label: 'Prepare challenge' }
    ],
    linkedLiquidityLease: walletView(lease, subswap)
  };
}

function arkGraftWalletView(arkGraft, lease, subswap) {
  const bundle = arkGraft.verification ? arkGraft : { ...arkGraft, verification: { ok: true } };
  const template = bundle.template.templateCore;
  const vtxo = bundle.vtxo.vtxoCore;
  const quote = bundle.quote.quoteCore;
  const settlement = bundle.settlementEvidence.settlementCore;
  const cost = bundle.costModel && bundle.costModel.modelCore;
  return {
    kind: 'wallet_ark_liquidity_graft_view',
    status: bundle.verification.ok ? 'verified' : 'needs_attention',
    title: 'Ark LN Liquidity Graft',
    subtitle: `${vtxo.vtxoAmountSats} sats Ark VTXO grafted into ${quote.promisedInboundSats} sats LN inbound`,
    aspId: template.aspId,
    templateId: template.templateId,
    taprootOutputKey: template.taprootOutputKey,
    vtxoId: vtxo.vtxoId,
    vtxoCommitmentId: bundle.vtxo.vtxoCommitmentId,
    vtxoAmountSats: vtxo.vtxoAmountSats,
    aspRoundId: vtxo.aspRoundId,
    connectorOutpoint: vtxo.connectorOutpoint,
    exitTxid: vtxo.exitTxid,
    forfeitTxid: vtxo.forfeitTxid,
    quoteId: bundle.quote.quoteId,
    promisedInboundSats: quote.promisedInboundSats,
    deliveredInboundSats: settlement.deliveredInboundSats,
    maxFeePpm: quote.maxFeePpm,
    maxCltvDelta: quote.maxCltvDelta,
    paymentHashHex: quote.paymentHashHex,
    liquidityLeaseBundleId: settlement.liquidityLeaseBundleId,
    channelOutpoint: settlement.channelOrSpliceOutpoint,
    lnClaimTxid: settlement.lnClaimTxid,
    costModel: cost && {
      graftCount: cost.graftCount,
      graftAmountSats: cost.graftAmountSats,
      feeRateSatVb: cost.feeRateSatVb,
      baselinePerGraftSats: cost.baseline.perGraftSats,
      arkPerGraftSats: cost.ark.perGraftSats,
      baselineTotalSats: cost.baseline.totalSats,
      arkTotalSats: cost.ark.totalSats,
      savingsSats: cost.comparison.savingsSats,
      savingsBps: cost.comparison.savingsBps,
      breakEvenGrafts: cost.comparison.breakEvenGrafts,
      saferMarginalCost: cost.comparison.saferMarginalCost,
      lowerTotalCost: cost.comparison.lowerTotalCost
    },
    htlc: {
      swapFundingTxid: subswap && subswap.swap && subswap.swap.fundingTxid,
      claimTxid: subswap && subswap.dlcFunding && subswap.dlcFunding.claimTxid,
      refundTxid: subswap && subswap.refundPath && subswap.refundPath.refundTxid
    },
    checks: bundle.settlementEvidence.checks,
    actions: [
      { id: 'verify_ark_graft', label: 'Verify Ark graft' },
      { id: 'show_ark_vtxo', label: 'Show Ark VTXO proof' },
      { id: 'prepare_ark_graft_challenge', label: 'Prepare challenge' }
    ],
    linkedLiquidityLease: walletView(lease, subswap)
  };
}

function arkDlcSettlementWalletView(arkDlc) {
  const bundle = arkDlc.verification ? arkDlc : { ...arkDlc, verification: { ok: true } };
  const contract = bundle.contract.contractCore;
  const settlement = bundle.settlementEvidence.settlementCore;
  const fee = bundle.feeModel.modelCore;
  return {
    kind: 'wallet_ark_dlc_settlement_view',
    status: bundle.verification.ok ? 'verified' : 'needs_attention',
    title: 'Ark DLC Settlement',
    subtitle: `${contract.totalCollateralSats} sats settle by Ark VTXO transfer; no on-chain CET broadcast`,
    contractId: contract.contractId,
    aspId: contract.aspId,
    oracleEventId: contract.oracleEventId,
    contractCommitmentId: bundle.contract.contractCommitmentId,
    virtualCetSetId: bundle.virtualCetSet.virtualCetSetId,
    virtualCetCount: bundle.virtualCetSet.virtualCets.length,
    selectedVirtualCetId: settlement.selectedVirtualCetId,
    oracleOutcomeId: settlement.oracleOutcomeId,
    arkRoundId: settlement.arkRoundId,
    arkTransitionId: settlement.arkTransitionId,
    noOnchainCetBroadcast: settlement.noOnchainCetBroadcast,
    avoidedOnchainCetTxid: settlement.avoidedOnchainCetTxid,
    payouts: settlement.payouts,
    feeModel: {
      outcomeCount: fee.outcomeCount,
      feeRateSatVb: fee.feeRateSatVb,
      onchainHappyPathSats: fee.onchainHappyPathSats,
      onchainCetWorstCaseSats: fee.onchainCetWorstCaseSats,
      arkHappyPathSats: fee.arkHappyPathSats,
      governedArkSats: fee.governedArkSats,
      avoidsOnchainCetHappyPath: fee.avoidsOnchainCetHappyPath,
      avoidsCetFanoutOnchainExposure: fee.avoidsCetFanoutOnchainExposure
    },
    checks: bundle.settlementEvidence.checks,
    challenge: {
      slashable: bundle.challengeEvidence.slashable,
      challengeId: bundle.challengeEvidence.challengeId,
      violations: bundle.challengeEvidence.challengeCore.violations
    },
    actions: [
      { id: 'verify_ark_dlc_settlement', label: 'Verify Ark DLC settlement' },
      { id: 'show_virtual_cets', label: 'Show virtual CET set' },
      { id: 'prepare_asp_challenge', label: 'Prepare ASP challenge' }
    ]
  };
}

function hasLiveDlcSubswapOverrides(overrides = {}) {
  return [
    'requestedCollateralSats',
    'swapFeeSats',
    'refundBlocks',
    'invoice',
    'paymentHashHex',
    'preimageHex',
    'refundAddress',
    'timeoutBlock',
    'epochId'
  ].some(key => overrides[key] !== undefined && overrides[key] !== null && overrides[key] !== '');
}

function dlcSubswapOverridesFromBody(body = {}) {
  return {
    walletNodeId: body.walletNodeId,
    requestedCollateralSats: body.requestedCollateralSats || body.collateralSats,
    swapFeeSats: body.swapFeeSats || body.feeSats,
    refundBlocks: body.refundBlocks || body.refundTimeoutBlocks,
    invoice: body.invoice || body.bolt11,
    paymentHashHex: body.paymentHashHex,
    preimageHex: body.preimageHex,
    refundAddress: body.refundAddress,
    timeoutBlock: body.timeoutBlock,
    epochId: body.epochId
  };
}

function latestDlcSubswapFundingRequest(overrides = {}) {
  if (fs.existsSync(dlcSubswapFundingPath) && !Object.keys(overrides).length) {
    const bundle = readJson(dlcSubswapFundingPath);
    return bundle.request;
  }
  const useFixtureProof = !hasLiveDlcSubswapOverrides(overrides);
  return buildDlcSubswapFundingRequest({
    dlcBundle: readJson(dlcPath),
    subswapProof: useFixtureProof && fs.existsSync(subswapPath) ? readJson(subswapPath) : null,
    options: overrides
  });
}

function satsToBtcString(sats) {
  const n = BigInt(sats);
  const whole = n / 100000000n;
  const frac = (n % 100000000n).toString().padStart(8, '0');
  return `${whole}.${frac}`;
}

function compactId(value, prefix, length = 8) {
  const cleaned = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${prefix}${cleaned.slice(0, length) || '0'}`;
}

// The quote lifecycle, one small state machine per request:
//   quoted     open. It can be paid until expiresAt, and is dropped once it has expired unpaid.
//   attempted  open. Its payment was saved as attempted before LND was asked, so LND may hold the payment even if the
//              sidecar never got an answer. It is dropped only when LND reports the payment failed, and it becomes paid
//              when LND reports the payment settled.
//   paid       open. It never expires, so a paid request is not dropped before it mints.
//   minted  a grant intent was issued. Its requestId is appended to the minted log, a set of hashes kept outside the
//           open table, and it is never quoted, paid or minted again. The intent itself is not kept. The Electrum tab
//           forwards an intent to TradeLayer, so a repeat intent would be a second grant this process cannot see.
// Only open requests count toward SIDECAR_MAX_QUOTED_REQUESTS. Minted requests count toward SIDECAR_MAX_MINTED_REQUESTS.
const STORE_KIND = 'utxoref_dlc_subswap_request_store';
const ALREADY_MINTED = 'already minted: this request already has a grant intent and cannot be granted again';
const QUOTE_EXPIRED = 'quote expired: quote the request again';
const requestStorePath = path.resolve(process.env.SIDECAR_REQUEST_STORE_PATH ||
  path.join(__dirname, 'runtime', 'dlc-subswap-requests.json'));
const mintedLogPath = `${requestStorePath}.minted`;
const MAX_ISSUED_DLC_REQUESTS = boundedInteger(process.env.SIDECAR_MAX_QUOTED_REQUESTS || 1000, 2, 100000);
if (MAX_ISSUED_DLC_REQUESTS === null) throw new Error('SIDECAR_MAX_QUOTED_REQUESTS must be an integer in 2..100000');
const MAX_MINTED_DLC_REQUESTS = boundedInteger(process.env.SIDECAR_MAX_MINTED_REQUESTS || 100000, 1, 10000000);
if (MAX_MINTED_DLC_REQUESTS === null) throw new Error('SIDECAR_MAX_MINTED_REQUESTS must be an integer in 1..10000000');
const QUOTE_TTL_SECONDS = boundedInteger(process.env.SIDECAR_QUOTE_TTL_SECONDS || 86400, 1, 31536000);
if (QUOTE_TTL_SECONDS === null) throw new Error('SIDECAR_QUOTE_TTL_SECONDS must be an integer in 1..31536000');
const QUOTE_TTL_MS = QUOTE_TTL_SECONDS * 1000;

const issuedDlcSubswapRequests = new Map(); // requestId -> { request, state, expiresAt, paying }
const mintedDlcSubswapRequests = new Set(); // requestIds with a grant intent issued

function loadMintedDlcSubswapRequests() {
  if (!fs.existsSync(mintedLogPath)) {
    writeAtomicPrivate(mintedLogPath, '');
    return;
  }
  const text = fs.readFileSync(mintedLogPath, 'utf8');
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  // A last line without its newline was never returned to a caller: an intent is returned only after its line is fsynced.
  if (complete.length < text.length) fs.truncateSync(mintedLogPath, Buffer.byteLength(complete));
  for (const line of complete.split('\n').filter(Boolean)) {
    if (!/^[0-9a-f]{64}$/.test(line)) throw new Error(`${mintedLogPath} holds a line that is not a request hash`);
    mintedDlcSubswapRequests.add(line);
  }
}

// Appends one requestId and fsyncs it before the caller returns an intent. A failed append is cut back to its start.
function recordMinted(requestId) {
  const descriptor = fs.openSync(mintedLogPath, 'a', 0o600);
  try {
    const size = fs.fstatSync(descriptor).size;
    try {
      fs.writeSync(descriptor, `${requestId}\n`);
      fs.fsyncSync(descriptor);
    } catch (err) {
      fs.ftruncateSync(descriptor, size);
      throw err;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  mintedDlcSubswapRequests.add(requestId);
}

function loadIssuedDlcSubswapRequests() {
  loadMintedDlcSubswapRequests();
  if (!fs.existsSync(requestStorePath)) return;
  const store = readJson(requestStorePath);
  if (!store || store.kind !== STORE_KIND || !Array.isArray(store.entries)) {
    throw new Error(`${requestStorePath} is not a sidecar DLC request store`);
  }
  if (store.version === 1) {
    // Version 1 never recorded a mint, so any of its requests may already have been granted. Each is recorded as
    // minted, so none is granted again. A paid version 1 request has to be checked on TradeLayer by an operator.
    for (const entry of store.entries) {
      if (!mintedDlcSubswapRequests.has(entry.request.requestId)) recordMinted(entry.request.requestId);
    }
    saveIssuedDlcSubswapRequests();
    return;
  }
  if (store.version !== 2) throw new Error(`${requestStorePath} has an unknown store version`);
  for (const entry of store.entries) {
    const requestId = entry.request.requestId;
    if (mintedDlcSubswapRequests.has(requestId)) continue;
    if (entry.state !== 'quoted' && entry.state !== 'attempted' && entry.state !== 'paid') {
      throw new Error(`${requestStorePath} has an unknown request state`);
    }
    if (entry.state !== 'paid' && !Number.isSafeInteger(entry.expiresAt)) {
      throw new Error(`${requestStorePath} has a quote without expiresAt`);
    }
    issuedDlcSubswapRequests.set(requestId, {
      request: entry.request,
      state: entry.state,
      expiresAt: entry.state === 'paid' ? null : entry.expiresAt,
      paying: false
    });
  }
}

loadIssuedDlcSubswapRequests();

function saveIssuedDlcSubswapRequests() {
  const entries = [...issuedDlcSubswapRequests.values()].map(({ request, state, expiresAt }) => ({ request, state, expiresAt }));
  writeAtomicPrivate(requestStorePath, `${JSON.stringify({
    kind: STORE_KIND,
    version: 2,
    entries
  }, null, 2)}\n`);
}

// LND's answer for a request's payment hash. An error from LND is a 502 for the caller.
async function lookupPaymentState(request) {
  try {
    return await lookupPaymentViaLndRest({ paymentHashHex: request.requestCore.submarineSwap.paymentHashHex });
  } catch (err) {
    throw new HttpError(502, 'lnd_lookup_failed', `LND payment lookup failed: ${err.message}`);
  }
}

// Drops quotes that expired unpaid and have no payment in flight. An attempted quote is decided by LND, by payment hash:
// LND's settled payment makes the request paid, LND's failed payment drops it, and anything else keeps it, including a
// lookup that errors. Paid requests and requests being paid are kept.
async function pruneExpiredQuotes(now) {
  let changed = false;
  for (const [requestId, issued] of [...issuedDlcSubswapRequests]) {
    if (issued.state === 'paid' || issued.paying || now < issued.expiresAt) continue;
    if (issued.state === 'quoted') {
      issuedDlcSubswapRequests.delete(requestId);
      changed = true;
      continue;
    }
    let lookup;
    try {
      lookup = await lookupPaymentState(issued.request);
    } catch (_err) {
      continue;
    }
    // A pay that started while LND was asked, or a request dropped meanwhile, is left as it is.
    if (issued.paying || issuedDlcSubswapRequests.get(requestId) !== issued) continue;
    if (lookup.state === 'failed') {
      issuedDlcSubswapRequests.delete(requestId);
      changed = true;
    } else if (lookup.state === 'settled') {
      issued.state = 'paid';
      issued.expiresAt = null;
      changed = true;
    }
  }
  if (changed) saveIssuedDlcSubswapRequests();
}

// Returns 'ok', 'full' when the open table holds its cap, or 'minted' when the request was already granted.
async function rememberIssuedDlcSubswapRequest(request) {
  const requestId = request.requestId;
  await pruneExpiredQuotes(Date.now());
  if (mintedDlcSubswapRequests.has(requestId)) return 'minted';
  if (issuedDlcSubswapRequests.has(requestId)) return 'ok';
  if (issuedDlcSubswapRequests.size >= MAX_ISSUED_DLC_REQUESTS) return 'full';
  issuedDlcSubswapRequests.set(requestId, { request, state: 'quoted', expiresAt: Date.now() + QUOTE_TTL_MS, paying: false });
  saveIssuedDlcSubswapRequests();
  return 'ok';
}

// LND settled the payment, which is a fact the sidecar must not forget, so the request stops expiring. Memory changes
// before the save, so a settled request is never pruned or refused as expired even if the save fails. Each save writes
// the whole table, and every later pay or mint for the request saves again, so a failed save is retried.
function markPaid(issued) {
  issued.state = 'paid';
  issued.expiresAt = null;
  saveIssuedDlcSubswapRequests();
}

// The attempt is saved before LND is asked. If the save fails, LND is not asked and the request stays quoted.
function markAttempted(issued) {
  if (issued.state !== 'quoted') return;
  issued.state = 'attempted';
  try {
    saveIssuedDlcSubswapRequests();
  } catch (err) {
    issued.state = 'quoted';
    throw err;
  }
}

function verifyPaymentProofForRequest(request, paymentProof) {
  if (!request || !request.requestCore || !request.requestCore.submarineSwap) {
    return { ok: false, reason: 'missing DLC submarine-swap request' };
  }
  const expectedHash = String(request.requestCore.submarineSwap.paymentHashHex || '').toLowerCase();
  const preimageHex = String(paymentProof && paymentProof.paymentPreimageHex || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(preimageHex)) {
    return { ok: false, reason: 'missing payment preimage' };
  }
  const derivedHash = paymentHashFromPreimageHex(preimageHex);
  if (derivedHash !== expectedHash) {
    return { ok: false, reason: 'payment preimage does not match request payment hash' };
  }
  const proofHash = String(paymentProof.paymentHashHex || '').toLowerCase();
  if (proofHash && proofHash !== expectedHash) {
    return { ok: false, reason: 'payment proof hash does not match request payment hash' };
  }
  return { ok: true, paymentHashHex: expectedHash };
}

// The payment proof is what LND reports as settled for the request's payment hash. Errors from LND are a 502:
// nothing is minted while the record cannot be read.
async function settledPaymentProof(request) {
  const lookup = await lookupPaymentState(request);
  if (lookup.state !== 'settled') return null;
  return {
    kind: 'utxoref_dlc_subswap_lnd_payment_proof',
    status: 'paid',
    paymentHashHex: lookup.paymentHashHex,
    paymentPreimageHex: lookup.paymentPreimageHex,
    source: 'lnd-track-payment'
  };
}

async function buildTlbtcMintIntent({ requestId, recipientAddress }) {
  if (mintedDlcSubswapRequests.has(requestId)) throw new HttpError(409, 'already_minted', ALREADY_MINTED);
  const issued = issuedDlcSubswapRequests.get(requestId);
  if (!issued) {
    return { ok: false, reason: 'unknown requestId: quote and pay the request first' };
  }
  const request = issued.request;
  const requestVerification = verifyDlcSubswapFundingRequest(request);
  if (!requestVerification.ok) {
    return { ok: false, reason: requestVerification.reason, requestVerification };
  }
  // LND is asked before the expiry gate: a payment LND has settled is granted even if the sidecar never recorded it.
  const paymentProof = await settledPaymentProof(request);
  if (!paymentProof) {
    if (issued.state === 'quoted' && Date.now() >= issued.expiresAt) throw new HttpError(410, 'quote_expired', QUOTE_EXPIRED);
    return { ok: false, reason: 'payment is not settled in LND', requestVerification };
  }
  const paymentVerification = verifyPaymentProofForRequest(request, paymentProof);
  if (!paymentVerification.ok) {
    return { ok: false, reason: paymentVerification.reason, requestVerification, paymentVerification };
  }
  markPaid(issued);
  const grantFromAddress = String(process.env.TL_PROCEDURAL_ADMIN_ADDRESS || '').trim();
  if (!grantFromAddress) {
    return { ok: false, reason: 'TL_PROCEDURAL_ADMIN_ADDRESS is not configured' };
  }
  const core = request.requestCore;
  const recipient = String(recipientAddress || '').trim();
  if (!recipient) throw new HttpError(400, 'invalid_request', 'recipientAddress is required for tlBTC mint intent');
  const requestedCollateralSats = core.submarineSwap.requestedCollateralSats;
  const amountGranted = satsToBtcString(requestedCollateralSats);
  const propertyId = Number(process.env.TL_TLBTC_PROPERTY_ID || 1);
  const dlcTemplateId = String(
    process.env.TL_DLC_TEMPLATE_ID ||
      compactId(core.targetDlc.contractCommitmentId || core.targetBindingHash, 'tpl')
  );
  const dlcContractId = String(process.env.TL_DLC_CONTRACT_ID || '');
  const settlementState = String(process.env.TL_DLC_SETTLEMENT_STATE || 'FUNDED').toUpperCase();
  const dlcHash = String(process.env.TL_DLC_HASH || core.targetBindingHash);
  const params = {
    fromAddress: grantFromAddress,
    propertyId,
    amountGranted,
    addressToGrantTo: recipient,
    redeemAddress: recipient,
    dlcTemplateId,
    dlcContractId,
    settlementState,
    dlcHash,
    requestId: request.requestId,
    targetBindingHash: core.targetBindingHash,
    paymentHashHex: paymentVerification.paymentHashHex
  };

  // Nothing above awaits, so this is the one commit point: a concurrent mint for this request is seen here.
  if (mintedDlcSubswapRequests.has(requestId)) throw new HttpError(409, 'already_minted', ALREADY_MINTED);
  if (mintedDlcSubswapRequests.size >= MAX_MINTED_DLC_REQUESTS) {
    throw new HttpError(503, 'minted_record_full', 'minted record is full: raise SIDECAR_MAX_MINTED_REQUESTS');
  }
  recordMinted(requestId);
  issuedDlcSubswapRequests.delete(requestId);
  saveIssuedDlcSubswapRequests();

  return {
    kind: 'tradelayer_tlbtc_mint_intent',
    ok: true,
    requestId: request.requestId,
    requestedCollateralSats,
    requestVerification,
    paymentVerification,
    tradeLayer: {
      method: 'tl_createGrantManagedTokenTransaction',
      params
    }
  };
}

function latestBitvmChannelRouterBundle(overrides = {}) {
  if (fs.existsSync(bitvmChannelRouterPath) && !Object.keys(overrides).length) {
    return readJson(bitvmChannelRouterPath);
  }
  return buildBitvmChannelRouterBundle({
    sources: {
      liquidityLease: readJsonIfExists(leasePath),
      arkManager: readJsonIfExists(arkLiquidityGraftManagerPath),
      tlusdPatch: readJsonIfExists(lnbtcTlusdLiquidityPatchPath),
      dlcSubswapFunding: readJsonIfExists(dlcSubswapFundingPath)
    },
    routeIntent: overrides.routeIntent || {
      intentId: 'bitvm-router-sidecar-quote',
      amountSats: overrides.amountSats || '120000',
      maxFeePpm: Number(overrides.maxFeePpm || 1200),
      maxCltvDelta: Number(overrides.maxCltvDelta || 45),
      destinationNodeId: overrides.destinationNodeId || 'ldk-router-destination-regtest'
    },
    policy: overrides.policy || {
      excludeSlashable: overrides.excludeSlashable !== false,
      allowFundingFallback: Boolean(overrides.allowFundingFallback),
      minShardSats: overrides.minShardSats || '1000'
    }
  });
}

function arkLiquidityGraftManagerWalletView(manager) {
  const bundle = manager.verification ? manager : { ...manager, verification: { ok: true } };
  const inventory = bundle.inventory.inventoryCore;
  const policy = bundle.policy.policyCore;
  const totals = bundle.allocation.totals;
  const cost = bundle.costModel && bundle.costModel.modelCore;
  const totalInventorySats = inventory.vtxos.reduce((sum, vtxo) => sum + BigInt(vtxo.vtxoAmountSats), 0n);
  const assignedVtxos = new Set(bundle.allocation.assignments.map(assignment => assignment.vtxo.vtxoCommitmentId));
  const availableInventorySats = inventory.vtxos
    .filter(vtxo => !assignedVtxos.has(vtxo.vtxoCommitmentId))
    .reduce((sum, vtxo) => sum + BigInt(vtxo.vtxoAmountSats), 0n);
  return {
    kind: 'wallet_ark_liquidity_graft_manager_view',
    status: bundle.verification.ok ? 'verified' : 'needs_attention',
    title: 'Ark LN Liquidity Graft Manager',
    subtitle: `${totals.assignedInboundSats} sats assigned across ${bundle.allocation.assignments.length} LN routes`,
    managerId: bundle.managerCore.managerId,
    bundleId: bundle.bundleId,
    aspId: inventory.aspId,
    inventoryId: bundle.inventory.inventoryId,
    demandId: bundle.demand.demandId,
    policyId: bundle.policy.policyId,
    allocationId: bundle.allocation.allocationId,
    bitvmPolicy: {
      governorCircuitId: policy.governorCircuitId,
      aspBondOutpoint: policy.aspBondOutpoint,
      maxAspExposureSats: policy.maxAspExposureSats,
      slashReserveSats: policy.slashReserveSats,
      challengeWindowBlocks: policy.challengeWindowBlocks,
      requireExitPath: policy.requireExitPath,
      requireForfeitPath: policy.requireForfeitPath
    },
    inventory: {
      vtxoCount: inventory.vtxos.length,
      totalInventorySats: totalInventorySats.toString(),
      availableInventorySats: availableInventorySats.toString(),
      assignedVtxoCount: assignedVtxos.size
    },
    totals,
    assignments: bundle.allocation.assignments.map(assignment => ({
      routeId: assignment.assignmentCore.routeId,
      edgeNodeId: assignment.assignmentCore.edgeNodeId,
      status: assignment.assignmentCore.status,
      assignmentId: assignment.assignmentId,
      vtxoCommitmentId: assignment.vtxo.vtxoCommitmentId,
      quoteId: assignment.quote.quoteId,
      promisedInboundSats: assignment.assignmentCore.promisedInboundSats,
      deliveredInboundSats: assignment.assignmentCore.deliveredInboundSats,
      maxFeePpm: assignment.quote.quoteCore.maxFeePpm,
      maxCltvDelta: assignment.quote.quoteCore.maxCltvDelta,
      settlementId: assignment.settlementEvidence.settlementId,
      settlementChecks: assignment.settlementEvidence.checks,
      challengeId: assignment.challengeEvidence.challengeId,
      slashable: assignment.challengeEvidence.slashable,
      violations: assignment.challengeEvidence.challengeCore.violations
    })),
    unmetRoutes: bundle.allocation.unmetRoutes,
    challenge: {
      slashable: bundle.challengeEvidence.slashable,
      challengeId: bundle.challengeEvidence.challengeId,
      remedy: bundle.challengeEvidence.remedy,
      violations: bundle.challengeEvidence.challengeCore.violations
    },
    costModel: cost && {
      graftCount: cost.graftCount,
      graftAmountSats: cost.graftAmountSats,
      baselinePerGraftSats: cost.baseline.perGraftSats,
      arkPerGraftSats: cost.ark.perGraftSats,
      baselineTotalSats: cost.baseline.totalSats,
      arkTotalSats: cost.ark.totalSats,
      savingsSats: cost.comparison.savingsSats,
      lowerTotalCost: cost.comparison.lowerTotalCost,
      saferMarginalCost: cost.comparison.saferMarginalCost
    },
    actions: [
      { id: 'verify_manager_allocation', label: 'Verify manager allocation' },
      { id: 'show_route_assignments', label: 'Show route assignments' },
      { id: 'prepare_manager_challenge', label: 'Prepare BitVM challenge' }
    ]
  };
}

function lnbtcTlusdLiquidityPatchWalletView(patch) {
  const bundle = patch.verification ? patch : { ...patch, verification: { ok: true } };
  const conversion = bundle.conversion.conversionCore;
  const asset = bundle.conversion.stablecoin.asset.descriptorCore;
  const stake = bundle.stake.stakeCore;
  const manager = bundle.mandate.manager;
  const totals = manager.allocation.totals;
  return {
    kind: 'wallet_lnbtc_tlusd_liquidity_patch_view',
    status: bundle.verification.ok ? 'verified' : 'needs_attention',
    title: 'LN-BTC to tlUSD Liquidity Patch',
    subtitle: `${conversion.lnbtcSats} sats externalized as ${asset.ticker}, ${stake.stakedTlUsdUnits} units staked for LN patching`,
    bundleId: bundle.bundleId,
    conversion: {
      conversionId: bundle.conversion.conversionId,
      lnbtcSats: conversion.lnbtcSats,
      btcUsdPriceMicros: conversion.btcUsdPriceMicros,
      tlusdUnits: conversion.tlusdUnits,
      assetTicker: asset.ticker,
      assetId: asset.assetId,
      assetProofId: conversion.assetProofId,
      rfqQuoteId: conversion.rfqQuoteId,
      settlementId: conversion.settlementId,
      subswapFundingTxid: conversion.subswapFundingTxid,
      dlcFundingTxid: conversion.dlcFundingTxid,
      checks: bundle.conversion.checks
    },
    stake: {
      stakeCommitmentId: bundle.stake.stakeCommitmentId,
      poolId: stake.poolId,
      ownerNodeId: stake.ownerNodeId,
      stakedTlUsdUnits: stake.stakedTlUsdUnits,
      routingNotionalSats: stake.routingNotionalSats,
      lockBlocks: stake.lockBlocks,
      targetYieldPpm: stake.targetYieldPpm,
      slashReserveUnits: stake.slashReserveUnits,
      checks: bundle.stake.checks
    },
    liquidityPatch: {
      mandateId: bundle.mandate.mandateId,
      managerBundleId: manager.bundleId,
      policyId: manager.policy.policyId,
      allocationId: manager.allocation.allocationId,
      totals,
      assignments: manager.allocation.assignments.map(assignment => ({
        routeId: assignment.assignmentCore.routeId,
        status: assignment.assignmentCore.status,
        promisedInboundSats: assignment.assignmentCore.promisedInboundSats,
        deliveredInboundSats: assignment.assignmentCore.deliveredInboundSats,
        quoteId: assignment.quote.quoteId,
        slashable: assignment.challengeEvidence.slashable,
        violations: assignment.challengeEvidence.challengeCore.violations
      })),
      challenge: {
        slashable: manager.challengeEvidence.slashable,
        challengeId: manager.challengeEvidence.challengeId,
        remedy: manager.challengeEvidence.remedy,
        violations: manager.challengeEvidence.challengeCore.violations
      },
      costModel: {
        baselinePerGraftSats: manager.costModel.modelCore.baseline.perGraftSats,
        arkPerGraftSats: manager.costModel.modelCore.ark.perGraftSats,
        baselineTotalSats: manager.costModel.modelCore.baseline.totalSats,
        arkTotalSats: manager.costModel.modelCore.ark.totalSats,
        savingsSats: manager.costModel.modelCore.comparison.savingsSats,
        saferMarginalCost: manager.costModel.modelCore.comparison.saferMarginalCost
      }
    },
    actions: [
      { id: 'verify_lnbtc_tlusd_patch', label: 'Verify end-to-end patch' },
      { id: 'show_tlusd_stake', label: 'Show tlUSD stake' },
      { id: 'prepare_patch_challenge', label: 'Prepare patch challenge' }
    ]
  };
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method === 'POST' && !postAuthorized(req)) {
    return sendJson(res, 401, { ok: false, reason: 'missing or invalid bearer token' });
  }

  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { ok: true, service: 'utxoref-liquidity-lease-sidecar' });
    }

    if (req.method === 'GET' && req.url === '/v1/wallet-demo/config') {
      const config = buildWalletDemoConfig(process.env);
      return sendJson(res, 200, { ...config, verification: verifyWalletDemoConfig(config) });
    }

    if (req.method === 'GET' && req.url === '/v1/wallet-demo/status') {
      return sendJson(res, 200, walletDemoStatus());
    }

    if (req.method === 'GET' && req.url === '/v1/wallet-demo/adapter-feed') {
      return sendJson(res, 200, buildAdapterFeed());
    }

    if (req.method === 'GET' && req.url.startsWith('/v1/wallet-demo/stress-dashboard')) {
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      const botCount = Number(requestUrl.searchParams.get('bots') || process.env.WALLET_DEMO_BOT_COUNT || 96);
      const config = buildWalletDemoConfig(process.env);
      const dashboard = buildStressDashboard({
        patch: readJson(lnbtcTlusdLiquidityPatchPath),
        config,
        botCount
      });
      return sendJson(res, 200, { ...dashboard, verification: verifyStressDashboard(dashboard) });
    }

    if (req.method === 'GET' && (req.url === '/dashboard' || req.url === '/dashboard/')) {
      return sendFile(res, path.join(walletDemoDir, 'dashboard.html'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && (req.url === '/funding' || req.url === '/funding/')) {
      return sendFile(res, path.join(walletDemoDir, 'funding.html'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && req.url === '/dashboard.css') {
      return sendFile(res, path.join(walletDemoDir, 'dashboard.css'), 'text/css; charset=utf-8');
    }

    if (req.method === 'GET' && req.url === '/dashboard.js') {
      return sendFile(res, path.join(walletDemoDir, 'dashboard.js'), 'text/javascript; charset=utf-8');
    }

    if (req.method === 'GET' && req.url === '/v1/liquidity-lease/latest') {
      return sendJson(res, 200, readJson(leasePath));
    }

    if (req.method === 'GET' && req.url === '/v1/liquidity-lease/wallet-view') {
      return sendJson(res, 200, walletView(readJson(leasePath), readJson(subswapPath)));
    }

    if (req.method === 'GET' && req.url === '/v1/taproot-assets-stablecoin/latest') {
      return sendJson(res, 200, readJson(stablecoinPath));
    }

    if (req.method === 'GET' && req.url === '/v1/taproot-assets-stablecoin/wallet-view') {
      return sendJson(
        res,
        200,
        stablecoinWalletView(readJson(stablecoinPath), readJson(leasePath), readJson(subswapPath))
      );
    }

    if (req.method === 'GET' && req.url === '/v1/ark-liquidity-graft/latest') {
      return sendJson(res, 200, readJson(arkGraftPath));
    }

    if (req.method === 'GET' && req.url === '/v1/ark-liquidity-graft/wallet-view') {
      return sendJson(
        res,
        200,
        arkGraftWalletView(readJson(arkGraftPath), readJson(leasePath), readJson(subswapPath))
      );
    }

    if (req.method === 'GET' && req.url === '/v1/ark-liquidity-graft/governor-bench/latest') {
      return sendJson(res, 200, readJson(arkGovernorBenchPath));
    }

    if (req.method === 'GET' && req.url === '/v1/ark-liquidity-graft-manager/latest') {
      return sendJson(res, 200, readJson(arkLiquidityGraftManagerPath));
    }

    if (req.method === 'GET' && req.url === '/v1/ark-liquidity-graft-manager/wallet-view') {
      return sendJson(res, 200, arkLiquidityGraftManagerWalletView(readJson(arkLiquidityGraftManagerPath)));
    }

    if (req.method === 'GET' && req.url === '/v1/lnbtc-tlusd-liquidity-patch/latest') {
      return sendJson(res, 200, readJson(lnbtcTlusdLiquidityPatchPath));
    }

    if (req.method === 'GET' && req.url === '/v1/lnbtc-tlusd-liquidity-patch/wallet-view') {
      return sendJson(res, 200, lnbtcTlusdLiquidityPatchWalletView(readJson(lnbtcTlusdLiquidityPatchPath)));
    }

    if (req.method === 'GET' && req.url === '/v1/bitvm-channel-router/latest') {
      return sendJson(res, 200, latestBitvmChannelRouterBundle());
    }

    if (req.method === 'GET' && req.url === '/v1/bitvm-channel-router/wallet-view') {
      return sendJson(res, 200, latestBitvmChannelRouterBundle().walletView);
    }

    if (req.method === 'GET' && req.url === '/v1/ark-dlc-settlement/latest') {
      return sendJson(res, 200, readJson(arkDlcSettlementPath));
    }

    if (req.method === 'GET' && req.url === '/v1/ark-dlc-settlement/wallet-view') {
      return sendJson(res, 200, arkDlcSettlementWalletView(readJson(arkDlcSettlementPath)));
    }

    if (req.method === 'GET' && req.url === '/v1/dlc-subswap-funding/latest') {
      return sendJson(res, 200, fs.existsSync(dlcSubswapFundingPath)
        ? readJson(dlcSubswapFundingPath)
        : { kind: 'utxoref_dlc_subswap_funding_bundle', request: latestDlcSubswapFundingRequest() });
    }

    if (req.method === 'GET' && req.url === '/v1/dlc-subswap-funding/wallet-view') {
      return sendJson(res, 200, buildDlcSubswapFundingWalletView(latestDlcSubswapFundingRequest()));
    }

    if (req.method === 'GET' && req.url === '/v1/liquidity-lease/subswap-proof') {
      return sendJson(res, 200, readJson(subswapPath));
    }

    if (req.method === 'POST' && req.url === '/v1/dlc-subswap-funding/quote') {
      const body = await readJsonBody(req, { requireJson: true });
      const request = latestDlcSubswapFundingRequest(dlcSubswapOverridesFromBody(body));
      const outcome = await rememberIssuedDlcSubswapRequest(request);
      if (outcome === 'minted') return sendJson(res, 409, { error: ALREADY_MINTED });
      if (outcome === 'full') {
        return sendJson(res, 503, { ok: false, reason: 'quote table is full: raise SIDECAR_MAX_QUOTED_REQUESTS or wait for live quotes to expire' });
      }
      return sendJson(res, 200, {
        request,
        walletView: buildDlcSubswapFundingWalletView(request)
      });
    }

    if (req.method === 'POST' && req.url === '/v1/dlc-subswap-funding/pay') {
      const body = await readJsonBody(req, { requireJson: true });
      const requestId = String(body.requestId || '');
      const issued = issuedDlcSubswapRequests.get(requestId);
      if (!issued) {
        if (mintedDlcSubswapRequests.has(requestId)) return sendJson(res, 409, { error: ALREADY_MINTED });
        return sendJson(res, 404, { ok: false, reason: 'unknown requestId: quote the request first' });
      }
      if (issued.state === 'quoted' && Date.now() >= issued.expiresAt) {
        return sendJson(res, 410, { ok: false, reason: QUOTE_EXPIRED });
      }
      if (issued.paying) {
        return sendJson(res, 409, { ok: false, reason: 'a payment for this request is in flight' });
      }
      const verification = verifyDlcSubswapFundingRequest(issued.request);
      if (!verification.ok) {
        return sendJson(res, 400, { ok: false, reason: verification.reason, verification });
      }
      const core = issued.request.requestCore;
      let paymentProof;
      issued.paying = true;
      try {
        if (await settledPaymentProof(issued.request)) {
          markPaid(issued);
          return sendJson(res, 409, { ok: false, reason: 'request is already paid' });
        }
        markAttempted(issued);
        try {
          paymentProof = await payInvoiceViaLndRest({
            invoice: core.submarineSwap.invoice,
            feeLimitSats: process.env.UTXOREF_LND_MAX_FEE_SATS || core.submarineSwap.swapFeeSats,
            timeoutSeconds: 60,
            paymentHashHex: core.submarineSwap.paymentHashHex
          });
        } catch (err) {
          throw new HttpError(502, 'lnd_payment_failed', err.message);
        }
        markPaid(issued);
      } finally {
        issued.paying = false;
      }
      const paymentVerification = verifyPaymentProofForRequest(issued.request, paymentProof);
      return sendJson(res, paymentVerification.ok ? 200 : 502, {
        ok: paymentVerification.ok,
        request: issued.request,
        paymentProof: {
          ...paymentProof,
          requestId: issued.request.requestId
        },
        paymentVerification,
        walletView: buildDlcSubswapFundingWalletView(issued.request)
      });
    }

    if (req.method === 'POST' && req.url === '/v1/dlc-subswap-funding/tlbtc-mint-intent') {
      const body = await readJsonBody(req, { requireJson: true });
      const intent = await buildTlbtcMintIntent({
        requestId: String(body.requestId || ''),
        recipientAddress: body.recipientAddress || body.address || body.redeemAddress
      });
      return sendJson(res, intent.ok ? 200 : 400, intent);
    }

    if (req.method === 'POST' && req.url === '/v1/bitvm-channel-router/quote') {
      const body = await readJsonBody(req, { requireJson: true });
      const bundle = latestBitvmChannelRouterBundle({
        routeIntent: body.routeIntent || {
          intentId: body.intentId,
          amountSats: body.amountSats,
          maxFeePpm: body.maxFeePpm,
          maxCltvDelta: body.maxCltvDelta,
          destinationNodeId: body.destinationNodeId
        },
        policy: body.policy || {
          excludeSlashable: body.excludeSlashable !== false,
          allowFundingFallback: Boolean(body.allowFundingFallback),
          minShardSats: body.minShardSats
        }
      });
      return sendJson(res, 200, bundle);
    }

    if (req.method === 'POST' && req.url === '/v1/liquidity-lease/quote') {
      const body = await readJsonBody(req, { requireJson: true });
      const lease = readJson(leasePath);
      return sendJson(res, 200, {
        kind: 'liquidity_lease_quote',
        requestedInboundSats: String(body.requestedInboundSats || lease.offer.terms.promisedInboundSats),
        leaseBlocks: Number(body.leaseBlocks || lease.offer.terms.leaseBlocks),
        maxFeePpm: Number(body.maxFeePpm || lease.offer.terms.maxFeePpm),
        maxCltvDelta: Number(body.maxCltvDelta || lease.offer.terms.maxCltvDelta),
        estimatedPremiumSats: lease.offer.terms.leasePremiumSats,
        penaltySats: lease.offer.terms.penaltySats,
        paymentHashHex: lease.offer.terms.paymentHashHex,
        source: 'latest-regtest-artifact'
      });
    }

    if (req.method === 'POST' && req.url === '/v1/liquidity-lease/verify') {
      const lease = readJson(leasePath);
      return sendJson(res, 200, {
        ok: Boolean(lease.verification && lease.verification.ok),
        reason: lease.verification && lease.verification.reason,
        offerId: lease.offer.offerId,
        successEvidenceId: lease.successEvidence.evidenceId,
        checks: lease.successEvidence.checks
      });
    }

    if (req.method === 'POST' && req.url === '/v1/liquidity-lease/challenge') {
      const lease = readJson(leasePath);
      return sendJson(res, 200, {
        slashable: lease.challengeEvidence.slashable,
        challengeId: lease.challengeEvidence.challengeId,
        penaltyClaim: lease.challengeEvidence.penaltyClaim,
        violations: lease.challengeEvidence.challengeCore.violations
      });
    }

    if (req.method === 'POST' && req.url === '/v1/taproot-assets-stablecoin/verify') {
      const stablecoin = readJson(stablecoinPath);
      return sendJson(res, 200, {
        ok: Boolean(stablecoin.verification && stablecoin.verification.ok),
        reason: stablecoin.verification && stablecoin.verification.reason,
        quoteId: stablecoin.rfqQuote.quoteId,
        settlementId: stablecoin.settlementEvidence.settlementId,
        checks: stablecoin.settlementEvidence.checks
      });
    }

    if (req.method === 'POST' && req.url === '/v1/taproot-assets-stablecoin/challenge') {
      const stablecoin = readJson(stablecoinPath);
      return sendJson(res, 200, {
        slashable: stablecoin.challengeEvidence.slashable,
        challengeId: stablecoin.challengeEvidence.challengeId,
        violations: stablecoin.challengeEvidence.challengeCore.violations
      });
    }

    if (req.method === 'POST' && req.url === '/v1/ark-liquidity-graft/verify') {
      const arkGraft = readJson(arkGraftPath);
      return sendJson(res, 200, {
        ok: Boolean(arkGraft.verification && arkGraft.verification.ok),
        reason: arkGraft.verification && arkGraft.verification.reason,
        quoteId: arkGraft.quote.quoteId,
        settlementId: arkGraft.settlementEvidence.settlementId,
        vtxoCommitmentId: arkGraft.vtxo.vtxoCommitmentId,
        costModelId: arkGraft.costModel && arkGraft.costModel.modelId,
        costComparison: arkGraft.costModel && arkGraft.costModel.modelCore.comparison,
        checks: arkGraft.settlementEvidence.checks
      });
    }

    if (req.method === 'POST' && req.url === '/v1/ark-liquidity-graft/challenge') {
      const arkGraft = readJson(arkGraftPath);
      return sendJson(res, 200, {
        slashable: arkGraft.challengeEvidence.slashable,
        challengeId: arkGraft.challengeEvidence.challengeId,
        violations: arkGraft.challengeEvidence.challengeCore.violations
      });
    }

    if (req.method === 'POST' && req.url === '/v1/ark-liquidity-graft-manager/verify') {
      const manager = readJson(arkLiquidityGraftManagerPath);
      return sendJson(res, 200, {
        ok: Boolean(manager.verification && manager.verification.ok),
        reason: manager.verification && manager.verification.reason,
        managerId: manager.managerCore.managerId,
        inventoryId: manager.inventory.inventoryId,
        demandId: manager.demand.demandId,
        policyId: manager.policy.policyId,
        allocationId: manager.allocation.allocationId,
        assignmentCount: manager.allocation.assignments.length,
        totals: manager.allocation.totals
      });
    }

    if (req.method === 'POST' && req.url === '/v1/ark-liquidity-graft-manager/challenge') {
      const manager = readJson(arkLiquidityGraftManagerPath);
      return sendJson(res, 200, {
        slashable: manager.challengeEvidence.slashable,
        challengeId: manager.challengeEvidence.challengeId,
        remedy: manager.challengeEvidence.remedy,
        assignmentChallenges: manager.challengeEvidence.challengeCore.assignmentChallenges,
        unmetRoutes: manager.challengeEvidence.challengeCore.unmetRoutes,
        violations: manager.challengeEvidence.challengeCore.violations
      });
    }

    if (req.method === 'POST' && req.url === '/v1/lnbtc-tlusd-liquidity-patch/verify') {
      const patch = readJson(lnbtcTlusdLiquidityPatchPath);
      return sendJson(res, 200, {
        ok: Boolean(patch.verification && patch.verification.ok),
        reason: patch.verification && patch.verification.reason,
        bundleId: patch.bundleId,
        conversionId: patch.conversion.conversionId,
        stakeCommitmentId: patch.stake.stakeCommitmentId,
        mandateId: patch.mandate.mandateId,
        lnbtcSats: patch.conversion.conversionCore.lnbtcSats,
        tlusdUnits: patch.conversion.conversionCore.tlusdUnits,
        stakedTlUsdUnits: patch.stake.stakeCore.stakedTlUsdUnits,
        assignedInboundSats: patch.mandate.manager.allocation.totals.assignedInboundSats,
        slashableAssignments: patch.mandate.manager.allocation.totals.slashableAssignments
      });
    }

    if (req.method === 'POST' && req.url === '/v1/lnbtc-tlusd-liquidity-patch/challenge') {
      const patch = readJson(lnbtcTlusdLiquidityPatchPath);
      const manager = patch.mandate.manager;
      return sendJson(res, 200, {
        slashable: manager.challengeEvidence.slashable,
        challengeId: manager.challengeEvidence.challengeId,
        remedy: manager.challengeEvidence.remedy,
        assignmentChallenges: manager.challengeEvidence.challengeCore.assignmentChallenges,
        violations: manager.challengeEvidence.challengeCore.violations
      });
    }

    if (req.method === 'POST' && req.url === '/v1/ark-dlc-settlement/verify') {
      const arkDlc = readJson(arkDlcSettlementPath);
      return sendJson(res, 200, {
        ok: Boolean(arkDlc.verification && arkDlc.verification.ok),
        reason: arkDlc.verification && arkDlc.verification.reason,
        contractCommitmentId: arkDlc.contract.contractCommitmentId,
        virtualCetSetId: arkDlc.virtualCetSet.virtualCetSetId,
        settlementId: arkDlc.settlementEvidence.settlementId,
        noOnchainCetBroadcast: arkDlc.settlementEvidence.settlementCore.noOnchainCetBroadcast,
        checks: arkDlc.settlementEvidence.checks
      });
    }

    if (req.method === 'POST' && req.url === '/v1/bitvm-channel-router/verify') {
      const body = await readJsonBody(req, { requireJson: true });
      if (body.plan) {
        return sendJson(res, 200, verifyBitvmChannelRouterPlan(body.plan));
      }
      return sendJson(res, 200, verifyBitvmChannelRouterBundle(body.bundle || latestBitvmChannelRouterBundle()));
    }

    if (req.method === 'POST' && req.url === '/v1/dlc-subswap-funding/verify') {
      const body = await readJsonBody(req, { requireJson: true });
      const request = body.request || latestDlcSubswapFundingRequest();
      return sendJson(res, 200, verifyDlcSubswapFundingRequest(request));
    }

    if (req.method === 'POST' && req.url === '/v1/ark-dlc-settlement/challenge') {
      const arkDlc = readJson(arkDlcSettlementPath);
      return sendJson(res, 200, {
        slashable: arkDlc.challengeEvidence.slashable,
        challengeId: arkDlc.challengeEvidence.challengeId,
        remedy: arkDlc.challengeEvidence.remedy,
        violations: arkDlc.challengeEvidence.challengeCore.violations
      });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.statusCode, { error: err.message });
    return sendJson(res, 500, { error: 'internal server error' });
  }
}

const port = Number(process.env.PORT || 8787);
const server = http.createServer((req, res) => {
  handle(req, res);
});

if (require.main === module) {
  server.listen(port, '127.0.0.1', () => {
    console.log(`liquidity lease sidecar listening on http://127.0.0.1:${port}`);
  });
}

module.exports = {
  walletView,
  stablecoinWalletView,
  arkGraftWalletView,
  arkDlcSettlementWalletView,
  arkLiquidityGraftManagerWalletView,
  lnbtcTlusdLiquidityPatchWalletView,
  latestDlcSubswapFundingRequest,
  latestBitvmChannelRouterBundle,
  buildTlbtcMintIntent,
  loadSidecarApiToken,
  verifyPaymentProofForRequest,
  walletDemoStatus,
  handle,
  server
};
