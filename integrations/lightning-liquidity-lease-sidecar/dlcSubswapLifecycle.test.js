const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { routeTrackRequest } = require('./lndTrackGateway');

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

// Each numbered payment has its own invoice and preimage. The fake LND pays only invoices it knows, and answers a
// payment by hash on the track endpoint the way LND does (404 for a hash it never initiated).
function payment(i) {
  const preimageHex = sha256Hex(`lifecycle-preimage-${i}`);
  return { invoice: `lntb-lifecycle-${i}`, preimageHex, paymentHashHex: sha256Hex(Buffer.from(preimageHex, 'hex')) };
}
const knownInvoices = new Map();
const lndPayments = [];
const lndCalls = [];
// How long the fake LND holds a payment before it settles, so a test can keep a payment in flight across the TTL.
let lndPayDelayMs = 0;
// A pay whose connection drops after LND has settled the payment: LND holds the payment, the sidecar sees an error.
let lndDropAfterSettle = false;
const TRACK = '/v2/router/track/';
const fakeLnd = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    lndCalls.push({ method: req.method, path: req.url });
    if (req.method === 'GET' && req.url.startsWith(TRACK)) {
      const found = lndPayments.find((p) => p.payment_hash === routeTrackRequest(req.url));
      if (!found) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: "payment isn't initiated", message: "payment isn't initiated", code: 5, details: [] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: found }));
      return;
    }
    const body = JSON.parse(raw || '{}');
    const known = knownInvoices.get(body.payment_request);
    if (!known) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no route to destination' }));
      return;
    }
    setTimeout(() => {
      lndPayments.push({ payment_hash: known.paymentHashHex, payment_preimage: known.preimageHex, status: 'SUCCEEDED', value_sat: '12345' });
      if (lndDropAfterSettle) {
        lndDropAfterSettle = false;
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
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
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text || '{}') };
}

