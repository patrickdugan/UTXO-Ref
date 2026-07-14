const { parentPort, workerData } = require('worker_threads');
const { performance } = require('perf_hooks');
const { readJsonStrictProfile } = require('../../bitvm3/utxo_referee/strict_artifact_profiles');
const { inspectArtifact } = require('../../bitvm3/utxo_referee/utxoref_v2_watchtower');
const { sha256 } = require('./betaStore');

function run() {
  const artifact = readJsonStrictProfile(workerData.artifactPath, 'utxoref-v2-public-artifact', 'beta public artifact');
  const trustPolicy = readJsonStrictProfile(workerData.trustPolicyPath, 'utxoref-v2-trust-policy', 'beta trust policy');
  const started = performance.now();
  let passed = 0;
  let graphHash = null;
  const digests = [];
  for (let index = 0; index < workerData.iterations; index++) {
    const inspection = inspectArtifact(artifact, trustPolicy);
    if (graphHash && graphHash !== inspection.graphHash) throw new Error('graph hash changed inside stress run');
    graphHash = inspection.graphHash;
    const ok = inspection.verification?.ok === true;
    if (ok) passed += 1;
    digests.push(sha256(JSON.stringify({ graphHash: inspection.graphHash, ok, index })));
  }
  const elapsedMs = performance.now() - started;
  return {
    passed,
    failed: workerData.iterations - passed,
    graphHash,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    verificationsPerSecond: Number((workerData.iterations / Math.max(elapsedMs / 1000, 0.000001)).toFixed(2)),
    resultDigest: sha256(digests.join(''))
  };
}

try { parentPort.postMessage({ ok: true, result: run() }); }
catch (err) { parentPort.postMessage({ ok: false, error: err.message }); }
