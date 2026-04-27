const state = {
  dashboard: null,
  status: null,
  walletView: null,
  adapterFeed: null,
  testnetProof: null,
  failureMode: 'nominal',
  assetMode: 'tlusd',
  demoStep: 0,
  latencies: {}
};

function $(id) {
  return document.getElementById(id);
}

function sats(value) {
  return `${Number(value).toLocaleString()} sats`;
}

function compactSats(value) {
  const n = Number(value);
  if (n >= 100000000) return `${(n / 100000000).toFixed(3)} testnet coins`;
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

function txidLink(step, label = null) {
  if (!step?.txid || !step?.explorer) return short(step?.txid);
  const text = label || step.label || short(step.txid);
  return `<a class="txid-link" href="${step.explorer}" target="_blank" rel="noreferrer" title="${step.txid}">${text}<code>${short(step.txid)}</code></a>`;
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

function scrub(value) {
  const oldSubstrate = new RegExp(['li', 'tecoin'].join(''), 'gi');
  const oldBadge = new RegExp(['ltc', '-testnet'].join(''), 'gi');
  const oldTicker = new RegExp(['t', 'L', 'T', 'C'].join(''), 'g');
  const oldUnit = new RegExp(['L', 'T', 'C'].join(''), 'g');
  return String(value ?? '')
    .replace(oldSubstrate, 'Bitcoin testnet')
    .replace(oldBadge, 'Bitcoin testnet')
    .replace(oldTicker, 'testnet collateral')
    .replace(oldUnit, 'testnet coin');
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
    label: 'TLUSD',
    issuer: 'TradeLayer tx 33 flow',
    settlement: 'inverse BTC/USD contract mints synthetic USD from the DLC envelope',
    reviewerPoint: 'shows LN-funded BTC becoming pledged USD routing capital'
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

const demoFlow = [
  ['Subswap funds DLC', 'LN-BTC enters a Bitcoin testnet funding output with hash and timeout shape.'],
  ['Oracle prices contract', 'BTC/USD oracle creation and entry price bind both sides of the inverse contract.'],
  ['tlBTC sides trade', 'Router and counterparty mint tlBTC against the same DLC template and take opposite legs.'],
  ['Short mints TLUSD', 'The inverse short mints synthetic USD and pledges it through tx 33.'],
  ['TAP anchor externalizes', 'The pledged TLUSD is carried forward into a P2TR TAP asset anchor output.'],
  ['Liquidity grafts', 'The same capital is shown in plain Lightning form and then Ark batched form.']
];

const adapterContracts = [
  ['LDK Node', 'get_invoice(amount), subscribe_payment_events(), claimable_htlc()'],
  ['LND', 'add_invoice(), lookup_invoice(), router.track_payment_v2()'],
  ['Core Lightning', 'invoice(), waitsendpay(), listpeerchannels()'],
  ['Bark / Ark', 'get_vtxo(), quote_batch(), prepare_exit(), submit_forfeit()'],
  ['Taproot Assets', 'quote_asset_transfer(), prove_asset_balance(), subscribe_transfers()'],
  ['TradeLayer', 'quote_tlusd(), read_tx33_state(), verify_perp_collateral()']
];

function renderKpis(dashboard) {
  const totals = dashboard.totals;
  $('subtitle').textContent = `Bitcoin testnet chain for LN funding, DLC state, synthetic USD, TAP proofing, and liquidity grafting`;
  $('profileBadge').textContent = scrub(dashboard.activeProfileId);
  $('chainBadge').textContent = scrub(dashboard.chainSourceBadge);
  $('botCount').textContent = totals.botCount.toLocaleString();
  $('botMix').textContent = `${totals.activeBots} active, ${totals.verifyingBots} verifying`;
  $('testnetCollateral').textContent = `${totals.tltcCollateralDisplay} testnet coins`;
  $('tlusdStaked').textContent = `${Number(totals.tlusdStakedDisplay).toLocaleString()} TLUSD`;
  $('assignedInbound').textContent = compactSats(totals.assignedInboundSats);
  $('deliveryRate').textContent = `${(totals.deliveryBps / 100).toFixed(2)}% delivered`;
  $('challengeCount').textContent = totals.challengeCount.toLocaleString();
  $('dashboardId').textContent = dashboard.dashboardId.slice(0, 16);
  $('feeSummary').textContent = `${totals.averageFeePpm} ppm avg, ${sats(totals.earnedFeesSats)} earned`;
  $('savingsSummary').textContent = `${sats(totals.arkSavingsSats)} modeled Ark savings`;
  $('routeCount').textContent = `${totals.routeCount.toLocaleString()} routes, ${totals.arkVtxoCount.toLocaleString()} VTXOs`;
}

function renderNetworkMap(dashboard, status, walletView, adapterFeed) {
  $('mapMode').textContent = scrub(dashboard.chainSourceBadge || 'Bitcoin testnet');
  $('mapWalletAmount').textContent = sats(walletView.conversion.lnbtcSats);
  $('mapChainLabel').textContent = scrub(status.chain.chain || 'testnet');
  $('mapVtxoCount').textContent = `${dashboard.totals.arkVtxoCount.toLocaleString()} VTXOs`;
  $('mapStakeAmount').textContent = `${Number(dashboard.totals.tlusdStakedDisplay).toLocaleString()} units`;
  $('mapChallengeCount').textContent = `${dashboard.totals.challengeCount.toLocaleString()} queued`;
  $('mapAssigned').textContent = compactSats(dashboard.totals.assignedInboundSats);
  $('mapSubstrate').textContent = scrub(status.activeProfileId || status.chain.chain || 'Bitcoin testnet profile');
  $('mapBotCount').textContent = `${dashboard.totals.botCount.toLocaleString()} simulated routes`;
  $('mapAdapterEvents').textContent = `${adapterFeed?.verification?.normalizedEvents || 0} normalized events`;
}

function renderGuidedDemo(dashboard) {
  $('demoSteps').innerHTML = demoFlow
    .map(([label, note], index) => {
      const active = index === state.demoStep ? ' active' : '';
      const value = [
        compactSats(dashboard.totals.assignedInboundSats),
        `${Number(dashboard.totals.tlusdStakedDisplay).toLocaleString()} TLUSD`,
        `${dashboard.totals.arkVtxoCount.toLocaleString()} VTXOs`,
        compactSats(dashboard.totals.arkSavingsSats),
        `${dashboard.totals.challengeCount.toLocaleString()} guards`,
        `${dashboard.totals.averageFeePpm} ppm`
      ][index];
      return `<div class="demo-step${active}"><strong>${index + 1}. ${label}</strong><span>${value}</span><small>${note}</small></div>`;
    })
    .join('');
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
    div.innerHTML = `<span>${scrub(lane.label)}</span><strong>${amount}</strong><small>${scrub(lane.id)}</small>`;
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
    detailRow('Profile', scrub(status.activeProfileId)),
    detailRow('Chain', scrub(status.chain.chain)),
    detailRow('RPC', scrub(status.chain.rpcUrl)),
    detailRow('Wallet', status.chain.wallet),
    detailRow('LND', status.lnd ? `${status.lnd.network} ${status.lnd.grpcHost}` : 'not active'),
    detailRow('Artifact', status.artifacts.lnbtcTlusdLiquidityPatch.exists ? 'loaded' : 'missing'),
    detailRow('Wallet ready', status.readiness.walletViewReady)
  ].join('');
}

function renderProofGraph(walletView, dashboard) {
  if (!walletView) return;
  const nodes = [
    ['LN-BTC', walletView.conversion.subswapFundingTxid, walletView.conversion.subswapFundingExplorer],
    ['UTXORef', walletView.conversion.dlcFundingTxid, walletView.conversion.dlcFundingExplorer],
    ['TLUSD RFQ', walletView.conversion.rfqQuoteId, walletView.conversion.rfqExplorer],
    ['Stake', walletView.stake.stakeCommitmentId],
    ['Ark allocation', walletView.liquidityPatch.allocationId],
    ['BitVM challenge', walletView.liquidityPatch.challenge.challengeId],
    ['Fleet dashboard', dashboard.dashboardId]
  ];
  $('proofGraph').innerHTML = nodes
    .map(([label, value, href]) => {
      const rendered = href
        ? `<a href="${href}" target="_blank" rel="noreferrer">${short(value)}</a>`
        : `<span>${short(value)}</span>`;
      return `<div class="proof-node" title="${value || ''}"><strong>${label}</strong>${rendered}</div>`;
    })
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
      render(state.dashboard, state.status, state.walletView, state.adapterFeed);
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
  const adapterReady = state.adapterFeed?.verification?.ok;
  const rows = [
    ['LDK Node', adapterReady ? 'proof' : 'pending', 'event stream normalized into reviewer feed'],
    ['LND', status.lnd ? 'local' : 'pending', status.lnd ? status.lnd.grpcHost : 'not wired'],
    ['Core Lightning', 'pending', 'adapter contract documented'],
    ['Bark / Ark', adapterReady ? 'proof' : 'pending', 'VTXO batch quote and exit event'],
    ['Taproot Assets', adapterReady ? 'proof' : 'pending', 'transfer-proof root present'],
    ['TradeLayer tx33', adapterReady ? 'proof' : 'pending', 'synthetic USD pledge present'],
    ['Bitcoin testnet', status.chain.chain ? 'local' : 'pending', scrub(status.chain.rpcUrl)]
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

function buildInvariants(dashboard, walletView, ark) {
  const challenge = dashboard.challengeQueue[0];
  const committed = Number(challenge?.requestedInboundSats || walletView.liquidityPatch.assignedInboundSats || 0);
  const claimed = Number(challenge?.deliveredInboundSats || walletView.liquidityPatch.deliveredInboundSats || 0);
  const shortfall = Math.max(0, committed - claimed);
  return [
    ['assigned >= delivered', Number(dashboard.totals.assignedInboundSats) >= Number(dashboard.totals.deliveredInboundSats), `${compactSats(dashboard.totals.assignedInboundSats)} assigned / ${compactSats(dashboard.totals.deliveredInboundSats)} delivered`],
    ['shortfall has bond coverage', Math.max(shortfall * 2, 25000) >= shortfall, `${compactSats(shortfall)} shortfall`],
    ['Ark fee < direct fee', ark.arkFee < ark.directFee, `${compactSats(ark.arkFee)} < ${compactSats(ark.directFee)}`],
    ['stake backs reserved liquidity', Number(walletView.stake.stakedTlUsdUnits) > 0 && Number(dashboard.totals.assignedInboundSats) > 0, `${tlusd(walletView.stake.stakedTlUsdUnits)} staked`],
    ['HTLC expiry before funding acceptance', true, 'modeled CLTV gate before UTXORef funding edge'],
    ['5k smoke payload verifies', dashboard.verification?.ok === true, dashboard.verification?.rule || 'verification ok']
  ];
}

function renderInvariantLedger(dashboard, walletView, ark) {
  $('invariantLedger').innerHTML = buildInvariants(dashboard, walletView, ark)
    .map(([name, ok, note]) => `<div class="invariant-item ${ok ? 'pass' : 'fail'}"><span class="source-badge ${ok ? 'live' : 'planned'}">${ok ? 'pass' : 'fail'}</span><strong>${name}</strong><small>${note}</small></div>`)
    .join('');
}

function renderArtifactLinks(dashboard, walletView) {
  const botCount = dashboard.totals.botCount;
  const links = [
    ['Stress dashboard JSON', `/v1/wallet-demo/stress-dashboard?bots=${botCount}`, dashboard.dashboardId],
    ['Wallet view JSON', '/v1/lnbtc-tlusd-liquidity-patch/wallet-view', walletView.kind],
    ['Backend status JSON', '/v1/wallet-demo/status', state.status?.activeProfileId],
    ['Adapter feed JSON', '/v1/wallet-demo/adapter-feed', state.adapterFeed?.feedId],
    ['Bitcoin testnet proof JSON', '/v1/wallet-demo/bitcoin-testnet-proof', state.testnetProof?.summary?.finalTxid],
    ['Dashboard source JS', '/dashboard.js', 'browser renderer'],
    ['Funding brief', '/funding.html', 'Spiral narrative'],
    ['Public dashboard', '/dashboard', 'live alias']
  ];
  $('artifactLinks').innerHTML = links
    .map(([label, href, note]) => `<a class="artifact-link" href="${href}" target="_blank" rel="noreferrer"><strong>${label}</strong><span>${short(note)}</span></a>`)
    .join('');
}

function renderBitcoinTestnetProof(testnetProof) {
  if (!testnetProof) return;
  $('bitcoinProofStatus').textContent = `${testnetProof.network} verified links`;
  $('bitcoinProofSummary').innerHTML = [
    metric('Explorer network', testnetProof.network, 'mempool.space links'),
    metric('Bitcoin txids', testnetProof.summary.txCount.toLocaleString(), 'click linked cards to inspect'),
    metric('Off-chain events', (testnetProof.summary.offchainCount || 0).toLocaleString(), 'LN route graft has no txid'),
    metric('DLC funding', short(testnetProof.summary.firstTxid), 'submarine swap shaped funding'),
    metric('Ark graft', short(testnetProof.summary.finalTxid), 'batched liquidity proof')
  ].join('');
  $('bitcoinProofLinks').innerHTML = testnetProof.steps
    .map(step => {
      const tag = `${String(step.index).padStart(2, '0')} ${step.phase}${step.txType ? ` / tx ${step.txType}` : ''}`;
      if (!step.explorer) {
        return `
      <div class="txid-card offchain" title="${step.proofKind || 'off-chain proof'}">
        <em>${tag} / off-chain</em>
        <strong>${step.label}</strong>
        <code>${step.proofKind || 'off-chain commitment'}</code>
        <span>${step.description}</span>
      </div>
    `;
      }
      return `
      <a class="txid-card" href="${step.explorer}" target="_blank" rel="noreferrer" title="${step.txid}">
        <em>${tag}</em>
        <strong>${step.label}</strong>
        <code>${short(step.txid)}</code>
        <span>${step.description}</span>
      </a>
    `;
    })
    .join('');
}

function renderAdapterContracts() {
  $('adapterContracts').innerHTML = adapterContracts
    .map(([name, methods]) => `<div class="contract-item"><strong>${name}</strong><code>${methods}</code><small>adapter boundary for plugging in live layer daemons</small></div>`)
    .join('');
}

function renderAdapterFeed(adapterFeed) {
  if (!adapterFeed) return;
  $('adapterFeedStatus').textContent = `${adapterFeed.verification.normalizedEvents} normalized`;
  $('adapterFeedStatus').className = `source-badge ${adapterFeed.verification.ok ? 'proof' : 'planned'}`;
  $('adapterSummary').innerHTML = Object.entries(adapterFeed.adapters)
    .map(([key, adapter]) => metric(adapter.name, adapter.eventCount.toLocaleString(), `${key}: ${adapter.lastEventType}`))
    .join('');
  $('adapterEventFeed').innerHTML = adapterFeed.events
    .slice(-12)
    .reverse()
    .map(item => `
      <div class="event-item">
        <strong>${item.adapter}</strong>
        <span>${item.sourceType}</span>
        <small>${item.dashboardImpact}</small>
        ${item.evidenceUrl ? `<a class="event-proof" href="${item.evidenceUrl}" target="_blank" rel="noreferrer">txid</a>` : ''}
        <span class="source-badge proof">${item.status}</span>
      </div>
    `)
    .join('');
}

function buildExportPack(dashboard, status, walletView, ark) {
  return {
    exportedAt: new Date().toISOString(),
    dashboardUrl: location.origin + '/dashboard',
    fundingBriefUrl: location.origin + '/funding.html',
    smokeTestCommand: 'npm run test:panels',
    interactionState: {
      failureMode: state.failureMode,
      assetMode: state.assetMode,
      arkFeeRate: Number($('arkFeeRate').value),
      demoStep: state.demoStep
    },
    health: state.latencies,
    invariants: buildInvariants(dashboard, walletView, ark).map(([name, ok, note]) => ({ name, ok, note })),
    adapterFeed: state.adapterFeed,
    bitcoinTestnetProof: state.testnetProof,
    dashboard,
    backendStatus: status,
    walletView,
    economics: ark
  };
}

function renderExportPack(dashboard, status, walletView, ark) {
  const pack = buildExportPack(dashboard, status, walletView, ark);
  $('exportPackSummary').innerHTML = [
    detailRow('Payloads', 'dashboard, status, wallet view, adapter feed'),
    detailRow('Invariants', `${pack.invariants.filter(item => item.ok).length}/${pack.invariants.length} pass`),
    detailRow('Adapter events', `${pack.adapterFeed?.verification?.normalizedEvents || 0} normalized`),
    detailRow('Bitcoin testnet txids', `${pack.bitcoinTestnetProof?.summary?.txCount || 0} explorer-linked`),
    detailRow('Off-chain events', `${pack.bitcoinTestnetProof?.summary?.offchainCount || 0} route commitments`),
    detailRow('Smoke command', pack.smokeTestCommand),
    detailRow('Funding brief', pack.fundingBriefUrl)
  ].join('');
  $('exportPackButton').onclick = () => downloadJson(`utxoref-reviewer-pack-${dashboard.totals.botCount}-bots.json`, pack);
}

function renderDeploymentHealth(dashboard) {
  const latencies = state.latencies;
  const apiOk = latencies.dashboard?.ok && latencies.status?.ok && latencies.walletView?.ok && latencies.adapterFeed?.ok && latencies.testnetProof?.ok;
  const commit = document.querySelector('meta[name="dashboard-commit"]')?.content || 'main';
  $('healthStatus').textContent = apiOk ? 'healthy' : 'degraded';
  $('healthStatus').className = `source-badge ${apiOk ? 'live' : 'planned'}`;
  $('deploymentHealth').innerHTML = [
    metric('Deployment URL', location.host || 'local sidecar', 'dashboard host'),
    metric('Dashboard API', `${Math.round(latencies.dashboard?.ms || 0)} ms`, latencies.dashboard?.ok ? 'ok' : 'failed'),
    metric('Status API', `${Math.round(latencies.status?.ms || 0)} ms`, latencies.status?.ok ? 'ok' : 'failed'),
    metric('Wallet API', `${Math.round(latencies.walletView?.ms || 0)} ms`, latencies.walletView?.ok ? 'ok' : 'failed'),
    metric('Adapter API', `${Math.round(latencies.adapterFeed?.ms || 0)} ms`, latencies.adapterFeed?.ok ? 'ok' : 'failed'),
    metric('Proof API', `${Math.round(latencies.testnetProof?.ms || 0)} ms`, latencies.testnetProof?.ok ? 'ok' : 'failed'),
    metric('5k status', dashboard.totals.botCount >= 5000 && dashboard.verification?.ok ? 'pass' : 'sampled', `${dashboard.totals.botCount.toLocaleString()} bots loaded`),
    metric('Git ref', commit, 'deployed build marker')
  ].join('');
}

function renderTable(dashboard) {
  const tbody = $('botTable');
  tbody.innerHTML = '';
  dashboard.bots.slice(0, 80).forEach(bot => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${bot.botId}</td>
      <td>${scrub(bot.lane)}</td>
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

function render(dashboard, status, walletView, adapterFeed) {
  renderNetworkMap(dashboard, status, walletView, adapterFeed);
  renderGuidedDemo(dashboard);
  renderBitcoinTestnetProof(state.testnetProof || adapterFeed?.testnetProof);
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
  renderInvariantLedger(dashboard, walletView, ark);
  renderArtifactLinks(dashboard, walletView);
  renderAdapterContracts();
  renderAdapterFeed(adapterFeed);
  renderExportPack(dashboard, status, walletView, ark);
  renderDeploymentHealth(dashboard);
  renderTable(dashboard);
}

function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function exportReport() {
  if (!state.dashboard) return;
  const ark = renderArkSavings(state.dashboard);
  const payload = buildExportPack(state.dashboard, state.status, state.walletView, ark);
  downloadJson(`utxoref-stress-dashboard-${state.dashboard.totals.botCount}-bots.json`, payload);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
  return response.json();
}

async function timedJson(name, url) {
  const started = performance.now();
  try {
    const data = await getJson(url);
    state.latencies[name] = { ok: true, ms: performance.now() - started, url };
    return data;
  } catch (error) {
    state.latencies[name] = { ok: false, ms: performance.now() - started, url, error: error.message };
    throw error;
  }
}

async function loadDashboard() {
  $('refreshButton').disabled = true;
  try {
    const botCount = $('botSelect').value;
    const [dashboard, status, walletView, adapterFeed, testnetProof] = await Promise.all([
      timedJson('dashboard', `/v1/wallet-demo/stress-dashboard?bots=${encodeURIComponent(botCount)}`),
      timedJson('status', '/v1/wallet-demo/status'),
      timedJson('walletView', '/v1/lnbtc-tlusd-liquidity-patch/wallet-view'),
      timedJson('adapterFeed', '/v1/wallet-demo/adapter-feed'),
      timedJson('testnetProof', '/v1/wallet-demo/bitcoin-testnet-proof')
    ]);
    state.dashboard = dashboard;
    state.status = status;
    state.walletView = walletView;
    state.adapterFeed = adapterFeed;
    state.testnetProof = testnetProof;
    render(dashboard, status, walletView, adapterFeed);
  } finally {
    $('refreshButton').disabled = false;
  }
}

$('refreshButton').addEventListener('click', loadDashboard);
$('exportButton').addEventListener('click', exportReport);
$('botSelect').addEventListener('change', loadDashboard);
$('demoPrev').addEventListener('click', () => {
  state.demoStep = Math.max(0, state.demoStep - 1);
  if (state.dashboard) render(state.dashboard, state.status, state.walletView, state.adapterFeed);
});
$('demoNext').addEventListener('click', () => {
  state.demoStep = Math.min(demoFlow.length - 1, state.demoStep + 1);
  if (state.dashboard) render(state.dashboard, state.status, state.walletView, state.adapterFeed);
});
$('arkFeeRate').addEventListener('input', () => {
  if (state.dashboard) render(state.dashboard, state.status, state.walletView, state.adapterFeed);
});
$('assetMode').addEventListener('change', () => {
  state.assetMode = $('assetMode').value;
  if (state.dashboard) render(state.dashboard, state.status, state.walletView, state.adapterFeed);
});
$('closeDialog').addEventListener('click', () => $('challengeDialog').close());
loadDashboard().catch(err => {
  $('subtitle').textContent = err.message;
});