const quote = (base, i) => {
  const p = payment(i);
  knownInvoices.set(p.invoice, p);
  return post(base, QUOTE_ROUTE, quoteBody(p));
};
const pay = (base, requestId) => post(base, PAY_ROUTE, { requestId });
// The requests this test has granted, so the minted cap can be set to the exact number in a restart.
const granted = new Set();
async function mint(base, requestId, recipientAddress = RECIPIENT) {
  const minted = await post(base, MINT_ROUTE, { requestId, recipientAddress });
  if (minted.status === 200) granted.add(requestId);
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
  const intentText = new Map();
  for (let i = 0; i < 3 * OPEN_CAP; i++) {
    const requestId = await quotedAndPaid(node.base, i);
    const minted = await mint(node.base, requestId);
    assert.strictEqual(minted.status, 200, `mint ${i} was refused: ${JSON.stringify(minted.json)}`);
    assert.strictEqual(minted.json.tradeLayer.params.amountGranted, '0.00012345');
    loop.push(requestId);
    intentText.set(requestId, minted.text);
  }
  log('an honest quote, pay, mint loop three times the open cap succeeds');

  // A minted request is never minted again, never re-quoted. A repeat mint to the same recipient gets the stored intent
  // back byte for byte; another recipient is refused. Two concurrent mints to the same recipient return the same intent.
  const again = await mint(node.base, loop[0]);
  assert.strictEqual(again.status, 200, 'a repeat mint to the same recipient did not return the stored intent');
  assert.strictEqual(again.text, intentText.get(loop[0]), 'a repeat mint returned a different intent');
  const otherRecipient = await mint(node.base, loop[0], 'tb1qotherrecipient000000000000000000000000');
  assert.strictEqual(otherRecipient.status, 409, 'a mint to another recipient was not refused');
  assert.match(otherRecipient.json.error, /already minted/);
  const requoted = await quote(node.base, 0);
  assert.strictEqual(requoted.status, 409, 'a minted request was quoted again');
  const racing = await quotedAndPaid(node.base, 9);
  const pair = await Promise.all([mint(node.base, racing), mint(node.base, racing)]);
  assert.deepStrictEqual(pair.map((r) => r.status), [200, 200], 'two concurrent mints to one recipient were not both answered');
  assert.strictEqual(pair[0].text, pair[1].text, 'two concurrent mints returned different intents');
  const racingOther = await quotedAndPaid(node.base, 90);
  const splitPair = await Promise.all([mint(node.base, racingOther), mint(node.base, racingOther, 'tb1qotherrecipient000000000000000000000000')]);
  assert.deepStrictEqual(splitPair.map((r) => r.status).sort(), [200, 409], 'two concurrent mints to two recipients did not grant exactly once');
  log('a repeat mint returns the stored intent; another recipient is refused; concurrent mints grant one intent');

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

  // LND settled a payment the sidecar never recorded (the process died before saving paid). Once the quote has
  // expired, mint still asks LND and grants it: a settled payment is never refused as expired.
  const unrecorded = payment(62);
  knownInvoices.set(unrecorded.invoice, unrecorded);
  const unrecordedId = (await quote(node.base, 62)).json.request.requestId;
  lndPayments.push({ payment_hash: unrecorded.paymentHashHex, payment_preimage: unrecorded.preimageHex, status: 'SUCCEEDED', value_sat: '12345' });
  await wait();
  assert.strictEqual((await mint(node.base, unrecordedId)).status, 200, 'a payment LND settled before expiry was refused as expired');
  log('a payment LND settled but the sidecar did not record is minted after the quote expired');

  // A pay whose connection drops while LND settles the payment is a 502, but LND holds the payment. The request is not
  // dropped at its TTL: a quote that arrives after the TTL asks LND, which settled it, and mint then grants it.
  const dropped = payment(64);
  knownInvoices.set(dropped.invoice, dropped);
  const droppedId = (await quote(node.base, 64)).json.request.requestId;
  lndDropAfterSettle = true;
  const droppedPay = await pay(node.base, droppedId);
  assert.strictEqual(droppedPay.status, 502, 'a pay whose connection dropped was not refused');
  await wait();
  const quoteAfterDrop = await quote(node.base, 65);
  assert.strictEqual(quoteAfterDrop.status, 200, 'a quote after the TTL was refused');
  const droppedMint = await mint(node.base, droppedId);
  assert.strictEqual(droppedMint.status, 200, `a payment LND settled after a dropped pay did not mint: ${JSON.stringify(droppedMint.json)}`);
  log('a pay that drops while LND settles survives the TTL and a quote that prunes, and mints');

  // An LND node with more than 5000 payments still mints a request paid before all of them: the payment is found by hash.
  const oldest = await quotedAndPaid(node.base, 66);
  for (let i = 0; i < 5001; i++) {
    const filler = sha256Hex(`lifecycle-filler-${i}`);
    lndPayments.push({ payment_hash: sha256Hex(Buffer.from(filler, 'hex')), payment_preimage: filler, status: 'SUCCEEDED', value_sat: '1' });
  }
  const behindFillers = await mint(node.base, oldest);
  assert.strictEqual(behindFillers.status, 200, `a payment behind 5000 newer LND payments did not mint: ${JSON.stringify(behindFillers.json)}`);
  log('a request paid behind more than 5000 newer LND payments mints');

  // A save that fails after LND settles the payment is reported, and the settled request is not lost: it stays paid in
  // memory, and the next pay saves it to disk. The first pay drops its connection after LND settles, so the attempt is
  // saved and LND holds the payment; the second pay finds the settlement and cannot save it as paid.
  const saveFailId = (await quote(node.base, 63)).json.request.requestId;
  lndDropAfterSettle = true;
  assert.strictEqual((await pay(node.base, saveFailId)).status, 502);
  fs.chmodSync(tokenDir, 0o500);
  let failedSave;
  try {
    failedSave = await pay(node.base, saveFailId);
  } finally {
    fs.chmodSync(tokenDir, 0o700);
  }
  assert.strictEqual(failedSave.status, 500, 'a failed save after a settled payment was not reported');
  const retriedSave = await pay(node.base, saveFailId);
  assert.strictEqual(retriedSave.status, 409, 'a retried pay of a settled request was not answered as already paid');
  const savedEntry = JSON.parse(fs.readFileSync(storePath, 'utf8')).entries.find((e) => e.request.requestId === saveFailId);
  assert.strictEqual(savedEntry.state, 'paid', 'the next pay did not save a settled request as paid');
  assert.strictEqual((await mint(node.base, saveFailId)).status, 200, 'a settled request whose save failed did not mint');
  log('a failed save after a settled payment is reported, and the next pay saves it as paid');

  // A restart keeps the lifecycle: a paid request still mints, a quoted one still pays, a minted one stays refused.
  const paidId = await quotedAndPaid(node.base, 30);
  const quotedId = (await quote(node.base, 31)).json.request.requestId;
  await node.close();
  node = await boot();
  const paidMint = await mint(node.base, paidId);
  assert.strictEqual(paidMint.status, 200, 'a restart orphaned a paid request');
  assert.strictEqual((await pay(node.base, quotedId)).status, 200, 'a restart lost a live quote');
  assert.strictEqual((await mint(node.base, quotedId)).status, 200);
  await node.close();
  node = await boot();
  const afterRestart = await mint(node.base, paidId);
  assert.strictEqual(afterRestart.status, 200, 'a restart lost the intent of a minted request');
  assert.strictEqual(afterRestart.text, paidMint.text, 'a restart returned a different intent');
  assert.strictEqual((await mint(node.base, paidId, 'tb1qotherrecipient000000000000000000000000')).status, 409,
    'a restart granted a minted request to another recipient');
  assert.strictEqual((await quote(node.base, 30)).status, 409, 'a restart let a minted request be quoted again');
  log('a restart mid-lifecycle keeps quoted, paid and minted state');

  // The minted record has its own cap. At the cap a mint is refused, the paid request stays open, and raising the
  // cap lets it mint.
  const mintedNow = granted.size;
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

  // An attempt LND never initiated (the invoice is one LND does not know, so its pay is refused) stays open, but a quote
  // request looks up at most five attempted quotes, oldest first, and an unknown one is dropped only once an hour (the
  // attempt window, which is longer than the quote TTL) has passed since its attempt. The clock is moved forward to get
  // past the TTL and the window. An attempt LND settles later is paid when a quote finds it, even after its window.
  const realNow = Date.now;
  let skewMs = 0;
  Date.now = () => realNow() + skewMs;
  try {
    await node.close();
    node = await boot({ SIDECAR_MAX_QUOTED_REQUESTS: '20' });
    const attempt = async (i) => {
      const quoted = await post(node.base, QUOTE_ROUTE, quoteBody(payment(i)));
      assert.strictEqual(quoted.status, 200, `quote ${i} was refused`);
      const refused = await pay(node.base, quoted.json.request.requestId);
      assert.strictEqual(refused.status, 502, `pay ${i} of an invoice LND does not know was not refused`);
      return quoted.json.request.requestId;
    };
    const trackCalls = () => lndCalls.filter((call) => call.method === 'GET' && call.path.startsWith(TRACK)).length;
    const storedIds = () => new Set(JSON.parse(fs.readFileSync(storePath, 'utf8')).entries.map((e) => e.request.requestId));
    const settledLater = payment(130);
    const late = await attempt(130);
    lndPayments.push({ payment_hash: settledLater.paymentHashHex, payment_preimage: settledLater.preimageHex, status: 'SUCCEEDED' });
    const stale = [];
    for (let i = 100; i < 108; i++) stale.push(await attempt(i));
    const lookupsIn = async (fn) => {
      const before = trackCalls();
      await fn();
      return trackCalls() - before;
    };

    skewMs = (TTL_SECONDS + 1) * 1000;
    assert.strictEqual(await lookupsIn(() => quote(node.base, 120)), 5, 'a quote request did not look up exactly five attempts');
    assert(storedIds().has(stale[0]), 'an unknown attempt was dropped before its window');
    assert.strictEqual(JSON.parse(fs.readFileSync(storePath, 'utf8')).entries.find((e) => e.request.requestId === late).state, 'paid',
      'an attempt LND settled was not recorded as paid');

    skewMs = 60 * 60 * 1000 + 5000;
    assert.strictEqual(await lookupsIn(() => quote(node.base, 121)), 5, 'the second quote request did not look up five attempts');
    assert(!storedIds().has(stale[0]) && !storedIds().has(stale[4]), 'unknown attempts past their window were kept');
    assert(storedIds().has(stale[5]), 'an unknown attempt past the window was dropped before the bound let it be looked up');
    assert.strictEqual((await mint(node.base, late)).status, 200, 'an attempt LND settled after its window did not mint');
    assert.strictEqual(await lookupsIn(() => quote(node.base, 122)), 3, 'the remaining attempts were not looked up');
    assert(!storedIds().has(stale[5]) && !storedIds().has(stale[7]), 'the remaining unknown attempts past their window were kept');
    log('an attempt LND never initiated is looked up five at a time and dropped after its window; a settled one still mints');
  } finally {
    Date.now = realNow;
  }

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
