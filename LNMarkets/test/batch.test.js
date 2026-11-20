'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyBatchProof } = require('../verify-batch');
const { test, before } = require('node:test');
const { exportTrade, prepareBatch, assembleWitness, buildNullifierPaths } = require('../src/batch');
const { createFixtureTrades, buildDemoBatch } = require('../batch-demo');

let fixtures, demo;
before(() => {
  fixtures = createFixtureTrades();
  demo = buildDemoBatch(fixtures);
});

test('verified recoveries produce exact batch payouts, ordered outpoints and a 276-byte journal', () => {
  const { proposal, witness } = demo;
  const journal = Buffer.from(proposal.expectedJournalHex, 'hex');
  const tx = Buffer.from(proposal.unsignedTxHex, 'hex');
  assert.equal(witness.subarray(0, 8).toString(), 'LNMBAT01');
  for (const { trade } of fixtures) assert.deepEqual(trade.summary.oracleKeys, [...trade.summary.oracleKeys].sort());
  assert.equal(journal.subarray(0, 8).toString(), 'LNMJNL01');
  assert.equal(journal.length, 276);
  assert.equal(journal.readUInt32LE(88), 2);
  assert.equal(journal.readBigUInt64LE(252), 802660n);
  assert.equal(journal.readBigUInt64LE(260), 800660n);
  assert.equal(journal.readBigUInt64LE(268), 2000n);
  const ordered = fixtures.map(({ trade }) => trade.summary.fundingTxid).sort();
  assert.deepEqual([tx.subarray(5, 37), tx.subarray(46, 78)].map((id) => Buffer.from(id).reverse().toString('hex')), ordered);
  assert.equal(tx[87], 3, 'identical scripts aggregate into three outputs');
  const payouts = [88, 131, 174].map((offset) => tx.readBigUInt64LE(offset)).sort((a, b) => Number(a - b));
  assert.deepEqual(payouts, [660n, 379798n, 420202n]);
  assert.equal(tx.readUInt32LE(tx.length - 4), 1001);
  assert.equal(createHash('sha256').update(journal).digest('hex'), proposal.expectedJournalSha256);
  assert.deepEqual(prepareBatch({ ...demo.inputs, trades: [...demo.inputs.trades].reverse() }), proposal);
});

test('wallet exporter rejects an altered retained outpoint, substituted package and missing original shares', () => {
  const [{ exportInput }, other] = fixtures;
  const changedOutpoint = { ...exportInput.pins.fundingOutpoint, vout: 3 };
  assert.throws(() => exportTrade({ ...exportInput, pins: { ...exportInput.pins, fundingOutpoint: changedOutpoint } }), /wallet pin/);
  assert.throws(() => exportTrade({ ...exportInput, recoveryPackage: other.exportInput.recoveryPackage }), /plan.*digest|pinned.*plan/i);
  assert.throws(() => exportTrade({ ...exportInput, attestations: exportInput.attestations.slice(0, 1) }), /attestations/);
});

test('batch rejects unverified exports, immature trades and changed or consumed nullifier paths', () => {
  const { inputs, proposal } = demo;
  assert.throws(() => prepareBatch({ ...inputs, trades: inputs.trades.map((row) => ({ ...row })) }), /verified trade exports/);
  assert.throws(() => prepareBatch({ ...inputs, trades: [inputs.trades[0], inputs.trades[0]] }), /duplicate/);
  assert.throws(() => prepareBatch({ ...inputs, evaluationHeight: 1000 }), /immature/);
  assert.throws(() => prepareBatch({ ...inputs, oldNullifierRoot: '00'.repeat(32) }), /prior root/);
  assert.throws(() => prepareBatch({ ...inputs, paths: [...inputs.paths].reverse() }), /canonical outpoint order/);
  assert.throws(() => buildNullifierPaths(proposal.nullifiers, proposal.nullifiers), /already consumed/);
});

test('application signatures cannot be replaced with DLC attestations or replayed under new consent context', () => {
  const { inputs, proposal, signedRows } = demo;
  const badRows = structuredClone(signedRows);
  badRows[0].oracleSignatures[0] = badRows[0].summarySignatures[0];
  assert.throws(() => assembleWitness(proposal, badRows), /invalid batch application signature/);
  const changed = prepareBatch({ ...inputs, validUntilHeight: inputs.validUntilHeight + 1 });
  assert.throws(() => assembleWitness(changed, signedRows), /invalid batch application signature/);
});


test('proof verification fails before launching a host for altered journals, expired context and stale roots', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lnmarkets-batch-policy-'));
  const journalPath = path.join(directory, 'journal.bin');
  t.after(() => {
    fs.unlinkSync(journalPath);
    fs.rmdirSync(directory);
  });
  const { proposal } = demo;
  const trustedJournal = Buffer.from(proposal.expectedJournalHex, 'hex');
  fs.writeFileSync(journalPath, trustedJournal);
  const policy = {
    network: 'bitcoin-regtest',
    hostExecutable: path.join(directory, 'absent-host'),
    hostSha256: 'aa'.repeat(32),
    elfPath: path.join(directory, 'absent-elf'),
    elfSha256: 'bb'.repeat(32),
    programVkDigest: 'cc'.repeat(32),
    expectedJournalSha256: proposal.expectedJournalSha256,
    currentNullifierRoot: proposal.context.oldNullifierRoot,
    observedHeight: proposal.context.evaluationHeight
  };
  const request = { journalPath, proofPath: path.join(directory, 'absent-proof'), reportPath: path.join(directory, 'report.json') };
  assert.throws(() => verifyBatchProof({ ...request, policy: { ...policy, network: 'bitcoin-mainnet' } }), /trusted regtest/);
  assert.throws(() => verifyBatchProof({ ...request, policy: { ...policy, observedHeight: 1011 } }), /validity window/);
  assert.throws(() => verifyBatchProof({ ...request, policy: { ...policy, currentNullifierRoot: proposal.context.newNullifierRoot } }), /stale/);
  const altered = Buffer.from(trustedJournal);
  altered[92] ^= 1;
  fs.writeFileSync(journalPath, altered);
  assert.throws(() => verifyBatchProof({ ...request, policy }), /independently approved/);
  assert.equal(fs.existsSync(request.reportPath), false);
});
