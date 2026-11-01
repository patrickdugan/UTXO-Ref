const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { routeTrackRequest } = require('./lndTrackGateway');
const { lookupPaymentViaLndRest } = require('./lndRestClient');

// One payment backs one mint, for the amount LND paid, and the sidecar never pays a request twice:
// - a second request (another refund address, so another requestId) for the same payment hash is refused at quote,
//   and at mint once the hash has backed a grant;
// - a mint needs LND to have paid exactly the request's invoiceAmountSats for the hash;
// - a request the sidecar saw settled is never paid again, a payment LND reports in flight is not paid again, and a
//   404 that is not LND's "never initiated" answer is an error, not a reason to pay.

const TOKEN = 'test-sidecar-token-binding';
const ADMIN_ADDRESS = 'tb1qadminplaceholder0000000000000000000000';
const RECIPIENT = 'tb1qwvzaayzrgreqyyvxp77wlr60ngaqnpcyhujz2m';
// What LND records as paid for the invoice: collateral 12345 plus fee 321.
const INVOICE_AMOUNT_SATS = '12666';
const QUOTE_ROUTE = '/v1/dlc-subswap-funding/quote';
const PAY_ROUTE = '/v1/dlc-subswap-funding/pay';
const MINT_ROUTE = '/v1/dlc-subswap-funding/tlbtc-mint-intent';
const TRACK = '/v2/router/track/';

const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-binding-'));
const tokenFile = path.join(tokenDir, 'token');
fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
const storePath = path.join(tokenDir, 'requests.json');

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
function payment(i) {
  const preimageHex = sha256Hex(`binding-preimage-${i}`);
  return { invoice: `lntb-binding-${i}`, preimageHex, paymentHashHex: sha256Hex(Buffer.from(preimageHex, 'hex')) };
}

// The fake LND pays invoices it knows and records each payment, by hash, for the invoice amount. A hash can be given
// a fixed track answer instead: 'inflight', 'bare404' (a proxy's 404 with no gRPC body), or a payment record.
const knownInvoices = new Map();
const lndPayments = new Map();
const trackOverrides = new Map();
const payPosts = [];
const fakeLnd = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (req.method === 'GET' && req.url.startsWith(TRACK)) {
      const hash = routeTrackRequest(req.url);
      const override = trackOverrides.get(hash);
      if (override === 'bare404') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      if (override === 'inflight') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: { payment_hash: hash, status: 'IN_FLIGHT', payment_preimage: '' } }));
        return;
      }
      const found = override || lndPayments.get(hash);
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
    payPosts.push(body.payment_request);
    const known = knownInvoices.get(body.payment_request);
    if (!known) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no route to destination' }));
      return;
    }
    lndPayments.set(known.paymentHashHex, {
      payment_hash: known.paymentHashHex,
      payment_preimage: known.preimageHex,
      status: 'SUCCEEDED',
      value_sat: INVOICE_AMOUNT_SATS
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      payment_preimage: Buffer.from(known.preimageHex, 'hex').toString('base64'),
      payment_hash: Buffer.from(known.paymentHashHex, 'hex').toString('base64'),
      payment_route: {}
    }));
  });
});

async function boot(overrides = {}) {
  Object.assign(process.env, {
    LND_REST_INSECURE: '1',
    LND_MACAROON_HEX: '00',
    LND_REST_URL: `http://127.0.0.1:${fakeLnd.address().port}`,
    SIDECAR_API_TOKEN_FILE: tokenFile,
    SIDECAR_REQUEST_STORE_PATH: storePath,
    TL_PROCEDURAL_ADMIN_ADDRESS: ADMIN_ADDRESS
  }, overrides);
  delete require.cache[require.resolve('./server')];
  const sidecar = require('./server');
  const server = http.createServer((req, res) => sidecar.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function quoteBody(p, extra = {}) {
  return {
    walletNodeId: 'electrum-tradelayer',
    requestedCollateralSats: '12345',
    swapFeeSats: '321',
    refundBlocks: 12,
    invoice: p.invoice,
    paymentHashHex: p.paymentHashHex,
    ...extra
  };
}

async function post(base, route, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text || '{}') };
}

