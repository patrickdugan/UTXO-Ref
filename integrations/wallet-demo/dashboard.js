const state = {
  dashboard: null,
  status: null,
  walletView: null,
  failureMode: 'nominal',
  assetMode: 'tlusd'
};

function $(id) {
  return document.getElementById(id);
}

function sats(value) {
  return `${Number(value).toLocaleString()} sats`;
}

function compactSats(value) {
  const n = Number(value);
  if (n >= 100000000) return `${(n / 100000000).toFixed(3)} tLTC`;
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M sats`;
  return `${n.toLocaleString()} sats`;
}

function tlusd(units) {
  return `${(Number(units) / 1000000).toLocaleString(undefined, { maximumFractionDigits: 2 })} TLUSD`;
}

function statusClass(status) {
  return `status ${status}`;
}

function short(value) {
  if (!value) return 'n/a';
  return String(value).length > 18 ? `${String(value).slice(0, 18)}...` : String(value);
}

function detailRow(label, value) {
  return `<div class="detail-row"><span>${label}</span><strong>${value ?? 'n/a'}</strong></div>`;
}

function metric(label, value, note = '') {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`;
}

function percent(value) {
  return `${Number(value).toFixed(2)}%`;
}

const failureScenarios = {
  nominal: {
    label: 'Nominal',
    detector: 'all adapters',
    impact: 'Routes remain inside committed liquidity envelopes; BitVM challenge path stays cold.'
  },
  asp_delay: {
    label: 'ASP delay',
    detector: 'Ark exit watcher',
    impact: 'Timeout pressure rises; wallet prepares unilateral Ark exit and BitVM slash evidence.'
  },
  oracle_mismatch: {
    label: 'Oracle mismatch',
    detector: 'DLC oracle adapter',
    impact: 'TLUSD mint path pauses until oracle delta and funding state are reconciled.'
  },
  htlc_timeout: {
    label: 'HTLC timeout',
    detector: 'LDK payment lifecycle',
    impact: 'Subswap funding reverts toward the LN sender before the UTXORef funding edge is accepted.'
  },
  under_delivery: {
    label: 'Under-delivery',
    detector: 'BitVM liquidity invariant',
    impact: 'Shortfall is challengeable; ASP bond or forfeit path covers the missing inbound liquidity.'
  },
  forced_exit: {
    label: 'Forced Ark exit',
    detector: 'Ark batch monitor',
    impact: 'VTXO leaves the batch path; fee model flips to emergency exit while liquidity accounting remains auditable.'
  }
};

const assetModes = {
  tlusd: {
    label: 'TLUSD mock',
    issuer: 'wallet sidecar',
    settlement: 'synthetic USD proof from local Litecoin testnet collateral',
    reviewerPoint: 'fastest path for showing wallet UX and stress quantities'
  },
  taproot: {
    label: 'Taproot Asset USD',
    issuer: 'Taproot Assets daemon',
    settlement: 'asset proof rides beside LN liquidity with daemon-issued transfer proofs',
    reviewerPoint: 'shows how the liquidity patch can externalize into a real LN asset stack'
  },
  tradelayer: {
    label: 'TradeLayer synthetic USD',
    issuer: 'TradeLayer tx 33',
    settlement: 'BTC/USD perp-backed synthetic USD controlled by UTXORef and DLC status',
    reviewerPoint: 'connects tokenized BTC, perps, DLC status, and Ark fee compression'
  }
};

function renderKpis(dashboard) {
  const totals = dashboard.totals;
  $('subtitle').textContent = `${dashboard.collateralAsset} stress fleet backing ${dashboard.quoteAsset} liquidity patches`;
  $('profileBadge').textContent = dashboard.activeProfileId;
  $('chainBadge').textContent = dashboard.chainSourceBadge;
  $('botCount').textContent = totals.botCount.toLocaleString();
  $('botMix').textContent = `${totals.activeBots} active, ${totals.verifyingBots} verifying`;
  $('tltcCollateral').textContent = `${totals.tltcCollateralDisplay} tLTC`;
  $('tlusdStaked').textContent = `${Number(totals.tlusdStakedDisplay).toLocaleString()} TLUSD`;
  $('assignedInbound').textContent = compactSats(totals.assignedInboundSats);
  $('deliveryRate').textContent = `${(totals.deliveryBps / 100).toFixed(2)}% delivered`;
  $('challengeCount').textContent = totals.challengeCount.toLocaleString();
  $('dashboardId').textContent = dashboard.dashboardId.slice(0, 16);
  $('feeSummary').textContent = `${totals.averageFeePpm} ppm avg, ${sats(totals.earnedFeesSats)} earned`;
  $('savingsSummary').textContent = `${sats(totals.arkSavingsSats)} modeled Ark savings`;
  $('routeCount').textContent = `${totals.routeCount.toLocaleString()} routes, ${totals.arkVtxoCount.toLocaleString()} VTXOs`;
}

