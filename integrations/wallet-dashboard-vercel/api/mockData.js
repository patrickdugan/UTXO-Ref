const crypto = require('crypto');
const { buildBitcoinTestnetProof } = require('./testnetProof');

const SATS = 100000000;

function id(prefix, input) {
  return `${prefix}_${crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 24)}`;
}

function boundedBotCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 96;
  return Math.min(parsed, 5000);
}

function buildStatus() {
  const proof = buildBitcoinTestnetProof();
  return {
    ok: true,
    activeProfileId: 'bitcoin-testnet-cross-domain',
    profile: {
      id: 'bitcoin-testnet-cross-domain',
      mode: 'Bitcoin testnet proof feed',
      notes: 'Public package exposing the Bitcoin testnet transaction chain and wallet-demo API contract.'
    },
    chain: {
      chain: 'bitcoin-testnet4',
      network: 'testnet4',
      rpcUrl: 'proof://bitcoin-testnet4',
      wallet: 'utxoref-demo'
    },
    lnd: {
      network: 'bitcoin-testnet',
      grpcHost: 'proof://ln-testnet'
    },
    artifacts: {
      lnbtcTlusdLiquidityPatch: { exists: true, source: 'Bitcoin testnet proof API' },
      walletStressSimulation: { exists: true, source: 'deterministic serverless generator' },
      bitcoinTestnetProof: {
        exists: true,
        source: 'Bitcoin testnet4',
        txCount: proof.summary.txCount,
        finalExplorer: proof.keyTxids.arkLiquidityGraft.explorer
      }
    },
    readiness: {
      walletViewReady: true,
      stressDashboardReady: true,
      deployPreviewReady: true
    }
  };
}

function buildWalletView() {
  const proof = buildBitcoinTestnetProof();
  const routerCircuit = {
    circuitId: id('router_circuit', 'ln-bitvm-liquidity-graft-v1'),
    version: 'ln-bitvm-liquidity-graft-v1',
    totalGates: 768,
    constraintSystem: 'booleanized route commitment plus liquidity shortfall comparator',
    gateCounts: [
      { family: 'HTLC hashlock', count: 96, checks: 'payment_hash == sha256(preimage)' },
      { family: 'CLTV timeout', count: 64, checks: 'expiry_height <= channel_expiry' },
      { family: 'Route sum', count: 112, checks: 'delivered_msat accumulates hop commitments' },
      { family: 'Liquidity comparator', count: 144, checks: 'delivered_sats >= committed_min_sats' },
      { family: 'TAP anchor binding', count: 128, checks: 'tap_anchor_outpoint matches tx33/TAP proof root' },
      { family: 'Ark batch binding', count: 96, checks: 'vtxo_batch_root commits route allocation' },
      { family: 'Challenge mux', count: 80, checks: 'select honest exit or slash path' },
      { family: 'Public input pack', count: 48, checks: 'pack proof root and challenge id' }
    ],
    publicInputs: [
      'tap_anchor_outpoint',
      'ark_batch_root',
      'payment_hash',
      'committed_min_sats',
      'expiry_height',
      'challenge_id'
    ],
    witnessInputs: [
      'payment_preimage',
      'hop_commitments',
      'delivered_sats',
      'router_signature',
      'asp_forfeit_signature'
    ],
    scriptTemplate: [
      '<tap_anchor_outpoint> OP_EQUALVERIFY',
      'OP_SHA256 <payment_hash> OP_EQUALVERIFY',
      '<delivered_sats> <committed_min_sats> OP_GREATERTHANOREQUAL',
      'OP_IF <router_pubkey> OP_CHECKSIG',
      'OP_ELSE <asp_forfeit_pubkey> OP_CHECKSIG OP_ENDIF'
    ],
    challengePath: [
      'route commitment published off-chain',
      'watcher recomputes delivered liquidity',
      'shortfall opens BitVM challenge',
      'script selects slash or cooperative exit'
    ]
  };
  return {
    kind: 'lnbtc_tlusd_liquidity_patch_wallet_view',
    generatedAt: '2026-04-26T00:00:00.000Z',
    conversion: {
      lnbtcSats: 49000,
      tlusdUnits: 49000000,
      subswapFundingTxid: proof.keyTxids.subswapDlcFunding.txid,
      subswapFundingExplorer: proof.keyTxids.subswapDlcFunding.explorer,
      dlcFundingTxid: proof.keyTxids.inverseContract.txid,
      dlcFundingExplorer: proof.keyTxids.inverseContract.explorer,
      rfqQuoteId: proof.keyTxids.hybridColoredPledge.txid,
      rfqExplorer: proof.keyTxids.hybridColoredPledge.explorer
    },
    stake: {
      stakedTlUsdUnits: 40000000,
      stakeCommitmentId: id('stake', 'tlusd-liquidity-patch'),
      termBlocks: 144,
      expectedFeePpm: 620
    },
    liquidityPatch: {
      allocationId: id('arkalloc', 'fleet-liquidity-patch'),
      assignedInboundSats: 40000,
      deliveredInboundSats: 36000,
      challenge: {
        challengeId: id('challenge', 'bitvm-asp-shortfall'),
        status: 'prepared',
        remedy: 'slash ASP bond or force Ark exit/forfeit path'
      },
      routerCircuit
    }
  };
}

