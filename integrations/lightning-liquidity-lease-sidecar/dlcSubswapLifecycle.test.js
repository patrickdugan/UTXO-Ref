const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// The open quote table bounds live, unsettled quotes. A quote is quoted -> paid -> minted: a quote expires after
// SIDECAR_QUOTE_TTL_SECONDS unless it was paid, and a minted request is recorded by hash, outside the open table,
// so it is never granted twice.

const TOKEN = 'test-sidecar-token-lifecycle';
const ADMIN_ADDRESS = 'tb1qadminplaceholder0000000000000000000000';
const RECIPIENT = 'tb1qwvzaayzrgreqyyvxp77wlr60ngaqnpcyhujz2m';
const OPEN_CAP = 3;
const TTL_SECONDS = 2;
const LARGE_MINTED_CAP = 100;
const QUOTE_ROUTE = '/v1/dlc-subswap-funding/quote';
const PAY_ROUTE = '/v1/dlc-subswap-funding/pay';
const MINT_ROUTE = '/v1/dlc-subswap-funding/tlbtc-mint-intent';

const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-lifecycle-'));
const tokenFile = path.join(tokenDir, 'token');
fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
const storePath = path.join(tokenDir, 'requests.json');

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Each numbered payment has its own invoice and preimage. The fake LND pays only invoices it knows, and lists
// settled payments the way LND does (hex fields, newest first).
function payment(i) {
  const preimageHex = sha256Hex(`lifecycle-preimage-${i}`);
  return { invoice: `lntb-lifecycle-${i}`, preimageHex, paymentHashHex: sha256Hex(Buffer.from(preimageHex, 'hex')) };
}
const knownInvoices = new Map();
const lndPayments = [];
const lndCalls = [];
// How long the fake LND holds a payment before it settles, so a test can keep a payment in flight across the TTL.
let lndPayDelayMs = 0;
const fakeLnd = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    lndCalls.push({ method: req.method, path: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET' && req.url.startsWith('/v1/payments')) {
      res.end(JSON.stringify({ payments: [...lndPayments].reverse(), first_index_offset: '0', last_index_offset: '0' }));
      return;
    }
    const known = knownInvoices.get(body.payment_request);
    if (!known) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no route to destination' }));
      return;
    }
    setTimeout(() => {
      lndPayments.push({ payment_hash: known.paymentHashHex, payment_preimage: known.preimageHex, status: 'SUCCEEDED', value_sat: '12345' });
      res.end(JSON.stringify({
        payment_preimage: Buffer.from(known.preimageHex, 'hex').toString('base64'),
        payment_hash: Buffer.from(known.paymentHashHex, 'hex').toString('base64'),
        payment_route: {}
      }));
    }, lndPayDelayMs);
  });
});

const BASE_ENV = {
  LND_REST_INSECURE: '1',
  LND_MACAROON_HEX: '00',
  SIDECAR_API_TOKEN_FILE: tokenFile,
  SIDECAR_REQUEST_STORE_PATH: storePath,
  SIDECAR_MAX_QUOTED_REQUESTS: String(OPEN_CAP),
  SIDECAR_MAX_MINTED_REQUESTS: String(LARGE_MINTED_CAP),
  SIDECAR_QUOTE_TTL_SECONDS: String(TTL_SECONDS),
  TL_PROCEDURAL_ADMIN_ADDRESS: ADMIN_ADDRESS
};

