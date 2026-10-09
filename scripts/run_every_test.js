#!/usr/bin/env node
/**
 * Run every *.test.js in the repository (outside node_modules, .git and Rust
 * target directories), plus the two test entry points not named *.test.js.
 * Each file runs in its own process; its exit status is authoritative, and a
 * harness that prints a FAIL line but exits 0 is also counted as failed.
 *
 *   node scripts/run_every_test.js [repo-root]
 */

const fs = require('fs');
const path = require('path');
const { runNodeFile } = require('../bitvm3/utxo_referee/run_test_process');

const repo = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const EXTRA_ENTRY_POINTS = ['bitvm3/utxo_referee/test.js', 'integrations/utxoref-testnet-beta/test.js'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'target']);
const HEAVY = new Set(['tradelayer_bitvm_sha256.test.js']);
// A file that hangs fails by name instead of stalling the run; in GitHub
// Actions failures, lingering processes and the slowest files are emitted as
// annotations.
const FILE_TIMEOUT_MS = Number(process.env.UTXOREF_SUITE_TIMEOUT_MS || 15 * 60 * 1000);
const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
const timings = [];

const found = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.test.js')) found.push(full);
  }
})(repo);
for (const rel of EXTRA_ENTRY_POINTS) {
  if (fs.existsSync(path.join(repo, rel))) found.push(path.join(repo, rel));
}
found.sort();

const annotation = (value) => String(value).replace(/[\r\n%]/g, ' ').slice(0, 400);

(async () => {
  let passed = 0;
  const failures = [];
  for (const file of found) {
    const args = HEAVY.has(path.basename(file)) ? ['--max-old-space-size=4096', file] : [file];
    const result = await runNodeFile(args, { cwd: repo, timeoutMs: FILE_TIMEOUT_MS });
    const relative = path.relative(repo, file);
    timings.push({ file: relative, seconds: result.seconds });
    if (result.lingering) {
      console.log(`WARNING ${relative} exited but left a process holding its output`);
      if (IN_ACTIONS) console.log(`::warning title=${relative}::exited but left a process holding its output pipes`);
    }
    const output = result.stdout + result.stderr + (result.timedOut ? `\nFAIL: timed out after ${FILE_TIMEOUT_MS / 1000}s\n` : '');
    const ok = result.status === 0 && !/^\s*(FAIL\b|✗)/m.test(output) && !/\bFAIL: /.test(output);
    if (ok) passed++;
    else {
      failures.push({
        file: relative,
        status: result.status,
        tail: output.split('\n').filter((line) => /FAIL|Error|✗|not ok/.test(line)).slice(0, 6).join('\n')
      });
    }
  }
  console.log(`${passed}/${found.length} test files pass`);
  for (const failure of failures) console.log(`FAILED ${failure.file} (exit ${failure.status})\n${failure.tail}`);
  if (IN_ACTIONS) {
    for (const failure of failures) {
      console.log(`::error title=${failure.file}::${annotation(`exit ${failure.status}: ${failure.tail}`)}`);
    }
    const slowest = [...timings].sort((a, b) => b.seconds - a.seconds).slice(0, 8)
      .map((entry) => `${entry.file} ${entry.seconds.toFixed(0)}s`).join(', ');
    console.log(`::notice title=run_every_test slowest files::${annotation(slowest)}`);
  }
  process.exit(failures.length ? 1 : 0);
})();
