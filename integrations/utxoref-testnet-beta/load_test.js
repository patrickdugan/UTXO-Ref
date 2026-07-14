#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

function parseArgs(argv) {
  const options = {
    url: 'http://127.0.0.1:8790', requests: 500, concurrency: 20,
    mode: 'status', iterations: 1, inviteToken: process.env.BETA_INVITE_TOKEN || null
  };
  for (let index = 2; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--url') options.url = argv[++index].replace(/\/$/, '');
    else if (argument === '--requests') options.requests = Number(argv[++index]);
    else if (argument === '--concurrency') options.concurrency = Number(argv[++index]);
    else if (argument === '--mode') options.mode = argv[++index];
    else if (argument === '--iterations') options.iterations = Number(argv[++index]);
    else if (argument === '--invite') options.inviteToken = argv[++index];
    else if (argument === '--help') options.help = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  if (!Number.isSafeInteger(options.requests) || options.requests < 1 || options.requests > 100000) {
    throw new Error('--requests must be 1..100000');
  }
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 1000) {
    throw new Error('--concurrency must be 1..1000');
  }
  if (!['status', 'verify'].includes(options.mode)) throw new Error('--mode must be status or verify');
  if (options.mode === 'verify' && !options.inviteToken) throw new Error('--invite is required in verify mode');
  return options;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)].toFixed(2));
}

async function execute(options, index) {
  const startedAt = performance.now();
  let response;
  if (options.mode === 'verify') {
    response = await fetch(`${options.url}/v1/stress/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: options.inviteToken, iterations: options.iterations })
    });
  } else {
    response = await fetch(`${options.url}/v1/beta/status?load=${index}`);
  }
  const body = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    elapsedMs: performance.now() - startedAt,
    digest: crypto.createHash('sha256').update(body).digest('hex')
  };
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log('Usage: node load_test.js [--url URL] [--requests N] [--concurrency N] [--mode status|verify] [--invite TOKEN] [--iterations N]');
    return;
  }
  const results = new Array(options.requests);
  let cursor = 0;
  const startedAt = performance.now();
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= options.requests) return;
      try { results[index] = await execute(options, index); }
      catch (err) { results[index] = { status: 0, ok: false, elapsedMs: 0, error: err.message, digest: null }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, options.requests) }, worker));
  const elapsedMs = performance.now() - startedAt;
  const latencies = results.map((result) => result.elapsedMs).sort((a, b) => a - b);
  const statuses = {};
  for (const result of results) statuses[result.status] = (statuses[result.status] || 0) + 1;
  const receipt = {
    kind: 'utxoref_beta_load_receipt', version: 1, createdAt: new Date().toISOString(),
    target: options.url, mode: options.mode, requests: options.requests,
    concurrency: options.concurrency, verificationIterationsPerRequest: options.mode === 'verify' ? options.iterations : null,
    elapsedMs: Number(elapsedMs.toFixed(2)), requestsPerSecond: Number((options.requests / (elapsedMs / 1000)).toFixed(2)),
    succeeded: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    statuses,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99), max: Number(latencies.at(-1).toFixed(2)) },
    responseDigest: crypto.createHash('sha256').update(results.map((result) => result.digest || result.error).join('\n')).digest('hex')
  };
  const runtime = path.join(__dirname, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'load_latest.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
  if (receipt.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});

module.exports = { parseArgs, percentile };
