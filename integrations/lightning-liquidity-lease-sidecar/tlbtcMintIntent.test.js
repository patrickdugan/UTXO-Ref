const assert = require('assert');
const crypto = require('crypto');
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

const intent = buildTlbtcMintIntent({
  request,
  paymentProof,
  recipientAddress: 'tb1qwvzaayzrgreqyyvxp77wlr60ngaqnpcyhujz2m'
});
assert.strictEqual(intent.ok, true);
assert.strictEqual(intent.tradeLayer.method, 'tl_createGrantManagedTokenTransaction');
assert.strictEqual(intent.tradeLayer.params.propertyId, 1);
assert.strictEqual(intent.tradeLayer.params.amountGranted, '0.00049000');
assert.strictEqual(intent.tradeLayer.params.settlementState, 'FUNDED');
assert(intent.tradeLayer.params.dlcHash);

const livePreimageHex = '01'.repeat(32);
const livePaymentHashHex = crypto.createHash('sha256').update(Buffer.from(livePreimageHex, 'hex')).digest('hex');
const liveRequest = latestDlcSubswapFundingRequest({
  walletNodeId: 'electrum-tradelayer',
  requestedCollateralSats: '12345',
  swapFeeSats: '321',
  refundBlocks: 12,
  invoice: 'lntb126660n1ptestinvoice',
  paymentHashHex: livePaymentHashHex
});
assert.strictEqual(liveRequest.executionProof, null);
assert.strictEqual(liveRequest.requestCore.submarineSwap.invoice, 'lntb126660n1ptestinvoice');
assert.strictEqual(liveRequest.requestCore.submarineSwap.requestedCollateralSats, '12345');
assert.strictEqual(liveRequest.requestCore.submarineSwap.swapFeeSats, '321');

const liveIntent = buildTlbtcMintIntent({
  request: liveRequest,
  paymentProof: {
    paymentHashHex: livePaymentHashHex,
    paymentPreimageHex: livePreimageHex
  },
  recipientAddress: 'tb1qwvzaayzrgreqyyvxp77wlr60ngaqnpcyhujz2m'
});
assert.strictEqual(liveIntent.ok, true);
assert.strictEqual(liveIntent.tradeLayer.params.amountGranted, '0.00012345');

console.log('tlbtcMintIntent tests ok');