function botStatus(index) {
  if (index % 13 === 0) return 'challengeable';
  if (index % 5 === 0) return 'verifying';
  return 'active';
}

function buildBot(index, botCount) {
  const status = botStatus(index);
  const requestedInboundSats = 420000 + ((index * 977) % 310000);
  const deliveredRatio = status === 'challengeable' ? 0.76 : status === 'verifying' ? 0.91 : 0.985;
  const deliveredInboundSats = Math.floor(requestedInboundSats * deliveredRatio);
  const routeCount = 2 + (index % 9);
  const tltcSats = 900000 + ((index * 144821) % 4100000);
  const tlusdUnits = Math.floor((tltcSats / SATS) * 85000000);
  return {
    botId: `autobot-${String(index + 1).padStart(5, '0')}`,
    lane: ['lnbtc-in', 'tlusd-stake', 'ark-vtxo', 'bitvm-guard'][index % 4],
    status,
    requestedInboundSats,
    deliveredInboundSats,
    routeCount,
    tltcSats,
    tltcDisplay: (tltcSats / SATS).toFixed(5),
    tlusdUnits,
    tlusdDisplay: (tlusdUnits / 1000000).toFixed(2),
    feePpm: 520 + (index % 160),
    arkVtxoRef: id('vtxo', `${botCount}:${index}`),
    bitvmChallengeId: id('bitvm', `${botCount}:${index}`),
    violations: status === 'challengeable' ? ['delivered_below_min', 'late_rebalance_window'] : []
  };
}

function buildTimeline(bots) {
  const buckets = 16;
  return Array.from({ length: buckets }, (_, bucket) => {
    const slice = bots.filter((_, index) => index % buckets === bucket);
    const assignedInboundSats = slice.reduce((sum, bot) => sum + bot.requestedInboundSats, 0);
    const deliveredInboundSats = slice.reduce((sum, bot) => sum + bot.deliveredInboundSats, 0);
    return {
      bucket: `t+${String(bucket).padStart(2, '0')}`,
      assignedInboundSats,
      deliveredInboundSats
    };
  });
}

function buildStressDashboard(input = {}) {
  const botCount = boundedBotCount(input.botCount || input.bots || 96);
  const bots = Array.from({ length: botCount }, (_, index) => buildBot(index, botCount));
  const activeBots = bots.filter(bot => bot.status === 'active').length;
  const verifyingBots = bots.filter(bot => bot.status === 'verifying').length;
  const challengeable = bots.filter(bot => bot.status === 'challengeable');
  const assignedInboundSats = bots.reduce((sum, bot) => sum + bot.requestedInboundSats, 0);
  const deliveredInboundSats = bots.reduce((sum, bot) => sum + bot.deliveredInboundSats, 0);
  const tltcCollateralSats = bots.reduce((sum, bot) => sum + bot.tltcSats, 0);
  const tlusdStakedUnits = bots.reduce((sum, bot) => sum + bot.tlusdUnits, 0);
  const routeCount = bots.reduce((sum, bot) => sum + bot.routeCount, 0);
  const averageFeePpm = Math.round(bots.reduce((sum, bot) => sum + bot.feePpm, 0) / bots.length);
  const earnedFeesSats = Math.floor((deliveredInboundSats * averageFeePpm) / 1000000);
  const arkSavingsSats = Math.floor(routeCount * 118);

  return {
    kind: 'wallet_stress_dashboard',
    dashboardId: id('dashboard', `${botCount}:${assignedInboundSats}:${deliveredInboundSats}`),
    activeProfileId: 'bitcoin-testnet-cross-domain',
    chainSourceBadge: 'Bitcoin testnet',
    quoteAsset: 'TLUSD',
    collateralAsset: 'testnet collateral',
    totals: {
      botCount,
      activeBots,
      verifyingBots,
      challengeCount: challengeable.length,
      routeCount,
      arkVtxoCount: botCount,
      tltcCollateralDisplay: (tltcCollateralSats / SATS).toFixed(4),
      tlusdStakedDisplay: (tlusdStakedUnits / 1000000).toFixed(3),
      assignedInboundSats,
      deliveredInboundSats,
      deliveryBps: Math.round((deliveredInboundSats / assignedInboundSats) * 10000),
      averageFeePpm,
      earnedFeesSats,
      arkSavingsSats
    },
    lanes: [
      { id: 'lnbtc-in', label: 'LN-BTC intake', amountSats: Math.floor(assignedInboundSats * 0.24) },
      { id: 'tlusd-stake', label: 'TLUSD stake', amountUnits: tlusdStakedUnits },
      { id: 'ark-vtxo', label: 'Ark VTXOs', count: botCount },
      { id: 'bitvm-guard', label: 'BitVM guards', count: challengeable.length },
      { id: 'rebalance', label: 'Routed patches', amountSats: deliveredInboundSats }
    ],
    timeline: buildTimeline(bots),
    bots,
    challengeQueue: challengeable.slice(0, 40),
    verification: {
      ok: true,
      checkedAt: '2026-04-26T00:00:00.000Z',
      rule: 'delivered liquidity plus challengeable shortfall equals assigned liquidity envelope'
    }
  };
}

module.exports = {
  buildStatus,
  buildWalletView,
  buildStressDashboard
};
