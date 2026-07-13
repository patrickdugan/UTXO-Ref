const fs = require('fs');
const path = require('path');
const {
  SCHEMA_PROFILES,
  validateArtifactProfile,
  parseJsonStrictProfile,
  readJsonStrictProfile
} = require('./strict_artifact_profiles');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
function rejects(fn, pattern) {
  try { fn(); } catch (err) { return pattern.test(err.message); }
  return false;
}

test('live public artifact and trust policy fit their named profiles', () => {
  const root = path.join(__dirname, 'artifacts', 'live');
  const artifact = readJsonStrictProfile(
    path.join(root, 'btc_testnet4_utxoref_v2_latest.json'),
    'utxoref-v2-public-artifact'
  );
  const trust = readJsonStrictProfile(
    path.join(root, 'utxoref_v2_watchtower_trust_policy.json'),
    'utxoref-v2-trust-policy'
  );
  assert(artifact.version === 2 && trust.version === 1);
});

test('public graph gates and payout rows have independent schema ceilings', () => {
  const input = {
    kind: 'btc_testnet4_utxoref_v2_live_ceremony',
    version: 2,
    graph: { publicTrace: { gates: new Array(4097).fill(null) } }
  };
  assert(rejects(() => validateArtifactProfile(input, 'utxoref-v2-public-artifact'), /gates exceeds schema maximum 4096/));
  input.graph.publicTrace.gates = [];
  input.graph.settlement = { payouts: new Array(2049).fill(null) };
  assert(rejects(() => validateArtifactProfile(input, 'utxoref-v2-public-artifact'), /payouts exceeds schema maximum 2048/));
});

test('trust signer and graph limits fail before downstream graph verification', () => {
  const allowedGraphs = {};
  for (let index = 0; index < 257; index++) allowedGraphs[index.toString(16).padStart(64, '0')] = {};
  const text = JSON.stringify({
    kind: 'utxoref_v2_watchtower_trust_policy',
    version: 1,
    allowedGraphs,
    trustedSigners: {}
  });
  assert(rejects(() => parseJsonStrictProfile(text, 'utxoref-v2-trust-policy'), /allowedGraphs exceeds schema maximum 256/));
});

test('durable state bounds replacement and confirmation history independently', () => {
  const state = {
    kind: 'utxoref_v2_watchtower_state',
    challenge: { replacements: new Array(33).fill({}), confirmationHistory: [] }
  };
  assert(rejects(() => validateArtifactProfile(state, 'utxoref-v2-watchtower-state'), /replacements exceeds schema maximum 32/));
  state.challenge.replacements = [];
  state.challenge.feeReserveLifecycle = { replacements: new Array(33).fill({}) };
  assert(rejects(() => validateArtifactProfile(state, 'utxoref-v2-watchtower-state'), /feeReserveLifecycle.replacements exceeds schema maximum 32/));
});

test('reserve CPFP guardian approvals use a separate bounded profile', () => {
  const approval = {
    kind: 'utxoref_v2_reserve_cpfp_guardian_approval',
    version: 1,
    approved: true,
    core: {}
  };
  assert(validateArtifactProfile(approval, 'utxoref-v2-reserve-cpfp-approval') === approval);
  approval.version = 2;
  assert(rejects(() => validateArtifactProfile(approval, 'utxoref-v2-reserve-cpfp-approval'), /wrong version/));
});

test('registry and quorum bundle profiles enforce operational fanout', () => {
  const registry = { kind: 'utxoref_v2_fee_reserve_registry', version: 1, core: { entries: new Array(257).fill({}) } };
  const quorum = { kind: 'utxoref_v2_watcher_quorum_bundle', version: 1, receipts: new Array(33).fill({}) };
  assert(rejects(() => validateArtifactProfile(registry, 'utxoref-v2-fee-reserve-registry'), /maximum 256/));
  assert(rejects(() => validateArtifactProfile(quorum, 'utxoref-v2-watcher-quorum'), /maximum 32/));
});

test('profiles retain parser byte, node, depth, and string limits', () => {
  for (const selected of Object.values(SCHEMA_PROFILES)) {
    assert(selected.parsePolicy.maxBytes > 0);
    assert(selected.parsePolicy.maxTotalNodes > 0);
    assert(selected.parsePolicy.maxDepth > 0);
    assert(selected.parsePolicy.maxStringBytes > 0);
  }
  const oversized = JSON.stringify({
    kind: 'utxoref_v2_watcher_quorum_bundle',
    version: 1,
    receipts: [{ payload: 'x'.repeat(70 * 1024) }]
  });
  assert(rejects(() => parseJsonStrictProfile(oversized, 'utxoref-v2-watcher-quorum'), /string exceeds/));
});

let passed = 0;
let failed = 0;
for (const item of tests) {
  try { item.fn(); console.log(`  OK  ${item.name}`); passed += 1; }
  catch (err) { console.log(`  FAIL ${item.name}\n       ${err.message}`); failed += 1; }
}
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
