const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const {
  buildLndRestConfig,
  decodeLndByteString,
  paymentHashFromPreimageHex,
  parseLndBody,
  payInvoiceViaLndRest,
  lookupPaymentViaLndRest,
  trackedPaymentOf
} = require('./lndRestClient');
const { routeTrackRequest } = require('./lndTrackGateway');

const urlBase64 = hashHex => Buffer.from(hashHex, 'hex').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const stdBase64 = hex => Buffer.from(hex, 'hex').toString('base64');

async function run() {
  const missing = buildLndRestConfig({});
  assert.strictEqual(missing.configured, false);
  assert(missing.missing.includes('LND_MACAROON_PATH or LND_MACAROON_HEX'));

  const preimageHex = '11'.repeat(32);
  const paymentHashHex = crypto.createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');
  assert.strictEqual(paymentHashFromPreimageHex(preimageHex), paymentHashHex);
  assert.strictEqual(decodeLndByteString(Buffer.from(preimageHex, 'hex').toString('base64')), preimageHex);

  const proof = await payInvoiceViaLndRest({
    invoice: 'lnbcrt-demo',
    feeLimitSats: 12,
    paymentHashHex,
    env: {
      LND_REST_URL: 'http://127.0.0.1:8080',
      LND_MACAROON_HEX: '00'
    },
    requestImpl: async (_config, method, pathname, body) => {
      assert.strictEqual(method, 'POST');
      assert.strictEqual(pathname, '/v1/channels/transactions');
      assert.strictEqual(body.payment_request, 'lnbcrt-demo');
      assert.strictEqual(body.fee_limit.fixed, '12');
      return {
        payment_preimage: Buffer.from(preimageHex, 'hex').toString('base64'),
        payment_hash: Buffer.from(paymentHashHex, 'hex').toString('base64')
      };
    }
  });
  assert.strictEqual(proof.status, 'paid');
  assert.strictEqual(proof.paymentPreimageHex, preimageHex);
  assert.strictEqual(proof.paymentHashHex, paymentHashHex);

  // LND's track endpoint for these tests: GET /v2/router/track/{payment_hash} answers the payment as {"result": payment},
  // and 404 for a hash it never initiated. The route is matched as the gateway matches it (lndTrackGateway.js).
  const trackLnd = (payments, calls = []) => async (config, method, pathname, body, timeoutMs) => {
    assert.strictEqual(method, 'GET');
    calls.push({ pathname, timeoutMs });
    assert.strictEqual(new URL(pathname, 'http://lnd.test').searchParams.get('no_inflight_updates'), 'true');
    const hash = routeTrackRequest(pathname);
    if (hash === null) {
      const err = new Error(`LND REST ${pathname} returned HTTP 404: Not Found`);
      err.statusCode = 404;
      throw err;
    }
    const payment = payments.find(p => p.payment_hash === hash);
    if (!payment) {
      const err = new Error(`LND REST ${pathname} returned HTTP 404: {"error":"payment isn't initiated","code":5}`);
      err.statusCode = 404;
      throw err;
    }
    return { result: payment };
  };

  // A payment the sidecar paid is found by its hash, whatever else the node has paid: 5001 newer payments sit above it.
  const env = { LND_REST_URL: 'http://127.0.0.1:8080', LND_MACAROON_HEX: '00' };
  const otherHash = crypto.createHash('sha256').update(Buffer.from('22'.repeat(32), 'hex')).digest('hex');
  const oldPreimageHex = '44'.repeat(32);
  const oldHashHex = paymentHashFromPreimageHex(oldPreimageHex);
  const payments = [
    { payment_hash: oldHashHex, status: 'SUCCEEDED', payment_preimage: oldPreimageHex },
    { payment_hash: otherHash, status: 'SUCCEEDED', payment_preimage: '22'.repeat(32) }
  ];
  for (let i = 0; i < 5001; i++) {
    const fillerPreimage = (0x100000 + i).toString(16).padStart(64, '0');
    payments.push({ payment_hash: paymentHashFromPreimageHex(fillerPreimage), status: 'SUCCEEDED', payment_preimage: fillerPreimage });
  }
  const calls = [];
  assert.deepStrictEqual(await lookupPaymentViaLndRest({
    paymentHashHex: oldHashHex,
    env,
    requestImpl: trackLnd(payments, calls)
  }), { state: 'settled', paymentHashHex: oldHashHex, paymentPreimageHex: oldPreimageHex, valueMsat: null },
  'a payment behind 5000 newer ones was not found');
  assert.strictEqual(calls.length, 1, 'the lookup asked LND more than once');
  assert.strictEqual(calls[0].pathname, `/v2/router/track/${encodeURIComponent(urlBase64(oldHashHex))}?no_inflight_updates=true`);
  assert.strictEqual(calls[0].timeoutMs, 10000, 'the lookup has no timeout');

  const failedPreimageHex = '55'.repeat(32);
  const failedHashHex = paymentHashFromPreimageHex(failedPreimageHex);
  const failedLnd = trackLnd([{ payment_hash: failedHashHex, status: 'FAILED', payment_preimage: '' }]);
  assert.deepStrictEqual(await lookupPaymentViaLndRest({ paymentHashHex: failedHashHex, env, requestImpl: failedLnd }), { state: 'failed' });
  assert.deepStrictEqual(await lookupPaymentViaLndRest({ paymentHashHex: oldHashHex, env, requestImpl: failedLnd }), { state: 'unknown' },
    'a hash LND never initiated is unknown, not failed');
  const lndError = (statusCode, text) => async () => {
    const err = new Error(`LND REST /v2/router/track returned HTTP ${statusCode}: ${text}`);
    err.statusCode = statusCode;
    throw err;
  };
  assert.deepStrictEqual(await lookupPaymentViaLndRest({ paymentHashHex: oldHashHex, env,
    requestImpl: lndError(500, '{"code":2,"message":"payment isn\'t initiated"}') }), { state: 'unknown' },
  'a 500 that says the payment was never initiated is unknown');
  await assert.rejects(lookupPaymentViaLndRest({ paymentHashHex: oldHashHex, env,
    requestImpl: lndError(500, '{"code":2,"message":"database is locked"}') }), /HTTP 500/,
  'any other 500 is an error, not an answer');
  assert.deepStrictEqual(await lookupPaymentViaLndRest({ paymentHashHex: oldHashHex, env, requestImpl: trackLnd([
    { payment_hash: oldHashHex, status: 'IN_FLIGHT', payment_preimage: '' }
  ]) }), { state: 'pending' });
  assert.deepStrictEqual(await lookupPaymentViaLndRest({ paymentHashHex: oldHashHex, env, requestImpl: trackLnd([
    { payment_hash: oldHashHex, status: 'SUCCEEDED', payment_preimage: '33'.repeat(32) }
  ]) }), { state: 'pending' }, 'a preimage that does not hash to the payment hash is not a settlement');
  await assert.rejects(lookupPaymentViaLndRest({ paymentHashHex: oldHashHex, env, requestImpl: async () => ({
    result: { payment_hash: otherHash, status: 'SUCCEEDED', payment_preimage: '22'.repeat(32) }
  }) }), /does not name the requested payment hash/, 'an answer for another hash was taken');
  await assert.rejects(lookupPaymentViaLndRest({ paymentHashHex: oldHashHex, env, requestImpl: async () => {
    throw new Error('LND REST timed out');
  } }), /timed out/, 'a transport error was read as an answer');
  await assert.rejects(lookupPaymentViaLndRest({ paymentHashHex: 'abc', env }), /32 bytes of hex/);
  await assert.rejects(lookupPaymentViaLndRest({ paymentHashHex: oldHashHex, env: {} }), /LND REST not configured/);

  // The answer parser: one function reads a body, one reads a track answer. Each is a table.
  const one = { payment_hash: oldHashHex, status: 'SUCCEEDED', payment_preimage: oldPreimageHex };
  const inFlight = { payment_hash: oldHashHex, status: 'IN_FLIGHT', payment_preimage: '' };
  const bodies = [
    ['empty body', '', {}],
    ['one JSON object', JSON.stringify({ result: one }), { result: one }],
    ['NDJSON stream, the last line is the answer', `${JSON.stringify({ result: inFlight })}\n${JSON.stringify({ result: one })}\n`, { result: one }],
    ['NDJSON with blank lines', `\n${JSON.stringify({ result: inFlight })}\n\n${JSON.stringify({ result: one })}\n\n`, { result: one }],
    ['NDJSON whose last line is garbage: the last line that parses', `${JSON.stringify({ result: one })}\nnot json`, { result: one }],
    ['bare payment object', JSON.stringify(one), one],
    ['text that is no JSON', 'not json at all', { raw: 'not json at all' }]
  ];
  for (const [name, text, parsed] of bodies) {
    assert.deepStrictEqual(parseLndBody(text), parsed, name);
  }
  const notInitiated = { error: { code: 5, message: "payment isn't initiated", details: [] } };
  const track = [
    ['{result: payment}', { result: one }, one],
    ['bare payment object', one, one],
    ['{error: NOT_FOUND}: LND never initiated the hash', notInitiated, null],
    ['{error: NOT_FOUND} with a null result', { error: { code: 5 }, result: null }, null],
    ['{error: a gRPC code other than NOT_FOUND}', { error: { code: 13, message: 'database is locked' } }, /LND track answer is an error/],
    ['{error} as a string', { error: 'payment isn\'t initiated' }, /LND track answer is an error/],
    ['{raw} from a body that is no JSON', { raw: 'garbage' }, /unparseable LND answer/],
    ['{result} with no payment', { result: null }, /unparseable LND answer/],
    ['an empty object', {}, /unparseable LND answer/],
    ['no answer at all', null, /unparseable LND answer/]
  ];
  for (const [name, answer, expected] of track) {
    if (expected instanceof RegExp) assert.throws(() => trackedPaymentOf(answer), expected, name);
    else assert.deepStrictEqual(trackedPaymentOf(answer), expected, name);
  }
  // A stream answer read through the lookup: the in-flight line is not the answer, the settled line is.
  const stream = `${JSON.stringify({ result: inFlight })}\n${JSON.stringify({ result: one })}\n`;
  assert.deepStrictEqual(await lookupPaymentViaLndRest({ paymentHashHex: oldHashHex, env, requestImpl: async () => parseLndBody(stream) }),
    { state: 'settled', paymentHashHex: oldHashHex, paymentPreimageHex: oldPreimageHex, valueMsat: null });

  // The real request path, to a loopback LND that routes the way the gateway does. Over many hashes, about half have
  // '/' in their standard base64 and some have '+': each must reach its payment. The answers are a single object, a
  // bare object, and an NDJSON stream whose last line is the answer.
  const loopbackPayments = new Map();
  const streamed = new Set();
  const lnd = http.createServer((req, res) => {
    const hash = routeTrackRequest(req.url);
    if (hash === null) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const payment = loopbackPayments.get(hash);
    if (!payment) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: "payment isn't initiated", message: "payment isn't initiated", code: 5, details: [] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (streamed.has(hash)) {
      res.end(`${JSON.stringify({ result: { ...payment, status: 'IN_FLIGHT', payment_preimage: '' } })}\n${JSON.stringify({ result: payment })}\n`);
    } else {
      res.end(JSON.stringify({ result: payment }));
    }
  });
  await new Promise(resolve => lnd.listen(0, '127.0.0.1', resolve));
  try {
    const loopbackEnv = { LND_REST_URL: `http://127.0.0.1:${lnd.address().port}`, LND_MACAROON_HEX: '00' };
    let withSlash = 0;
    let withPlus = 0;
    for (let i = 0; i < 400; i++) {
      const preimageHex = crypto.createHash('sha256').update(`track-preimage-${i}`).digest('hex');
      const hashHex = paymentHashFromPreimageHex(preimageHex);
      const std = stdBase64(hashHex);
      if (std.includes('/')) withSlash++;
      if (std.includes('+')) withPlus++;
      loopbackPayments.set(hashHex, { payment_hash: stdBase64(hashHex), status: 'SUCCEEDED', payment_preimage: stdBase64(preimageHex) });
      if (i % 3 === 1) streamed.add(hashHex);
      assert.deepStrictEqual(await lookupPaymentViaLndRest({ paymentHashHex: hashHex, env: loopbackEnv }),
        { state: 'settled', paymentHashHex: hashHex, paymentPreimageHex: preimageHex, valueMsat: null }, `hash ${i} (${std}) was not found`);
    }
    assert(withSlash > 100, 'the sample has too few hashes with a slash in standard base64');
    assert(withPlus > 0, 'the sample has no hash with a plus in standard base64');
    const unknownHash = paymentHashFromPreimageHex('66'.repeat(32));
    assert.deepStrictEqual(await lookupPaymentViaLndRest({ paymentHashHex: unknownHash, env: loopbackEnv }), { state: 'unknown' });
  } finally {
    lnd.close();
  }
}

run().then(
  () => console.log('lndRestClient tests ok'),
  err => {
    console.error(err);
    process.exit(1);
  }
);
