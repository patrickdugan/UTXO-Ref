#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readBoundedJson } = require('./restore');
const { canonicalize } = require('../bitvm3/utxo_referee/dlc_canonical_json');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tag = Buffer.from(sha256('UTXORef/LNMarkets/bitcoin-regtest/lnmarkets/v1/statement-domain'), 'hex');
const expectedDomain = sha256(Buffer.concat([tag, tag, Buffer.from('co-signed-batch-proposal-certificate')]));
const HEX32 = /^[0-9a-f]{64}$/;
const EPOCH = /^[1-9][0-9]{0,19}$/;
const MIB = 1024 * 1024;

function fileDigest(filename, maxBytes) {
  const fd = fs.openSync(filename, 'r');
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size === 0 || info.size > maxBytes) throw new Error('unexpected file size or type');
    const digest = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    let remaining = info.size;
    while (remaining) {
      const n = fs.readSync(fd, chunk, 0, Math.min(remaining, chunk.length), null);
      if (!n) throw new Error('file truncated during pin check');
      digest.update(chunk.subarray(0, n));
      remaining -= n;
    }
    if (fs.readSync(fd, chunk, 0, 1, null) !== 0) throw new Error('file grew during pin check');
    return digest.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function verifyJournal(bytes, policy) {
  if (bytes.length !== 276 || bytes.toString('ascii', 0, 8) !== 'LNMJNL01' ||
      bytes.subarray(8, 40).toString('hex') !== expectedDomain || sha256(bytes) !== policy.expectedJournalSha256) {
    throw new Error('journal differs from the independently approved regtest journal');
  }
  const evaluationHeight = bytes.readUInt32LE(80);
  const validUntilHeight = bytes.readUInt32LE(84);
  if (!Number.isSafeInteger(policy.observedHeight) || evaluationHeight < 1 || validUntilHeight >= 500_000_000 ||
      policy.observedHeight < evaluationHeight || policy.observedHeight > validUntilHeight) {
    throw new Error('trusted chain height falls outside the batch validity window');
  }
  if (bytes.subarray(124, 156).toString('hex') !== policy.currentNullifierRoot) {
    throw new Error('journal starts from a stale authorization root');
  }
  const epoch = bytes.readBigUInt64LE(40).toString();
  if (epoch !== policy.expectedEpoch) throw new Error('journal epoch differs from the approved epoch');
  const rowCount = bytes.readUInt32LE(88);
  if (rowCount < 1 || rowCount > 32 || policy.outputCount > rowCount * 3) {
    throw new Error('journal row count or approved output count is outside the batch layout');
  }
  return {
    epoch,
    rowCount,
    batchId: bytes.subarray(48, 80).toString('hex'),
    previousRoot: policy.currentNullifierRoot,
    proposedRoot: bytes.subarray(156, 188).toString('hex'),
    batchTxDigest: bytes.subarray(188, 220).toString('hex'),
    txid: bytes.subarray(220, 252).toString('hex')
  };
}

function verifyBatchProof({ journalPath, proofPath, reportPath, policy: inputPolicy }) {
  const policy = canonicalize(inputPolicy);
  const { network, hostExecutable, hostSha256, expectedJournalSha256, currentNullifierRoot, expectedEpoch, outputCount } = policy;
  if (network !== 'bitcoin-regtest' ||
      typeof hostExecutable !== 'string' || !path.isAbsolute(hostExecutable) ||
      ![hostSha256, expectedJournalSha256, currentNullifierRoot]
        .every((value) => typeof value === 'string' && HEX32.test(value)) ||
      typeof expectedEpoch !== 'string' || !EPOCH.test(expectedEpoch) ||
      !Number.isSafeInteger(outputCount) || outputCount < 3 || outputCount > 96) {
    throw new Error('trusted regtest policy must pin the Nova verifier, layout, journal, epoch and live authorization root');
  }
  const journalFd = fs.openSync(journalPath, 'r');
  let context;
  try {
    const info = fs.fstatSync(journalFd);
    const bytes = Buffer.alloc(277);
    if (!info.isFile() || info.size !== 276 || fs.readSync(journalFd, bytes, 0, bytes.length, 0) !== 276) {
      throw new Error('expected journal must be a 276-byte regular file');
    }
    context = verifyJournal(bytes.subarray(0, 276), policy);
  } finally {
    fs.closeSync(journalFd);
  }
  if (fileDigest(hostExecutable, 256 * MIB) !== hostSha256) {
    throw new Error('local Nova verifier binary differs from its approval pin');
  }
  const proofNames = ['authorization', 'curve', 'nullifier'];
  const proofs = proofNames.map((name) => path.resolve(proofPath, name + '.bin'));
  const digests = proofs.map((filename) => fileDigest(filename, 64 * MIB));
  const result = spawnSync(hostExecutable, [
    path.resolve(journalPath), String(outputCount), ...proofs
  ], {
    encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: MIB, windowsHide: true,
    env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('pinned Nova verifier rejected the proof set: ' + result.stderr.trim());
  const report = JSON.parse(result.stdout);
  if (report.status !== 'nova_batch_proof_verified' || report.network !== network ||
      report.journal_sha256 !== expectedJournalSha256 ||
      proofNames.some((name, index) => report[name + '_sha256'] !== digests[index])) {
    throw new Error('Nova verifier report differs from the approved verification inputs');
  }
  const receipt = {
    status: 'nova_batch_proof_verified', network, zeroKnowledgeProofVerified: true,
    proofSha256: Object.fromEntries(proofNames.map((name, i) => [name, digests[i]])),
    expectedJournalSha256, hostSha256, outputCount,
    ...context, bitcoinSpendabilityVerified: false
  };
  fs.writeFileSync(reportPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return receipt;
}

function main(argv) {
  const flags = ['--policy', '--journal', '--proof', '--report'];
  if (argv.length !== flags.length * 2 || flags.some((flag, i) => argv[i * 2] !== flag || !argv[i * 2 + 1])) {
    throw new Error('Usage: node LNMarkets/verify-batch.js --policy TRUSTED_JSON --journal BIN --proof PROOF_DIRECTORY --report NEW_JSON');
  }
  const [, configPath, , journalPath, , proofPath, , reportPath] = argv;
  console.log(JSON.stringify(verifyBatchProof({ policy: readBoundedJson(configPath), journalPath, proofPath, reportPath }), null, 2));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { verifyBatchProof };