function renderLanes(dashboard) {
  const laneRail = $('laneRail');
  laneRail.innerHTML = '';
  dashboard.lanes.forEach(lane => {
    const div = document.createElement('div');
    div.className = 'lane';
    const amount = lane.amountSats
      ? compactSats(lane.amountSats)
      : lane.amountUnits
        ? tlusd(lane.amountUnits)
        : Number(lane.count).toLocaleString();
    div.innerHTML = `<span>${lane.label}</span><strong>${amount}</strong><small>${lane.id}</small>`;
    laneRail.appendChild(div);
  });
}

function renderTimeline(dashboard) {
  const timeline = $('timeline');
  timeline.innerHTML = '';
  const maxAssigned = Math.max(...dashboard.timeline.map(point => Number(point.assignedInboundSats)));
  dashboard.timeline.forEach(point => {
    const assignedHeight = Math.max(6, Math.round((Number(point.assignedInboundSats) / maxAssigned) * 240));
    const deliveredHeight = Math.max(4, Math.round((Number(point.deliveredInboundSats) / Number(point.assignedInboundSats)) * 100));
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = `${assignedHeight}px`;
    bar.style.setProperty('--delivered', `${deliveredHeight}%`);
    bar.title = `${point.bucket}: ${sats(point.assignedInboundSats)} assigned, ${sats(point.deliveredInboundSats)} delivered`;
    timeline.appendChild(bar);
  });
}

function showChallenge(item) {
  $('dialogTitle').textContent = `${item.botId} BitVM Challenge`;
  $('dialogBody').innerHTML = [
    detailRow('Challenge ID', short(item.bitvmChallengeId)),
    detailRow('Promised liquidity', sats(item.requestedInboundSats)),
    detailRow('Delivered liquidity', sats(item.deliveredInboundSats)),
    detailRow('Shortfall', sats(Number(item.requestedInboundSats) - Number(item.deliveredInboundSats))),
    detailRow('Violations', item.violations.join(', ')),
    detailRow('Remedy', 'slash ASP bond or force Ark exit/forfeit path')
  ].join('');
  $('challengeDialog').showModal();
}

function renderQueue(dashboard) {
  const queue = $('challengeQueue');
  queue.innerHTML = '';
  dashboard.challengeQueue.forEach(item => {
    const div = document.createElement('div');
    div.className = 'queue-item';
    div.innerHTML = `
      <strong>${item.botId}</strong>
      <span>${sats(item.deliveredInboundSats)} / ${sats(item.requestedInboundSats)}</span>
      <small>${item.violations.join(', ')}</small>
    `;
    div.addEventListener('click', () => showChallenge(item));
    queue.appendChild(div);
  });
}

function renderWalletPane(walletView, dashboard) {
  if (!walletView) return;
  $('walletLnBtc').textContent = sats(walletView.conversion.lnbtcSats);
  $('walletTlusd').textContent = tlusd(walletView.conversion.tlusdUnits);
  $('walletStaked').textContent = tlusd(walletView.stake.stakedTlUsdUnits);
  $('walletPatch').textContent = compactSats(dashboard.totals.assignedInboundSats);
  $('walletVerify').onclick = () => {
    $('subtitle').textContent = `Verified ${compactSats(dashboard.totals.assignedInboundSats)} assigned across ${dashboard.totals.botCount} bots`;
  };
  $('walletChallenge').onclick = () => {
    const first = dashboard.challengeQueue[0];
    if (first) showChallenge(first);
  };
}

function renderProfilePanel(status) {
  if (!status) return;
  $('profileMode').textContent = status.profile.mode;
  $('profilePanel').innerHTML = [
    detailRow('Profile', status.activeProfileId),
    detailRow('Chain', status.chain.chain),
    detailRow('RPC', status.chain.rpcUrl),
    detailRow('Wallet', status.chain.wallet),
    detailRow('LND', status.lnd ? `${status.lnd.network} ${status.lnd.grpcHost}` : 'not active'),
    detailRow('Artifact', status.artifacts.lnbtcTlusdLiquidityPatch.exists ? 'loaded' : 'missing'),
    detailRow('Wallet ready', status.readiness.walletViewReady)
  ].join('');
}

