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

// BVM-4: the challenger signs on its own host. The fixture builds the unsigned
// graph the way stage() does, without RPC.
const bvm4 = (() => {
  const crypto = require('crypto');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const adaptor = require('./tradelayer_dlc_adaptor_sig');
  const { buildSignedStateCheckpointV2, publicKeyId } = require('./utxoref_v2');
  const { buildWireSecretSetV2, buildPublicTraceV2 } = require('./bitvm_trace_v2');
  const graphV2 = require('./bitvm_assertion_graph_v2');
  const live = require('./btc_testnet4_utxoref_v2_live');
  const genesis = '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043';
  const snapshot = 150000;

  function fixture(label, fraudMode = 'honest') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `utxoref-v2-live-${label}-`));
    const secretRoot = path.join(directory, 'operator-host');
    const challengerHost = path.join(directory, 'challenger-host');
    fs.mkdirSync(challengerHost, { recursive: true });
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const keyId = publicKeyId(publicKey);
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    const operatorSecret = 0x5eed01n;
    const challengerSecret = 0x5eed02n;
    const ceremonyId = `utxoref-v2-test-${label}`;
    const ceremonyRoot = path.join(secretRoot, ceremonyId);
    fs.mkdirSync(path.join(ceremonyRoot, 'state-signer'), { recursive: true });
    fs.mkdirSync(path.join(ceremonyRoot, 'operator'), { recursive: true });
    fs.writeFileSync(path.join(ceremonyRoot, 'state-signer', 'public-key.spki.pem'), pem);
    fs.writeFileSync(path.join(ceremonyRoot, 'operator', 'secret.hex'), adaptor.bytes32(operatorSecret).toString('hex') + '\n');
    const challengerSecretFile = path.join(challengerHost, 'secret.hex');
    fs.writeFileSync(challengerSecretFile, adaptor.bytes32(challengerSecret).toString('hex') + '\n');

    const contractId = '4c'.repeat(32);
    const stateEnvelope = buildSignedStateCheckpointV2(live.buildDemoStateBody({
      chainGenesisHash: genesis, contractId, epochId: snapshot, snapshotHeight: snapshot,
      snapshotBlockHash: '22'.repeat(32),
      winnerA: { address: 'winner-a', scriptPubKeyHex: '0014' + '01'.repeat(20) },
      winnerC: { address: 'winner-c', scriptPubKeyHex: '0014' + '03'.repeat(20) }
    }), { privateKey, publicKey, keyId });
    const stateVerification = {
      trustedSigners: { [keyId]: publicKey }, expectedNetwork: 'bitcoin-testnet4',
      expectedGenesisHash: genesis, currentHeight: snapshot, maxAgeBlocks: 6
    };
    const binding = graphV2.buildSettlementTraceBindingV2({ stateEnvelope, feeSats: 1000n });
    const publicTrace = buildPublicTraceV2({
      circuitId: 'utxoref-v2-state-and-payout-authorization', binding,
      gates: [{ type: 'and', inputs: ['state_checkpoint_valid', 'payout_vector_exact'], output: 'settlement_authorized' }],
      wireBundle: buildWireSecretSetV2(['state_checkpoint_valid', 'payout_vector_exact', 'settlement_authorized']),
      values: live.traceValuesForMode(fraudMode).values
    });
    const template = graphV2.buildBitvmAssertionTemplateV2({
      network: 'bitcoin-testnet4', publicTrace,
      operatorXonly: adaptor.xOnlyPubkey(operatorSecret).toString('hex'),
      challengerXonly: adaptor.xOnlyPubkey(challengerSecret).toString('hex'),
      challengeCsvBlocks: 6, recoveryCsvBlocks: 2016
    });
    const unsignedGraph = graphV2.buildUnsignedBitvmAssertionGraphV2({
      template, publicTrace, stateEnvelope, stateVerification,
      assertionOutpoint: { txid: 'aa'.repeat(32), vout: 0, amountSats: binding.assertionAmountSats, scriptPubKeyHex: template.p2trScriptPubKey },
      feeSats: 1000n, recoveryFeeSats: 1000n, recoveryScriptPubKeyHex: '0014' + '09'.repeat(20)
    });
    const artifactPath = path.join(secretRoot, 'artifact.json');
    fs.writeFileSync(artifactPath, JSON.stringify({
      kind: 'btc_testnet4_utxoref_v2_live_ceremony', version: 2, network: 'bitcoin-testnet4',
      status: 'awaiting-challenger-signature', traceMode: fraudMode,
      chain: { snapshotHeight: snapshot, snapshotBlockHash: '22'.repeat(32), genesisHash: genesis },
      keyCeremony: {
        id: ceremonyId, stateSignerKeyId: keyId, stateSignerPublicKeyPem: pem,
        operatorXonly: template.operatorXonly, challengerXonly: template.challengerXonly,
        model: 'separate-challenger-host'
      },
      unsignedGraph: JSON.parse(JSON.stringify(unsignedGraph))
    }, null, 2));
    // The challenger's copy of the artifact and its pinned trust policy.
    const challengerArtifact = path.join(challengerHost, 'artifact.json');
    fs.copyFileSync(artifactPath, challengerArtifact);
    const trustPolicyPath = path.join(challengerHost, 'trust-policy.json');
    fs.writeFileSync(trustPolicyPath, JSON.stringify({
      kind: 'utxoref_v2_watchtower_trust_policy', version: 1, policyId: `bvm4-${label}`,
      network: 'bitcoin-testnet4', genesisHash: genesis, trustedSigners: { [keyId]: pem }, allowedGraphs: {}
    }));
    const rpc = async (method, params) => {
      if (method === 'getblockchaininfo') {
        return { chain: 'testnet4', blocks: snapshot + 2, headers: snapshot + 2, initialblockdownload: false };
      }
      if (method === 'getblockhash' && params[0] === 0) return genesis;
      throw new Error(`unexpected RPC ${method}`);
    };
    return {
      directory, secretRoot, challengerHost, artifactPath, challengerArtifact, trustPolicyPath,
      challengerSecretFile, unsignedGraph, runtime: { artifactPath, secretRoot, rpc }
    };
  }
  return { fixture, live, fs, path };
})();

