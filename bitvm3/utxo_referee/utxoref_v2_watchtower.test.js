const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseArgs,
  inspectArtifact,
  authorizationPolicy,
  challengeStateBindsArtifact,
  deterministicChallengeAux,
  feeCandidates,
  isFeePolicyReject,
  isFeePolicyError,
  replacementFeeCandidates,
  assertTrackedOutputBinding,
  assertChallengeTransactionBinding,
  assertRpcSnapshotTip,
  deriveChallengeLifecycle,
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
const TRUST_POLICY_PATH = path.join(__dirname, 'artifacts', 'live', 'utxoref_v2_watchtower_trust_policy.json');
const TRUST_POLICY = JSON.parse(fs.readFileSync(TRUST_POLICY_PATH, 'utf8'));
const tr = require('./tradelayer_taproot');
const { txidFromUnsignedHex } = require('./recover_btc_testnet4_reserve_vault');

function boundChallengeState(artifact) {
  const assertion = artifact.graph.assertionOutpoint;
  const feeSats = 1000n;
  const outputSats = BigInt(assertion.amountSats) - feeSats;
  const script = `0014${'44'.repeat(20)}`;
  const unsigned = tr.serializeUnsignedTx(2, [{
    outpoint: tr.outpoint(assertion.txid, assertion.vout),
    sequence: 0xfffffffd
  }], [{ valueSats: outputSats, script }], 0);
  return { challenge: {
    graphHash: artifact.graph.graphHash,
    txid: txidFromUnsignedHex(unsigned),
    vout: 0,
    outputSats: outputSats.toString(),
    feeSats: feeSats.toString(),
    challengeScriptPubKeyHex: script
  } };
}

console.log('\n=== UTXORef V2 Watchtower Tests ===\n');

test('public artifact reconstructs and verifies without a challenger secret', () => {
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
  const result = inspectArtifact(artifact, TRUST_POLICY);
  assert(result.graphHash === artifact.graph.graphHash);
  assert(result.fraudDetected === false, 'honest graph must not trigger a fraud alert');
  assert(result.assertionOutpoint.txid === artifact.funding.txid);
});

test('public artifact cannot nominate its own signer or graph trust', () => {
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
  const untrusted = JSON.parse(JSON.stringify(artifact));
  untrusted.graph.graphHash = 'ff'.repeat(32);
  let rejected = false;
  try { inspectArtifact(untrusted, TRUST_POLICY); }
  catch (err) { rejected = /not externally allowlisted/.test(err.message); }
  assert(rejected);

  const wrongSigner = JSON.parse(JSON.stringify(TRUST_POLICY));
  wrongSigner.allowedGraphs[artifact.graph.graphHash].signerKeyId = '00'.repeat(32);
  rejected = false;
  try { inspectArtifact(artifact, wrongSigner); }
  catch (err) { rejected = /not trusted for this graph/.test(err.message); }
  assert(rejected);
});

test('external graph policy pins an exact minimum fee reserve', () => {
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
  const graphHash = artifact.graph.graphHash;
  const policy = JSON.parse(JSON.stringify(TRUST_POLICY));
  policy.allowedGraphs[graphHash].feeReserve = {
    reserveHash: '77'.repeat(32),
    minimumFeeReserveSats: '10000'
  };
  const inspected = inspectArtifact(artifact, policy);
  assert(inspected.feeReservePolicy.reserveHash === '77'.repeat(32));
  assert(inspected.feeReservePolicy.minimumFeeReserveSats === '10000');
  policy.allowedGraphs[graphHash].feeReserve.minimumFeeReserveSats = '0';
  let rejected = false;
  try { inspectArtifact(artifact, policy); } catch (err) { rejected = /fee reserve policy is invalid/.test(err.message); }
  assert(rejected);
});

test('watchtower CLI keeps monitor and broadcast authority distinct', () => {
  const monitor = parseArgs(['--once', '--artifact', 'public.json']);
  assert(monitor.once === true && monitor.broadcast === false);
  const broadcast = parseArgs(['--broadcast', '--challenger-secret-file', 'test.hex']);
  assert(broadcast.broadcast === true && broadcast.challengerSecretFile === 'test.hex');
  const replacement = parseArgs(['--replace-challenge', '--broadcast', '--challenger-secret-file', 'test.hex']);
  assert(replacement.replaceChallenge === true && replacement.broadcast === true);
});

