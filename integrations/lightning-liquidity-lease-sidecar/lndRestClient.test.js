const assert = require('assert');
const crypto = require('crypto');
const {
  buildLndRestConfig,
  decodeLndByteString,
  paymentHashFromPreimageHex,
  payInvoiceViaLndRest,
  lookupPaymentViaLndRest
} = require('./lndRestClient');

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

  // LND's track endpoint for these tests: GET /v2/router/track/{payment_hash} (hash as base64) answers the payment as
  // {"result": payment}, and 404 for a hash it never initiated, with no body error code beyond the HTTP status.
  const trackLnd = (payments, calls = []) => async (config, method, pathname, body, timeoutMs) => {
    assert.strictEqual(method, 'GET');
    calls.push({ pathname, timeoutMs });
    const url = new URL(pathname, 'http://lnd.test');
    const prefix = '/v2/router/track/';
    assert(url.pathname.startsWith(prefix), `unexpected LND path ${pathname}`);
    assert.strictEqual(url.searchParams.get('no_inflight_updates'), 'true');
    const hash = Buffer.from(decodeURIComponent(url.pathname.slice(prefix.length)), 'base64').toString('hex');
    const payment = payments.find(p => p.payment_hash === hash);
    if (!payment) {
      const err = new Error(`LND REST ${url.pathname} returned HTTP 404: {"error":"payment isn't initiated","code":5}`);
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
  }), { state: 'settled', paymentHashHex: oldHashHex, paymentPreimageHex: oldPreimageHex },
  'a payment behind 5000 newer ones was not found');
  assert.strictEqual(calls.length, 1, 'the lookup asked LND more than once');
  assert.strictEqual(calls[0].pathname, `/v2/router/track/${encodeURIComponent(Buffer.from(oldHashHex, 'hex').toString('base64'))}?no_inflight_updates=true`);
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
}

run().then(
  () => console.log('lndRestClient tests ok'),
  err => {
    console.error(err);
    process.exit(1);
  }
);
