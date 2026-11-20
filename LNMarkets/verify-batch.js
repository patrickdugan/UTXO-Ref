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
  return {
    epoch: bytes.readBigUInt64LE(40).toString(),
    batchId: bytes.subarray(48, 80).toString('hex'),
    previousRoot: policy.currentNullifierRoot,
    proposedRoot: bytes.subarray(156, 188).toString('hex'),
    batchTxDigest: bytes.subarray(188, 220).toString('hex'),
    txid: bytes.subarray(220, 252).toString('hex')
  };
}

function verifyBatchProof({ journalPath, proofPath, reportPath, policy: inputPolicy }) {
  const policy = canonicalize(inputPolicy);
  const { network, hostExecutable, elfPath, hostSha256, elfSha256, programVkDigest, expectedJournalSha256, currentNullifierRoot } = policy;
  if (network !== 'bitcoin-regtest' ||
      ![hostExecutable, elfPath].every((value) => typeof value === 'string' && path.isAbsolute(value)) ||
      ![hostSha256, elfSha256, programVkDigest, expectedJournalSha256, currentNullifierRoot]
        .every((value) => typeof value === 'string' && HEX32.test(value))) {
    throw new Error('trusted regtest policy must pin the host, ELF, program key, journal and live authorization root');
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
  if (fileDigest(hostExecutable, 256 * MIB) !== hostSha256 || fileDigest(elfPath, 32 * MIB) !== elfSha256) {
    throw new Error('local host or guest binary differs from its approval pin');
  }
  const proofSha256 = fileDigest(proofPath, 64 * MIB);
  const result = spawnSync(hostExecutable, [
    'verify-proof', '--mode', 'groth16', '--elf', elfPath, '--journal', path.resolve(journalPath),
    '--proof', path.resolve(proofPath), '--report', path.resolve(reportPath),
    '--expect-elf-sha256', elfSha256, '--expect-program-vk', programVkDigest,
    '--expect-journal-sha256', expectedJournalSha256
  ], {
    // The pinned host derives the program key from the ELF on each run.
    // That setup alone can take several minutes on the local CPU.
    encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: MIB, windowsHide: true,
    env: { SP1_CIRCUIT_MODE: 'release', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('pinned SP1 host rejected the proof: ' + result.stderr.trim());
  const report = readBoundedJson(reportPath);
  if (report.schema !== 'lnm-sp1-local-run/v1' || report.status !== 'groth16_proof_verified' ||
      report.sp1_sdk_version !== '6.9.0' || report.sp1_circuit_mode !== 'release' ||
      report.proof_mode !== 'groth16' || report.zero_knowledge_proof_verified !== true ||
      report.expected_journal_sha256 !== expectedJournalSha256 || report.journal_bytes !== 276 ||
      report.elf_sha256 !== elfSha256 || report.program_vk_digest !== programVkDigest || report.proof_sha256 !== proofSha256) {
    throw new Error('SP1 host report differs from the approved verification inputs');
  }
  return {
    status: 'groth16_batch_proof_verified', network, zeroKnowledgeProofVerified: true,
    proofSha256, expectedJournalSha256, hostSha256, elfSha256, programVkDigest,
    ...context, bitcoinSpendabilityVerified: false
  };
}

function main(argv) {
  const flags = ['--policy', '--journal', '--proof', '--report'];
  if (argv.length !== flags.length * 2 || flags.some((flag, i) => argv[i * 2] !== flag || !argv[i * 2 + 1])) {
    throw new Error('Usage: node LNMarkets/verify-batch.js --policy TRUSTED_JSON --journal BIN --proof BIN --report NEW_JSON');
  }
  const [, configPath, , journalPath, , proofPath, , reportPath] = argv;
  console.log(JSON.stringify(verifyBatchProof({ policy: readBoundedJson(configPath), journalPath, proofPath, reportPath }), null, 2));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { verifyBatchProof };
