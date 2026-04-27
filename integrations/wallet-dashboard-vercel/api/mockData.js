const crypto = require('crypto');

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
  return {
    ok: true,
    activeProfileId: 'vercel-mock-litecoin-testnet',
    profile: {
      id: 'vercel-mock-litecoin-testnet',
      mode: 'serverless mock',
      notes: 'Static Vercel package mirroring the local wallet-demo sidecar contract.'
    },
    chain: {
      chain: 'litecoin',
      network: 'testnet',
      rpcUrl: 'mock://litecoin-testnet',
      wallet: 'utxoref-demo'
    },
    lnd: {
      network: 'bitcoin-testnet',
      grpcHost: 'mock://lnd-testnet'
    },
    artifacts: {
      lnbtcTlusdLiquidityPatch: { exists: true, source: 'vercel mock API' },
      walletStressSimulation: { exists: true, source: 'deterministic serverless generator' }
    },
    readiness: {
      walletViewReady: true,
      stressDashboardReady: true,
      deployPreviewReady: true
    }
  };
}

function buildWalletView() {
  return {
    kind: 'lnbtc_tlusd_liquidity_patch_wallet_view',
    generatedAt: '2026-04-26T00:00:00.000Z',
    conversion: {
      lnbtcSats: 49000,
      tlusdUnits: 49000000,
      subswapFundingTxid: id('subswap', 'lnbtc-funding'),
      dlcFundingTxid: id('dlc', 'utxoref-funding'),
      rfqQuoteId: id('rfq', 'tlusd-quote')
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
      }
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
    activeProfileId: 'vercel-mock-litecoin-testnet',
    chainSourceBadge: 'ltc-testnet mock',
    quoteAsset: 'TLUSD',
    collateralAsset: 'tLTC',
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
