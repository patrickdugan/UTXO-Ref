const assert = require('assert');
const {
  buildTlbtcMintIntent,
  latestDlcSubswapFundingRequest,
  verifyPaymentProofForRequest
} = require('./server');

const request = latestDlcSubswapFundingRequest();
const paymentProof = {
  paymentHashHex: request.executionProof.paymentHashHex,
  paymentPreimageHex: request.executionProof.paymentPreimageHex
};

const proofCheck = verifyPaymentProofForRequest(request, paymentProof);
assert.strictEqual(proofCheck.ok, true);

const forgedCheck = verifyPaymentProofForRequest(request, { paymentPreimageHex: '01'.repeat(32) });
assert.strictEqual(forgedCheck.ok, false);

// A mint intent exists only for a request this process quoted and paid. The artifact's recorded
// execution proof and any caller-supplied preimage are not enough; see dlcSubswapHttp.test.js for the paid path.
const intent = buildTlbtcMintIntent({
  requestId: request.requestId,
  recipientAddress: 'tb1qwvzaayzrgreqyyvxp77wlr60ngaqnpcyhujz2m'
});
assert.strictEqual(intent.ok, false);
assert.strictEqual(intent.reason, 'unknown requestId: quote and pay the request first');
assert.strictEqual(intent.tradeLayer, undefined);

console.log('tlbtcMintIntent tests ok');