// Loads a fresh sidecar process state from the environment, as a restart does.
async function boot(overrides = {}) {
  Object.assign(process.env, BASE_ENV, overrides);
  delete require.cache[require.resolve('./server')];
  const sidecar = require('./server');
  const server = http.createServer((req, res) => sidecar.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function quoteBody(p) {
  return {
    walletNodeId: 'electrum-tradelayer',
    requestedCollateralSats: '12345',
    swapFeeSats: '321',
    refundBlocks: 12,
    invoice: p.invoice,
    paymentHashHex: p.paymentHashHex
  };
}

async function post(base, route, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

const quote = (base, i) => {
  const p = payment(i);
  knownInvoices.set(p.invoice, p);
  return post(base, QUOTE_ROUTE, quoteBody(p));
};
const pay = (base, requestId) => post(base, PAY_ROUTE, { requestId });
// Counts the grants this test has been given, so the minted cap can be set to the exact number in a restart.
const grants = { count: 0 };
async function mint(base, requestId, recipientAddress = RECIPIENT) {
  const minted = await post(base, MINT_ROUTE, { requestId, recipientAddress });
  if (minted.status === 200) grants.count++;
  return minted;
}
const paymentPosts = () => lndCalls.filter((call) => call.method === 'POST').length;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = () => sleep(TTL_SECONDS * 1000 + 300);

async function quotedAndPaid(base, i) {
  const quoted = await quote(base, i);
  assert.strictEqual(quoted.status, 200, `quote ${i} was refused: ${JSON.stringify(quoted.json)}`);
  const paid = await pay(base, quoted.json.request.requestId);
  assert.strictEqual(paid.status, 200, `pay ${i} was refused: ${JSON.stringify(paid.json)}`);
  return quoted.json.request.requestId;
}

async function main() {
  let node = await boot();
  const log = (name) => console.log(`  OK  ${name}`);

  // An honest loop of three times the open cap: every quote is served because a minted request leaves the table.
  const loop = [];
  for (let i = 0; i < 3 * OPEN_CAP; i++) {
    const requestId = await quotedAndPaid(node.base, i);
    const minted = await mint(node.base, requestId);
    assert.strictEqual(minted.status, 200, `mint ${i} was refused: ${JSON.stringify(minted.json)}`);
    assert.strictEqual(minted.json.tradeLayer.params.amountGranted, '0.00012345');
    loop.push(requestId);
  }
  log('an honest quote, pay, mint loop three times the open cap succeeds');

  // A minted request is never minted again, never re-quoted, and a concurrent pair of mints grants once.
  const again = await mint(node.base, loop[0]);
  assert.strictEqual(again.status, 409, 'a second mint of a minted request was not refused');
  assert.match(again.json.error, /already minted/);
  const otherRecipient = await mint(node.base, loop[0], 'tb1qotherrecipient000000000000000000000000');
  assert.strictEqual(otherRecipient.status, 409, 'a mint to another recipient was not refused');
  const requoted = await quote(node.base, 0);
  assert.strictEqual(requoted.status, 409, 'a minted request was quoted again');
  const racing = await quotedAndPaid(node.base, 9);
  const pair = await Promise.all([mint(node.base, racing), mint(node.base, racing)]);
  assert.deepStrictEqual(pair.map((r) => r.status).sort(), [200, 409], 'two concurrent mints did not grant exactly once');
  log('a minted request is refused on a second mint, another recipient and a re-quote; concurrent mints grant once');

  // An expired quote cannot be paid. It is refused without calling LND, and a fresh quote after expiry works.
  const expiredId = (await quote(node.base, 10)).json.request.requestId;
  await wait();
  const callsBeforeExpiredPay = paymentPosts();
  const expiredPay = await pay(node.base, expiredId);
  assert.strictEqual(expiredPay.status, 410, 'an expired quote was paid');
  assert.strictEqual(paymentPosts(), callsBeforeExpiredPay, 'LND was asked to pay an expired quote');
  const expiredMint = await mint(node.base, expiredId);
  assert.strictEqual(expiredMint.status, 410, 'an expired quote was minted');
  const reQuoted = await quote(node.base, 10);
  assert.strictEqual(reQuoted.status, 200);
  assert.strictEqual(reQuoted.json.request.requestId, expiredId, 'the same invoice quoted again changed its request');
  assert.strictEqual((await pay(node.base, expiredId)).status, 200, 'a fresh quote after expiry could not be paid');
  assert.strictEqual((await mint(node.base, expiredId)).status, 200);
  log('an expired quote is refused by pay and mint, and re-quoting after expiry works');

  // A table full of live open quotes refuses a new quote with 503, and recovers once they expire.
  const live = [];
  for (let i = 11; i < 11 + OPEN_CAP; i++) {
    const quoted = await quote(node.base, i);
    assert.strictEqual(quoted.status, 200, `live quote ${i} was refused`);
    live.push(quoted.json.request.requestId);
  }
  const full = await quote(node.base, 20);
  assert.strictEqual(full.status, 503, 'a full table of live quotes accepted another quote');
  assert.match(full.json.reason, /quote table is full/);
  const stillLive = await quote(node.base, 11);
  assert.strictEqual(stillLive.status, 200, 'a live quote already in a full table was refused');
  await wait();
  const recovered = await quote(node.base, 20);
  assert.strictEqual(recovered.status, 200, 'the table did not recover after its quotes expired');
  log('a full table of live quotes returns 503 and recovers when they expire');

  // A payment that LND is still settling when the TTL passes is not dropped: a quote that arrives meanwhile does not
  // prune it, the payment settles, and the request mints.
  const slow = await quote(node.base, 60);
  assert.strictEqual(slow.status, 200);
  const slowId = slow.json.request.requestId;
  lndPayDelayMs = (TTL_SECONDS + 1) * 1000;
  const slowPay = pay(node.base, slowId);
  await sleep(TTL_SECONDS * 1000 + 300);
  const duringPay = await quote(node.base, 61);
  assert.strictEqual(duringPay.status, 200, 'a quote during a slow pay was refused');
  const slowPaid = await slowPay;
  lndPayDelayMs = 0;
  assert.strictEqual(slowPaid.status, 200, `a slow payment across the TTL was refused: ${JSON.stringify(slowPaid.json)}`);
  const slowMint = await mint(node.base, slowId);
  assert.strictEqual(slowMint.status, 200, `a payment that settled after the TTL did not mint: ${JSON.stringify(slowMint.json)}`);
  log('a payment still in flight across the TTL survives a quote that prunes, and mints');

  // A restart keeps the lifecycle: a paid request still mints, a quoted one still pays, a minted one stays refused.
  const paidId = await quotedAndPaid(node.base, 30);
  const quotedId = (await quote(node.base, 31)).json.request.requestId;
  await node.close();
  node = await boot();
  assert.strictEqual((await mint(node.base, paidId)).status, 200, 'a restart orphaned a paid request');
  assert.strictEqual((await pay(node.base, quotedId)).status, 200, 'a restart lost a live quote');
  assert.strictEqual((await mint(node.base, quotedId)).status, 200);
  await node.close();
  node = await boot();
  const afterRestart = await mint(node.base, paidId);
  assert.strictEqual(afterRestart.status, 409, 'a restart forgot that a request was minted');
  assert.strictEqual((await quote(node.base, 30)).status, 409, 'a restart let a minted request be quoted again');
  log('a restart mid-lifecycle keeps quoted, paid and minted state');

  // The minted record has its own cap. At the cap a mint is refused, the paid request stays open, and raising the
  // cap lets it mint.
  const mintedNow = grants.count;
  await node.close();
  node = await boot({ SIDECAR_MAX_MINTED_REQUESTS: String(mintedNow) });
  const capId = await quotedAndPaid(node.base, 40);
  const capped = await mint(node.base, capId);
  assert.strictEqual(capped.status, 503, 'a mint past the minted cap was not refused');
  assert.match(capped.json.error, /minted record is full/);
  await node.close();
  node = await boot({ SIDECAR_MAX_MINTED_REQUESTS: String(mintedNow + 1) });
  assert.strictEqual((await mint(node.base, capId)).status, 200, 'raising the minted cap did not unblock a paid request');
  log('the minted record refuses at its own cap and recovers when the cap is raised');

  // A version 1 store never recorded a mint, so after the upgrade each of its requests is recorded as minted.
  const legacy = (await quote(node.base, 50)).json.request;
  const legacyPath = path.join(tokenDir, 'legacy-requests.json');
  fs.writeFileSync(legacyPath, JSON.stringify({ kind: 'utxoref_dlc_subswap_request_store', version: 1, entries: [{ request: legacy }] }));
  await node.close();
  node = await boot({ SIDECAR_REQUEST_STORE_PATH: legacyPath });
  assert.strictEqual((await mint(node.base, legacy.requestId)).status, 409, 'a version 1 request was granted again after upgrade');
  assert.strictEqual((await quote(node.base, 50)).status, 409, 'a version 1 request was quoted again after upgrade');
  log('a version 1 store is upgraded with its requests recorded as minted');

  await node.close();
  fs.rmSync(tokenDir, { recursive: true, force: true });
}

fakeLnd.listen(0, '127.0.0.1', () => {
  process.env.LND_REST_URL = `http://127.0.0.1:${fakeLnd.address().port}`;
  main().then(
    () => {
      fakeLnd.close();
      console.log('dlcSubswapLifecycle tests ok');
    },
    (err) => {
      console.error(err);
      fakeLnd.close();
      fs.rmSync(tokenDir, { recursive: true, force: true });
      process.exit(1);
    }
  );
});
