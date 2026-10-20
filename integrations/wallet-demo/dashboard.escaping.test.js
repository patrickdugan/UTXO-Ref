const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const api = path.join(__dirname, '..', 'wallet-dashboard-vercel', 'api');
const { buildStatus, buildWalletView, buildStressDashboard } = require(path.join(api, 'mockData'));
const { buildAdapterFeed } = require(path.join(api, 'adapterFeed'));
const { buildBitcoinTestnetProof } = require(path.join(api, 'testnetProof'));

// Every dashboard script is run in a sandbox with a stub DOM, fed with the mock API payloads after a hostile string
// is placed in each field that reaches innerHTML. The page must render the string as text, never as markup.
const HOSTILE = '<img src=x onerror=ZZHOSTILE>';
const HOSTILE_ATTR = '" onmouseover="ZZHOSTILE';

function poisonedPayloads() {
  const dashboard = buildStressDashboard({ botCount: 5 });
  const walletView = buildWalletView();
  const status = buildStatus();
  const adapterFeed = buildAdapterFeed();
  const testnetProof = buildBitcoinTestnetProof();
  dashboard.lanes[0].label = HOSTILE;
  dashboard.lanes[0].id = HOSTILE_ATTR;
  dashboard.bots[0].botId = HOSTILE;
  dashboard.bots[0].lane = HOSTILE;
  dashboard.challengeQueue[0].botId = HOSTILE;
  dashboard.challengeQueue[0].violations = [HOSTILE];
  dashboard.challengeQueue[0].bitvmChallengeId = HOSTILE;
  walletView.tradeLayerOracleDlc.trigger.payloadText = HOSTILE;
  walletView.tradeLayerOracleDlc.trigger.pair = HOSTILE;
  walletView.tradeLayerOracleDlc.trigger.designatedOracleAddress = HOSTILE;
  walletView.tradeLayerOracleDlc.settlement.selectedOutcomeId = HOSTILE;
  walletView.useCases[0].label = HOSTILE;
  walletView.useCases[0].id = HOSTILE_ATTR;
  walletView.useCases[0].bitcoinEvidence = [];
  walletView.pureBtcRouteDemo.stages[0].label = HOSTILE;
  walletView.pureBtcRouteDemo.stages[0].id = HOSTILE_ATTR;
  walletView.pureBtcRouteDemo.stages[0].channelState = HOSTILE;
  walletView.liquidityPatch.routerCircuit.gateCounts[0].family = HOSTILE;
  walletView.liquidityPatch.routerCircuit.gateCounts[0].id = HOSTILE_ATTR;
  walletView.conversion.subswapFundingTxid = HOSTILE;
  status.chain.rpcUrl = HOSTILE;
  status.chain.wallet = HOSTILE;
  status.activeProfileId = HOSTILE;
  adapterFeed.events[0].adapter = HOSTILE;
  adapterFeed.events[0].status = HOSTILE;
  adapterFeed.events[0].evidenceUrl = `https://mempool.space/testnet4/tx/${HOSTILE_ATTR}`;
  testnetProof.steps[0].label = HOSTILE;
  testnetProof.steps[0].explorer = `https://mempool.space/testnet4/tx/${HOSTILE_ATTR}`;
  testnetProof.steps[1].description = HOSTILE;
  return {
    '/v1/wallet-demo/stress-dashboard': dashboard,
    '/v1/wallet-demo/status': status,
    '/v1/lnbtc-tlusd-liquidity-patch/wallet-view': walletView,
    '/v1/wallet-demo/adapter-feed': adapterFeed,
    '/v1/wallet-demo/bitcoin-testnet-proof': testnetProof
  };
}

function makeDom() {
  const byId = new Map();
  const created = [];
  const element = (id) => ({
    id,
    innerHTML: '',
    textContent: '',
    value: '0.5',
    className: '',
    disabled: false,
    dataset: {},
    style: { setProperty() {} },
    appendChild() {},
    remove() {},
    addEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    showModal() {},
    close() {}
  });
  const document = {
    activeElement: null,
    body: { appendChild() {} },
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, element(id));
      return byId.get(id);
    },
    querySelector() { return null; },
    createElement() {
      const el = element('');
      created.push(el);
      return el;
    }
  };
  return { document, byId, created };
}

async function renderPage(scriptPath, payloads) {
  const { document, byId, created } = makeDom();
  const requested = [];
  const sandbox = {
    document,
    location: { origin: 'https://dashboard.example', host: 'dashboard.example' },
    performance: { now: () => 0 },
    console,
    Blob: class {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    fetch: async (url) => {
      requested.push(url);
      const route = Object.keys(payloads).find((key) => url.startsWith(key));
      if (!route) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(payloads[route])) };
    },
    setTimeout,
    clearTimeout
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(scriptPath, 'utf8');
  vm.runInContext(source, sandbox, { filename: scriptPath });
  for (let turn = 0; turn < 50 && requested.length < 4; turn++) await new Promise((resolve) => setImmediate(resolve));
  for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve));
  // textContent is never parsed as markup, so only what was assigned to innerHTML can inject.
  const html = [...byId.values(), ...created].map((el) => el.innerHTML).join('\n');
  return { html, byId, created, requested };
}

async function testRenderedMarkupIsEscaped(scriptPath) {
  const name = path.relative(path.join(__dirname, '..'), scriptPath);
  const page = await renderPage(scriptPath, poisonedPayloads());
  assert.ok(page.requested.length >= 4, `${name} did not load its payloads`);
  assert.ok(!page.html.includes('<img src=x onerror=ZZHOSTILE>'), `${name} rendered hostile markup`);
  assert.ok(!page.html.includes('" onmouseover="ZZHOSTILE'), `${name} let a hostile attribute break out of its quotes`);
  assert.ok(page.html.includes('&lt;img src=x onerror=ZZHOSTILE&gt;'), `${name} did not render the hostile value as text`);
}

(async () => {
  await testRenderedMarkupIsEscaped(path.join(__dirname, 'dashboard.js'));
  await testRenderedMarkupIsEscaped(path.join(api, '..', 'public', 'dashboard.js'));
  console.log('dashboard escaping tests ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