test('challenge signing auxiliary data is stable and leaf-bound', () => {
  const graphHash = '11'.repeat(32);
  const first = deterministicChallengeAux(graphHash, { scriptHex: '51' });
  const second = deterministicChallengeAux(graphHash, { scriptHex: '51' });
  const otherLeaf = deterministicChallengeAux(graphHash, { scriptHex: '52' });
  assert(first.length === 32);
  assert(first.equals(second), 'same graph and leaf must reproduce the preflight signature input');
  assert(!first.equals(otherLeaf), 'different leaves must use different auxiliary data');
});

// WT-1: this test used to assert that a reorged authorization block or a state
// checkpoint more than six blocks old removed challenge authority
// (`!authorizedForNewChallenge`). That was the vulnerable behaviour: an
// operator who confirmed a fraudulent assertion seven blocks after the
// snapshot could not be challenged. Reorg and staleness are still detected and
// still withdraw fresh settlement authority; they no longer block a challenge.
test('authorization reorg and staleness are detected but never withdraw challenge authority', () => {
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
  const inspected = inspectArtifact(artifact, TRUST_POLICY);
  const tip = inspected.stateSnapshotHeight;
  const untracked = authorizationPolicy(inspected, '33'.repeat(32), {}, tip, artifact);
  assert(untracked.reorged && !untracked.settlementAuthorityFresh && untracked.authorizedForNewChallenge);
  const forged = authorizationPolicy(inspected, '33'.repeat(32), { challenge: { graphHash: inspected.graphHash } }, tip, artifact);
  assert(!forged.tracked, 'a state entry that does not reconstruct the challenge txid is not a tracked challenge');
  const state = boundChallengeState(artifact);
  assert(challengeStateBindsArtifact(artifact, state));
  const tracked = authorizationPolicy(inspected, '33'.repeat(32), state, tip, artifact);
  assert(tracked.reorged && tracked.tracked && tracked.authorizedForNewChallenge);
  const active = authorizationPolicy(inspected, inspected.authorizationBlockHash, {}, tip, artifact);
  assert(!active.reorged && active.settlementAuthorityFresh && active.authorizedForNewChallenge);
  const stale = authorizationPolicy(inspected, inspected.authorizationBlockHash, {}, tip + 7, artifact);
  assert(stale.stale && !stale.settlementAuthorityFresh && stale.authorizedForNewChallenge);
});

test('challenge fee ladder is bounded by policy and the dust floor', () => {
  const fees = feeCandidates({ feeSats: '1000', feeStepSats: '500', maxFeeSats: '2000' }, '6000');
  assert(JSON.stringify(fees) === JSON.stringify(['1000', '1500', '2000']));
  assert(isFeePolicyReject({ allowed: false, 'reject-reason': 'mempool min fee not met' }));
  assert(!isFeePolicyReject({ allowed: false, 'reject-reason': 'mandatory-script-verify-flag-failed' }));
  let rejected = false;
  try { feeCandidates({ feeSats: '1000', maxFeeSats: '5800' }, '6000'); }
  catch (err) { rejected = /dust floor/.test(err.message); }
  assert(rejected, 'fee policy must preserve a non-dust challenge output');
});

test('replacement fees only advance and classify RPC fee failures', () => {
  const fees = replacementFeeCandidates(
    { feeSats: '1000', feeStepSats: '500', maxFeeSats: '2500' },
    '6000',
    '1500'
  );
  assert(JSON.stringify(fees) === JSON.stringify(['2000', '2500']));
  assert(isFeePolicyError(new Error('RPC sendrawtransaction failed: insufficient fee, rejecting replacement')));
  assert(!isFeePolicyError(new Error('RPC sendrawtransaction failed: mandatory-script-verify-flag-failed')));
  assert(!isFeePolicyError(new Error('replacement txid mismatch')));
});