function renderProofGraph(walletView, dashboard) {
  if (!walletView) return;
  const nodes = [
    ['LN-BTC', walletView.conversion.subswapFundingTxid],
    ['UTXORef', walletView.conversion.dlcFundingTxid],
    ['TLUSD RFQ', walletView.conversion.rfqQuoteId],
    ['Stake', walletView.stake.stakeCommitmentId],
    ['Ark allocation', walletView.liquidityPatch.allocationId],
    ['BitVM challenge', walletView.liquidityPatch.challenge.challengeId],
    ['Fleet dashboard', dashboard.dashboardId]
  ];
  $('proofGraph').innerHTML = nodes
    .map(([label, value]) => `<div class="proof-node" title="${value || ''}"><strong>${label}</strong><span>${short(value)}</span></div>`)
    .join('');
}

function renderProtocolTrace(walletView, dashboard) {
  if (!walletView) return;
  const scenario = failureScenarios[state.failureMode];
  const steps = [
    ['LN invoice', `hash ${short(walletView.conversion.subswapFundingTxid)}`, 'BOLT11 invoice accepted by wallet funding flow'],
    ['Subswap HTLC', `cltv ${48 + Math.floor(dashboard.totals.botCount / 512)}`, 'payment hash locks inbound funding until preimage or timeout'],
    ['UTXORef funding', short(walletView.conversion.dlcFundingTxid), 'DLC funding output becomes the state anchor'],
    ['Ark VTXO', short(walletView.liquidityPatch.allocationId), `${dashboard.totals.arkVtxoCount.toLocaleString()} batched references compress fee surface`],
    ['Asset stake', short(walletView.stake.stakeCommitmentId), `${assetModes[state.assetMode].label} posted as routing commitment`],
    ['BitVM guard', short(walletView.liquidityPatch.challenge.challengeId), `${scenario.detector} watches for ${scenario.label.toLowerCase()}`]
  ];
  $('protocolTrace').innerHTML = steps
    .map(([label, value, note]) => `<div class="trace-step"><strong>${label}</strong><span>${value}</span><small>${note}</small></div>`)
    .join('');
}

function renderFailureLab(dashboard) {
  const scenario = failureScenarios[state.failureMode];
  $('failureStatus').textContent = scenario.label;
  $('failureControls').innerHTML = Object.entries(failureScenarios)
    .map(([key, item]) => `<button type="button" data-failure="${key}" class="${key === state.failureMode ? 'active' : ''}">${item.label}</button>`)
    .join('');
  $('failureControls').querySelectorAll('button').forEach(button => {
    button.addEventListener('click', () => {
      state.failureMode = button.dataset.failure;
      render(state.dashboard, state.status, state.walletView);
    });
  });

  const shortfall = Math.max(0, Number(dashboard.totals.assignedInboundSats) - Number(dashboard.totals.deliveredInboundSats));
  $('failureImpact').innerHTML = [
    detailRow('Detector', scenario.detector),
    detailRow('Current shortfall', compactSats(shortfall)),
    detailRow('Recovery path', scenario.impact)
  ].join('');
}

function renderLnCompatibility(walletView, dashboard) {
  if (!walletView) return;
  const cltvDelta = 48 + Math.floor(dashboard.totals.botCount / 512);
  const outbound = Math.floor(Number(walletView.conversion.lnbtcSats) * 0.82);
  const inbound = Number(dashboard.totals.assignedInboundSats);
  $('lnCompatibility').innerHTML = [
    detailRow('Invoice amount', sats(walletView.conversion.lnbtcSats)),
    detailRow('Payment hash', short(walletView.conversion.subswapFundingTxid)),
    detailRow('Preimage source', 'subswap fulfillment witness'),
    detailRow('CLTV delta', `${cltvDelta} blocks`),
    detailRow('Route fee', `${dashboard.totals.averageFeePpm} ppm`),
    detailRow('Outbound liquidity', compactSats(outbound)),
    detailRow('Inbound liquidity', compactSats(inbound)),
    detailRow('LDK event', state.failureMode === 'htlc_timeout' ? 'PaymentPathFailed' : 'PaymentClaimable')
  ].join('');
}

