const assert = require('assert/strict');
const { buildDashboardShinigamiProof } = require('./shinigamiProof');

const proof = buildDashboardShinigamiProof();
const projection = proof.projection;

assert.equal(proof.kind, 'shinigami_virtual_cet_dashboard_proof');
assert.equal(proof.verification.ok, true);
assert.equal(proof.source, 'utxoref-shinigami-virtual-cet-ark');
assert.match(proof.bundleId, /^[0-9a-f]{64}$/);
assert.match(proof.claimId, /^[0-9a-f]{64}$/);
assert.match(proof.receiptId, /^[0-9a-f]{64}$/);
assert.equal(projection.summary.virtualCetCount, 17);
assert.equal(projection.summary.materializedCetCount, 0);
assert.equal(projection.flow.length, 4);
assert.equal(projection.proofStatement.claimId, proof.claimId);
assert.equal(projection.proofStatement.receiptId, proof.receiptId);
assert.equal(projection.compression.onchainCetTxidsPublished, 0);
assert.equal(projection.compression.arkLeafCount, projection.summary.virtualCetCount);
assert.ok(projection.publicInputs.includes('ark_leaf_root'));
assert.ok(projection.publicInputs.includes('payout_root'));
assert.ok(projection.fraudMatrix.some(item => item.id === 'stale-oracle'));
assert.ok(projection.fraudMatrix.some(item => item.id === 'asp-route-mismatch'));

console.log('wallet-dashboard-vercel shinigami proof ok');