test('tracked outputs and replacement parents are bound to Core and the assertion', () => {
  const challenge = { challengeScriptPubKeyHex: `0014${'22'.repeat(20)}` };
  const tracked = {
    txid: '11'.repeat(32),
    outputSats: '5000',
    challengeScriptPubKeyHex: challenge.challengeScriptPubKeyHex
  };
  assertTrackedOutputBinding(challenge, tracked, {
    value: 0.00005,
    scriptPubKey: { hex: challenge.challengeScriptPubKeyHex }
  });
  let mismatch = false;
  try {
    assertTrackedOutputBinding(challenge, tracked, {
      value: 0.00005,
      scriptPubKey: { hex: `0014${'33'.repeat(20)}` }
    });
  } catch (err) { mismatch = /script does not match/.test(err.message); }
  assert(mismatch, 'state/Core script mismatch must fail closed');

  const artifact = { graph: { assertionOutpoint: { txid: 'aa'.repeat(32), vout: 2 } } };
  assertChallengeTransactionBinding(artifact, tracked, {
    txid: tracked.txid,
    vin: [{ txid: artifact.graph.assertionOutpoint.txid, vout: 2, sequence: 0xfffffffd }],
    vout: [{ value: 0.00005, scriptPubKey: { hex: challenge.challengeScriptPubKeyHex } }]
  });
  let wrongInput = false;
  try {
    assertChallengeTransactionBinding(artifact, tracked, {
      txid: tracked.txid,
      vin: [{ txid: 'bb'.repeat(32), vout: 2, sequence: 0xfffffffd }],
      vout: [{ value: 0.00005, scriptPubKey: { hex: challenge.challengeScriptPubKeyHex } }]
    });
  } catch (err) { wrongInput = /assertion outpoint/.test(err.message); }
  assert(wrongInput, 'replacement must decode to the assertion outpoint');
});

test('challenge lifecycle distinguishes mempool, confirmation, and reorg states', () => {
  const mempool = deriveChallengeLifecycle({ currentHeight: 100, txout: { confirmations: 0 } });
  assert(mempool.action === 'challenge_in_mempool');
  const confirmed = deriveChallengeLifecycle({
    currentHeight: 105,
    txout: { confirmations: 3 },
    inclusionBlockHash: '22'.repeat(32)
  });
  assert(confirmed.action === 'challenge_confirmed');
  assert(confirmed.confirmation.height === 103);
  const reorged = deriveChallengeLifecycle({
    currentHeight: 106,
    txout: null,
    priorConfirmation: confirmed.confirmation,
    activeHashAtPriorHeight: '33'.repeat(32)
  });
  assert(reorged.action === 'challenge_reorged');
  assert(reorged.reorgDetected === true);
  const reconfirmed = deriveChallengeLifecycle({
    currentHeight: 108,
    txout: { confirmations: 2 },
    priorConfirmation: confirmed.confirmation,
    inclusionBlockHash: '44'.repeat(32)
  });
  assert(reconfirmed.action === 'challenge_reconfirmed');
  assert(reconfirmed.reorgDetected === true);
  const reconfirmedAfterMempool = deriveChallengeLifecycle({
    currentHeight: 109,
    txout: { confirmations: 1 },
    reorgPending: true,
    inclusionBlockHash: confirmed.confirmation.blockHash
  });
  assert(reconfirmedAfterMempool.action === 'challenge_reconfirmed');
  const reorgedToMempool = deriveChallengeLifecycle({
    currentHeight: 108,
    txout: { confirmations: 0 },
    priorConfirmation: confirmed.confirmation
  });
  assert(reorgedToMempool.action === 'challenge_in_mempool');
  assert(reorgedToMempool.reorgDetected === true);
});

