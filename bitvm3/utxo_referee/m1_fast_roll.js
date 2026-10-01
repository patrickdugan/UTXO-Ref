/**
 * Milestone 1 - Fast Roll Handoff
 *
 * Uses the current challenge bundle plus oracle wiring to emit an
 * event-driven roll publication. This is a bookkeeping artifact that
 * captures the intended "send -> new contract" handoff.
 *
 * Run:
 *   node bitvm3/utxo_referee/m1_fast_roll.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { buildFastRollHandoff } = require('./m1_oracle_delta_publication');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const BUNDLE_PATH = path.join(ARTIFACTS_DIR, 'm1_challenge_bundle_latest.json');
const ORACLE_PATH = path.join(ARTIFACTS_DIR, 'm1_oracle_wiring_latest.json');
const OUT_PATH = path.join(ARTIFACTS_DIR, 'm1_fast_roll_latest.json');

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function loadJson(p) {
  if (!fs.existsSync(p)) {
    throw new Error(`Missing artifact: ${p}`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function run() {
  const challengeBundle = loadJson(BUNDLE_PATH);
  const oracleWiring = loadJson(ORACLE_PATH);

  const handoff = buildFastRollHandoff({
    challengeBundle,
    oracleWiring,
    selectedPath: challengeBundle.selectedPath,
    deltaSats: challengeBundle.deltaPublication?.deltaSats || challengeBundle.selectedPath?.residualSats || 0n,
    bundleHash: challengeBundle.bundleHash || null
  });

  const artifact = {
    kind: 'm1_fast_roll',
    createdAt: new Date().toISOString(),
    sourceArtifacts: {
      challengeBundlePath: BUNDLE_PATH,
      oracleWiringPath: ORACLE_PATH,
      challengeBundleHash: challengeBundle.bundleHash || null,
      oracleWiringHash: sha256Hex(JSON.stringify(oracleWiring))
    },
    handoff
  };

  artifact.artifactHash = sha256Hex(JSON.stringify(artifact));
  fs.writeFileSync(OUT_PATH, JSON.stringify(artifact, null, 2));

  console.log('=== M1 Fast Roll ===');
  console.log(`oracleMapId=${handoff.oracleMapId}`);
  console.log(`publicationId=${handoff.publication.publicationId}`);
  console.log(`nextContractId=${handoff.nextContract.contractId}`);
  console.log(`artifactHash=${artifact.artifactHash}`);
  console.log(`artifactPath=${OUT_PATH}`);
}

try {
  run();
} catch (err) {
  console.error('Fast roll generation failed:', err.message);
  process.exit(1);
}