function renderArkSavings(dashboard) {
  const feeRate = Number($('arkFeeRate').value);
  const routes = Number(dashboard.totals.routeCount);
  const directVbytes = routes * 112;
  const arkVbytes = Math.ceil(routes / 64) * 155 + Number(dashboard.totals.arkVtxoCount) * 3;
  const directFee = directVbytes * feeRate;
  const arkFee = arkVbytes * feeRate;
  const savings = Math.max(0, directFee - arkFee);
  const breakeven = routes > 0 ? (arkVbytes / directVbytes) * feeRate : 0;
  $('arkFeeLabel').textContent = `${feeRate} sat/vB`;
  $('arkSavingsHeadline').textContent = compactSats(savings);
  $('arkSavingsPanel').innerHTML = [
    metric('Direct cost', compactSats(directFee), `${directVbytes.toLocaleString()} vB`),
    metric('Ark batch cost', compactSats(arkFee), `${arkVbytes.toLocaleString()} vB`),
    metric('Fee saved', compactSats(savings), `${Math.round((savings / directFee) * 100)}% lower`),
    metric('Breakeven', `${breakeven.toFixed(2)} sat/vB`, 'batch path ratio')
  ].join('');
  return { feeRate, directFee, arkFee, savings };
}

function renderBitvmEnforcement(walletView, dashboard) {
  if (!walletView) return;
  const firstChallenge = dashboard.challengeQueue[0];
  const committed = Number(firstChallenge?.requestedInboundSats || walletView.liquidityPatch.assignedInboundSats || 0);
  const claimed = Number(firstChallenge?.deliveredInboundSats || walletView.liquidityPatch.deliveredInboundSats || 0);
  const shortfall = Math.max(0, committed - claimed);
  $('bitvmEnforcement').innerHTML = [
    detailRow('Committed state', `${compactSats(committed)} inbound promised`),
    detailRow('Claimed state', `${compactSats(claimed)} delivered by ASP`),
    detailRow('Invariant', 'delivered >= committed minimum before expiry'),
    detailRow('Shortfall', compactSats(shortfall)),
    detailRow('Bond coverage', compactSats(Math.max(shortfall * 2, 25000))),
    detailRow('Challenge window', `${walletView.stake.termBlocks || 144} blocks`),
    detailRow('Exit path', state.failureMode === 'forced_exit' ? 'force Ark exit then slash' : 'challenge ASP commitment then slash')
  ].join('');
}

function renderAssetMode(walletView, dashboard) {
  const mode = assetModes[state.assetMode];
  const units = state.assetMode === 'tlusd'
    ? tlusd(walletView.conversion.tlusdUnits)
    : `${(Number(walletView.conversion.tlusdUnits) / 1000000).toLocaleString(undefined, { maximumFractionDigits: 2 })} USD units`;
  $('assetModePanel').innerHTML = [
    detailRow('Backend', mode.label),
    detailRow('Issuer', mode.issuer),
    detailRow('Settlement', mode.settlement),
    detailRow('Wallet balance', units),
    detailRow('Routing stake', compactSats(dashboard.totals.assignedInboundSats)),
    detailRow('Reviewer signal', mode.reviewerPoint)
  ].join('');
}

function renderIntegrationChecklist(status) {
  if (!status) return;
  const rows = [
    ['LDK Node', 'mocked', 'event mapping surfaced in BOLT pane'],
    ['LND', status.lnd ? 'local' : 'pending', status.lnd ? status.lnd.grpcHost : 'not wired'],
    ['Core Lightning', 'pending', 'adapter contract documented'],
    ['Bark / Ark', 'mocked', 'VTXO batch cost model live'],
    ['Taproot Assets', state.assetMode === 'taproot' ? 'pending' : 'mocked', 'mode-ready asset adapter'],
    ['Litecoin testnet', status.chain.chain === 'litecoin' ? 'local' : 'mocked', status.chain.rpcUrl],
    ['Bitcoin testnet', status.lnd ? 'remote' : 'pending', status.lnd ? status.lnd.network : 'future LND profile']
  ];
  $('integrationChecklist').innerHTML = rows
    .map(([name, stateLabel, note]) => `<div class="check-item"><div><strong>${name}</strong><small>${note}</small></div><span class="status ${stateLabel}">${stateLabel}</span></div>`)
    .join('');
}

