const state = {
  dashboard: null,
  status: null,
  walletView: null
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
  renderTable(dashboard);
}

function exportReport() {
  if (!state.dashboard) return;
  const payload = {
    exportedAt: new Date().toISOString(),
    plan: 'UTXORef wallet stress dashboard',
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
$('closeDialog').addEventListener('click', () => $('challengeDialog').close());
loadDashboard().catch(err => {
  $('subtitle').textContent = err.message;
});