const log = (name) => console.log(`  OK  ${name}`);

async function lookupClient() {
  const env = { LND_REST_URL: 'http://lnd.test', LND_MACAROON_HEX: '00', LND_REST_INSECURE: '1' };
  const hash = payment(900).paymentHashHex;
  const fail = (statusCode, text) => async () => {
    const err = new Error(`LND REST /v2/router/track returned HTTP ${statusCode}: ${text}`);
    err.statusCode = statusCode;
    err.body = text;
    throw err;
  };
  await assert.rejects(lookupPaymentViaLndRest({ paymentHashHex: hash, env, requestImpl: fail(404, 'Not Found') }), /HTTP 404/,
    'a 404 without the gateway NOT_FOUND body was read as unknown');
  assert.deepStrictEqual(await lookupPaymentViaLndRest({ paymentHashHex: hash, env,
    requestImpl: fail(404, '{"code":5,"message":"payment isn\'t initiated","details":[]}') }), { state: 'unknown' });
  const settled = (fields) => async () => ({ result: { payment_hash: hash, status: 'SUCCEEDED', payment_preimage: payment(900).preimageHex, ...fields } });
  const valueOf = async (fields) => (await lookupPaymentViaLndRest({ paymentHashHex: hash, env, requestImpl: settled(fields) })).valueMsat;
  assert.strictEqual(await valueOf({ value_msat: '12666000', value_sat: '1' }), '12666000', 'value_msat is the amount');
  assert.strictEqual(await valueOf({ value_sat: '12666' }), '12666000', 'value_sat is the amount when value_msat is absent');
  assert.strictEqual(await valueOf({}), null, 'an unreported amount is null');
  assert.strictEqual(await valueOf({ value_msat: '-5', value_sat: 'abc' }), null, 'a malformed amount is null');
  log('a bare 404 is an LND error, and the settled amount is read from value_msat or value_sat');
}

