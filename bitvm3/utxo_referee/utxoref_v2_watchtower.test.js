const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseArgs,
  inspectArtifact,
  saveJsonAtomic,
  loadState
} = require('./utxoref_v2_watchtower');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

const ARTIFACT_PATH = path.join(__dirname, 'artifacts', 'live', 'btc_testnet4_utxoref_v2_latest.json');

console.log('\n=== UTXORef V2 Watchtower Tests ===\n');

test('public artifact reconstructs and verifies without a challenger secret', () => {
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
  const result = inspectArtifact(artifact);
  assert(result.graphHash === artifact.graph.graphHash);
  assert(result.fraudDetected === false, 'honest graph must not trigger a fraud alert');
  assert(result.assertionOutpoint.txid === artifact.funding.txid);
});

test('watchtower CLI keeps monitor and broadcast authority distinct', () => {
  const monitor = parseArgs(['--once', '--artifact', 'public.json']);
  assert(monitor.once === true && monitor.broadcast === false);
  const broadcast = parseArgs(['--broadcast', '--challenger-secret-file', 'test.hex']);
  assert(broadcast.broadcast === true && broadcast.challengerSecretFile === 'test.hex');
});

test('state is written atomically and resumes after a restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-v2-watchtower-'));
  const statePath = path.join(directory, 'state.json');
  saveJsonAtomic(statePath, { kind: 'utxoref_v2_watchtower_state', tickCount: 7 });
  const state = loadState(statePath);
  assert(state.tickCount === 7);
  assert(state.restarts === 1);
});

test('wrong artifact kind fails closed', () => {
  let rejected = false;
  try { inspectArtifact({ kind: 'wrong', version: 2 }); }
  catch (err) { rejected = /wrong UTXORef V2 public artifact/.test(err.message); }
  assert(rejected);
});

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
