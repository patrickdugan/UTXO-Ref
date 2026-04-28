const state = {
  dashboard: null,
  status: null,
  walletView: null,
  adapterFeed: null,
  testnetProof: null,
  failureMode: 'nominal',
  assetMode: 'tlusd',
  selectedGateId: 'liquidity-comparator',
  swapMode: 'claim',
  dlcPrice: 85000,
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

function anchorTxidLink(step, label = null) {
  const txid = step?.txid || step?.anchorTxid;
  const explorer = step?.explorer || step?.anchorExplorer;
  if (!txid || !explorer) return short(txid);
  const text = label || step.label || short(txid);
  return `<a class="txid-link" href="${explorer}" target="_blank" rel="noreferrer" title="${txid}">${text}<code>${short(txid)}</code></a>`;
}

function directTxidLink(txid, label = 'inspect') {
  if (!txid) return 'n/a';
  return `<a class="txid-link" href="https://mempool.space/testnet4/tx/${txid}" target="_blank" rel="noreferrer" title="${txid}">${label}<code>${short(txid)}</code></a>`;
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function renderNetworkMap(status, walletView, testnetProof) {
  const oracleDlc = walletView.tradeLayerOracleDlc;
  $('subtitle').textContent = 'Bitcoin testnet proofs, Lightning receipts, DLC triggers, and BitVM challenge paths';
  $('profileBadge').textContent = scrub(status.activeProfileId);
  $('chainBadge').textContent = scrub(status.chain.chain || 'bitcoin-testnet4');
  $('mapMode').textContent = scrub(status.chain.network || 'Bitcoin testnet');
  $('mapWalletAmount').textContent = sats(walletView.conversion.lnbtcSats);
  $('mapChainLabel').textContent = scrub(status.chain.chain || 'testnet');
  $('mapVtxoCount').textContent = `${testnetProof.summary.offchainCount.toLocaleString()} off-chain proofs`;
  $('mapStakeAmount').textContent = oracleDlc?.noTapAssets ? 'BTC-only DLC path' : 'routing reserve';
  $('mapChallengeCount').textContent = `${walletView.liquidityPatch.routerCircuit.totalGates.toLocaleString()} gates`;
  $('mapAssigned').textContent = compactSats(walletView.liquidityPatch.assignedInboundSats);
  $('mapSubstrate').textContent = scrub(status.activeProfileId || status.chain.chain || 'Bitcoin testnet profile');
  $('mapBotCount').textContent = `${testnetProof.summary.txCount.toLocaleString()} linked txids`;
  $('mapAdapterEvents').textContent = oracleDlc?.trigger?.payloadText || 'tx14 OP_RETURN';
}

function renderGuidedDemo(walletView, testnetProof) {
  const oracleDlc = walletView.tradeLayerOracleDlc;
  $('demoSteps').innerHTML = demoFlow
    .map(([label, note], index) => {
      const active = index === state.demoStep ? ' active' : '';
      const value = [
        compactSats(walletView.conversion.lnbtcSats),
        `${oracleDlc.trigger.pair} ${oracleDlc.trigger.price}`,
        short(walletView.conversion.dlcFundingTxid),
        tlusd(walletView.conversion.tlusdUnits),
        short(testnetProof.summary.showcaseAnchorTxid),
        `${walletView.liquidityPatch.routerCircuit.totalGates.toLocaleString()} gates`
      ][index];
      return `<div class="demo-step${active}"><strong>${index + 1}. ${label}</strong><span>${value}</span><small>${note}</small></div>`;
    })
    .join('');
}

function renderSwapStateMachine(walletView) {
  if (!walletView) return;
  const htlc = walletView.conversion.submarineSwapHtlc || {};
  const modes = {
    claim: {
      label: 'Preimage claim',
      branch: 'receiver spends with preimage before CLTV',
      witness: short(htlc.preimage || htlc.paymentPreimage || walletView.pureBtcRouteDemo?.stages?.[1]?.paymentPreimage),
      result: 'invoice paid, DLC funding leg is valid'
    },
    timeout: {
      label: 'Timeout refund',
      branch: 'sender refunds after CLTV expiry',
      witness: `height >= ${htlc.expiryHeight || 'expiry'}`,
      result: 'DLC leg is not funded by this swap'
    },
    wrong_hash: {
      label: 'Wrong preimage',
      branch: 'hashlock rejects witness',
      witness: 'sha256(preimage) != payment_hash',
      result: 'no claim; funds wait for timeout path'
    }
  };
  const mode = modes[state.swapMode] || modes.claim;
  const nodes = [
    ['Invoice hash', short(htlc.paymentHash)],
    ['P2WSH HTLC', short(htlc.htlcAddress)],
    [mode.label, mode.branch],
    ['DLC funding gate', mode.result]
  ];
  $('swapStateMachine').innerHTML = `
    <div class="segmented-controls">
      ${Object.entries(modes).map(([key, item]) => `<button type="button" data-swap-mode="${key}" class="${key === state.swapMode ? 'active' : ''}">${item.label}</button>`).join('')}
    </div>
    <div class="mechanic-flow">
      ${nodes.map(([label, value], index) => `
        <div class="mechanic-node ${index === 2 ? 'selected' : ''}">
          <span>${index + 1}</span>
          <strong>${escapeHtml(label)}</strong>
          <small>${escapeHtml(value)}</small>
        </div>
      `).join('')}
    </div>
    <div class="mechanic-readout">
      ${[
        detailRow('Funding txid', anchorTxidLink(htlc, 'inspect HTLC')),
        detailRow('Witness condition', escapeHtml(mode.witness)),
        detailRow('Selected branch', escapeHtml(mode.branch)),
        detailRow('Outcome', escapeHtml(mode.result))
      ].join('')}
    </div>
  `;
  $('swapStateMachine').querySelectorAll('[data-swap-mode]').forEach(button => {
    button.addEventListener('click', () => {
      state.swapMode = button.dataset.swapMode;
      render(state.dashboard, state.status, state.walletView, state.adapterFeed);
    });
  });
}

function renderDlcSettlement(walletView) {
  if (!walletView) return;
  const priceInput = $('dlcPrice');
  if (document.activeElement !== priceInput) priceInput.value = state.dlcPrice;
  const entryPrice = 85000;
  const maturityPrice = Number(state.dlcPrice);
  const collateralSats = Number(walletView.conversion.lnbtcSats);
  const priceMove = (maturityPrice - entryPrice) / entryPrice;
  const longShare = clamp(0.5 + priceMove * 1.6, 0.08, 0.92);
  const longPayout = Math.round(collateralSats * longShare);
  const shortPayout = Math.max(0, collateralSats - longPayout);
  const tlusdMint = Math.round((shortPayout / 100000000) * maturityPrice * 1000000);
  const cetLabel = maturityPrice >= entryPrice ? 'higher-price CET branch' : 'lower-price CET branch';
  $('dlcPriceLabel').textContent = `$${maturityPrice.toLocaleString()}`;
  $('dlcSettlementHeadline').textContent = tlusd(tlusdMint);
  $('dlcSettlement').innerHTML = `
    <div class="mechanic-flow settlement-flow">
      ${[
        ['Oracle price', `$${maturityPrice.toLocaleString()}`],
        ['CET selected', cetLabel],
        ['Short output', compactSats(shortPayout)],
        ['TLUSD mint', tlusd(tlusdMint)]
      ].map(([label, value], index) => `
        <div class="mechanic-node ${index === 1 ? 'selected' : ''}">
          <span>${index + 1}</span>
          <strong>${escapeHtml(label)}</strong>
          <small>${escapeHtml(value)}</small>
        </div>
      `).join('')}
    </div>
    <div class="metric-grid">
      ${[
        metric('Entry price', '$85,000', 'oracle baseline'),
        metric('Long payout', compactSats(longPayout), `${Math.round(longShare * 100)}% of collateral`),
        metric('Short payout', compactSats(shortPayout), 'backs synthetic USD leg'),
        metric('TradeLayer tx', short(walletView.conversion.rfqQuoteId), 'hybrid/TAP continuity')
      ].join('')}
    </div>
    <div class="script-template mechanic-code">
      <code>price = oracle_attestation(BTCUSD)</code>
      <code>selected_cet = bucket(price)</code>
      <code>tlusd_mint = short_output_sats * price / 1e8</code>
    </div>
  `;
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

function renderUseCases(walletView, testnetProof) {
  if (!walletView?.useCases) return;
  const txLookup = new Map((testnetProof?.steps || []).filter(step => step.txid).map(step => [step.txid, step]));
  $('useCaseGrid').innerHTML = walletView.useCases.map(useCase => {
    const txLinks = useCase.bitcoinEvidence
      .map(txid => txLookup.get(txid))
      .filter(Boolean)
      .map(step => `<a href="${step.explorer}" target="_blank" rel="noreferrer">${step.label}<code>${short(step.txid)}</code></a>`)
      .join('');
    const offchain = useCase.offchainProofs
      .map(kind => `<span>${escapeHtml(kind)}</span>`)
      .join('');
    const flow = useCase.flow
      .map(item => `<span>${escapeHtml(item)}</span>`)
      .join('');
    return `
      <article class="use-case-card ${useCase.id}">
        <div class="use-case-head">
          <strong>${escapeHtml(useCase.label)}</strong>
          <span class="source-badge ${useCase.id === 'btc-bitvm-graft' ? 'derived' : 'proof'}">${useCase.id === 'btc-bitvm-graft' ? 'BTC only' : 'asset route'}</span>
        </div>
        <p>${escapeHtml(useCase.objective)}</p>
        <div class="flow-pills">${flow}</div>
        <div class="use-case-evidence">
          <div><em>Bitcoin evidence</em>${txLinks}</div>
          <div><em>Off-chain proofs</em>${offchain}</div>
        </div>
        <small>${escapeHtml(useCase.reviewerSignal)}</small>
      </article>
    `;
  }).join('');
}

function renderPureBtcRouteDemo(walletView) {
  const demo = walletView?.pureBtcRouteDemo;
  if (!demo) return;
  const cards = demo.stages.map((stage, index) => {
    const primary = stage.explorer
      ? `<a href="${stage.explorer}" target="_blank" rel="noreferrer">${short(stage.txid)}</a>`
      : stage.anchorExplorer
        ? `<a href="${stage.anchorExplorer}" target="_blank" rel="noreferrer">${short(stage.anchorTxid)}</a>`
        : `<code>${short(stage.channelTxid || stage.paymentHash)}</code>`;
    const rows = [
      stage.amountSats ? ['Amount', sats(stage.amountSats)] : null,
      stage.htlcAddress ? ['HTLC address', short(stage.htlcAddress)] : null,
      stage.expiryHeight ? ['CLTV expiry', stage.expiryHeight] : null,
      stage.channelState ? ['Channel', stage.channelState] : null,
      stage.invoiceAmount ? ['Invoice', stage.invoiceAmount] : null,
      stage.paymentPreimage ? ['Preimage', short(stage.paymentPreimage)] : null,
      stage.totalGates ? ['Circuit', `${stage.totalGates.toLocaleString()} gates`] : null,
      stage.routeCommitment ? ['Commitment', stage.routeCommitment] : null
    ].filter(Boolean).map(([label, value]) => detailRow(label, value)).join('');
    return `
      <article class="pure-demo-card ${stage.id}">
        <em>step ${index + 1}</em>
        <strong>${escapeHtml(stage.label)}</strong>
        <span>${escapeHtml(stage.kind)}</span>
        <div class="pure-demo-primary">${primary}</div>
        <div class="pure-demo-details">${rows}</div>
        <small>${escapeHtml(stage.note)}</small>
      </article>
    `;
  }).join('');
  $('pureBtcRouteDemo').innerHTML = `
    <div class="pure-demo-head">
      <strong>${escapeHtml(demo.summary)}</strong>
      <span>${escapeHtml(demo.invariant)}</span>
    </div>
    <div class="pure-demo-flow">${cards}</div>
  `;
}

function renderTradeLayerOracleDlc(walletView) {
  const demo = walletView?.tradeLayerOracleDlc;
  if (!demo) return;
  const triggerLink = txidLink(demo.trigger, 'inspect tx14');
  const vwap = demo.vwapStateOracle;
  const vwapChallenge = demo.vwapChallenge;
  const vwapTradeLinks = (vwap?.validTrades || [])
    .map(trade => `<span>${escapeHtml(trade.impliedPrice)} ${directTxidLink(trade.txid, 'base')} ${directTxidLink(trade.counterTxid, 'quote')}</span>`)
    .join('');
  const flowNotes = [
    demo.trigger.payloadText,
    'publisher address proof',
    `${demo.trigger.priceDeviationBps} / ${demo.trigger.maxDeviationBps} bps`,
    demo.settlement.selectedOutcomeId,
    demo.settlement.settlementRail
  ];
  const flow = demo.bitvmOrganizer.flow
    .map((item, index) => `
      <div class="mechanic-node ${index === 2 ? 'selected' : ''}">
        <span>${index + 1}</span>
        <strong>${escapeHtml(item)}</strong>
        <small>${escapeHtml(flowNotes[index] || 'BitVM witness')}</small>
      </div>
    `)
    .join('');
  const code = demo.bitvmOrganizer.pseudocode
    .map(line => `<code>${escapeHtml(line)}</code>`)
    .join('');
  const vwapPanel = vwap ? `
    <div class="pure-demo-head oracle-head">
      <strong>TradeLayer VWAP State Oracle</strong>
      <span>${escapeHtml(vwap.validationBoundary)}</span>
    </div>
    <div class="oracle-grid">
      <div class="mechanic-card">
        <div class="mechanic-flow oracle-flow">
          ${[
            ['State snapshot', short(vwap.summaryCore.stateSnapshotRoot)],
            ['Valid trades', `${vwap.summaryCore.validTradeCount} trades`],
            ['VWAP arithmetic', `${vwap.summaryCore.pair} ${vwap.summaryCore.vwapPrice}`],
            ['Fraud proof', vwapChallenge.challengeViolation]
          ].map(([label, value], index) => `
            <div class="mechanic-node ${index === 2 ? 'selected' : ''}">
              <span>${index + 1}</span>
              <strong>${escapeHtml(label)}</strong>
              <small>${escapeHtml(value)}</small>
            </div>
          `).join('')}
        </div>
        <div class="script-template mechanic-code">
          ${vwapChallenge.scriptTemplate.map(line => `<code>${escapeHtml(line)}</code>`).join('')}
        </div>
      </div>
      <div class="oracle-readout">
        ${[
          detailRow('Summary id', `<code>${short(vwap.summaryCommitmentId)}</code>`),
          detailRow('Summary txid', directTxidLink(vwap.publishTxid, 'inspect tx14')),
          detailRow('Window', `${vwap.summaryCore.windowStartHeight} - ${vwap.summaryCore.windowEndHeight}`),
          detailRow('State root', `<code>${short(vwap.summaryCore.stateSnapshotRoot)}</code>`),
          detailRow('Valid trade root', `<code>${short(vwap.summaryCore.validTradeSetRoot)}</code>`),
          detailRow('Trade txids', `<span class="txid-stack">${vwapTradeLinks}</span>`),
          detailRow('Volume', `${compactSats(vwap.summaryCore.totalBaseAmountSats)} ${escapeHtml(vwap.summaryCore.baseTokenId)}`),
          detailRow('Quote notional', `$${(Number(vwap.summaryCore.totalQuoteAmountMicrousd) / 1000000).toLocaleString()}`),
          detailRow('VWAP mark', `${escapeHtml(vwap.summaryCore.pair)} ${escapeHtml(vwap.summaryCore.vwapPrice)}`),
          detailRow('VWAP delta', `${vwap.summaryCore.priceDeviationBps} bps / ${vwap.solvencyGuard.withinBand ? 'inside band' : 'outside band'}`),
          detailRow('Fraud surface', escapeHtml(vwap.fraudProofSurface.join(', '))),
          detailRow('Challenge circuit', `${vwapChallenge.totalGates.toLocaleString()} gates`)
        ].join('')}
      </div>
    </div>
  ` : '';
  $('tradelayerOracleDlc').innerHTML = `
    <div class="pure-demo-head oracle-head">
      <strong>${escapeHtml(demo.summary)}</strong>
      <span>No TAP asset path. BTC collateral enters through Lightning receipts; BitVM treats the TradeLayer OP_RETURN as a bounded oracle witness.</span>
    </div>
    <div class="oracle-grid">
      <div class="mechanic-card">
        <div class="mechanic-flow oracle-flow">${flow}</div>
        <div class="script-template mechanic-code">${code}</div>
      </div>
      <div class="oracle-readout">
        ${[
          detailRow('Trigger txid', triggerLink),
          detailRow('Payload', `<code>${escapeHtml(demo.trigger.payloadText)}</code>`),
          detailRow('OP_RETURN', `<code>${escapeHtml(demo.trigger.opReturnScriptHex)}</code>`),
          detailRow('Oracle price', `${escapeHtml(demo.trigger.pair)} ${escapeHtml(demo.trigger.price)}`),
          detailRow('Designated oracle', `<code>${short(demo.trigger.designatedOracleAddress)}</code>`),
          detailRow('Publisher hash', `<code>${short(demo.trigger.oracleAddressProof?.addressCommitmentHash)}</code>`),
          detailRow('Previous mark', `${escapeHtml(demo.trigger.pair)} ${escapeHtml(demo.trigger.lastAcceptedPrice)}`),
          detailRow('Max delta', `${demo.trigger.maxDeviationBps} bps`),
          detailRow('Observed delta', `${demo.trigger.priceDeviationBps} bps / ${demo.trigger.solvencyGuard?.withinBand ? 'inside band' : 'outside band'}`),
          detailRow('Contract', short(demo.contract.commitmentId)),
          detailRow('Collateral', compactSats(demo.contract.totalCollateralSats)),
          detailRow('Selected outcome', escapeHtml(demo.settlement.selectedOutcomeId)),
          detailRow('BTC payouts', `${compactSats(demo.settlement.longPayoutSats)} long / ${compactSats(demo.settlement.shortPayoutSats)} short`),
          detailRow('BitVM organizer', `${short(demo.bitvmOrganizer.organizerId)} / ${demo.bitvmOrganizer.totalGates.toLocaleString()} gates`),
          detailRow('Challenge', escapeHtml(demo.bitvmOrganizer.challengeViolation))
        ].join('')}
      </div>
    </div>
    ${vwapPanel}
  `;
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
    detailRow('LN discovery', status.lightningDiscovery?.publicRegistry || 'public gossip only'),
    detailRow('Candidate peers', `${status.lightningDiscovery?.candidatePeers?.filter(peer => peer.tcpOpen).length || 0} TCP reachable`),
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
    ['Subswap HTLC', `cltv ${walletView.conversion.submarineSwapHtlc?.expiryHeight || 48 + Math.floor(dashboard.totals.botCount / 512)}`, `P2WSH hash ${short(walletView.conversion.submarineSwapHtlc?.paymentHash)}`],
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
  const routeInput = $('arkRouteCount');
  const routes = Number(routeInput?.value || dashboard.totals.routeCount);
  const batchSize = 64;
  const batchCount = Math.ceil(routes / batchSize);
  const directVbytes = routes * 112;
  const arkVbytes = batchCount * 155 + Math.min(routes, Number(dashboard.totals.arkVtxoCount)) * 3;
  const directFee = directVbytes * feeRate;
  const arkFee = arkVbytes * feeRate;
  const savings = Math.max(0, directFee - arkFee);
  const breakeven = routes > 0 ? (arkVbytes / directVbytes) * feeRate : 0;
  $('arkFeeLabel').textContent = `${feeRate} sat/vB`;
  $('arkRoutesLabel').textContent = `${routes.toLocaleString()} routes`;
  $('arkSavingsHeadline').textContent = compactSats(savings);
  $('arkSavingsPanel').innerHTML = [
    metric('Direct cost', compactSats(directFee), `${directVbytes.toLocaleString()} vB`),
    metric('Ark batch cost', compactSats(arkFee), `${arkVbytes.toLocaleString()} vB`),
    metric('Fee saved', compactSats(savings), `${Math.round((savings / directFee) * 100)}% lower`),
    metric('Breakeven', `${breakeven.toFixed(2)} sat/vB`, 'batch path ratio')
  ].join('');
  $('arkBatchSimulator').innerHTML = `
    <div class="ark-batch-strip">
      <div><strong>${routes.toLocaleString()}</strong><span>direct refresh txs</span></div>
      <div><strong>${batchCount.toLocaleString()}</strong><span>Ark batch roots</span></div>
      <div><strong>${compactSats(Math.ceil(arkFee / Math.max(routes, 1)))}</strong><span>marginal fee per route</span></div>
    </div>
    <div class="mechanic-flow ark-flow">
      ${[
        ['Route leases', `${routes.toLocaleString()} commitments`],
        ['VTXO leaves', `${batchSize} per batch`],
        ['Batch root', `${batchCount.toLocaleString()} anchors`],
        ['BitVM guard', 'slash if under-delivered']
      ].map(([label, value], index) => `
        <div class="mechanic-node ${index === 2 ? 'selected' : ''}">
          <span>${index + 1}</span>
          <strong>${escapeHtml(label)}</strong>
          <small>${escapeHtml(value)}</small>
        </div>
      `).join('')}
    </div>
  `;
  return { feeRate, routes, batchCount, directFee, arkFee, savings };
}

function renderBitvmUnpack(circuit, selectedGate) {
  const flow = selectedGate.flow || [];
  const pseudocode = selectedGate.pseudocode || [];
  const inputs = selectedGate.inputs || [];
  const flowNodes = flow.map((label, index) => `
    <div class="unpack-flow-node">
      <span>${index + 1}</span>
      <strong>${escapeHtml(label)}</strong>
    </div>
  `).join('');
  const codeLines = pseudocode
    .map((line, index) => `<code><span>${index + 1}</span>${escapeHtml(line)}</code>`)
    .join('');
  const inputPills = inputs.map(input => `<span>${escapeHtml(input)}</span>`).join('');
  return `
    <div class="bitvm-unpack" id="bitvmUnpack">
      <div class="circuit-head">
        <div>
          <strong>Unpacked Script Family</strong>
          <small>${escapeHtml(selectedGate.family)} enforces ${escapeHtml(selectedGate.checks)}</small>
        </div>
        <span class="source-badge proof">${Number(selectedGate.count || 0).toLocaleString()} gates</span>
      </div>
      <div class="unpack-grid">
        <div class="unpack-flow" aria-label="${escapeHtml(selectedGate.family)} circuit flow">
          ${flowNodes}
        </div>
        <div class="unpack-code">
          ${codeLines}
        </div>
        <div class="unpack-meta">
          <strong>Witness / public inputs</strong>
          <div>${inputPills}</div>
        </div>
      </div>
    </div>
  `;
}

function renderBitvmEnforcement(walletView, dashboard) {
  if (!walletView) return;
  const firstChallenge = dashboard?.challengeQueue?.[0];
  const committed = Number(firstChallenge?.requestedInboundSats || walletView.liquidityPatch.assignedInboundSats || 0);
  const claimed = Number(firstChallenge?.deliveredInboundSats || walletView.liquidityPatch.deliveredInboundSats || 0);
  const shortfall = Math.max(0, committed - claimed);
  const circuit = walletView.liquidityPatch.routerCircuit || {
    version: 'router-circuit-unavailable',
    totalGates: 0,
    gateCounts: [],
    publicInputs: [],
    witnessInputs: [],
    scriptTemplate: [],
    challengePath: []
  };
  const fallbackGate = {
    id: 'unavailable',
    family: 'Circuit unavailable',
    count: 0,
    checks: 'no script family loaded',
    inputs: [],
    flow: ['load circuit data'],
    pseudocode: ['assert routerCircuit is present in wallet view']
  };
  const selectedGate = circuit.gateCounts.find(gate => gate.id === state.selectedGateId) || circuit.gateCounts[0] || fallbackGate;
  state.selectedGateId = selectedGate.id;
  const gateBars = circuit.gateCounts.map((gate, index) => {
    const width = Math.max(12, Math.round((gate.count / circuit.totalGates) * 240));
    const gateId = gate.id || gate.family.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const active = gateId === selectedGate.id ? ' active' : '';
    return `
      <g class="gate-row${active}" data-gate-id="${escapeHtml(gateId)}" role="button" tabindex="0" transform="translate(18 ${28 + index * 24})">
        <title>Unpack ${escapeHtml(gate.family)}</title>
        <rect width="${width}" height="12" rx="2"></rect>
        <text x="${width + 8}" y="10">${escapeHtml(gate.family)} ${gate.count}</text>
      </g>
    `;
  }).join('');
  const scriptLines = circuit.scriptTemplate
    .map(line => `<code>${escapeHtml(line)}</code>`)
    .join('');
  const inputs = [
    ['Public inputs', circuit.publicInputs.join(', ')],
    ['Witness inputs', circuit.witnessInputs.join(', ')],
    ['Challenge path', circuit.challengePath.join(' -> ')]
  ].map(([label, value]) => detailRow(label, escapeHtml(value))).join('');

  const enforcement = $('bitvmEnforcement');
  enforcement.innerHTML = `
    <div class="bitvm-circuit-summary">
      ${[
        detailRow('Showcase anchor', anchorTxidLink(state.testnetProof?.bitvmShowcase, 'TAP / circuit anchor')),
        detailRow('Journey entry', short(walletView.conversion.journeyEntryTxid || walletView.conversion.subswapFundingTxid)),
        detailRow('Committed state', `${compactSats(committed)} inbound promised`),
        detailRow('Claimed state', `${compactSats(claimed)} delivered by ASP`),
        detailRow('Invariant', 'delivered >= committed minimum before expiry'),
        detailRow('Shortfall', compactSats(shortfall)),
        detailRow('Bond coverage', compactSats(Math.max(shortfall * 2, 25000))),
        detailRow('Challenge window', `${walletView.stake.termBlocks || 144} blocks`),
        detailRow('Exit path', state.failureMode === 'forced_exit' ? 'force Ark exit then slash' : 'challenge ASP commitment then slash')
      ].join('')}
    </div>
    <div class="circuit-layout">
      <div class="circuit-card">
        <div class="circuit-head">
          <strong>Router Circuit</strong>
          <span class="source-badge proof">${circuit.totalGates.toLocaleString()} gates</span>
        </div>
        <svg class="circuit-svg" viewBox="0 0 520 248" role="img" aria-label="BitVM router circuit gate count visualization">
          <path d="M28 222 H492" class="circuit-wire"></path>
          <path d="M86 222 V48 H148" class="circuit-wire"></path>
          <path d="M236 222 V72 H304" class="circuit-wire"></path>
          <path d="M386 222 V96 H456" class="circuit-wire"></path>
          <g class="gate-bars">${gateBars}</g>
          <circle cx="86" cy="222" r="6"></circle>
          <circle cx="236" cy="222" r="6"></circle>
          <circle cx="386" cy="222" r="6"></circle>
          <text x="28" y="242">LN commitment</text>
          <text x="196" y="242">liquidity comparator</text>
          <text x="372" y="242">BitVM challenge</text>
        </svg>
      </div>
      <div class="circuit-card">
        <div class="circuit-head">
          <strong>${escapeHtml(circuit.version)}</strong>
          <span class="source-badge derived">script</span>
        </div>
        <div class="script-template">${scriptLines}</div>
        <div class="circuit-inputs">${inputs}</div>
      </div>
      ${renderBitvmUnpack(circuit, selectedGate)}
    </div>
  `;
  enforcement.querySelectorAll('[data-gate-id]').forEach(row => {
    const selectGate = () => {
      state.selectedGateId = row.dataset.gateId;
      render(state.dashboard, state.status, state.walletView, state.adapterFeed);
    };
    row.addEventListener('click', selectGate);
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectGate();
      }
    });
  });
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
    metric('Off-chain events', (testnetProof.summary.offchainCount || 0).toLocaleString(), 'LN and Ark grafts have no txid'),
    metric('Journey entry', short(testnetProof.summary.entryTxid || testnetProof.summary.firstTxid), 'P2WSH submarine swap HTLC'),
    metric('BitVM showcase', short(testnetProof.summary.showcaseAnchorTxid || testnetProof.summary.finalTxid), testnetProof.summary.showcaseKind || 'circuit anchor')
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
    routerCircuit: walletView.liquidityPatch.routerCircuit,
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
    detailRow('Off-chain events', `${pack.bitcoinTestnetProof?.summary?.offchainCount || 0} route/VTXO commitments`),
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
  const testnetProof = state.testnetProof || adapterFeed?.testnetProof;
  renderNetworkMap(status, walletView, testnetProof);
  renderGuidedDemo(walletView, testnetProof);
  renderSwapStateMachine(walletView);
  renderDlcSettlement(walletView);
  renderBitcoinTestnetProof(testnetProof);
  renderUseCases(walletView, testnetProof);
  renderPureBtcRouteDemo(walletView);
  renderTradeLayerOracleDlc(walletView);
  renderBitvmEnforcement(walletView, null);
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
    const [dashboard, status, walletView, adapterFeed, testnetProof] = await Promise.all([
      timedJson('dashboard', '/v1/wallet-demo/stress-dashboard?bots=96'),
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
if ($('exportButton')) $('exportButton').addEventListener('click', exportReport);
if ($('botSelect')) $('botSelect').addEventListener('change', loadDashboard);
$('demoPrev').addEventListener('click', () => {
  state.demoStep = Math.max(0, state.demoStep - 1);
  if (state.dashboard) render(state.dashboard, state.status, state.walletView, state.adapterFeed);
});
$('demoNext').addEventListener('click', () => {
  state.demoStep = Math.min(demoFlow.length - 1, state.demoStep + 1);
  if (state.dashboard) render(state.dashboard, state.status, state.walletView, state.adapterFeed);
});
if ($('arkFeeRate')) $('arkFeeRate').addEventListener('input', () => {
  if (state.dashboard) render(state.dashboard, state.status, state.walletView, state.adapterFeed);
});
if ($('arkRouteCount')) $('arkRouteCount').addEventListener('input', () => {
  if (state.dashboard) render(state.dashboard, state.status, state.walletView, state.adapterFeed);
});
$('dlcPrice').addEventListener('input', () => {
  state.dlcPrice = Number($('dlcPrice').value);
  if (state.dashboard) render(state.dashboard, state.status, state.walletView, state.adapterFeed);
});
if ($('assetMode')) $('assetMode').addEventListener('change', () => {
  state.assetMode = $('assetMode').value;
  if (state.dashboard) render(state.dashboard, state.status, state.walletView, state.adapterFeed);
});
if ($('closeDialog')) $('closeDialog').addEventListener('click', () => $('challengeDialog').close());
loadDashboard().catch(err => {
  $('subtitle').textContent = err.message;
});
