'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dlc = require('./tradelayer_dlc_adaptor_sig');
const {
  ALL_EVIDENCE_KINDS,
  REQUIRED_EVIDENCE,
  createDlcContract,
  signValidationReceipt,
  validateDlcContract,
  transitionDlcContract
} = require('./dlc_contract_state');
const { DlcStateStore } = require('./dlc_state_store');
const {
  validateOracleSet,
  buildThresholdOutcomeSets,
  combineThresholdAttestations
} = require('./dlc_threshold_oracle');
const { validateFundingAuthorization } = require('./m1_dlc_sign_finalize');
const { createDlcCryptoProvider, requireDlcSigningProvider } = require('./dlc_crypto_provider');
const { DlcOracleEventStore } = require('./dlc_oracle_event_store');

let passed = 0;
let failed = 0;
function test(name, run) {
  try {
    run();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
    failed++;
  }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
function expectThrow(run, pattern) {
  try { run(); } catch (error) { if (pattern.test(error.message)) return; throw error; }
  throw new Error(`expected error matching ${pattern}`);
}
function hash(label) { return crypto.createHash('sha256').update(label).digest(); }
function digest(label) { return hash(label).toString('hex'); }
const validatorKeys = crypto.generateKeyPairSync('ed25519');
const validatorPublicKeySpki = validatorKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const validatorKeyId = crypto.createHash('sha256').update(Buffer.from(validatorPublicKeySpki, 'base64')).digest('hex');
const validatorPolicy = Object.fromEntries(ALL_EVIDENCE_KINDS.map((kind) => [kind, {
  keyId: validatorKeyId,
  publicKeySpki: validatorPublicKeySpki
}]));

function requestFor(contract, to, suffix = to, overrides = {}) {
  const idempotencyKey = `transition:${suffix}`;
  return {
    to,
    idempotencyKey,
    evidence: REQUIRED_EVIDENCE[to].map((kind) => signValidationReceipt({
      privateKey: validatorKeys.privateKey,
      contractId: contract.contractId,
      contractDigest: contract.contractDigest,
      from: contract.stage,
      to,
      idempotencyKey,
      kind,
      digest: overrides[kind] || digest(`${to}:${kind}`)
    }))
  };
}

const oracleSecrets = [101n, 202n, 303n];
const nonceSeeds = [1001n, 2002n, 3003n];
const outcome = hash('threshold-event:yes');
const otherOutcome = hash('threshold-event:no');
const announcements = oracleSecrets.map((secret, index) => dlc.buildDlcOracle(secret, nonceSeeds[index], {
  eventId: 'threshold-event',
  outcomeMessages: [outcome, otherOutcome]
}));
const pinnedPubkeys = announcements.map((announcement) => announcement.px);

console.log('\n=== DLC Infrastructure Hardening Tests ===\n');

test('2-of-3 oracle set produces three canonical adaptor combinations', () => {
  const policy = validateOracleSet(announcements, 2, pinnedPubkeys);
  const sets = buildThresholdOutcomeSets({ announcements, threshold: 2, pinnedPubkeys, outcomeMsg32: outcome });
  assert(policy.threshold === 2 && policy.total === 3, 'wrong threshold policy');
  assert(sets.length === 3, '2-of-3 must produce three oracle subsets');
  assert(new Set(sets.map((set) => set.oraclePubkeys.join(':'))).size === 3, 'subsets must be unique');
});

test('any valid two-oracle subset completes its matching adaptor signature', () => {
  const signerSecret = 909n;
  const publicKey = dlc.xOnlyPubkey(signerSecret);
  const cetMessage = hash('threshold-cet');
  const sets = buildThresholdOutcomeSets({ announcements, threshold: 2, pinnedPubkeys, outcomeMsg32: outcome });
  const byKey = new Map(announcements.map((announcement, index) => [announcement.px, { announcement, index }]));
  for (const set of sets) {
    const presignature = dlc.adaptorSign(signerSecret, cetMessage, set.outcomePoint, hash(`aux:${set.oraclePubkeys.join(':')}`));
    const subset = set.oraclePubkeys.map((key) => byKey.get(key));
    const attestations = subset.map(({ announcement }) => dlc.dlcAttest(announcement, outcome));
    const combined = combineThresholdAttestations({
      announcements,
      threshold: 2,
      pinnedPubkeys,
      outcomeMsg32: outcome,
      attestations,
      oraclePubkeys: set.oraclePubkeys
    });
    const signature = dlc.adaptorComplete(presignature, combined.scalar);
    assert(dlc.schnorrVerify(publicKey, cetMessage, signature), 'threshold-completed CET signature failed');
  }
});

test('threshold policy rejects one attestation, duplicates, and unpinned sets', () => {
  const attestation = dlc.dlcAttest(announcements[0], outcome);
  expectThrow(() => combineThresholdAttestations({
    announcements,
    threshold: 2,
    pinnedPubkeys,
    outcomeMsg32: outcome,
    attestations: [attestation],
    oraclePubkeys: [announcements[0].px]
  }), /exactly 2/);
  expectThrow(() => combineThresholdAttestations({
    announcements,
    threshold: 2,
    pinnedPubkeys,
    outcomeMsg32: outcome,
    attestations: [attestation, attestation],
    oraclePubkeys: [announcements[0].px, announcements[0].px]
  }), /duplicate/);
  expectThrow(() => validateOracleSet(announcements, 2, [pinnedPubkeys[0], pinnedPubkeys[1], '11'.repeat(32)]), /pinned/);
});

function initialContract(contractId = 'contract-1') {
  return createDlcContract({
    contractId,
    network: 'bitcoin-testnet4',
    contractDigest: digest(`contract:${contractId}`),
    oraclePolicy: { threshold: 2, total: 3, pinnedPubkeys },
    validatorPolicy
  });
}

test('state machine rejects skipped stages and missing validation receipts', () => {
  const contract = initialContract();
  expectThrow(() => transitionDlcContract(contract, requestFor(contract, 'CANONICAL_CETS_AND_REFUND')), /invalid DLC transition/);
  const incomplete = requestFor(contract, 'AUTHENTICATED_ORACLES');
  expectThrow(() => transitionDlcContract(contract, {
    ...incomplete,
    evidence: []
  }), /evidence must contain|requires oracle_policy/);
});

test('state machine reaches funding approval only through every required gate', () => {
  let contract = initialContract('ordered-contract');
  const stages = [
    'AUTHENTICATED_ORACLES',
    'CANONICAL_CETS_AND_REFUND',
    'COUNTERPARTY_SIGNATURES_VERIFIED',
    'LOCAL_SIGNATURES_PERSISTED',
    'FUNDING_PSBT_APPROVED'
  ];
  let oracleRequest;
  for (const stage of stages) {
    const stageRequest = requestFor(contract, stage);
    if (stage === 'AUTHENTICATED_ORACLES') oracleRequest = stageRequest;
    contract = transitionDlcContract(contract, stageRequest);
  }
  assert(contract.stage === 'FUNDING_PSBT_APPROVED' && contract.revision === 5, 'funding approval ordering failed');
  assert(validateDlcContract(contract), 'ordered contract did not validate');
  const repeated = transitionDlcContract(contract, oracleRequest);
  assert(repeated === contract, 'identical transition retry must be idempotent');
  const altered = JSON.parse(JSON.stringify(oracleRequest));
  altered.evidence[0].digest = digest('different-policy');
  expectThrow(() => transitionDlcContract(contract, altered), /signature is invalid|idempotency key/);
});

test('state hash detects transition evidence tampering', () => {
  const initial = initialContract('tamper-contract');
  const advanced = transitionDlcContract(initial, requestFor(initial, 'AUTHENTICATED_ORACLES'));
  const tampered = JSON.parse(JSON.stringify(advanced));
  tampered.history[0].evidence[0].digest = '00'.repeat(32);
  expectThrow(() => validateDlcContract(tampered), /hash mismatch|request or prior transcript/);
});

test('append-only store survives reload and rejects stale revisions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-dlc-state-'));
  try {
    const store = new DlcStateStore(directory);
    const initial = initialContract('stored-contract');
    store.create(initial);
    const oracleRequest = requestFor(initial, 'AUTHENTICATED_ORACLES');
    const advanced = store.transition(initial.contractId, 0, oracleRequest);
    assert(advanced.revision === 1, 'store did not advance');
    const reloaded = new DlcStateStore(directory).read(initial.contractId);
    assert(reloaded.recordHash === advanced.recordHash, 'reloaded state differs');
    expectThrow(() => store.transition(initial.contractId, 0, requestFor(advanced, 'CANONICAL_CETS_AND_REFUND')), /stale DLC state revision/);
    const replay = store.transition(initial.contractId, 0, oracleRequest);
    assert(replay.recordHash === advanced.recordHash, 'idempotent stale retry should return committed state');
    const chain = store.verifyChain(initial.contractId);
    assert(chain.ok && chain.revisions === 2, 'append-only revision chain failed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('wallet funding signing is bound to an approved PSBT digest and network', () => {
  const psbtBytes = Buffer.from('70736274ff01020304', 'hex');
  const psbt = psbtBytes.toString('base64');
  let contract = initialContract('funding-gate-contract');
  const stages = [
    'AUTHENTICATED_ORACLES',
    'CANONICAL_CETS_AND_REFUND',
    'COUNTERPARTY_SIGNATURES_VERIFIED',
    'LOCAL_SIGNATURES_PERSISTED'
  ];
  for (const stage of stages) contract = transitionDlcContract(contract, requestFor(contract, stage, `funding:${stage}`));
  contract = transitionDlcContract(contract, requestFor(
    contract,
    'FUNDING_PSBT_APPROVED',
    'funding-approved',
    { funding_psbt_validation: crypto.createHash('sha256').update(psbtBytes).digest('hex') }
  ));
  const funding = { chain: { network: 'testnet4' }, funding: { psbt } };
  const authorization = validateFundingAuthorization(contract, funding);
  assert(authorization.psbt === psbt && authorization.stateRecordHash === contract.recordHash, 'funding authorization failed');
  expectThrow(() => validateFundingAuthorization(contract, {
    ...funding,
    funding: { psbt: Buffer.from('70736274ff09090909', 'hex').toString('base64') }
  }), /does not match/);
  expectThrow(() => validateFundingAuthorization(contract, {
    ...funding,
    chain: { network: 'main' }
  }), /network must be testnet4/);
});