async function main() {
  await lookupClient();
  await new Promise((resolve) => fakeLnd.listen(0, '127.0.0.1', resolve));
  let node = await boot();

  // One payment, one request: a second body for the same hash is refused while the first is open and after it mints.
  const shared = payment(1);
  knownInvoices.set(shared.invoice, shared);
  const first = await post(node.base, QUOTE_ROUTE, quoteBody(shared, { refundAddress: 'tb1qrefundfirst00000000000000000000000000' }));
  assert.strictEqual(first.status, 200, JSON.stringify(first.json));
  const firstId = first.json.request.requestId;
  const secondBody = quoteBody(shared, { refundAddress: 'tb1qrefundsecond0000000000000000000000000' });
  const openTwin = await post(node.base, QUOTE_ROUTE, secondBody);
  assert.strictEqual(openTwin.status, 409, `a second request for an open payment hash was quoted: ${JSON.stringify(openTwin.json)}`);
  assert.match(openTwin.json.reason, /payment hash in use/);
  assert.strictEqual((await post(node.base, PAY_ROUTE, { requestId: firstId })).status, 200);
  assert.strictEqual((await post(node.base, MINT_ROUTE, { requestId: firstId, recipientAddress: RECIPIENT })).status, 200);
  const mintedTwin = await post(node.base, QUOTE_ROUTE, quoteBody(shared, {
    refundAddress: 'tb1qrefundthird00000000000000000000000000',
    requestedCollateralSats: '100000000'
  }));
  assert.strictEqual(mintedTwin.status, 409, `a request for a minted payment hash was quoted: ${JSON.stringify(mintedTwin.json)}`);
  log('a second request for one payment hash is refused at quote, while the first is open and after it minted');

  // A store written before this rule can hold a twin for a hash that later minted. Its mint is refused, also after a
  // restart, which rebuilds the minted hashes from the minted log.
  await node.close();
  const otherStore = path.join(tokenDir, 'other-requests.json');
  node = await boot({ SIDECAR_REQUEST_STORE_PATH: otherStore });
  const twinQuote = await post(node.base, QUOTE_ROUTE, secondBody);
  assert.strictEqual(twinQuote.status, 200);
  const twinId = twinQuote.json.request.requestId;
  const twinEntry = JSON.parse(fs.readFileSync(otherStore, 'utf8')).entries.find((e) => e.request.requestId === twinId);
  await node.close();
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  store.entries.push(twinEntry);
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
  node = await boot();
  const twinMint = await post(node.base, MINT_ROUTE, { requestId: twinId, recipientAddress: RECIPIENT });
  assert.strictEqual(twinMint.status, 409, `a second request minted from one payment: ${JSON.stringify(twinMint.json)}`);
  assert.match(twinMint.json.reason || twinMint.json.error || '', /payment already minted/);
  log('a stored twin of a minted payment hash is refused at mint, after a restart');

  // The amount: LND settled the hash for 1 sat, or did not say how much, so nothing mints.
  for (const [label, record] of [['1 sat', { value_sat: '1' }], ['an unreported amount', {}]]) {
    const small = payment(label === '1 sat' ? 2 : 3);
    trackOverrides.set(small.paymentHashHex, { payment_hash: small.paymentHashHex, payment_preimage: small.preimageHex, status: 'SUCCEEDED', ...record });
    const quoted = await post(node.base, QUOTE_ROUTE, quoteBody(small));
    assert.strictEqual(quoted.status, 200);
    const minted = await post(node.base, MINT_ROUTE, { requestId: quoted.json.request.requestId, recipientAddress: RECIPIENT });
    assert.strictEqual(minted.status, 400, `a payment of ${label} minted: ${JSON.stringify(minted.json)}`);
    assert.match(minted.json.reason, /not the invoice amount of 12666000 msat/);
  }
  log('a payment LND settled for less than the invoice amount, or for an amount it did not report, does not mint');

  // A request the sidecar saw settled is not paid again when LND no longer knows the payment, before or after a restart.
  const paidOnce = payment(4);
  knownInvoices.set(paidOnce.invoice, paidOnce);
  const paidId = (await post(node.base, QUOTE_ROUTE, quoteBody(paidOnce))).json.request.requestId;
  assert.strictEqual((await post(node.base, PAY_ROUTE, { requestId: paidId })).status, 200);
  lndPayments.delete(paidOnce.paymentHashHex);
  const postsBefore = payPosts.length;
  const repay = await post(node.base, PAY_ROUTE, { requestId: paidId });
  assert.strictEqual(repay.status, 409, `a paid request was paid again: ${JSON.stringify(repay.json)}`);
  await node.close();
  node = await boot();
  assert.strictEqual((await post(node.base, PAY_ROUTE, { requestId: paidId })).status, 409);
  assert.strictEqual(payPosts.length, postsBefore, 'a request saved as paid was sent to LND again');
  log('a paid request is never paid again, though LND forgot the payment, before or after a restart');

  // LND reports the payment in flight, or a proxy answers a bare 404: neither is a reason to pay.
  for (const [label, answer, status] of [['in flight', 'inflight', 409], ['a bare 404', 'bare404', 502]]) {
    const held = payment(label === 'in flight' ? 5 : 6);
    knownInvoices.set(held.invoice, held);
    trackOverrides.set(held.paymentHashHex, answer);
    const heldId = (await post(node.base, QUOTE_ROUTE, quoteBody(held))).json.request.requestId;
    const before = payPosts.length;
    const paid = await post(node.base, PAY_ROUTE, { requestId: heldId });
    assert.strictEqual(paid.status, status, `a pay with LND answering ${label} returned ${paid.status}: ${JSON.stringify(paid.json)}`);
    assert.strictEqual(payPosts.length, before, `a pay with LND answering ${label} was sent to LND`);
  }
  log('a payment LND reports in flight, or a bare 404 from the track route, is not paid again');

  await node.close();
}

main().then(() => {
  fakeLnd.close();
  fs.rmSync(tokenDir, { recursive: true, force: true });
  console.log('dlcSubswapBinding tests ok');
}).catch((err) => {
  console.error(err);
  fakeLnd.close();
  fs.rmSync(tokenDir, { recursive: true, force: true });
  process.exit(1);
});
