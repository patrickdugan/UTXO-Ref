'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { verifyBatchProof } = require('../verify-batch');

const verifier = process.env.LNM_NOVA_VERIFIER;
const proofDirectory = process.env.LNM_NOVA_PROOFS;
const proofNames = ['authorization.bin', 'curve.bin', 'nullifier.bin'];
const retainedJournal = path.join(__dirname, '../evidence/sp1-two-trade-journal.bin');
const retainedJournalHash = 'd86b336aa405809b466694c13a285dc632230bdcf46f73be9c7f1a18d1dbbe00';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('the venue verifies the saved Nova proof set and rejects a substituted component', {
  skip: !verifier || !proofDirectory ? 'requires the compiled verifier and saved CUDA proof artifacts' : false
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lnmarkets-nova-proof-set-'));
  const journalPath = path.join(directory, 'journal.bin');
  const reportPath = path.join(directory, 'receipt.json');
  const rejectedReportPath = path.join(directory, 'rejected.json');
  t.after(() => {
    for (const file of [journalPath, reportPath, rejectedReportPath, ...proofNames.map((name) => path.join(directory, name))]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
  });

  const journal = fs.readFileSync(retainedJournal);
  assert.equal(sha256(journal), retainedJournalHash);
  fs.writeFileSync(journalPath, journal, { flag: 'wx' });
  for (const name of proofNames) {
    fs.copyFileSync(path.join(proofDirectory, name), path.join(directory, name), fs.constants.COPYFILE_EXCL);
  }
  const hostExecutable = path.resolve(verifier);
  const policy = {
    network: 'bitcoin-regtest',
    hostExecutable,
    hostSha256: sha256(fs.readFileSync(hostExecutable)),
    expectedJournalSha256: retainedJournalHash,
    outputCount: 3,
    expectedEpoch: journal.readBigUInt64LE(40).toString(),
    currentNullifierRoot: journal.subarray(124, 156).toString('hex'),
    observedHeight: journal.readUInt32LE(80)
  };
  const request = { journalPath, proofPath: directory, reportPath, policy };
  const receipt = verifyBatchProof(request);
  assert.equal(receipt.status, 'nova_batch_proof_verified');
  assert.equal(receipt.zeroKnowledgeProofVerified, true);
  assert.equal(receipt.expectedJournalSha256, retainedJournalHash);
  assert.equal(receipt.rowCount, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')), receipt);

  // Supply a valid artifact from the same journal in a different proof slot.
  fs.copyFileSync(path.join(directory, 'nullifier.bin'), path.join(directory, 'curve.bin'));
  assert.throws(() => verifyBatchProof({ ...request, reportPath: rejectedReportPath }), /pinned Nova verifier rejected the proof set/);
  assert.equal(fs.existsSync(rejectedReportPath), false);
});
