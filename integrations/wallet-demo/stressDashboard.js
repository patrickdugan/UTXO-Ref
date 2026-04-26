const crypto = require('crypto');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function numberFromHash(seed, min, max) {
  const span = max - min + 1;
  const value = parseInt(sha256Hex(seed).slice(0, 8), 16);
  return min + (value % span);
}

function formatUnits(units, decimals = 6) {
  const value = BigInt(units);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function tlusdUnitsFromTltcSats(tltcSats, ltcUsdPriceMicros) {
  return (BigInt(tltcSats) * BigInt(ltcUsdPriceMicros)) / 100000000n;
}

function buildBot(seed, index, basePatch, ltcUsdPriceMicros) {
  const multiplier = BigInt(numberFromHash(`${seed}:mult:${index}`, 18, 90));
  const baseRouting = BigInt(basePatch.mandate.manager.allocation.totals.assignedInboundSats);
  const tltcCollateralSats = baseRouting * multiplier;
  const requestedInboundSats = (tltcCollateralSats * BigInt(numberFromHash(`${seed}:req:${index}`, 28, 62))) / 100n;
  const deliveryBps = BigInt(numberFromHash(`${seed}:delivery:${index}`, 8900, 10000));
  const deliveredInboundSats = (requestedInboundSats * deliveryBps) / 10000n;
  const challengeable = index % 17 === 0 || deliveryBps < 9300n;
  const status = challengeable ? 'challengeable' : index % 11 === 0 ? 'verifying' : 'active';
  const feePpm = numberFromHash(`${seed}:fee:${index}`, 220, challengeable ? 1800 : 820);
  const routeCount = numberFromHash(`${seed}:routes:${index}`, 8, 54);
  const arkVtxoCount = numberFromHash(`${seed}:vtxo:${index}`, 2, 12);
  const tlusdStakedUnits = tlusdUnitsFromTltcSats(tltcCollateralSats, ltcUsdPriceMicros);
  const earnedFeesSats = (deliveredInboundSats * BigInt(feePpm)) / 1000000n;
  const botId = `tl-autobot-${String(index + 1).padStart(3, '0')}`;

  return {
    botId,
    operator: `autobot-${String(index + 1).padStart(2, '0')}`,
    lane: ['edge-maker', 'rebalance-runner', 'watchtower-sentinel', 'asp-auditor'][index % 4],
    status,
    tltcCollateralSats: tltcCollateralSats.toString(),
    tltcDisplay: formatUnits(tltcCollateralSats, 8),
    tlusdStakedUnits: tlusdStakedUnits.toString(),
    tlusdDisplay: formatUnits(tlusdStakedUnits, 6),
    requestedInboundSats: requestedInboundSats.toString(),
    deliveredInboundSats: deliveredInboundSats.toString(),
    deliveryBps: Number(deliveryBps),
    feePpm,
    routeCount,
    arkVtxoCount,
    earnedFeesSats: earnedFeesSats.toString(),
    bitvmChallengeId: challengeable ? sha256Hex(`${seed}:challenge:${botId}`) : null,
    violations: challengeable ? ['delivered_liquidity_below_route_quote', 'fee_ppm_above_patch_ceiling'] : []
  };
}

function sumBigInt(items, selector) {
  return items.reduce((acc, item) => acc + BigInt(selector(item)), 0n);
}

function buildTimeline(seed, totals) {
  const assigned = BigInt(totals.assignedInboundSats);
  const delivered = BigInt(totals.deliveredInboundSats);
  const challenges = totals.challengeCount;
  return Array.from({ length: 24 }, (_, index) => {
    const loadBps = BigInt(numberFromHash(`${seed}:load:${index}`, 7100, 10400));
    const deliveredBps = BigInt(numberFromHash(`${seed}:delivered:${index}`, 8800, 9980));
    return {
      bucket: `t-${String(23 - index).padStart(2, '0')}`,
      assignedInboundSats: ((assigned * loadBps) / 10000n).toString(),
      deliveredInboundSats: ((delivered * deliveredBps) / 10000n).toString(),
      challengeCount: Math.max(0, challenges + numberFromHash(`${seed}:challenges:${index}`, -2, 3))
    };
  }).reverse();
}

function buildStressDashboard({ patch, config, botCount = 96, ltcUsdPriceMicros = 85000000n } = {}) {
  if (!patch || patch.kind !== 'lnbtc_tlusd_liquidity_patch_bundle') {
    throw new Error('patch must be an lnbtc_tlusd_liquidity_patch_bundle');
  }
  const activeProfileId = config && config.activeProfileId ? config.activeProfileId : 'litecoin-testnet-local';
  const seed = `${patch.bundleId}:${activeProfileId}:${botCount}:${ltcUsdPriceMicros}`;
  const bots = Array.from({ length: botCount }, (_, index) => buildBot(seed, index, patch, ltcUsdPriceMicros));
  const challengeBots = bots.filter(bot => bot.status === 'challengeable');
  const activeBots = bots.filter(bot => bot.status === 'active').length;
  const verifyingBots = bots.filter(bot => bot.status === 'verifying').length;
  const assignedInboundSats = sumBigInt(bots, bot => bot.requestedInboundSats);
  const deliveredInboundSats = sumBigInt(bots, bot => bot.deliveredInboundSats);
  const tltcCollateralSats = sumBigInt(bots, bot => bot.tltcCollateralSats);
  const tlusdStakedUnits = sumBigInt(bots, bot => bot.tlusdStakedUnits);
  const earnedFeesSats = sumBigInt(bots, bot => bot.earnedFeesSats);
  const routeCount = bots.reduce((acc, bot) => acc + bot.routeCount, 0);
  const arkVtxoCount = bots.reduce((acc, bot) => acc + bot.arkVtxoCount, 0);
  const averageFeePpm = Math.round(bots.reduce((acc, bot) => acc + bot.feePpm, 0) / bots.length);
  const deliveryBps =
    assignedInboundSats > 0n ? Number((deliveredInboundSats * 10000n) / assignedInboundSats) : 0;
  const arkPerGraftSats = BigInt(patch.mandate.manager.costModel.modelCore.ark.perGraftSats);
  const baselinePerGraftSats = BigInt(patch.mandate.manager.costModel.modelCore.baseline.perGraftSats);
  const arkSavingsSats = (baselinePerGraftSats - arkPerGraftSats) * BigInt(routeCount);

  const totals = {
    botCount,
    activeBots,
    verifyingBots,
    challengeCount: challengeBots.length,
    routeCount,
    arkVtxoCount,
    tltcCollateralSats: tltcCollateralSats.toString(),
    tltcCollateralDisplay: formatUnits(tltcCollateralSats, 8),
    tlusdStakedUnits: tlusdStakedUnits.toString(),
    tlusdStakedDisplay: formatUnits(tlusdStakedUnits, 6),
    assignedInboundSats: assignedInboundSats.toString(),
    deliveredInboundSats: deliveredInboundSats.toString(),
    deliveryBps,
    averageFeePpm,
    earnedFeesSats: earnedFeesSats.toString(),
    arkSavingsSats: arkSavingsSats.toString()
  };

  return {
    kind: 'utxoref_stress_dashboard',
    dashboardId: sha256Hex(`${seed}:dashboard`),
    generatedAt: new Date(0).toISOString(),
    activeProfileId,
    chainSourceBadge: config && config.activeProfile ? config.activeProfile.chainSourceBadge : 'litecoin-testnet',
    quoteAsset: 'TLUSD',
    collateralAsset: 'tLTC',
    stressModel: {
      botCount,
      sourceBundleId: patch.bundleId,
      ltcUsdPriceMicros: ltcUsdPriceMicros.toString(),
      deterministic: true,
      caveat: 'Stress telemetry is deterministic synthetic fleet data anchored to the current TLUSD liquidity patch artifact.'
    },
    totals,
    lanes: [
      { id: 'lnbtc', label: 'LN-BTC ingress', amountSats: patch.conversion.conversionCore.lnbtcSats },
      { id: 'tltc', label: 'tLTC collateral pool', amountSats: totals.tltcCollateralSats },
      { id: 'tlusd', label: 'TLUSD stake pool', amountUnits: totals.tlusdStakedUnits },
      { id: 'ark', label: 'Ark VTXO patches', count: totals.arkVtxoCount },
      { id: 'bitvm', label: 'BitVM challenge queue', count: totals.challengeCount }
    ],
    timeline: buildTimeline(seed, totals),
    bots,
    challengeQueue: challengeBots.slice(0, 16).map(bot => ({
      botId: bot.botId,
      bitvmChallengeId: bot.bitvmChallengeId,
      requestedInboundSats: bot.requestedInboundSats,
      deliveredInboundSats: bot.deliveredInboundSats,
      violations: bot.violations
    }))
  };
}

function verifyStressDashboard(dashboard) {
  if (!dashboard || dashboard.kind !== 'utxoref_stress_dashboard') {
    return { ok: false, reason: 'wrong dashboard kind' };
  }
  if (!Array.isArray(dashboard.bots) || dashboard.bots.length !== dashboard.totals.botCount) {
    return { ok: false, reason: 'bot count mismatch' };
  }
  if (dashboard.totals.challengeCount !== dashboard.bots.filter(bot => bot.status === 'challengeable').length) {
    return { ok: false, reason: 'challenge count mismatch' };
  }
  if (!dashboard.timeline || dashboard.timeline.length !== 24) {
    return { ok: false, reason: 'timeline length mismatch' };
  }
  return { ok: true };
}

module.exports = {
  buildStressDashboard,
  verifyStressDashboard,
  tlusdUnitsFromTltcSats
};
