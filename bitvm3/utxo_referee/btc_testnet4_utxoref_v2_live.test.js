const { traceValuesForMode, graphVerificationOptions } = require('./btc_testnet4_utxoref_v2_live');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

console.log('\n=== Bitcoin Testnet4 UTXORef V2 Live Staging Tests ===\n');

test('honest trace is internally consistent', () => {
  const trace = traceValuesForMode('honest');
  assert(trace.mode === 'honest');
  assert(trace.values.settlement_authorized === 1);
});

test('gate fraud keeps true inputs but asserts a false output', () => {
  const trace = traceValuesForMode('gate');
  assert(trace.values.state_checkpoint_valid === 1);
  assert(trace.values.payout_vector_exact === 1);
  assert(trace.values.settlement_authorized === 0);
});

test('input fraud remains gate-consistent but violates expected input binding', () => {
  const trace = traceValuesForMode('input');
  assert(trace.values.state_checkpoint_valid === 0);
  assert(trace.values.payout_vector_exact === 1);
  assert(trace.values.settlement_authorized === 0);
});

test('unknown fraud modes fail closed', () => {
  let rejected = false;
  try { traceValuesForMode('anything'); }
  catch (err) { rejected = /fraudMode/.test(err.message); }
  assert(rejected);
});

// BVM-5: the driver verifies --broadcast and --settle against the pinned
// trust policy, not against the signer key the artifact names for itself.
test('graph verification options come from the pinned trust policy, never the artifact', () => {
  const crypto = require('crypto');
  const fs = require('fs');
  const path = require('path');
  const live = path.join(__dirname, 'artifacts', 'live');
  const artifact = JSON.parse(fs.readFileSync(path.join(live, 'btc_testnet4_utxoref_v2_latest.json'), 'utf8'));
  const trustPolicy = JSON.parse(fs.readFileSync(path.join(live, 'utxoref_v2_watchtower_trust_policy.json'), 'utf8'));
  let missingPolicy = null;
  try { graphVerificationOptions(artifact, 1000); } catch (err) { missingPolicy = err.message; }
  assert(missingPolicy && /pinned trust policy is required/.test(missingPolicy), missingPolicy || 'no policy accepted');

  const pinned = graphVerificationOptions(artifact, 1000, trustPolicy);
  const signerKeyId = trustPolicy.allowedGraphs[artifact.graph.graphHash].signerKeyId;
  assert(Object.keys(pinned.trustedSigners).join() === signerKeyId, 'trusted signer is not the pinned one');

  // An artifact that names its own (attacker) signer key is refused.
  const attacker = crypto.generateKeyPairSync('ed25519');
  const forged = JSON.parse(JSON.stringify(artifact));
  forged.keyCeremony.stateSignerPublicKeyPem = attacker.publicKey.export({ type: 'spki', format: 'pem' });
  let forgedError = null;
  try { graphVerificationOptions(forged, 1000, trustPolicy); } catch (err) { forgedError = err.message; }
  assert(forgedError && /differs from the external trust policy/.test(forgedError), forgedError || 'self-nominated key accepted');

  // A graph the policy has not pinned cannot be broadcast or settled.
  const unpinned = JSON.parse(JSON.stringify(artifact));
  unpinned.graph.graphHash = 'ab'.repeat(32);
  let unpinnedError = null;
  try { graphVerificationOptions(unpinned, 1000, trustPolicy); } catch (err) { unpinnedError = err.message; }
  assert(unpinnedError && /not externally allowlisted/.test(unpinnedError), unpinnedError || 'unpinned graph accepted');
});

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
