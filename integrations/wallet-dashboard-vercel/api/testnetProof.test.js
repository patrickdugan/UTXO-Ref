const assert = require('assert/strict');
const { buildBitcoinTestnetProof, findProofStep } = require('./testnetProof');

const proof = buildBitcoinTestnetProof();

assert.equal(proof.kind, 'bitcoin_testnet4_cross_domain_proof');
assert.equal(proof.network, 'testnet4');
assert.equal(proof.summary.txCount, 14);
assert.match(proof.summary.firstTxid, /^[0-9a-f]{64}$/);
assert.match(proof.summary.finalTxid, /^[0-9a-f]{64}$/);

for (const step of proof.steps) {
  assert.match(step.txid, /^[0-9a-f]{64}$/);
  assert.equal(step.explorer, `${proof.explorerBase}${step.txid}`);
}

for (const label of ['subswap-dlc-funding', 'fund-counterparty-address', 'mint-tlbtc-counterparty-dlc', 'short-mints-tlusd', 'make-tap-asset-tlusd', 'ark-liquidity-graft']) {
  assert.equal(findProofStep(label).label, label);
}

console.log('bitcoin testnet proof txids ok');
