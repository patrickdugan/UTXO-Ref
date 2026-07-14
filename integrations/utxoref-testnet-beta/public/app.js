const elements = Object.fromEntries([
  'ready-badge', 'refresh-button', 'checked-at', 'block-height', 'chain-lag',
  'graph-verification', 'assertion-state', 'faucet-available', 'daily-remaining',
  'assertion-link', 'graph-hash', 'invite-token', 'claim-amount', 'faucet-form',
  'faucet-address', 'claim-button', 'claim-receipt', 'stress-form',
  'stress-iterations', 'stress-output', 'stress-button', 'stress-receipt',
  'stress-limit', 'receipt-rows', 'clear-receipts', 'toast'
].map((id) => [id, document.getElementById(id)]));

const RECEIPT_KEY = 'utxoref-beta-receipts-v1';
let statusSnapshot = null;

function shortHash(value) {
  const text = String(value || '');
  return text.length > 20 ? `${text.slice(0, 10)}...${text.slice(-8)}` : text;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function formatSats(value) {
  return `${Number(value || 0).toLocaleString()} sats`;
}

function setValue(id, text, good = null) {
  const element = elements[id];
  element.textContent = text;
  element.classList.toggle('value-good', good === true);
  element.classList.toggle('value-bad', good === false);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { elements.toast.hidden = true; }, 4500);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  let payload;
  try { payload = await response.json(); }
  catch (_err) { throw new Error(`Server returned HTTP ${response.status}`); }
  if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
  return payload;
}

function loadReceipts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECEIPT_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.slice(0, 30) : [];
  } catch (_err) { return []; }
}

function saveReceipt(receipt) {
  const receipts = [receipt, ...loadReceipts()].slice(0, 30);
  localStorage.setItem(RECEIPT_KEY, JSON.stringify(receipts));
  renderReceipts();
}

function renderReceipts() {
  const receipts = loadReceipts();
  if (receipts.length === 0) {
    elements['receipt-rows'].innerHTML = '<tr><td colspan="4" class="empty-row">No receipts in this browser.</td></tr>';
    return;
  }
  elements['receipt-rows'].innerHTML = receipts.map((receipt) => {
    const link = receipt.url
      ? `<a href="${escapeHtml(receipt.url)}" target="_blank" rel="noreferrer">${escapeHtml(shortHash(receipt.receipt))}</a>`
      : escapeHtml(shortHash(receipt.receipt));
    return `<tr><td>${escapeHtml(new Date(receipt.time).toLocaleString())}</td><td>${escapeHtml(receipt.type)}</td><td>${escapeHtml(receipt.result)}</td><td>${link}</td></tr>`;
  }).join('');
}

function inviteToken() {
  const value = elements['invite-token'].value.trim();
  if (!value) throw new Error('Invite token is required');
  sessionStorage.setItem('utxoref-beta-invite', value);
  return value;
}

async function refreshStatus() {
  elements['refresh-button'].disabled = true;
  try {
    const status = await requestJson('/v1/beta/status');
    statusSnapshot = status;
    elements['checked-at'].textContent = `Checked ${new Date(status.checkedAt).toLocaleTimeString()}`;
    setValue('block-height', Number(status.chain.blocks).toLocaleString());
    setValue('chain-lag', `${status.chain.lagBlocks} blocks`, status.chain.lagBlocks === 0);
    setValue('graph-verification', status.graph.verified ? 'Verified' : 'Failed', status.graph.verified);
    setValue('assertion-state', status.graph.assertionUnspent ? 'Unspent' : status.graph.artifactStatus, true);
    setValue('faucet-available', formatSats(status.faucet.walletAvailableAboveReserveSats), status.faucet.enabled);
    setValue('daily-remaining', formatSats(status.faucet.dailyRemainingSats));
    elements['assertion-link'].href = status.graph.explorer;
    elements['graph-hash'].textContent = `Graph ${status.graph.graphHash} | Assertion ${status.graph.assertionOutpoint}`;
    elements['claim-amount'].textContent = formatSats(status.faucet.amountSats);
    elements['stress-limit'].textContent = `Max ${status.stress.maxIterationsPerRun}`;
    elements['stress-iterations'].max = String(status.stress.maxIterationsPerRun);
    elements['ready-badge'].textContent = status.betaReady ? 'Beta ready' : 'Not ready';
    elements['ready-badge'].className = `badge ${status.betaReady ? 'badge-ready' : 'badge-waiting'}`;
  } catch (err) {
    statusSnapshot = null;
    elements['ready-badge'].textContent = 'Offline';
    elements['ready-badge'].className = 'badge badge-error';
    showToast(err.message);
  } finally {
    elements['refresh-button'].disabled = false;
  }
}

function showReceipt(element, html, error = false) {
  element.innerHTML = html;
  element.classList.toggle('error', error);
  element.hidden = false;
}

elements['refresh-button'].addEventListener('click', refreshStatus);
elements['stress-iterations'].addEventListener('input', () => {
  elements['stress-output'].value = elements['stress-iterations'].value;
});

elements['faucet-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  elements['claim-button'].disabled = true;
  showReceipt(elements['claim-receipt'], 'Submitting claim...');
  try {
    if (!statusSnapshot?.betaReady) throw new Error('Beta service is not ready');
    const payload = await requestJson('/v1/faucet/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ inviteToken: inviteToken(), address: elements['faucet-address'].value.trim() })
    });
    const txLink = payload.txid
      ? `<a href="${escapeHtml(payload.explorer)}" target="_blank" rel="noreferrer">${escapeHtml(payload.txid)}</a>`
      : escapeHtml(payload.claimId);
    showReceipt(elements['claim-receipt'], `${escapeHtml(formatSats(payload.amountSats))} | ${escapeHtml(payload.status)}<br>${txLink}`);
    saveReceipt({ time: new Date().toISOString(), type: 'faucet', result: payload.status, receipt: payload.txid || payload.claimId, url: payload.explorer });
    await refreshStatus();
  } catch (err) {
    showReceipt(elements['claim-receipt'], escapeHtml(err.message), true);
  } finally {
    elements['claim-button'].disabled = false;
  }
});

elements['stress-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  elements['stress-button'].disabled = true;
  showReceipt(elements['stress-receipt'], 'Running verifier...');
  try {
    const payload = await requestJson('/v1/stress/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: inviteToken(), iterations: Number(elements['stress-iterations'].value) })
    });
    const result = payload.failed === 0 ? `${payload.passed}/${payload.iterations} passed` : `${payload.failed} failed`;
    showReceipt(elements['stress-receipt'], `${escapeHtml(result)} | ${escapeHtml(String(payload.elapsedMs))} ms | ${escapeHtml(String(payload.verificationsPerSecond))}/s<br>Receipt ${escapeHtml(payload.runId)} | ${escapeHtml(shortHash(payload.resultDigest))}`);
    saveReceipt({ time: payload.createdAt, type: 'verification', result, receipt: payload.runId, url: null });
  } catch (err) {
    showReceipt(elements['stress-receipt'], escapeHtml(err.message), true);
  } finally {
    elements['stress-button'].disabled = false;
  }
});

elements['clear-receipts'].addEventListener('click', () => {
  localStorage.removeItem(RECEIPT_KEY);
  renderReceipts();
});

elements['invite-token'].value = sessionStorage.getItem('utxoref-beta-invite') || '';
renderReceipts();
refreshStatus();
window.setInterval(refreshStatus, 30000);