test('monitoring rejects a mixed Core chain snapshot', () => {
  let rejected = false;
  try {
    assertRpcSnapshotTip({ bestblock: '55'.repeat(32) }, '66'.repeat(32), 'challenge output');
  } catch (err) { rejected = /snapshot does not match/.test(err.message); }
  assert(rejected);
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

// ---- WT-1 regression: port of poc7_watchtower_stale_gate ----
// A gate-fraud assertion (AND(1,1) revealed as 0) whose funding the operator
// broadcast at the last allowed block and confirmed one block later, so the
// state checkpoint is more than six blocks old for the whole challenge window.
const crypto = require('crypto');
const adaptor = require('./tradelayer_dlc_adaptor_sig');
const { buildSignedStateCheckpointV2, publicKeyId } = require('./utxoref_v2');
const { buildWireSecretSetV2, buildPublicTraceV2 } = require('./bitvm_trace_v2');
const graphV2 = require('./bitvm_assertion_graph_v2');
const { runTick, recordTickFailure, recordTickSuccess } = require('./utxoref_v2_watchtower');

function fraudFixture(directory, snapshotHeight) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = publicKeyId(publicKey);
  const genesis = TRUST_POLICY.genesisHash;
  const contractId = '42'.repeat(32);
  const stateEnvelope = buildSignedStateCheckpointV2({
    network: 'bitcoin-testnet4', chainGenesisHash: genesis, contractId, epochId: '91',
    snapshotHeight, snapshotBlockHash: '22'.repeat(32),
    settlementAddressMap: {
      A: { address: 'winner-a', scriptPubKeyHex: '0014' + '01'.repeat(20) },
      C: { address: 'winner-c', scriptPubKeyHex: '0014' + '03'.repeat(20) }
    },
    pnlRows: [
      { id: 'a-wins-from-b', contractId, side: 'long', entryPrice: 2100, closePrice: 2200, quantityUnits: 30, collateralSats: 50000, traderAddress: 'A', counterpartyAddress: 'B' },
      { id: 'c-wins-from-b', contractId, side: 'long', entryPrice: 2100, closePrice: 2200, quantityUnits: 20, collateralSats: 50000, traderAddress: 'C', counterpartyAddress: 'B' }
    ]
  }, { privateKey, publicKey });
  const stateVerification = {
    trustedSigners: { [keyId]: publicKey }, expectedNetwork: 'bitcoin-testnet4',
    expectedGenesisHash: genesis, currentHeight: snapshotHeight
  };
  const binding = graphV2.buildSettlementTraceBindingV2({ stateEnvelope, feeSats: '1000' });
  const wireBundle = buildWireSecretSetV2(['state_checkpoint_valid', 'payout_vector_exact', 'settlement_authorized']);
  const publicTrace = buildPublicTraceV2({
    circuitId: 'utxoref-v2-state-and-payout-authorization', binding, wireBundle,
    values: { state_checkpoint_valid: 1, payout_vector_exact: 1, settlement_authorized: 0 },
    gates: [{ type: 'and', inputs: ['state_checkpoint_valid', 'payout_vector_exact'], output: 'settlement_authorized' }]
  });
  const template = graphV2.buildBitvmAssertionTemplateV2({
    network: 'bitcoin-testnet4', publicTrace,
    expectedInputs: { state_checkpoint_valid: 1, payout_vector_exact: 1 },
    operatorXonly: adaptor.xOnlyPubkey(0x12345n).toString('hex'),
    challengerXonly: adaptor.xOnlyPubkey(0x67890n).toString('hex'),
    challengeCsvBlocks: 6, recoveryCsvBlocks: 2016
  });
  const graph = graphV2.finalizeBitvmAssertionGraphV2({
    template, publicTrace, stateEnvelope, stateVerification,
    assertionOutpoint: { txid: 'aa'.repeat(32), vout: 0, amountSats: binding.assertionAmountSats, scriptPubKeyHex: template.p2trScriptPubKey },
    feeSats: binding.feeSats, recoveryFeeSats: '500', recoveryScriptPubKeyHex: '0014' + '09'.repeat(20),
    operatorSecret: 0x12345n, challengerSecret: 0x67890n
  });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const artifactPath = path.join(directory, 'artifact.json');
  const trustPolicyPath = path.join(directory, 'trust-policy.json');
  fs.writeFileSync(artifactPath, JSON.stringify({
    kind: 'btc_testnet4_utxoref_v2_live_ceremony', version: 2, network: 'bitcoin-testnet4', status: 'broadcast',
    chain: { snapshotHeight, snapshotBlockHash: '22'.repeat(32), genesisHash: genesis },
    keyCeremony: { stateSignerKeyId: keyId, stateSignerPublicKeyPem: pem },
    verificationAtBroadcast: { height: snapshotHeight + 6, blockHash: '33'.repeat(32) },
    graph
  }));
  fs.writeFileSync(trustPolicyPath, JSON.stringify({
    kind: 'utxoref_v2_watchtower_trust_policy', version: 1, policyId: 'wt1-regression',
    network: 'bitcoin-testnet4', genesisHash: genesis,
    trustedSigners: { [keyId]: pem }, allowedGraphs: { [graph.graphHash]: { signerKeyId: keyId } }
  }));
  const rpcAt = (height, confirmations, authorizationOnChain = true) => async (method, params) => {
    const tip = 'bb'.repeat(32);
    if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: height, bestblockhash: tip };
    if (method === 'getblockhash') {
      return authorizationOnChain && params[0] === snapshotHeight + 6 ? '33'.repeat(32) : 'cc'.repeat(32);
    }
    if (method === 'gettxout') {
      return { bestblock: tip, confirmations, value: Number(binding.assertionAmountSats) / 1e8, scriptPubKey: { hex: template.p2trScriptPubKey } };
    }
    throw new Error(`unexpected RPC ${method}`);
  };
  return { artifactPath, trustPolicyPath, rpcAt };
}