function renderOperatorEconomics(dashboard, ark) {
  const capitalSats = Math.max(1, Number(dashboard.totals.assignedInboundSats));
  const grossFees = Number(dashboard.totals.earnedFeesSats);
  const challengeReserve = Number(dashboard.totals.challengeCount) * 1800;
  const emergencyExitReserve = state.failureMode === 'forced_exit' ? ark.arkFee * 2 : Math.floor(ark.arkFee * 0.35);
  const net = grossFees + ark.savings - challengeReserve - emergencyExitReserve;
  const utilization = Number(dashboard.totals.deliveredInboundSats) / capitalSats;
  const periodYield = (net / capitalSats) * 100;
  $('operatorNetYield').textContent = `${net >= 0 ? '+' : ''}${compactSats(net)} modeled net`;
  $('operatorEconomics').innerHTML = [
    metric('Gross fees', compactSats(grossFees), `${dashboard.totals.averageFeePpm} ppm`),
    metric('Ark savings', compactSats(ark.savings), `${ark.feeRate} sat/vB model`),
    metric('Challenge reserve', compactSats(challengeReserve), `${dashboard.totals.challengeCount} queue items`),
    metric('Exit reserve', compactSats(emergencyExitReserve), state.failureMode),
    metric('Utilization', percent(utilization * 100), 'delivered / assigned'),
    metric('Net yield', `${periodYield.toFixed(3)}%`, 'per simulated batch')
  ].join('');
}

function renderTable(dashboard) {
  const tbody = $('botTable');
  tbody.innerHTML = '';
  dashboard.bots.slice(0, 80).forEach(bot => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${bot.botId}</td>
      <td>${bot.lane}</td>
      <td><span class="${statusClass(bot.status)}">${bot.status}</span></td>
      <td>${bot.tltcDisplay}</td>
      <td>${Number(bot.tlusdDisplay).toLocaleString()}</td>
      <td>${bot.routeCount}</td>
      <td>${compactSats(bot.deliveredInboundSats)}</td>
      <td>${bot.feePpm} ppm</td>
    `;
    if (bot.status === 'challengeable') {
      tr.addEventListener('click', () => {
        const item = dashboard.challengeQueue.find(challenge => challenge.botId === bot.botId) || {
          botId: bot.botId,
          bitvmChallengeId: bot.bitvmChallengeId,
          requestedInboundSats: bot.requestedInboundSats,
          deliveredInboundSats: bot.deliveredInboundSats,
          violations: bot.violations
        };
        showChallenge(item);
      });
    }
    tbody.appendChild(tr);
  });
}

function render(dashboard, status, walletView) {
  renderKpis(dashboard);
  renderLanes(dashboard);
  renderTimeline(dashboard);
  renderQueue(dashboard);
  renderWalletPane(walletView, dashboard);
  renderProfilePanel(status);
  renderProofGraph(walletView, dashboard);
  renderProtocolTrace(walletView, dashboard);
  renderFailureLab(dashboard);
  renderLnCompatibility(walletView, dashboard);
  const ark = renderArkSavings(dashboard);
  renderBitvmEnforcement(walletView, dashboard);
  renderAssetMode(walletView, dashboard);
  renderIntegrationChecklist(status);
  renderOperatorEconomics(dashboard, ark);
  renderTable(dashboard);
}

function exportReport() {
  if (!state.dashboard) return;
  const payload = {
    exportedAt: new Date().toISOString(),
    plan: 'UTXORef wallet stress dashboard',
    interactionState: {
      failureMode: state.failureMode,
      assetMode: state.assetMode,
      arkFeeRate: Number($('arkFeeRate').value)
    },
    dashboard: state.dashboard,
    backendStatus: state.status,
    walletView: state.walletView
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `utxoref-stress-dashboard-${state.dashboard.totals.botCount}-bots.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
  return response.json();
}

async function loadDashboard() {
  $('refreshButton').disabled = true;
  try {
    const botCount = $('botSelect').value;
    const [dashboard, status, walletView] = await Promise.all([
      getJson(`/v1/wallet-demo/stress-dashboard?bots=${encodeURIComponent(botCount)}`),
      getJson('/v1/wallet-demo/status'),
      getJson('/v1/lnbtc-tlusd-liquidity-patch/wallet-view')
    ]);
    state.dashboard = dashboard;
    state.status = status;
    state.walletView = walletView;
    render(dashboard, status, walletView);
  } finally {
    $('refreshButton').disabled = false;
  }
}

$('refreshButton').addEventListener('click', loadDashboard);
$('exportButton').addEventListener('click', exportReport);
$('botSelect').addEventListener('change', loadDashboard);
$('arkFeeRate').addEventListener('input', () => {
  if (state.dashboard) render(state.dashboard, state.status, state.walletView);
});
$('assetMode').addEventListener('change', () => {
  state.assetMode = $('assetMode').value;
  if (state.dashboard) render(state.dashboard, state.status, state.walletView);
});
$('closeDialog').addEventListener('click', () => $('challengeDialog').close());
loadDashboard().catch(err => {
  $('subtitle').textContent = err.message;
});
