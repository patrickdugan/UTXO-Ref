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
const { spawnSync } = require('child_process');

const repo = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const EXTRA_ENTRY_POINTS = ['bitvm3/utxo_referee/test.js', 'integrations/utxoref-testnet-beta/test.js'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'target']);
const HEAVY = new Set(['tradelayer_bitvm_sha256.test.js']);

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

let passed = 0;
const failures = [];
for (const file of found) {
  const args = HEAVY.has(path.basename(file)) ? ['--max-old-space-size=4096', file] : [file];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: repo, maxBuffer: 256 * 1024 * 1024 });
  const output = (result.stdout || '') + (result.stderr || '');
  const ok = result.status === 0 && !/^\s*(FAIL\b|✗)/m.test(output) && !/\bFAIL: /.test(output);
  if (ok) passed++;
  else {
    failures.push({
      file: path.relative(repo, file),
      status: result.status,
      tail: output.split('\n').filter((line) => /FAIL|Error|✗|not ok/.test(line)).slice(0, 6).join('\n')
    });
  }
}
console.log(`${passed}/${found.length} test files pass`);
for (const failure of failures) console.log(`FAILED ${failure.file} (exit ${failure.status})\n${failure.tail}`);
process.exit(failures.length ? 1 : 0);
