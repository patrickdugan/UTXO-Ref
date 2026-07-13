#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { sha256Hex } = require('./tradelayer_pnl_route_adapter');
const { SCHEMA_PROFILES, parseJsonStrictProfile } = require('./strict_artifact_profiles');

const DEFAULT_OUTPUT = path.join(__dirname, 'artifacts', 'benchmarks', 'strict_artifact_profiles_latest.json');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    args[key] = value;
  }
  return args;
}

function repeatedObject(count, valueFactory = (index) => ({ index })) {
  return Object.fromEntries(Array.from({ length: count }, (_unused, index) => [index.toString(16).padStart(64, '0'), valueFactory(index)]));
}

function sampleForProfile(profileName) {
  if (profileName === 'utxoref-v2-public-artifact') {
    return {
      kind: 'btc_testnet4_utxoref_v2_live_ceremony', version: 2,
      graph: {
        publicTrace: {
          gates: Array.from({ length: 4096 }, (_unused, index) => ({ id: `g${index}`, type: 'AND' })),
          publicWires: repeatedObject(8192, () => ({ hash0: '00', hash1: '11' })),
          reveals: repeatedObject(8192, () => ({ bit: 0 }))
        },
        template: { leaves: Array.from({ length: 16384 }, (_unused, index) => ({ id: `leaf${index}` })) },
        settlement: {
          payouts: Array.from({ length: 2048 }, (_unused, index) => ({ requestId: `r${index}` })),
          outputs: new Array(2048).fill(null), rows: new Array(2048).fill(null),
          grossEdges: new Array(4096).fill(null), netBalances: new Array(2048).fill(null)
        }
      }
    };
  }
  if (profileName === 'utxoref-v2-trust-policy') {
    return {
      kind: 'utxoref_v2_watchtower_trust_policy', version: 1,
      allowedGraphs: repeatedObject(256, () => ({ signerKeyId: 'signer' })),
      trustedSigners: Object.fromEntries(Array.from({ length: 64 }, (_unused, index) => [`signer${index}`, 'pem']))
    };
  }
  if (profileName === 'utxoref-v2-watchtower-state') {
    return {
      kind: 'utxoref_v2_watchtower_state',
      challenge: {
        replacements: Array.from({ length: 32 }, (_unused, index) => ({ txid: `${index}`.padStart(64, '0') })),
        confirmationHistory: Array.from({ length: 64 }, (_unused, index) => ({ height: index })),
        cpfp: { replacements: new Array(32).fill(null), confirmationHistory: new Array(64).fill(null) }
      }
    };
  }
  if (profileName === 'utxoref-v2-fee-reserve-registry') {
    return { kind: 'utxoref_v2_fee_reserve_registry', version: 1, core: { entries: new Array(256).fill({ counted: true }) } };
  }
  if (profileName === 'utxoref-v2-fee-reserve') {
    return { kind: 'utxoref_v2_fee_reserve', version: 1, core: { kind: 'utxoref_v2_fee_reserve_v1', proof: 'x'.repeat(32 * 1024) } };
  }
  return { kind: 'utxoref_v2_watcher_quorum_bundle', version: 1, receipts: new Array(32).fill({ signature: 'A'.repeat(128) }) };
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function benchmarkProfile(profileName, iterations) {
  const text = JSON.stringify(sampleForProfile(profileName));
  parseJsonStrictProfile(text, profileName, `${profileName} warmup`);
  const timingsMs = [];
  let maximumHeapDeltaBytes = 0;
  for (let index = 0; index < iterations; index++) {
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    parseJsonStrictProfile(text, profileName, `${profileName} benchmark`);
    timingsMs.push(performance.now() - started);
    maximumHeapDeltaBytes = Math.max(maximumHeapDeltaBytes, process.memoryUsage().heapUsed - heapBefore);
  }
  return {
    profile: profileName,
    bytes: Buffer.byteLength(text),
    sha256: sha256Hex(text),
    iterations,
    medianMs: Number(percentile(timingsMs, 0.5).toFixed(3)),
    p95Ms: Number(percentile(timingsMs, 0.95).toFixed(3)),
    maximumMs: Number(Math.max(...timingsMs).toFixed(3)),
    maximumHeapDeltaBytes: Math.max(0, maximumHeapDeltaBytes),
    parsePolicy: SCHEMA_PROFILES[profileName].parsePolicy,
    collectionLimits: SCHEMA_PROFILES[profileName].collections
  };
}

function runBenchmark(args = {}) {
  const iterations = Number(args.iterations || 5);
  const maxProfileMs = Number(args.maxProfileMs || 2000);
  const maxHeapDeltaBytes = Number(args.maxHeapDeltaBytes || 256 * 1024 * 1024);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100) throw new Error('iterations must be in 1..100');
  const profiles = Object.keys(SCHEMA_PROFILES).map((name) => benchmarkProfile(name, iterations));
  const failures = profiles.flatMap((result) => [
    ...(result.maximumMs > maxProfileMs ? [`${result.profile} exceeded ${maxProfileMs} ms`] : []),
    ...(result.maximumHeapDeltaBytes > maxHeapDeltaBytes ? [`${result.profile} exceeded ${maxHeapDeltaBytes} heap bytes`] : [])
  ]);
  return {
    kind: 'utxoref_v2_strict_artifact_profile_benchmark',
    version: 1,
    observedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpu: os.cpus()[0]?.model || 'unknown',
    iterations,
    releaseGates: { maxProfileMs, maxHeapDeltaBytes },
    ok: failures.length === 0,
    failures,
    profiles
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = runBenchmark(args);
  const output = path.resolve(args.output || DEFAULT_OUTPUT);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

if (require.main === module) main();

module.exports = { sampleForProfile, benchmarkProfile, runBenchmark };