const asyncTests = [];
function asyncTest(name, fn) { asyncTests.push({ name, fn }); }

asyncTest('BVM-4: the challenger signs on its own host and the operator completes the graph', async () => {
  const { fixture, live, fs, path } = bvm4;
  const f = fixture('split');
  try {
    assert(!fs.existsSync(path.join(f.secretRoot, 'utxoref-v2-test-split', 'challenger')),
      'the operator host holds no challenger secret');
    const out = path.join(f.challengerHost, 'challenger-signature.json');
    const signature = live.challengerSign({
      artifact: f.challengerArtifact, trustPolicy: f.trustPolicyPath,
      challengerSecretFile: f.challengerSecretFile, currentHeight: '150001', out
    });
    assert(signature.unsignedGraphHash === f.unsignedGraph.unsignedGraphHash);
    assert(!JSON.stringify(signature).includes(fs.readFileSync(f.challengerSecretFile, 'utf8').trim()),
      'the signature file leaks the challenger secret');
    const signed = await live.operatorSign(f.runtime, { challengerSignature: out });
    assert(signed.status === 'staged' && signed.unsignedGraph === undefined && signed.verification.ok === true);
    assert(signed.graph.settlementPath.challengerSignature === signature.signature);
    const onDisk = JSON.parse(fs.readFileSync(f.artifactPath, 'utf8'));
    assert(onDisk.status === 'staged' && onDisk.graph.graphHash === signed.graph.graphHash);
    let again = null;
    try { await live.operatorSign(f.runtime, { challengerSignature: out }); } catch (err) { again = err.message; }
    assert(again && /not awaiting a challenger signature/.test(again), again || 'signed twice');
  } finally { bvm4.fs.rmSync(f.directory, { recursive: true, force: true }); }
});

asyncTest('BVM-4: the challenger refuses fraud, unpinned signers and a foreign key', async () => {
  const { fixture, live, fs, path } = bvm4;
  const expectError = (run, pattern, label) => {
    let error = null;
    try { run(); } catch (err) { error = err.message; }
    assert(error && pattern.test(error), `${label}: ${error || 'accepted'}`);
  };
  const fraud = fixture('fraud', 'gate');
  const honest = fixture('refusals');
  try {
    const sign = (f, overrides = {}) => live.challengerSign({
      artifact: f.challengerArtifact, trustPolicy: f.trustPolicyPath, challengerSecretFile: f.challengerSecretFile,
      currentHeight: '150001', out: path.join(f.challengerHost, `sig-${Math.random().toString(16).slice(2)}.json`),
      ...overrides
    });
    expectError(() => sign(fraud), /refuses to pre-sign a trace that contains a provable fraud/, 'fraudulent trace');
    assert(sign(fraud, { allowFraudulentTrace: true }).unsignedGraphHash === fraud.unsignedGraph.unsignedGraphHash,
      'a drill may sign a fraudulent trace explicitly');
    const policy = JSON.parse(fs.readFileSync(honest.trustPolicyPath, 'utf8'));
    fs.writeFileSync(honest.trustPolicyPath, JSON.stringify({ ...policy, trustedSigners: {} }));
    expectError(() => sign(honest), /does not trust this graph's state signer/, 'unpinned state signer');
    fs.writeFileSync(honest.trustPolicyPath, JSON.stringify(policy));
    const foreign = path.join(honest.challengerHost, 'foreign.hex');
    fs.writeFileSync(foreign, '07'.repeat(32));
    expectError(() => sign(honest, { challengerSecretFile: foreign }), /challengerSecret/, 'foreign challenger key');
    expectError(() => sign(honest, { currentHeight: '150100' }), /stale|age|old/i, 'stale state at signing');
    // The operator refuses a signature made for another graph.
    const otherOut = path.join(fraud.challengerHost, 'other.json');
    sign(fraud, { allowFraudulentTrace: true, out: otherOut });
    let mismatch = null;
    try { await live.operatorSign(honest.runtime, { challengerSignature: otherOut }); } catch (err) { mismatch = err.message; }
    assert(mismatch && /not bound to this unsigned graph/.test(mismatch), mismatch || 'foreign signature accepted');
  } finally {
    fs.rmSync(fraud.directory, { recursive: true, force: true });
    fs.rmSync(honest.directory, { recursive: true, force: true });
  }
});

(async () => {
  for (const item of asyncTests) {
    try { await item.fn(); console.log(`  OK  ${item.name}`); passed++; }
    catch (err) { console.log(`  FAIL ${item.name}`); console.log(`       ${err.message}`); failed++; }
  }
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
  if (failed) process.exit(1);
})();
