const crypto = require('crypto');
const {
  normalizeQuorumPolicy,
  buildWatcherReceipt,
  verifyWatcherReceipt,
  aggregateWatcherReceipts
} = require('./utxoref_v2_watcher_quorum');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

const identities = [
  { watcherId: 'watcher-a', faultDomain: 'home-santiago', keys: crypto.generateKeyPairSync('ed25519') },
  { watcherId: 'watcher-b', faultDomain: 'vps-us-east', keys: crypto.generateKeyPairSync('ed25519') },
  { watcherId: 'watcher-c', faultDomain: 'vps-eu-west', keys: crypto.generateKeyPairSync('ed25519') }
];

function policy(overrides = {}) {
  return {
    kind: 'utxoref_v2_watcher_quorum_policy',
    version: 1,
    policyId: 'quorum-policy-1',
    threshold: 2,
    minFaultDomains: 2,
    maxStatementAgeBlocks: 2,
    watchers: Object.fromEntries(identities.map((identity) => [identity.watcherId, {
      faultDomain: identity.faultDomain,
      publicKeyPem: identity.keys.publicKey.export({ type: 'spki', format: 'pem' })
    }])),
    ...overrides
  };
}

function statement(overrides = {}) {
  return {
    roundId: 'round-100-a',
    graphHash: '11'.repeat(32),
    trustPolicyId: 'trust-policy-1',
    network: 'bitcoin-testnet4',
    height: 100,
    bestBlockHash: '22'.repeat(32),
    authorizationBlockHash: '33'.repeat(32),
    assertionOutpoint: `${'44'.repeat(32)}:0`,
    assertionUnspent: true,
    fraudDetected: false,
    fraudType: null,
    action: 'monitoring',
    challengeTxid: null,
    ...overrides
  };
}

function receipt(index, observation = statement()) {
  const identity = identities[index];
  return buildWatcherReceipt(observation, identity, identity.keys.privateKey);
}

test('two allowlisted watchers in distinct fault domains form a quorum', () => {
  const first = receipt(0);
  assert(verifyWatcherReceipt(first, policy()).ok, 'raw policies must verify directly');
  const quorum = aggregateWatcherReceipts([first, receipt(1)], policy(), {
    currentHeight: 101,
    expectedBestBlockHash: '22'.repeat(32)
  });
  assert(quorum.ok);
  assert(quorum.core.signerCount === 2 && quorum.core.faultDomainCount === 2);
});

test('duplicate watcher receipts cannot satisfy threshold', () => {
  const first = receipt(0);
  let rejected = false;
  try { aggregateWatcherReceipts([first, first], policy()); } catch (err) { rejected = /duplicate watcher/.test(err.message); }
  assert(rejected);
});

test('distinct keys in one fault domain do not satisfy independence policy', () => {
  const sameDomainPolicy = policy({
    watchers: {
      'watcher-a': { faultDomain: 'shared-vps', publicKeyPem: identities[0].keys.publicKey.export({ type: 'spki', format: 'pem' }) },
      'watcher-b': { faultDomain: 'shared-vps', publicKeyPem: identities[1].keys.publicKey.export({ type: 'spki', format: 'pem' }) }
    }
  });
  const aReceipt = buildWatcherReceipt(statement(), { watcherId: 'watcher-a', faultDomain: 'shared-vps' }, identities[0].keys.privateKey);
  const bReceipt = buildWatcherReceipt(statement(), { watcherId: 'watcher-b', faultDomain: 'shared-vps' }, identities[1].keys.privateKey);
  const quorum = aggregateWatcherReceipts([aReceipt, bReceipt], sameDomainPolicy);
  assert(!quorum.ok && quorum.core.thresholdMet && !quorum.core.faultDomainsMet);
});

test('watchers on different chain tips cannot form a quorum', () => {
  let rejected = false;
  try { aggregateWatcherReceipts([receipt(0), receipt(1, statement({ bestBlockHash: '99'.repeat(32) }))], policy()); }
  catch (err) { rejected = /disagree/.test(err.message); }
  assert(rejected);
});

test('round, height, and expected tip prevent stale receipt replay', () => {
  let stale = false;
  try { aggregateWatcherReceipts([receipt(0), receipt(1)], policy(), { currentHeight: 103 }); }
  catch (err) { stale = /age/.test(err.message); }
  assert(stale);
  let wrongTip = false;
  try { aggregateWatcherReceipts([receipt(0), receipt(1)], policy(), { expectedBestBlockHash: 'aa'.repeat(32) }); }
  catch (err) { wrongTip = /expected chain tip/.test(err.message); }
  assert(wrongTip);
  let wrongRound = false;
  try { aggregateWatcherReceipts([receipt(0), receipt(1, statement({ roundId: 'round-100-b' }))], policy()); }
  catch (err) { wrongRound = /disagree/.test(err.message); }
  assert(wrongRound);
});

test('tampered statements, signatures, identities, and reused policy keys fail closed', () => {
  const valid = receipt(0);
  const tampered = JSON.parse(JSON.stringify(valid));
  tampered.core.statement.height += 1;
  assert(!verifyWatcherReceipt(tampered, policy()).ok);
  const wrongDomain = JSON.parse(JSON.stringify(valid));
  wrongDomain.core.faultDomain = 'vps-us-east';
  assert(/fault domain/.test(verifyWatcherReceipt(wrongDomain, policy()).reason));
  const reused = policy();
  reused.watchers['watcher-c'].publicKeyPem = reused.watchers['watcher-a'].publicKeyPem;
  let rejected = false;
  try { normalizeQuorumPolicy(reused); } catch (err) { rejected = /reuses/.test(err.message); }
  assert(rejected);
});

test('an under-threshold receipt set remains explicit evidence, not a quorum', () => {
  const quorum = aggregateWatcherReceipts([receipt(0)], policy());
  assert(!quorum.ok && !quorum.core.thresholdMet);
});

let passed = 0;
let failed = 0;
for (const item of tests) {
  try { item.fn(); console.log(`  OK  ${item.name}`); passed += 1; }
  catch (err) { console.log(`  FAIL ${item.name}\n       ${err.message}`); failed += 1; }
}
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
