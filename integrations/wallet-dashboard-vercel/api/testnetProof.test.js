const assert = require('assert/strict');
const { buildBitcoinTestnetProof, findProofStep } = require('./testnetProof');

const proof = buildBitcoinTestnetProof();

assert.equal(proof.kind, 'bitcoin_testnet4_dashboard_proof');
assert.equal(proof.network, 'testnet4');
assert.equal(proof.summary.txCount, 18);
assert.equal(proof.summary.setupTxCount, 17);
assert.match(proof.summary.anchorTxid, /^[0-9a-f]{64}$/);
assert.match(proof.summary.finalTxid, /^[0-9a-f]{64}$/);

for (const step of proof.steps) {
  assert.match(step.txid, /^[0-9a-f]{64}$/);
  assert.equal(step.explorer, `${proof.explorerBase}${step.txid}`);
}

for (const label of ['demo-anchor', 'issue-tlbtc', 'issue-tlusd', 'relay-bitvm-dlc-funded', 'externalize-tlusd-tx33']) {
  assert.equal(findProofStep(label).label, label);
}

console.log('bitcoin testnet proof txids ok');
