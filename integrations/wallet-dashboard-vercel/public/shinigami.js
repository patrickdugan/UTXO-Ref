const shinigamiState = {
  proof: null
};

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function short(value) {
  if (!value) return 'n/a';
  const text = String(value);
  return text.length > 18 ? `${text.slice(0, 18)}...` : text;
}

function sats(value) {
  return `${Number(value).toLocaleString()} sats`;
}

function metric(label, value, note = '') {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`;
}

function detailRow(label, value) {
  return `<div class="detail-row"><span>${escapeHtml(label)}</span><strong>${value ?? 'n/a'}</strong></div>`;
}

function codeRow(value) {
  return `<code>${escapeHtml(value)}</code>`;
}

function renderHero(proof) {
  const summary = proof.projection.summary;
  const statement = proof.projection.proofStatement;
  $('shinigamiSubtitle').textContent = proof.projection.headline;
  $('shinigamiSource').textContent = proof.source;
  $('shinigamiStatus').textContent = proof.verification.ok ? 'verified' : 'degraded';
  $('shinigamiStatus').className = `badge ${proof.verification.ok ? 'good' : 'warn'}`;
  $('shinigamiHero').innerHTML = [
    metric('Virtual CETs', summary.virtualCetCount.toLocaleString(), 'committed Ark leaves'),
    metric('Materialized CETs', summary.materializedCetCount.toLocaleString(), 'happy path broadcasts none'),
    metric('Selected outcome', summary.selectedOutcomeId, 'oracle-bound virtual leaf'),
    metric('Amount', sats(statement.amountSats), `${statement.exitDelayBlocks} block exit delay`)
  ].join('');
}

function renderFlow(projection) {
  const points = [
    [96, 118],
    [334, 118],
    [572, 118],
    [810, 118]
  ];
  const nodes = projection.flow.map((item, index) => {
    const [x, y] = points[index];
    return `
      <g class="shinigami-svg-node ${item.id}" transform="translate(${x} ${y})">
        <rect width="180" height="112" rx="8"></rect>
        <text x="16" y="30">${escapeHtml(item.label)}</text>
        <text x="16" y="58">${escapeHtml(short(item.commitment))}</text>
        <text x="16" y="84">${escapeHtml(item.id)}</text>
      </g>
    `;
  }).join('');
  const cards = projection.flow.map((item, index) => `
    <article class="shinigami-flow-card">
      <span>${index + 1}</span>
      <strong>${escapeHtml(item.label)}</strong>
      <small>${escapeHtml(item.detail)}</small>
      <code>${escapeHtml(short(item.commitment))}</code>
    </article>
  `).join('');

  $('shinigamiFlow').innerHTML = `
    <svg class="shinigami-svg" viewBox="0 0 1080 320" role="img" aria-label="Shinigami virtual CET proof flow">
      <defs>
        <marker id="shinigamiArrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L0,6 L8,3 z" fill="#334155"></path>
        </marker>
      </defs>
      <path class="shinigami-wire" d="M276 174 H334" marker-end="url(#shinigamiArrow)"></path>
      <path class="shinigami-wire" d="M514 174 H572" marker-end="url(#shinigamiArrow)"></path>
      <path class="shinigami-wire" d="M752 174 H810" marker-end="url(#shinigamiArrow)"></path>
      <path class="shinigami-wire secondary" d="M186 230 C300 284 650 284 900 230"></path>
      ${nodes}
      <text class="shinigami-caption" x="540" y="292">BitVM challenge can unpack any bad claim without publishing the CET fanout</text>
    </svg>
    <div class="shinigami-flow-cards">${cards}</div>
  `;
}

function renderProofStatement(projection) {
  const statement = projection.proofStatement;
  $('shinigamiProofStatement').innerHTML = [
    detailRow('Contract', `<code>${escapeHtml(statement.contractId)}</code>`),
    detailRow('Oracle event', `<code>${escapeHtml(statement.oracleEventId)}</code>`),
    detailRow('Ark round', `<code>${escapeHtml(statement.arkRoundId)}</code>`),
    detailRow('Oracle outcome hash', `<code>${escapeHtml(short(statement.oracleOutcomeHash))}</code>`),
    detailRow('Selected leaf', `<code>${escapeHtml(short(statement.selectedLeafHash))}</code>`),
    detailRow('Ark leaf root', `<code>${escapeHtml(short(statement.arkLeafRoot))}</code>`),
    detailRow('Payout root', `<code>${escapeHtml(short(statement.payoutRoot))}</code>`),
    detailRow('Claim id', `<code>${escapeHtml(short(statement.claimId))}</code>`),
    detailRow('Receipt id', `<code>${escapeHtml(short(statement.receiptId))}</code>`)
  ].join('');
}

function renderCompression(projection) {
  const c = projection.compression;
  $('shinigamiCompression').innerHTML = [
    metric('Virtual CET set', c.virtualCetCount.toLocaleString(), 'DLC outcomes committed'),
    metric('Ark leaves', c.arkLeafCount.toLocaleString(), 'VTXO leaf layer'),
    metric('On-chain CET txids', c.onchainCetTxidsPublished.toLocaleString(), 'none in happy path'),
    metric('Avoided fanout', c.avoidedOnchainCetTxids.toLocaleString(), 'kept virtual'),
    metric('Selected outcome', c.selectedOutcomeId, 'single leaf proved'),
    metric('Receipt', c.proofReceiptStatus, 'deterministic scaffold')
  ].join('');
}

function renderFraudMatrix(projection) {
  $('shinigamiFraudMatrix').innerHTML = projection.fraudMatrix.map(item => `
    <article class="fraud-card">
      <div class="fraud-card-head">
        <strong>${escapeHtml(item.label)}</strong>
        <span class="source-badge ${item.slashable ? 'proof' : 'planned'}">${item.slashable ? 'slashable' : 'watch'}</span>
      </div>
      <code>${escapeHtml(item.challengeViolation)}</code>
      <small>${escapeHtml(item.witnessCounterexample)}</small>
      <p>${escapeHtml(item.bitvmRemedy)}</p>
    </article>
  `).join('');
}

function renderInputs(projection) {
  $('shinigamiInputs').innerHTML = projection.publicInputs.map(codeRow).join('');
  $('shinigamiCaveats').innerHTML = projection.caveats.map(item => `<div class="readout-item"><span>${escapeHtml(item)}</span></div>`).join('');
}

function render(proof) {
  shinigamiState.proof = proof;
  renderHero(proof);
  renderFlow(proof.projection);
  renderProofStatement(proof.projection);
  renderCompression(proof.projection);
  renderFraudMatrix(proof.projection);
  renderInputs(proof.projection);
}

async function loadShinigami() {
  $('shinigamiRefresh').disabled = true;
  try {
    const response = await fetch('/api/shinigami-proof');
    if (!response.ok) throw new Error(`/api/shinigami-proof failed: ${response.status}`);
    render(await response.json());
  } finally {
    $('shinigamiRefresh').disabled = false;
  }
}

$('shinigamiRefresh').addEventListener('click', loadShinigami);
loadShinigami().catch(err => {
  $('shinigamiSubtitle').textContent = err.message;
  $('shinigamiStatus').textContent = 'error';
  $('shinigamiStatus').className = 'badge warn';
});
