const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseArgs,
  inspectArtifact,
  authorizationPolicy,
  deterministicChallengeAux,
  feeCandidates,
  isFeePolicyReject,
  isFeePolicyError,
  replacementFeeCandidates,
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

test('authorization reorg permits only an already tracked graph to remain monitored', () => {
  const inspected = { graphHash: '11'.repeat(32), authorizationBlockHash: '22'.repeat(32) };
  const untracked = authorizationPolicy(inspected, '33'.repeat(32), {});
  assert(untracked.reorged && !untracked.monitoringOnly && !untracked.authorizedForNewChallenge);
  const tracked = authorizationPolicy(inspected, '33'.repeat(32), {
    challenge: { graphHash: inspected.graphHash }
  });
  assert(tracked.reorged && tracked.monitoringOnly && !tracked.authorizedForNewChallenge);
  const active = authorizationPolicy(inspected, inspected.authorizationBlockHash, {});
  assert(!active.reorged && active.authorizedForNewChallenge);
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
