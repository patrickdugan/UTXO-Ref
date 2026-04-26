const state = {
  dashboard: null
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
    queue.appendChild(div);
  });
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
    tbody.appendChild(tr);
  });
}

function render(dashboard) {
  renderKpis(dashboard);
  renderLanes(dashboard);
  renderTimeline(dashboard);
  renderQueue(dashboard);
  renderTable(dashboard);
}

async function loadDashboard() {
  $('refreshButton').disabled = true;
  try {
    const response = await fetch('/v1/wallet-demo/stress-dashboard');
    if (!response.ok) throw new Error(`stress dashboard failed: ${response.status}`);
    const dashboard = await response.json();
    state.dashboard = dashboard;
    render(dashboard);
  } finally {
    $('refreshButton').disabled = false;
  }
}

$('refreshButton').addEventListener('click', loadDashboard);
loadDashboard().catch(err => {
  $('subtitle').textContent = err.message;
});
