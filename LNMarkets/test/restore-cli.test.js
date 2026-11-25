'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MAX_JSON_BYTES, readBoundedJson, parseArgs } = require('../restore');

const pins = ['--package', 'public.json', '--plan-digest', 'aa'.repeat(32), '--recovery-digest', 'bb'.repeat(32)];

test('restore requires independently supplied pins and one explicit recovery path', () => {
  assert.equal(parseArgs([...pins, '--refund'])['--refund'], true);
  assert.equal(parseArgs([...pins, '--outcome', 'cc'.repeat(32), '--attestations', 'oracles.json'])['--attestations'], 'oracles.json');
  for (const argv of [
    [], [...pins], [...pins, '--refund', '--refund'],
    ['--package', 'public.json', '--plan-digest', 'aa'.repeat(32), '--refund'],
    [...pins, '--refund', '--outcome', 'cc'.repeat(32)],
    [...pins, '--refund', '--attestations', 'oracles.json'],
    [...pins, '--refund', '--private-key', 'test'],
    [...pins, '--refund', '--broadcast'],
    [...pins, '--outcome', 'cc'.repeat(32)]
  ]) assert.throws(() => parseArgs(argv));
});

test('public artifact loader enforces size, UTF-8, JSON and regular-file boundaries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lnmarkets-cli-'));
  try {
    const filename = path.join(directory, 'input.json');
    fs.writeFileSync(filename, '{"example":1}');
    assert.deepEqual(readBoundedJson(filename), { example: 1 });
    fs.writeFileSync(filename, Buffer.alloc(MAX_JSON_BYTES + 1, 32));
    assert.throws(() => readBoundedJson(filename), /1 MiB/);
    fs.writeFileSync(filename, Buffer.from([0xff, 0xfe]));
    assert.throws(() => readBoundedJson(filename));
    fs.writeFileSync(filename, '{"example":');
    assert.throws(() => readBoundedJson(filename));
    assert.throws(() => readBoundedJson(directory));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