test('crypto provider defaults closed and confines JavaScript secrets to explicit test mode', () => {
  const disabled = createDlcCryptoProvider({ network: 'bitcoin-testnet4' });
  assert(disabled.mode === 'disabled' && Object.keys(disabled.operations).length === 0, 'default provider must be disabled');
  expectThrow(() => createDlcCryptoProvider({ network: 'bitcoin-testnet4', mode: 'experimental-js' }), /allowExperimental/);
  expectThrow(() => createDlcCryptoProvider({
    network: 'bitcoin-mainnet',
    mode: 'experimental-js',
    allowExperimental: true
  }), /mainnet/);
  const research = createDlcCryptoProvider({
    network: 'bitcoin-testnet4',
    mode: 'experimental-js',
    allowExperimental: true
  });
  assert(requireDlcSigningProvider(research) === research, 'explicit research provider was rejected');
  assert(research.productionReady === false && research.capabilities.nativeSecretArithmetic === false, 'research provider overstated security');
});

test('native provider rejects incomplete security capability claims', () => {
  expectThrow(() => createDlcCryptoProvider({
    network: 'bitcoin-testnet4',
    mode: 'native-isolated',
    implementation: { capabilities: { apiVersion: 1 } }
  }), /capability manifest/);
});

test('sealed oracle event survives restart and persists before attestation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-oracle-state-'));
  const wrappingKey = hash('oracle-wrapping-key');
  try {
    const firstStore = new DlcOracleEventStore({
      baseDirectory: directory,
      wrappingKey,
      network: 'bitcoin-testnet4'
    });
    const eventOutcome = hash('persistent-oracle:yes');
    const conflictingOutcome = hash('persistent-oracle:no');
    const announcement = firstStore.createEvent({
      oracleSecret: 707n,
      nonceSeed: 808n,
      eventId: 'persistent-oracle-event',
      outcomeMessages: [eventOutcome, conflictingOutcome]
    });
    firstStore.close();

    const restartedStore = new DlcOracleEventStore({
      baseDirectory: directory,
      wrappingKey,
      network: 'bitcoin-testnet4'
    });
    const restoredAnnouncement = restartedStore.getAnnouncement({
      oraclePubkey: announcement.px,
      eventId: announcement.eventId
    });
    assert(restoredAnnouncement.signature === announcement.signature, 'announcement changed after restart');
    const attestation = restartedStore.attest({
      oraclePubkey: announcement.px,
      eventId: announcement.eventId,
      outcomeMsg32: eventOutcome
    });
    assert(dlc.verifyDlcAttestation(restoredAnnouncement, eventOutcome, attestation), 'restored attestation failed');
    const retry = restartedStore.attest({
      oraclePubkey: announcement.px,
      eventId: announcement.eventId,
      outcomeMsg32: eventOutcome
    });
    assert(retry === attestation, 'restored identical retry was not idempotent');
    expectThrow(() => restartedStore.attest({
      oraclePubkey: announcement.px,
      eventId: announcement.eventId,
      outcomeMsg32: conflictingOutcome
    }), /conflicting outcome/);
    const chain = restartedStore.verifyChain({ oraclePubkey: announcement.px, eventId: announcement.eventId });
    assert(chain.ok && chain.revisions === 2, 'oracle event state was not append-only');
    restartedStore.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('sealed oracle state rejects the wrong wrapping key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-oracle-wrong-key-'));
  try {
    const outcomeMessage = hash('wrong-key:outcome');
    const creator = new DlcOracleEventStore({
      baseDirectory: directory,
      wrappingKey: hash('correct-wrapping-key'),
      network: 'bitcoin-testnet4'
    });
    const announcement = creator.createEvent({
      oracleSecret: 919n,
      nonceSeed: 929n,
      eventId: 'wrong-key-event',
      outcomeMessages: [outcomeMessage]
    });
    creator.close();
    const wrong = new DlcOracleEventStore({
      baseDirectory: directory,
      wrappingKey: hash('wrong-wrapping-key'),
      network: 'bitcoin-testnet4'
    });
    expectThrow(() => wrong.attest({
      oraclePubkey: announcement.px,
      eventId: announcement.eventId,
      outcomeMsg32: outcomeMessage
    }), /authentication failed/);
    wrong.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}
console.log(`\nPASS: ${passed} tests\n`);
