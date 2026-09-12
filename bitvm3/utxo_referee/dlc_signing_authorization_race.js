#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const { DlcSigningAuthorizationStore } = require('./dlc_signing_authorization_store');

const directory = process.argv[2];
const workers = Number(process.argv[3] || 12);
const request = Object.freeze({
  network: 'bitcoin-testnet4',
  contractId: 'signing-race-contract',
  authorizationId: 'cet:0:oracle-set:0',
  stateRecordHash: '11'.repeat(32),
  authorizationDigest: '22'.repeat(32),
  providerIdentity: '33'.repeat(32)
});

if (!directory) throw new Error('authorization store directory is required');

if (process.argv.includes('--worker')) {
  try {
    new DlcSigningAuthorizationStore(directory).consume(request);
    process.stdout.write('consumed\n');
    process.exitCode = 0;
  } catch (error) {
    process.stdout.write(`${error.message}\n`);
    process.exitCode = /already durably consumed|lock|incomplete consumption marker/.test(error.message) ? 2 : 1;
  }
} else {
  if (!Number.isSafeInteger(workers) || workers < 2 || workers > 64) {
    throw new Error('workers must be an integer in 2..64');
  }
  Promise.all(Array.from({ length: workers }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, directory, String(workers), '--worker'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  }))).then((results) => {
    const consumed = results.filter((result) => result.code === 0).length;
    const rejected = results.filter((result) => result.code === 2).length;
    const unexpected = results.filter((result) => ![0, 2].includes(result.code));
    const verification = new DlcSigningAuthorizationStore(directory).verifyAll();
    const report = {
      schema: 'utxoref_dlc_signing_authorization_race_v1',
      workers,
      consumed,
      rejected,
      unexpected,
      records: verification.records,
      passed: consumed === 1 && rejected === workers - 1 && unexpected.length === 0 && verification.records === 1
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.passed) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
