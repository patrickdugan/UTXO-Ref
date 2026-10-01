const assert = require('assert');
const crypto = require('crypto');
const {
  buildLndRestConfig,
  decodeLndByteString,
  paymentHashFromPreimageHex,
  payInvoiceViaLndRest
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
    requestImpl: async (_config, pathname, body) => {
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
}

run().then(
  () => console.log('lndRestClient tests ok'),
  err => {
    console.error(err);
    process.exit(1);
  }
);
