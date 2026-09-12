#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const { DlcRefundRecoveryStore } = require('./dlc_refund_recovery_store');

const directory = process.argv[2];
const fixturePath = process.argv[3];
const workers = Number(process.argv[4] || 16);
const workerIndex = Number(process.argv[5] || -1);

if (!directory || !fixturePath) throw new Error('refund race requires store and fixture paths');
if (!Number.isSafeInteger(workers) || workers < 2 || workers > 64) {
  throw new Error('refund race workers must be an integer in 2..64');
}
const fixtureBytes = fs.readFileSync(fixturePath);
if (fixtureBytes.length < 2 || fixtureBytes.length > 1048576) throw new Error('refund race fixture is not bounded');
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
if (!fixture.contractState || !fixture.transactionSet || !Array.isArray(fixture.signedRefunds) ||
    fixture.signedRefunds.length < workers) {
  throw new Error('refund race fixture is incomplete');
}

if (process.argv.includes('--worker')) {
  try {
    const record = new DlcRefundRecoveryStore(directory).store({
      contractState: fixture.contractState,
      transactionSet: fixture.transactionSet,
      signedRefundTxHex: fixture.signedRefunds[workerIndex]
    });
    process.stdout.write(`${record.recordHash}\n`);
    process.exitCode = 0;
  } catch (error) {
    process.stdout.write(`${error.message}\n`);
    process.exitCode = /conflicting contract artifact|incomplete persistence marker/.test(error.message) ? 2 : 1;
  }
} else {
  Promise.all(Array.from({ length: workers }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      __filename, directory, fixturePath, String(workers), String(index), '--worker'
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  }))).then((results) => {
    const stored = results.filter((result) => result.code === 0);
    const rejected = results.filter((result) => result.code === 2);
    const unexpected = results.filter((result) => ![0, 2].includes(result.code));
    const restored = new DlcRefundRecoveryStore(directory).restore({
      contractState: fixture.contractState,
      transactionSet: fixture.transactionSet
    });
    const entries = fs.readdirSync(directory).filter((name) => /^[0-9a-f]{64}$/.test(name));
    const report = {
      schema: 'utxoref_dlc_refund_recovery_race_v1',
      workers,
      stored: stored.length,
      rejected: rejected.length,
      unexpected,
      records: entries.length,
      recordHash: restored.recordHash,
      passed: stored.length === 1 && rejected.length === workers - 1 &&
        unexpected.length === 0 && entries.length === 1 &&
        stored[0].stdout === restored.recordHash
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.passed) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
