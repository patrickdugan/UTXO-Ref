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

const lndCalls = [];
const fakeLnd = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    lndCalls.push({ path: req.url, macaroon: req.headers['grpc-metadata-macaroon'], body });
    res.writeHead(200, { 'content-type': 'application/json' });
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
  assert.strictEqual(lndCalls.length, 1);
  assert.strictEqual(lndCalls[0].body.payment_request, 'lntb126660n1ptestinvoice');
  assert.strictEqual(lndCalls[0].body.fee_limit.fixed, '321');
  assert.strictEqual(lndCalls[0].macaroon, '00');

  // A second payment attempt for the same request is refused.
  const repay = await post(base, payRoute, { requestId });
  assert.strictEqual(repay.status, 409);
  assert.strictEqual(lndCalls.length, 1);

  // Mint intent: a caller-supplied preimage and request body are ignored.
  const unpaidQuote = await post(base, quoteRoute, quoteBody(unpaidPaymentHashHex, 'lntb-unpaid'));
  const forged = await post(base, mintRoute, {
    requestId: unpaidQuote.json.request.requestId,
    request: unpaidQuote.json.request,
    paymentProof: { paymentHashHex: unpaidPaymentHashHex, paymentPreimageHex: '02'.repeat(32) },
    recipientAddress: RECIPIENT
  });
  assert.strictEqual(forged.status, 400);
  assert.strictEqual(forged.json.ok, false);
  assert.strictEqual(forged.json.tradeLayer, undefined);

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

  // Request shape: JSON only, and bodies are bounded.
  const textBody = await post(base, quoteRoute, JSON.stringify(quoteBody(unpaidPaymentHashHex, 'lntb-x')), { contentType: 'text/plain' });
  assert.strictEqual(textBody.status, 415);
  const huge = await post(base, quoteRoute, { invoice: 'x'.repeat(1024 * 1024) });
  assert.strictEqual(huge.status, 413);

  // A token file readable by group or others is refused at startup.
  const looseFile = path.join(tokenDir, 'loose');
  fs.writeFileSync(looseFile, TOKEN, { mode: 0o644 });
  fs.chmodSync(looseFile, 0o644);
  assert.throws(() => sidecar.loadSidecarApiToken({ SIDECAR_API_TOKEN_FILE: looseFile }), /mode 0600/);
}
