'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildV2Handoff } = require('./index');

// Exercise the real imported UTXORef V2 commitment builder, without a bitcoin
// network, oracle endpoint, signer, or transaction broadcaster.
test('real UTXORef V2 builder commits to exact collateral, payout vector and fee', () => {
  const contractId = '42'.repeat(32);
  const txid = 'aa'.repeat(32);
  const epoch = {
    epochId: '27',
    selections: [{
      contractId,
      funding: {
        txid,
        vout: 0,
        amountSats: '25000000',
        scriptPubKeyHex: '5120' + '33'.repeat(32)
      },
      holderScriptPubKeyHex: '0014' + '01'.repeat(20),
      writerScriptPubKeyHex: '0014' + '02'.repeat(20),
      row: { holderSats: '12500000', writerSats: '12499000', feeSats: '1000' }
    }]
  };
  const result = buildV2Handoff(epoch, {
    network: 'bitcoin-testnet4',
    chainGenesisHash: '11'.repeat(32),
    stateCheckpointHash: '22'.repeat(32),
    operatorXonly: '44'.repeat(32),
    challengerXonly: '55'.repeat(32),
    challengeCsvBlocks: 144,
    recoveryCsvBlocks: 2016
  });
  assert.equal(result.length, 1);
  const commitment = result[0];
  assert.match(commitment.commitmentHash, /^[a-f0-9]{64}$/);
  assert.equal(commitment.core.contractId, contractId);
  assert.equal(commitment.core.fundingCount, 1);
  assert.equal(commitment.core.fundingTotalSats, '25000000');
  assert.equal(commitment.core.feeSats, '1000');
  assert.equal(commitment.core.payoutCount, 2);
  assert.equal(commitment.core.payoutTotalSats, '24999000');
  assert.equal(commitment.core.stateCheckpointHash, '22'.repeat(32));
  assert.equal(commitment.funding[0].txid, txid);
  assert.deepEqual(commitment.outputs.map(x => x.valueSats), ['12500000', '12499000']);
});
