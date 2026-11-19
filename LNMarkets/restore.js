#!/usr/bin/env node
'use strict';

// This entry point accepts public recovery data only. It accepts no signing
// keys and makes no signer, wallet, venue, RPC or broadcast calls. It outputs transaction
// bytes for a later independently guarded Bitcoin Core acceptance step.
const fs = require('node:fs');
const { TextDecoder } = require('node:util');
const { completeSettlement, getRefundTransaction } = require('./src/settlement');

const MAX_JSON_BYTES = 1024 * 1024;

function readBoundedJson(filename) {
  const fd = fs.openSync(filename, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error('expected a JSON file of at most 1 MiB');
    const bytes = Buffer.alloc(MAX_JSON_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (read === 0) break;
      size += read;
    }
    if (size > MAX_JSON_BYTES) throw new Error('expected a JSON file of at most 1 MiB');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } finally {
    fs.closeSync(fd);
  }
}

function parseArgs(argv) {
  const result = {};
  const valued = new Set(['--package', '--plan-digest', '--recovery-digest', '--outcome', '--attestations']);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (Object.hasOwn(result, flag)) throw new Error(`duplicate argument ${flag}`);
    if (flag === '--refund') result[flag] = true;
    else if (valued.has(flag) && argv[index + 1] && !argv[index + 1].startsWith('--')) result[flag] = argv[++index];
    else throw new Error(`unsupported or incomplete argument ${flag}`);
  }
  if (!result['--package'] || !/^[0-9a-f]{64}$/.test(result['--plan-digest'] || '') ||
      !/^[0-9a-f]{64}$/.test(result['--recovery-digest'] || '')) {
    throw new Error('--package, independently saved --plan-digest and --recovery-digest are required');
  }
  if (result['--refund']) {
    if (result['--outcome'] || result['--attestations']) throw new Error('refund accepts no oracle outcome or attestation');
  } else if (!/^[0-9a-f]{64}$/.test(result['--outcome'] || '') || !result['--attestations']) {
    throw new Error('settlement requires --outcome and --attestations; use --refund for timeout recovery');
  }
  return result;
}

function restore(args) {
  const common = {
    recoveryPackage: readBoundedJson(args['--package']),
    expectedPlanId: args['--plan-digest'],
    expectedRecoveryDigest: args['--recovery-digest']
  };
  return args['--refund']
    ? getRefundTransaction(common)
    : completeSettlement({
      ...common,
      outcomeId: args['--outcome'],
      attestations: readBoundedJson(args['--attestations'])
    });
}

function main(argv) { console.log(JSON.stringify(restore(parseArgs(argv)), null, 2)); }
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { MAX_JSON_BYTES, readBoundedJson, parseArgs, restore };
