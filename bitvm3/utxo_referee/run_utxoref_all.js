#!/usr/bin/env node

/**
 * Run every UTXORef referee test in this directory and report a summary.
 *
 *   node bitvm3/utxo_referee/run_utxoref_all.js
 *
 * Each *.test.js is run in its own process (the SHA256 circuit test gets extra
 * heap). Exit code is non-zero if any suite fails. This is the one-command
 * regression gate for the deposit/withdrawal + DLC + BitVM referee stack.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const heavy = new Set(['tradelayer_bitvm_sha256.test.js']);
const tests = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

let passed = 0;
let failed = 0;
const failures = [];

console.log(`\nUTXORef referee regression: ${tests.length} suites\n`);
for (const t of tests) {
  const args = heavy.has(t) ? ['--max-old-space-size=4096', path.join(dir, t)] : [path.join(dir, t)];
  const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const out = (res.stdout || '') + (res.stderr || '');
  const ok = res.status === 0 && !/\bFAIL\b/.test(out);
  // pull the suite's own pass line if present
  const summary = (out.match(/(PASS:[^\n]*|Results:[^\n]*|PASS\b[^\n]*)/) || [''])[0].trim();
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${t}${summary ? '  (' + summary + ')' : ''}`);
  if (ok) passed++; else { failed++; failures.push({ t, out }); }
}

console.log(`\n${passed}/${tests.length} suites passed.`);
if (failed) {
  console.log(`\n${failed} FAILED:`);
  for (const f of failures) {
    console.log(`\n### ${f.t}`);
    console.log(f.out.split('\n').filter((l) => /FAIL|Error|Results/.test(l)).slice(0, 8).join('\n'));
  }
  process.exit(1);
}
console.log('All UTXORef referee suites green.\n');
