const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { routeTrackRequest } = require('./lndTrackGateway');
// What LND records as paid for a settled payment: the invoice amount, collateral 12345 plus fee 321.
const INVOICE_AMOUNT_SATS = '12666';

// The sidecar runs as a child process here, so a crash is a real SIGKILL. The payment attempt is saved before LND is
// asked. A process killed while LND has not answered therefore leaves the request open after a restart: LND decides
// it, and a payment LND settled mints.

const TOKEN = 'test-sidecar-token-crash';
const ADMIN_ADDRESS = 'tb1qadminplaceholder0000000000000000000000';
const RECIPIENT = 'tb1qwvzaayzrgreqyyvxp77wlr60ngaqnpcyhujz2m';
const TTL_SECONDS = 1;
const QUOTE = '/v1/dlc-subswap-funding/quote';
const PAY = '/v1/dlc-subswap-funding/pay';
const MINT = '/v1/dlc-subswap-funding/tlbtc-mint-intent';
const TRACK = '/v2/router/track/';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-crash-'));
const tokenFile = path.join(dir, 'token');
fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
const storePath = path.join(dir, 'requests.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

function payment(i) {
  const preimageHex = sha256Hex(`crash-preimage-${i}`);
  return { invoice: `lntb-crash-${i}`, preimageHex, paymentHashHex: sha256Hex(Buffer.from(preimageHex, 'hex')) };
}

// The fake LND. While `hold` is set, a payment is never answered and never recorded: LND has not got it, as when the
// sidecar dies before its call completes.
const knownInvoices = new Map();
const lndPayments = [];
const lndPaymentCalls = [];
let hold = false;
const fakeLnd = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (req.method === 'GET' && req.url.startsWith(TRACK)) {
      const found = lndPayments.find((p) => p.payment_hash === routeTrackRequest(req.url));
      res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(found ? { result: found } : { error: "payment isn't initiated", code: 5, details: [] }));
      return;
    }
    const known = knownInvoices.get(JSON.parse(raw || '{}').payment_request);
    lndPaymentCalls.push(known ? known.invoice : null);
    if (hold) return;
    lndPayments.push({ payment_hash: known.paymentHashHex, payment_preimage: known.preimageHex, status: 'SUCCEEDED', value_sat: INVOICE_AMOUNT_SATS });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      payment_preimage: Buffer.from(known.preimageHex, 'hex').toString('base64'),
      payment_hash: Buffer.from(known.paymentHashHex, 'hex').toString('base64'),
      payment_route: {}
    }));
  });
});

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