const asyncTests = [];
function asyncTest(name, fn) { asyncTests.push({ name, fn }); }

asyncTest('a fraudulent assertion is still challengeable after the state checkpoint goes stale', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-v2-watchtower-stale-'));
  try {
    const snapshot = 150000;
    const { artifactPath, trustPolicyPath, rpcAt } = fraudFixture(directory, snapshot);
    for (const [height, confirmations] of [[snapshot + 6, 0], [snapshot + 7, 1], [snapshot + 12, 6]]) {
      const alertPath = path.join(directory, `alerts-${height}.jsonl`);
      const tick = await runTick({ artifact: artifactPath, trustPolicy: trustPolicyPath, alertPath }, rpcAt(height, confirmations), {});
      assert(tick.fraudDetected === true, `fraud must be detected at height ${height}`);
      assert(tick.action === 'challenge_signature_required', `height ${height}: expected a challenge request, got ${tick.action}`);
      assert(tick.challengeRequest && tick.challengeRequest.fraudType === 'gate');
      assert(fs.existsSync(alertPath), `height ${height}: the challenge request must be alerted`);
      if (height > snapshot + 6) assert(tick.authorization.stale === true, 'staleness must still be reported');
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

asyncTest('a reorged authorization block does not stop a challenge either', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-v2-watchtower-reorg-'));
  try {
    const snapshot = 150000;
    const { artifactPath, trustPolicyPath, rpcAt } = fraudFixture(directory, snapshot);
    const alertPath = path.join(directory, 'alerts.jsonl');
    const tick = await runTick({ artifact: artifactPath, trustPolicy: trustPolicyPath, alertPath }, rpcAt(snapshot + 8, 1, false), {});
    assert(tick.authorization.reorged === true);
    assert(tick.action === 'challenge_signature_required', `expected a challenge request, got ${tick.action}`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

asyncTest('the checked-in live artifact ticks without throwing once its checkpoint is old', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-v2-watchtower-live-'));
  try {
    const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
    const rpc = async (method, params) => {
      if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 160000, bestblockhash: 'bb'.repeat(32) };
      if (method === 'getblockhash') {
        return params[0] === artifact.verificationAtBroadcast.height ? artifact.verificationAtBroadcast.blockHash : 'cc'.repeat(32);
      }
      if (method === 'gettxout') return null; // the live assertion has settled
      throw new Error(`unexpected RPC ${method}`);
    };
    const tick = await runTick({ alertPath: path.join(directory, 'alerts.jsonl') }, rpc, {});
    assert(tick.fraudDetected === false && tick.assertionUnspent === false);
    assert(tick.authorization.stale === true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

asyncTest('a failing tick writes one alert line and counts repeats', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-v2-watchtower-failure-'));
  try {
    const alertPath = path.join(directory, 'alerts.jsonl');
    const args = { alertPath };
    const state = {};
    const first = recordTickFailure(args, state, new Error('Bitcoin Core RPC timed out'));
    const second = recordTickFailure(args, state, new Error('Bitcoin Core RPC timed out'));
    assert(first.logged === true && second.logged === false, 'identical consecutive failures are logged once');
    assert(state.consecutiveFailures === 2 && state.failureCount === 2 && state.alertCount === 1);
    const lines = fs.readFileSync(alertPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert(lines.length === 1 && lines[0].action === 'watchtower_tick_failed' && /timed out/.test(lines[0].message));
    const different = recordTickFailure(args, state, new Error('wrong chain: main'));
    assert(different.logged === true, 'a different failure is a new alert');
    recordTickSuccess(state);
    assert(state.consecutiveFailures === 0 && state.lastError === undefined);
    const afterRecovery = recordTickFailure(args, state, new Error('wrong chain: main'));
    assert(afterRecovery.logged === true, 'a failure after recovery is alerted again');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

(async () => {
  for (const item of asyncTests) {
    try { await item.fn(); console.log(`  OK  ${item.name}`); passed++; }
    catch (err) { console.log(`  FAIL ${item.name}`); console.log(`       ${err.message}`); failed++; }
  }
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
  if (failed) process.exit(1);
})();
