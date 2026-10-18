const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// dashboard.js is a browser script. It runs against a minimal DOM stub here, so its profile panel renders
// exactly the markup a browser would receive for the given status.
const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    elements.set(id, { id, textContent: '', innerHTML: '', value: '', addEventListener() {}, close() {} });
  }
  return elements.get(id);
}
const context = {
  console,
  setTimeout,
  clearTimeout,
  URL,
  location: { search: '' },
  document: { getElementById: element, querySelector: () => null, createElement: () => element('created') },
  fetch: async () => { throw new Error('offline'); }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.js'), 'utf8'), context);

function statusWithLnd(lnd) {
  return {
    activeProfileId: 'beta',
    profile: { mode: 'testnet4' },
    chain: { chain: 'testnet4', rpcUrl: 'http://127.0.0.1:18332', wallet: 'beta-wallet' },
    lnd,
    artifacts: { lnbtcTlusdLiquidityPatch: { exists: true } },
    readiness: { walletViewReady: true }
  };
}

const hostile = '<img src=x onerror="alert(1)">';
context.renderProfilePanel(statusWithLnd({ network: 'testnet4', grpcHost: `${hostile}:10009` }));
const hostileHtml = element('profilePanel').innerHTML;
assert.doesNotMatch(hostileHtml, /<img/, 'an LND host from configuration must not become markup');
assert.match(hostileHtml, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;:10009/);

context.renderProfilePanel(statusWithLnd({ network: 'testnet4', grpcHost: '127.0.0.1:10009' }));
assert.match(element('profilePanel').innerHTML, /<strong>testnet4 127\.0\.0\.1:10009<\/strong>/);

context.renderProfilePanel(statusWithLnd(null));
assert.match(element('profilePanel').innerHTML, /<strong>not active<\/strong>/);

console.log('dashboard profile panel tests ok');
