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
const { runNodeFile } = require('./run_test_process');

const dir = __dirname;
const heavy = new Set(['tradelayer_bitvm_sha256.test.js']);
// legacy/ holds quarantined prototypes (MuSig2, nonce journal). They are not
// part of the pilot surface but their tests still gate regressions.
const listTests = (sub) => fs.readdirSync(path.join(dir, sub))
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join(sub, f))
  .sort();
const tests = [...listTests('.'), ...(fs.existsSync(path.join(dir, 'legacy')) ? listTests('legacy') : [])];
// A suite that hangs fails by name instead of stalling the whole run. In
// GitHub Actions, failures, lingering processes and the slowest suites are
// also emitted as annotations, which are readable without the job log.
const SUITE_TIMEOUT_MS = Number(process.env.UTXOREF_SUITE_TIMEOUT_MS || 15 * 60 * 1000);
const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
const annotation = (text) => String(text).replace(/[\r\n%]/g, ' ').slice(0, 400);

(async () => {
  let passed = 0;
  let failed = 0;
  const failures = [];
  const timings = [];

  console.log(`\nUTXORef referee regression: ${tests.length} suites\n`);
  for (const t of tests) {
    const args = heavy.has(path.basename(t)) ? ['--max-old-space-size=4096', path.join(dir, t)] : [path.join(dir, t)];
    const res = await runNodeFile(args, { timeoutMs: SUITE_TIMEOUT_MS });
    const out = res.stdout + res.stderr + (res.timedOut ? `\nFAIL: timed out after ${SUITE_TIMEOUT_MS / 1000}s\n` : '');
    const ok = res.status === 0 && !/\bFAIL\b/.test(out);
    timings.push({ t, seconds: res.seconds });
    // pull the suite's own pass line if present
    const summary = (out.match(/(PASS:[^\n]*|Results:[^\n]*|PASS\b[^\n]*)/) || [''])[0].trim();
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${t}  ${res.seconds.toFixed(1)}s${res.timedOut ? '  TIMED OUT' : ''}` +
      `${res.lingering ? '  (left a process holding its output)' : ''}${summary ? '  (' + summary + ')' : ''}`);
    if (res.lingering && IN_ACTIONS) console.log(`::warning title=${t}::exited but left a process holding its output pipes`);
    if (ok) passed++; else {
      failed++;
      failures.push({ t, out });
      if (IN_ACTIONS) {
        const reason = res.timedOut ? `timed out after ${SUITE_TIMEOUT_MS / 1000}s` : `exit ${res.status}`;
        const detail = out.split('\n').filter((l) => /FAIL|Error/.test(l)).slice(0, 3).join(' | ');
        console.log(`::error title=${t}::${annotation(`${reason}${detail ? ': ' + detail : ''}`)}`);
      }
    }
  }
  if (IN_ACTIONS) {
    const slowest = [...timings].sort((a, b) => b.seconds - a.seconds).slice(0, 8)
      .map((entry) => `${entry.t} ${entry.seconds.toFixed(0)}s`).join(', ');
    console.log(`::notice title=run_utxoref_all slowest suites::${annotation(slowest)}`);
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
})();
