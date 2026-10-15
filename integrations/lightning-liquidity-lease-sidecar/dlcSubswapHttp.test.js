const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TOKEN = 'test-sidecar-token-7f3a';
const ADMIN_ADDRESS = 'tb1qadminplaceholder0000000000000000000000';
const RECIPIENT = 'tb1qwvzaayzrgreqyyvxp77wlr60ngaqnpcyhujz2m';
const paidPreimageHex = '01'.repeat(32);
const paidPaymentHashHex = crypto.createHash('sha256').update(Buffer.from(paidPreimageHex, 'hex')).digest('hex');
const unpaidPaymentHashHex = crypto.createHash('sha256').update(Buffer.from('02'.repeat(32), 'hex')).digest('hex');

const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-token-'));
const tokenFile = path.join(tokenDir, 'token');
fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });

// A fake LND REST node. Payments it has made are listed on /v1/payments the way LND lists them (hex fields,
// newest first), so the sidecar can only treat a request as paid when LND itself reports it.
const lndCalls = [];
const lndPayments = [];
let lndFailNextPayment = false;
const fakeLnd = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    lndCalls.push({ method: req.method, path: req.url, macaroon: req.headers['grpc-metadata-macaroon'], body });
    if (lndFailNextPayment) {
      lndFailNextPayment = false;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no route to destination' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET' && req.url.startsWith('/v1/payments')) {
      res.end(JSON.stringify({ payments: [...lndPayments].reverse(), first_index_offset: '0', last_index_offset: '0' }));
      return;
    }
    lndPayments.push({
      payment_hash: paidPaymentHashHex,
      payment_preimage: paidPreimageHex,
      status: 'SUCCEEDED',
      value_sat: '12345'
    });
    res.end(JSON.stringify({
      payment_preimage: Buffer.from(paidPreimageHex, 'hex').toString('base64'),
      payment_hash: Buffer.from(paidPaymentHashHex, 'hex').toString('base64'),
      payment_route: {}
    }));
  });
});

fakeLnd.listen(0, '127.0.0.1', () => {
  process.env.LND_REST_URL = `http://127.0.0.1:${fakeLnd.address().port}`;
  process.env.LND_MACAROON_HEX = '00';
  process.env.LND_REST_INSECURE = '1';
  process.env.SIDECAR_API_TOKEN_FILE = tokenFile;
  process.env.SIDECAR_REQUEST_STORE_PATH = path.join(tokenDir, 'requests.json');
  process.env.SIDECAR_MAX_QUOTED_REQUESTS = '3';
  process.env.TL_PROCEDURAL_ADMIN_ADDRESS = ADMIN_ADDRESS;
  delete process.env.UTXOREF_LND_MAX_FEE_SATS;

  const sidecar = require('./server');
  const server = http.createServer((req, res) => sidecar.handle(req, res));
  server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    run(sidecar, base).then(
      () => {
        server.close();
        fakeLnd.close();
        fs.rmSync(tokenDir, { recursive: true, force: true });
        console.log('dlcSubswapHttp tests ok');
      },
      (err) => {
        console.error(err);
        process.exit(1);
      }
    );
  });
});

function quoteBody(paymentHashHex, invoice) {
  return {
    walletNodeId: 'electrum-tradelayer',
    requestedCollateralSats: '12345',
    swapFeeSats: '321',
    refundBlocks: 12,
    invoice,
    paymentHashHex
  };
}

async function post(base, route, body, { token = TOKEN, contentType = 'application/json' } = {}) {
  const headers = { 'content-type': contentType };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  return { status: response.status, headers: response.headers, json: await response.json().catch(() => ({})) };
}