const children = [];
async function startSidecar() {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      LND_REST_URL: `http://127.0.0.1:${fakeLnd.address().port}`,
      LND_MACAROON_HEX: '00',
      LND_REST_INSECURE: '1',
      SIDECAR_API_TOKEN_FILE: tokenFile,
      SIDECAR_REQUEST_STORE_PATH: storePath,
      SIDECAR_QUOTE_TTL_SECONDS: String(TTL_SECONDS),
      TL_PROCEDURAL_ADMIN_ADDRESS: ADMIN_ADDRESS
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(base);
      break;
    } catch (err) {
      if (attempt > 100) throw err;
      await sleep(50);
    }
  }
  return {
    base,
    kill: async () => {
      const exited = new Promise((resolve) => child.on('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
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

function storeEntries() {
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf8')).entries;
  } catch (_err) {
    return [];
  }
}

function entryState(requestId) {
  const entry = storeEntries().find((e) => e.request.requestId === requestId);
  return entry ? entry.state : null;
}

async function waitForState(requestId, state, message) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (entryState(requestId) === state) return;
    await sleep(20);
  }
  throw new Error(`${message} (store has ${entryState(requestId)})`);
}

// Quotes and starts a pay that LND never answers, waits until the attempt is saved, then kills the sidecar.
async function crashWhileLndPending(i) {
  const node = await startSidecar();
  const p = payment(i);
  knownInvoices.set(p.invoice, p);
  const quoted = await post(node.base, QUOTE, {
    walletNodeId: 'electrum-tradelayer',
    requestedCollateralSats: '12345',
    swapFeeSats: '321',
    refundBlocks: 12,
    invoice: p.invoice,
    paymentHashHex: p.paymentHashHex
  });
  assert.strictEqual(quoted.status, 200, `quote ${i} was refused`);
  const requestId = quoted.json.request.requestId;
  hold = true;
  const unanswered = post(node.base, PAY, { requestId }).catch(() => null);
  await waitForState(requestId, 'attempted', `request ${i} was not saved as attempted before LND was asked`);
  await node.kill();
  await unanswered;
  hold = false;
  return { requestId, paymentHashHex: p.paymentHashHex };
}

async function main() {
  // LND never got the payment. After the TTL a quote arrives: the attempted request is still open, LND has no record
  // of it, so a pay of it is made and the payment mints.
  const neverReached = await crashWhileLndPending(70);
  const restartedA = await startSidecar();
  await sleep(TTL_SECONDS * 1000 + 300);
  const quoteAfterTtl = await post(restartedA.base, QUOTE, {
    walletNodeId: 'electrum-tradelayer',
    requestedCollateralSats: '12345',
    swapFeeSats: '321',
    refundBlocks: 12,
    invoice: payment(71).invoice,
    paymentHashHex: payment(71).paymentHashHex
  });
  knownInvoices.set(payment(71).invoice, payment(71));
  assert.strictEqual(quoteAfterTtl.status, 200);
  assert.strictEqual(entryState(neverReached.requestId), 'attempted', 'an attempted request was pruned after a restart');
  const paidA = await post(restartedA.base, PAY, { requestId: neverReached.requestId });
  assert.strictEqual(paidA.status, 200, `an attempted request LND never received could not be paid: ${JSON.stringify(paidA.json)}`);
  const mintedA = await post(restartedA.base, MINT, { requestId: neverReached.requestId, recipientAddress: RECIPIENT });
  assert.strictEqual(mintedA.status, 200, `the paid request did not mint: ${JSON.stringify(mintedA.json)}`);
  await restartedA.kill();
  console.log('  OK  a sidecar killed after the attempt was saved, with LND never reached, pays and mints after a restart');

  // LND settled the payment before the restart. After the TTL a quote arrives: the attempted request is still open and
  // LND's settlement makes it paid, so it mints without a second payment.
  const settledBefore = await crashWhileLndPending(72);
  const callsBeforeMint = lndPaymentCalls.length;
  lndPayments.push({ payment_hash: settledBefore.paymentHashHex, payment_preimage: payment(72).preimageHex, status: 'SUCCEEDED', value_sat: INVOICE_AMOUNT_SATS });
  const restartedB = await startSidecar();
  await sleep(TTL_SECONDS * 1000 + 300);
  knownInvoices.set(payment(73).invoice, payment(73));
  const quoteB = await post(restartedB.base, QUOTE, {
    walletNodeId: 'electrum-tradelayer',
    requestedCollateralSats: '12345',
    swapFeeSats: '321',
    refundBlocks: 12,
    invoice: payment(73).invoice,
    paymentHashHex: payment(73).paymentHashHex
  });
  assert.strictEqual(quoteB.status, 200);
  assert.strictEqual(entryState(settledBefore.requestId), 'paid', 'LND settled the payment but the request was not kept as paid');
  const mintedB = await post(restartedB.base, MINT, { requestId: settledBefore.requestId, recipientAddress: RECIPIENT });
  assert.strictEqual(mintedB.status, 200, `a payment LND settled before the restart did not mint: ${JSON.stringify(mintedB.json)}`);
  assert.strictEqual(lndPaymentCalls.length, callsBeforeMint, 'a settled payment was paid again');
  await restartedB.kill();
  console.log('  OK  a sidecar killed after the attempt was saved, with LND settling the payment, mints after a restart without paying again');
}

fakeLnd.listen(0, '127.0.0.1', () => {
  main().then(
    () => {
      cleanup();
      console.log('dlcSubswapCrash tests ok');
    },
    (err) => {
      cleanup();
      console.error(err);
      process.exit(1);
    }
  );
});

function cleanup() {
  for (const child of children) child.kill('SIGKILL');
  fakeLnd.closeAllConnections();
  fakeLnd.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
