#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const { DlcBroadcastAuthorizationStore } = require('./dlc_broadcast_authorization_store');

const directory = process.argv[2];
const fixturePath = process.argv[3];
const workers = Number(process.argv[4] || 16);

if (!directory || !fixturePath) throw new Error('broadcast race requires store and fixture paths');
if (!Number.isSafeInteger(workers) || workers < 2 || workers > 64) {
  throw new Error('broadcast race workers must be an integer in 2..64');
}
const fixtureBytes = fs.readFileSync(fixturePath);
if (fixtureBytes.length < 2 || fixtureBytes.length > 1048576) throw new Error('broadcast race fixture is not bounded');
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
fixtureBytes.fill(0);
if (!fixture.contractState || !fixture.transitionRequest || typeof fixture.rawTxHex !== 'string' ||
    typeof fixture.now !== 'string') {
  throw new Error('broadcast race fixture is incomplete');
}

if (process.argv.includes('--worker')) {
  try {
    const result = new DlcBroadcastAuthorizationStore(directory).consume({
      contractState: fixture.contractState,
      transitionRequest: fixture.transitionRequest,
      rawTxHex: fixture.rawTxHex,
      now: new Date(fixture.now)
    });
    process.stdout.write(`${result.consumption.recordHash}\n`);
    process.exitCode = 0;
  } catch (error) {
    process.stdout.write(`${error.message}\n`);
    process.exitCode = /already durably consumed|incomplete consumption marker/.test(error.message) ? 2 : 1;
  }
} else {
  Promise.all(Array.from({ length: workers }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      __filename, directory, fixturePath, String(workers), '--worker'
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  }))).then((results) => {
    const consumed = results.filter((result) => result.code === 0);
    const rejected = results.filter((result) => result.code === 2);
    const unexpected = results.filter((result) => ![0, 2].includes(result.code));
    const entries = fs.readdirSync(directory).filter((name) => /^[0-9a-f]{64}$/.test(name));
    const report = {
      schema: 'utxoref_dlc_broadcast_authorization_race_v1',
      workers,
      consumed: consumed.length,
      rejected: rejected.length,
      unexpected,
      records: entries.length,
      passed: consumed.length === 1 && rejected.length === workers - 1 &&
        unexpected.length === 0 && entries.length === 1
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.passed) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