async function run(sidecar, base) {
  const quoteRoute = '/v1/dlc-subswap-funding/quote';
  const payRoute = '/v1/dlc-subswap-funding/pay';
  const mintRoute = '/v1/dlc-subswap-funding/tlbtc-mint-intent';

  // Every POST route requires the bearer token; a refused call reaches neither the quote store nor LND.
  const noToken = await post(base, payRoute, { invoice: 'lntb-attacker' }, { token: '' });
  assert.strictEqual(noToken.status, 401);
  const wrongToken = await post(base, quoteRoute, quoteBody(paidPaymentHashHex, 'lntb-attacker'), { token: 'guess' });
  assert.strictEqual(wrongToken.status, 401);
  assert.strictEqual(lndCalls.length, 0);

  // A request with a caller-chosen invoice cannot be paid by naming the invoice.
  const bodyInvoice = await post(base, payRoute, { invoice: 'lntb-attacker', paymentHashHex: paidPaymentHashHex });
  assert.strictEqual(bodyInvoice.status, 404);
  assert.strictEqual(lndCalls.length, 0);

  // Quote the paid request. The caller's fee limit is not honoured; the quoted swap fee is.
  const quote = await post(base, quoteRoute, quoteBody(paidPaymentHashHex, 'lntb126660n1ptestinvoice'));
  assert.strictEqual(quote.status, 200);
  assert.strictEqual(quote.headers.get('access-control-allow-origin'), null);
  const requestId = quote.json.request.requestId;
  const pay = await post(base, payRoute, { requestId, feeLimitSats: '999999', invoice: 'lntb-attacker' });
  assert.strictEqual(pay.status, 200);
  assert.strictEqual(pay.json.paymentVerification.ok, true);
  const payments = lndCalls.filter((call) => call.method === 'POST');
  assert.strictEqual(payments.length, 1);
  assert.strictEqual(payments[0].body.payment_request, 'lntb126660n1ptestinvoice');
  assert.strictEqual(payments[0].body.fee_limit.fixed, '321');
  assert.strictEqual(payments[0].macaroon, '00');

  // A second payment attempt for the same request is refused.
  const repay = await post(base, payRoute, { requestId });
  assert.strictEqual(repay.status, 409);
  assert.strictEqual(lndCalls.filter((call) => call.method === 'POST').length, 1);

  // Mint intent: a request nobody paid cannot mint, whatever preimage and request the caller supplies.
  const unpaidQuote = await post(base, quoteRoute, quoteBody(unpaidPaymentHashHex, 'lntb-unpaid'));
  const forged = await post(base, mintRoute, {
    requestId: unpaidQuote.json.request.requestId,
    request: unpaidQuote.json.request,
    paymentProof: { paymentHashHex: unpaidPaymentHashHex, paymentPreimageHex: '02'.repeat(32) },
    recipientAddress: RECIPIENT
  });
  assert.strictEqual(forged.status, 400);
  assert.strictEqual(forged.json.ok, false);
  assert.strictEqual(forged.json.reason, 'payment is not settled in LND');
  assert.strictEqual(forged.json.tradeLayer, undefined);

  // A second pay of the paid request is refused by LND's record, not by memory, and LND is not called again.
  const alreadyPaid = await post(base, payRoute, { requestId });
  assert.strictEqual(alreadyPaid.status, 409);
  assert.strictEqual(lndCalls.filter((call) => call.method === 'POST').length, 1);

  const mint = await post(base, mintRoute, {
    requestId,
    fromAddress: 'tb1qattackerplaceholder000000000000000000000',
    settlementState: 'SETTLED',
    recipientAddress: RECIPIENT
  });
  assert.strictEqual(mint.status, 200);
  assert.strictEqual(mint.json.ok, true);
  assert.strictEqual(mint.json.tradeLayer.params.fromAddress, ADMIN_ADDRESS);
  assert.strictEqual(mint.json.tradeLayer.params.settlementState, 'FUNDED');
  assert.strictEqual(mint.json.tradeLayer.params.amountGranted, '0.00012345');

  // A restarted sidecar still knows the quoted request, and mints from LND's record of the payment.
  delete require.cache[require.resolve('./server')];
  const restarted = require('./server');
  const restartedServer = http.createServer((req, res) => restarted.handle(req, res));
  await new Promise((resolve) => restartedServer.listen(0, '127.0.0.1', resolve));
  try {
    const afterRestart = await post(`http://127.0.0.1:${restartedServer.address().port}`, mintRoute, {
      requestId,
      recipientAddress: RECIPIENT
    });
    assert.strictEqual(afterRestart.status, 200, 'a restart orphaned a paid request');
    assert.strictEqual(afterRestart.json.tradeLayer.params.amountGranted, '0.00012345');
  } finally {
    await new Promise((resolve) => restartedServer.close(resolve));
  }

  // A full quote table never refuses a new quote: the oldest request that is neither paying nor settled goes.
  // The paid request survives eviction, so it can still mint after the table turns over.
  const churn = [];
  for (let index = 0; index < 3; index++) {
    const hash = crypto.createHash('sha256').update(`churn-${index}`).digest('hex');
    churn.push(await post(base, quoteRoute, quoteBody(hash, `lntb-churn-${index}`)));
  }
  assert.ok(churn.every((quote) => quote.status === 200), 'a full quote table refused a new quote');
  const evictedUnpaid = await post(base, payRoute, { requestId: unpaidQuote.json.request.requestId });
  assert.strictEqual(evictedUnpaid.status, 404);
  const stillPaid = await post(base, mintRoute, { requestId, recipientAddress: RECIPIENT });
  assert.strictEqual(stillPaid.status, 200, 'eviction dropped a settled request');

  // An LND payment failure is a 502 that leaves the request payable: the next attempt is not refused as in flight.
  const failing = await post(base, quoteRoute, quoteBody(crypto.createHash('sha256').update('failing').digest('hex'), 'lntb-failing'));
  lndFailNextPayment = true;
  const failed = await post(base, payRoute, { requestId: failing.json.request.requestId });
  assert.strictEqual(failed.status, 502);
  assert.match(failed.json.reason || failed.json.error || '', /no route to destination/);
  const sentBeforeRetry = lndCalls.filter((call) => call.method === 'POST').length;
  await post(base, payRoute, { requestId: failing.json.request.requestId });
  assert.strictEqual(lndCalls.filter((call) => call.method === 'POST').length, sentBeforeRetry + 1,
    'a failed payment left the request stuck in flight');

  // Request shape: JSON only, and bodies are bounded. Malformed JSON is the client's error, not the server's.
  const textBody = await post(base, quoteRoute, JSON.stringify(quoteBody(unpaidPaymentHashHex, 'lntb-x')), { contentType: 'text/plain' });
  assert.strictEqual(textBody.status, 415);
  const huge = await post(base, quoteRoute, { invoice: 'x'.repeat(1024 * 1024) });
  assert.strictEqual(huge.status, 413);
  const malformed = await post(base, mintRoute, '{"requestId":', {});
  assert.strictEqual(malformed.status, 400);
  const notObject = await post(base, mintRoute, '[1]', {});
  assert.strictEqual(notObject.status, 400);

  // A token file readable by group or others is refused at startup.
  const looseFile = path.join(tokenDir, 'loose');
  fs.writeFileSync(looseFile, TOKEN, { mode: 0o644 });
  fs.chmodSync(looseFile, 0o644);
  assert.throws(() => sidecar.loadSidecarApiToken({ SIDECAR_API_TOKEN_FILE: looseFile }), /mode 0600/);
}
