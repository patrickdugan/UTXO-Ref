const assert = require('assert');
const crypto = require('crypto');
const {
  buildLndRestConfig,
  decodeLndByteString,
  paymentHashFromPreimageHex,
  payInvoiceViaLndRest,
  findSettledPaymentViaLndRest
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

  // LND lists payments newest first; a settled payment is found by hash on any page, and only SUCCEEDED counts.
  const env = { LND_REST_URL: 'http://127.0.0.1:8080', LND_MACAROON_HEX: '00' };
  const otherHash = crypto.createHash('sha256').update(Buffer.from('22'.repeat(32), 'hex')).digest('hex');
  const pages = [
    { payments: [{ payment_hash: otherHash, status: 'SUCCEEDED', payment_preimage: '22'.repeat(32) }], first_index_offset: '40' },
    { payments: [
      { payment_hash: paymentHashHex, status: 'FAILED', payment_preimage: '' },
      { payment_hash: paymentHashHex, status: 'SUCCEEDED', payment_preimage: preimageHex }
    ], first_index_offset: '20' }
  ];
  const seen = [];
  const found = await findSettledPaymentViaLndRest({
    paymentHashHex,
    env,
    pageSize: 1,
    requestImpl: async (_config, method, pathname) => {
      assert.strictEqual(method, 'GET');
      seen.push(pathname);
      return pages.shift() || { payments: [] };
    }
  });
  assert.deepStrictEqual(found, { paymentHashHex, paymentPreimageHex: preimageHex });
  assert.match(seen[0], /reversed=true/);
  assert.match(seen[1], /index_offset=40/, 'the scan must continue from the first index of the previous page');

  assert.strictEqual(await findSettledPaymentViaLndRest({
    paymentHashHex,
    env,
    requestImpl: async () => ({ payments: [{ payment_hash: paymentHashHex, status: 'SUCCEEDED', payment_preimage: '33'.repeat(32) }] })
  }), null, 'a preimage that does not hash to the payment hash is not a settlement');
  assert.strictEqual(await findSettledPaymentViaLndRest({ paymentHashHex, env, requestImpl: async () => ({ payments: [] }) }), null);
  await assert.rejects(findSettledPaymentViaLndRest({
    paymentHashHex,
    env,
    pageSize: 1,
    maxPages: 2,
    requestImpl: async () => ({ payments: [{ payment_hash: otherHash }], first_index_offset: '9' })
  }), /exceeded 2 pages/);
  await assert.rejects(findSettledPaymentViaLndRest({ paymentHashHex: 'abc', env }), /32 bytes of hex/);
  await assert.rejects(findSettledPaymentViaLndRest({ paymentHashHex, env: {} }), /LND REST not configured/);
}

run().then(
  () => console.log('lndRestClient tests ok'),
  err => {
    console.error(err);
    process.exit(1);
  }
);
