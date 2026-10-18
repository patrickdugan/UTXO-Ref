/**
 * Run: node integrations/wallet-dashboard-vercel/dashboard_href.test.js
 *
 * Every dashboard opens its links through safeHref, which lets only http(s) and relative URLs through. The helper is
 * read from each dashboard's source and run, so the test exercises the code the browser runs.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DASHBOARDS = [
  'wallet-demo/dashboard.js',
  'wallet-dashboard-vercel/public/dashboard.js',
  'utxoref-testnet-beta/public/app.js'
];

function loadSafeHref(file) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const match = source.match(/^function safeHref\(value\) \{[\s\S]*?^\}$/m);
  assert.ok(match, `${file} defines no safeHref`);
  const context = { URL };
  vm.createContext(context);
  vm.runInContext(`${match[0]}\nthis.safeHref = safeHref;`, context);
  return context.safeHref;
}

const REFUSED = [
  'javascript:alert(1)',
  '  JavaScript:alert(1)',
  'java\nscript:alert(1)',
  'java\tscript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'ftp://example.invalid/x'
];
const ALLOWED = [
  'https://mempool.space/testnet4/tx/aa',
  'http://127.0.0.1:8787/status',
  '/dashboard',
  'funding.html',
  '#',
  '?view=wallet'
];

for (const file of DASHBOARDS) {
  const safeHref = loadSafeHref(file);
  for (const value of REFUSED) {
    assert.equal(safeHref(value), '#', `${file}: ${JSON.stringify(value)} was not refused`);
  }
  for (const value of ALLOWED) {
    assert.equal(safeHref(value), value, `${file}: ${JSON.stringify(value)} was refused`);
  }
  assert.equal(safeHref(undefined), '', `${file}: a missing link is an empty href, which points at this page`);
  assert.equal(safeHref(''), '', `${file}: an empty link stays empty`);
  console.log(`OK ${file} safeHref`);
}

// Every href written from a value goes through safeHref. The only unwrapped hrefs are constant https prefixes.
for (const file of DASHBOARDS) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const unwrapped = source.split('\n').filter((line) => /href="\$\{escapeHtml\((?!safeHref)/.test(line));
  assert.deepEqual(unwrapped, [], `${file} writes an href from a value without safeHref`);
}
const appSource = fs.readFileSync(path.join(ROOT, 'utxoref-testnet-beta/public/app.js'), 'utf8');
assert.match(appSource, /\.href = safeHref\(status\.graph\.explorer\)/, 'assertion link is assigned without safeHref');
console.log('OK every href sink uses safeHref');
console.log('\nPASS: dashboard href tests');
