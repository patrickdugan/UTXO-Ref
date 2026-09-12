#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');

const implementationPath = path.join(
  __dirname,
  '..',
  'bitvm3',
  'utxo_referee',
  'tradelayer_dlc_adaptor_sig.js'
);
const fundingFinalizerPath = path.join(
  __dirname,
  '..',
  'bitvm3',
  'utxo_referee',
  'm1_dlc_sign_finalize.js'
);
const dlc = require(implementationPath);
const {
  ALL_EVIDENCE_KINDS,
  REQUIRED_EVIDENCE,
  createDlcContract,
  signValidationReceipt,
  transitionDlcContract
} = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_contract_state.js'));
const { DlcStateStore } = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_state_store.js'));
const {
  buildThresholdOutcomeSets,
  combineThresholdAttestations
} = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_threshold_oracle.js'));
const { validateFundingAuthorization } = require(fundingFinalizerPath);
const { createDlcCryptoProvider } = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_crypto_provider.js'));
const { DlcOracleEventStore } = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_oracle_event_store.js'));
const validatorKeys = crypto.generateKeyPairSync('ed25519');
const validatorSpki = validatorKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const validatorKeyId = crypto.createHash('sha256').update(Buffer.from(validatorSpki, 'base64')).digest('hex');
const validatorPolicy = Object.fromEntries(ALL_EVIDENCE_KINDS.map((kind) => [kind, {
  keyId: validatorKeyId,
  publicKeySpki: validatorSpki
}]));

const PROFILES = {
  lite: { adversarialRuns: 8 },
  full: { adversarialRuns: 64 },
  scale: { adversarialRuns: 512 }
};

function option(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

const profileName = option('profile', process.env.EVAL_PROFILE || 'full');
const profile = PROFILES[profileName];
if (!profile) throw new Error(`Unknown profile ${profileName}; expected lite, full, or scale`);
const seed = Number(option('seed', process.env.EVAL_SEED || '3549216002')) >>> 0;
const jsonOnly = process.argv.includes('--json');
const requirePerfect = process.argv.includes('--require-perfect');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function scalar(label) {
  return (dlc.bufToBig(sha256(`${seed}:${label}`)) % (dlc.N - 1n)) + 1n;
}

function throws(fn, pattern) {
  try {
    fn();
    return false;
  } catch (error) {
    return pattern.test(error && error.message ? error.message : String(error));
  }
}

function evidenceFor(contract, stage, idempotencyKey, overrides = {}) {
  return REQUIRED_EVIDENCE[stage].map((kind) => signValidationReceipt({
    privateKey: validatorKeys.privateKey,
    contractId: contract.contractId,
    contractDigest: contract.contractDigest,
    from: contract.stage,
    to: stage,
    idempotencyKey,
    kind,
    digest: overrides[kind] || sha256(`${stage}:${kind}`).toString('hex')
  }));
}

const cases = [];
function check(name, category, points, run) {
  const started = process.hrtime.bigint();
  try {
    const value = run();
    const passed = value === true;
    cases.push({
      name,
      category,
      points,
      passed,
      detail: passed ? undefined : (typeof value === 'string' ? value : 'security property was not satisfied'),
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6
    });
  } catch (error) {
    cases.push({
      name,
      category,
      points,
      passed: false,
      detail: error && error.message ? error.message : String(error),
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6
    });
  }
}

check('valid adaptor signature completes and extracts its scalar', 'correctness', 8, () => {
  const signingSecret = scalar('roundtrip:signer');
  const adaptorSecret = scalar('roundtrip:adaptor');
  const message = sha256('roundtrip:message');
  const publicKey = dlc.xOnlyPubkey(signingSecret);
  const presignature = dlc.adaptorSign(
    signingSecret,
    message,
    dlc.pointMul(dlc.G, adaptorSecret),
    sha256('roundtrip:aux')
  );
  const signature = dlc.adaptorComplete(presignature, adaptorSecret);
  return dlc.adaptorVerify(publicKey, message, presignature) &&
    dlc.schnorrVerify(publicKey, message, signature) &&
    dlc.adaptorExtract(presignature, signature, publicKey, message) === adaptorSecret;
});

check('T and -T cannot reuse an adaptor signing nonce', 'nonce-safety', 14, () => {
  const signingSecret = scalar('related:signer');
  const message = sha256('related:message');
  const point = dlc.pointMul(dlc.G, scalar('related:point'));
  const auxiliary = sha256('related:aux');
  const positive = dlc.adaptorSign(signingSecret, message, point, auxiliary);
  const negative = dlc.adaptorSign(signingSecret, message, dlc.pointNegate(point), auxiliary);
  return positive.Tx === negative.Tx && positive.Ty !== negative.Ty &&
    (positive.R0x !== negative.R0x || positive.R0y !== negative.R0y);
});

check('malformed signatures and pre-signatures fail closed', 'parsing', 8, () => {
  const signingSecret = scalar('malformed:signer');
  const message = sha256('malformed:message');
  const point = dlc.pointMul(dlc.G, scalar('malformed:adaptor'));
  const presignature = dlc.adaptorSign(signingSecret, message, point, sha256('malformed:aux'));
  const publicKey = dlc.xOnlyPubkey(signingSecret);
  return dlc.schnorrVerify(publicKey, message, Buffer.alloc(0)) === false &&
    dlc.schnorrVerify(Buffer.alloc(0), message, Buffer.alloc(64)) === false &&
    dlc.adaptorVerify(publicKey, message, { ...presignature, s0: `00${presignature.s0}` }) === false &&
    dlc.adaptorVerify(publicKey, message, { ...presignature, R0x: 'zz'.repeat(32) }) === false;
});

check('extraction rejects a forged completed signature', 'extraction', 8, () => {
  const signingSecret = scalar('extract:signer');
  const message = sha256('extract:message');
  const point = dlc.pointMul(dlc.G, scalar('extract:adaptor'));
  const presignature = dlc.adaptorSign(signingSecret, message, point, sha256('extract:aux'));
  const forged = Buffer.concat([
    Buffer.from(presignature.rx, 'hex'),
    dlc.bytes32((dlc.bufToBig(Buffer.from(presignature.s0, 'hex')) + 1n) % dlc.N)
  ]);
  return throws(
    () => dlc.adaptorExtract(presignature, forged, dlc.xOnlyPubkey(signingSecret), message),
    /invalid completed signature|does not match adaptor point/
  );
});

check('oracle announcement authenticates its full event commitment', 'oracle-auth', 10, () => {
  const yes = sha256('announcement:yes');
  const no = sha256('announcement:no');
  const announcement = dlc.buildDlcOracle(scalar('announcement:key'), scalar('announcement:nonce'), {
    eventId: 'announcement-event',
    outcomeMessages: [yes, no]
  });
  return dlc.verifyDlcOracleAnnouncement(announcement) &&
    !dlc.verifyDlcOracleAnnouncement({ ...announcement, eventId: 'substituted-event' }) &&
    !dlc.verifyDlcOracleAnnouncement({ ...announcement, outcomeMessages: [yes.toString('hex')] }) &&
    !dlc.verifyDlcOracleAnnouncement({ ...announcement, rx: '01'.repeat(32) });
});

check('oracle rejects outcomes absent from its announcement', 'oracle-binding', 8, () => {
  const allowed = sha256('committed:allowed');
  const injected = sha256('committed:injected');
  const announcement = dlc.buildDlcOracle(scalar('committed:key'), scalar('committed:nonce'), {
    eventId: 'committed-event',
    outcomeMessages: [allowed]
  });
  return throws(() => dlc.dlcOutcomePoint(announcement, injected), /not committed/) &&
    throws(() => dlc.dlcAttest(announcement, injected), /not committed/);
});

check('oracle event is one-shot and identical retry is idempotent', 'oracle-state', 10, () => {
  const firstOutcome = sha256('one-shot:first');
  const conflictingOutcome = sha256('one-shot:conflict');
  const announcement = dlc.buildDlcOracle(scalar('one-shot:key'), scalar('one-shot:nonce'), {
    eventId: 'one-shot-event',
    outcomeMessages: [firstOutcome, conflictingOutcome]
  });
  const first = dlc.dlcAttest(announcement, firstOutcome);
  const retry = dlc.dlcAttest(announcement, firstOutcome);
  return first === retry &&
    throws(() => dlc.dlcAttest(announcement, conflictingOutcome), /conflicting outcome/) &&
    announcement._x === undefined && announcement._k === undefined &&
    Object.isFrozen(announcement) && Object.isFrozen(announcement.outcomeMessages) &&
    throws(() => dlc.dlcAttest({ ...announcement }, firstOutcome), /signer state is unavailable/);
});

check('repeated nonce seed cannot reuse a public nonce across events', 'nonce-safety', 10, () => {
  const oracleSecret = scalar('cross-event:key');
  const nonceSeed = scalar('cross-event:nonce');
  const first = dlc.buildDlcOracle(oracleSecret, nonceSeed, {
    eventId: 'cross-event-a',
    outcomeMessages: [sha256('cross-event:a')]
  });
  const second = dlc.buildDlcOracle(oracleSecret, nonceSeed, {
    eventId: 'cross-event-b',
    outcomeMessages: [sha256('cross-event:b')]
  });
  return first.rx !== second.rx;
});

check(`blocks ${profile.adversarialRuns} seeded related-point and oracle attacks`, 'scale', 12, () => {
  for (let index = 0; index < profile.adversarialRuns; index++) {
    const signingSecret = scalar(`scale:${index}:signer`);
    const adaptorSecret = scalar(`scale:${index}:adaptor`);
    const message = sha256(`scale:${index}:message`);
    const auxiliary = sha256(`scale:${index}:aux`);
    const point = dlc.pointMul(dlc.G, adaptorSecret);
    const left = dlc.adaptorSign(signingSecret, message, point, auxiliary);
    const right = dlc.adaptorSign(signingSecret, message, dlc.pointNegate(point), auxiliary);
    if (left.R0x === right.R0x && left.R0y === right.R0y) return `related-point nonce collision at run ${index}`;
    if (!dlc.adaptorVerify(dlc.xOnlyPubkey(signingSecret), message, left)) return `valid pre-signature failed at run ${index}`;

    if (index % 8 === 0) {
      const outcome = sha256(`scale:${index}:outcome`);
      const first = dlc.buildDlcOracle(scalar(`scale:${index}:oracle`), scalar(`scale:${index}:nonce`), {
        eventId: `scale-event-${index}`,
        outcomeMessages: [outcome]
      });
      const second = dlc.buildDlcOracle(scalar(`scale:${index}:oracle`), scalar(`scale:${index}:nonce`), {
        eventId: `scale-event-other-${index}`,
        outcomeMessages: [outcome]
      });
      if (first.rx === second.rx) return `oracle nonce collision at run ${index}`;
      if (!dlc.verifyDlcOracleAnnouncement(first)) return `announcement failed at run ${index}`;
    }
  }
  return true;
});

check('funding broadcast request fails before artifacts or RPC', 'funding-safety', 8, () => {
  const result = spawnSync(process.execPath, [fundingFinalizerPath], {
    cwd: path.dirname(fundingFinalizerPath),
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      BROADCAST_FUNDING: '1',
      LTC_RPC_URL: 'http://127.0.0.1:1',
      LTC_RPC_USER: 'eval',
      LTC_RPC_PASS: 'eval'
    }
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return result.status !== 0 &&
    /funding broadcast disabled: verified CET adaptor signatures and a fully signed refund transaction are required first/.test(output) &&
    !/Artifact missing|ECONNREFUSED|RPC .* failed/.test(output);
});

check('funding finalizer contains no transaction broadcast RPC', 'funding-safety', 4, () => {
  const source = fs.readFileSync(fundingFinalizerPath, 'utf8');
  return !/['\"]sendrawtransaction['\"]/.test(source);
});

check('2-of-3 oracle subsets complete only their combined adaptor points', 'threshold-oracle', 12, () => {
  const outcome = sha256('threshold:yes');
  const other = sha256('threshold:no');
  const announcements = [0, 1, 2].map((index) => dlc.buildDlcOracle(
    scalar(`threshold:${index}:key`),
    scalar(`threshold:${index}:nonce`),
    { eventId: 'threshold-eval-event', outcomeMessages: [outcome, other] }
  ));
  const pinnedPubkeys = announcements.map((announcement) => announcement.px);
  const sets = buildThresholdOutcomeSets({ announcements, threshold: 2, pinnedPubkeys, outcomeMsg32: outcome });
  if (sets.length !== 3) return '2-of-3 did not produce three subsets';
  const selected = sets[0];
  const byKey = new Map(announcements.map((announcement) => [announcement.px, announcement]));
  const attestations = selected.oraclePubkeys.map((key) => dlc.dlcAttest(byKey.get(key), outcome));
  const combined = combineThresholdAttestations({
    announcements,
    threshold: 2,
    pinnedPubkeys,
    outcomeMsg32: outcome,
    attestations,
    oraclePubkeys: selected.oraclePubkeys
  });
  const signerSecret = scalar('threshold:cet-signer');
  const message = sha256('threshold:cet-message');
  const presignature = dlc.adaptorSign(signerSecret, message, selected.outcomePoint, sha256('threshold:cet-aux'));
  const signature = dlc.adaptorComplete(presignature, combined.scalar);
  return dlc.schnorrVerify(dlc.xOnlyPubkey(signerSecret), message, signature) &&
    throws(() => combineThresholdAttestations({
      announcements,
      threshold: 2,
      pinnedPubkeys,
      outcomeMsg32: outcome,
      attestations: [attestations[0]],
      oraclePubkeys: [selected.oraclePubkeys[0]]
    }), /exactly 2/);
});

check('funding PSBT approval requires the complete ordered state transcript', 'state-machine', 12, () => {
  const pinnedPubkeys = ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)];
  let contract = createDlcContract({
    contractId: 'eval-contract',
    network: 'bitcoin-testnet4',
    contractDigest: sha256('eval-contract').toString('hex'),
    oraclePolicy: { threshold: 2, total: 3, pinnedPubkeys },
    validatorPolicy
  });
  const skipKey = 'skip-to-funding';
  if (!throws(() => transitionDlcContract(contract, {
    to: 'FUNDING_PSBT_APPROVED',
    idempotencyKey: skipKey,
    evidence: evidenceFor(contract, 'FUNDING_PSBT_APPROVED', skipKey)
  }), /invalid DLC transition/)) return 'funding stage skip was accepted';
  const psbtBytes = Buffer.from('70736274ff01020304', 'hex');
  const stages = [
    'AUTHENTICATED_ORACLES',
    'CANONICAL_CETS_AND_REFUND',
    'COUNTERPARTY_SIGNATURES_VERIFIED',
    'LOCAL_SIGNATURES_PERSISTED',
    'FUNDING_PSBT_APPROVED'
  ];
  for (const stage of stages) {
    const overrides = stage === 'FUNDING_PSBT_APPROVED'
      ? { funding_psbt_validation: crypto.createHash('sha256').update(psbtBytes).digest('hex') }
      : {};
    const idempotencyKey = `eval:${stage}`;
    contract = transitionDlcContract(contract, {
      to: stage,
      idempotencyKey,
      evidence: evidenceFor(contract, stage, idempotencyKey, overrides)
    });
  }
  const authorization = validateFundingAuthorization(contract, {
    chain: { network: 'testnet4' },
    funding: { psbt: psbtBytes.toString('base64') }
  });
  return contract.stage === 'FUNDING_PSBT_APPROVED' && authorization.stateRecordHash === contract.recordHash;
});

check('append-only state store rejects stale competing writes', 'state-persistence', 8, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-dlc-eval-'));
  try {
    const store = new DlcStateStore(directory);
    const contract = createDlcContract({
      contractId: 'stored-eval-contract',
      network: 'bitcoin-testnet4',
      contractDigest: sha256('stored-eval-contract').toString('hex'),
      oraclePolicy: { threshold: 2, total: 3, pinnedPubkeys: ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)] },
      validatorPolicy
    });
    store.create(contract);
    const oracleKey = 'stored:oracles';
    store.transition(contract.contractId, 0, {
      to: 'AUTHENTICATED_ORACLES',
      idempotencyKey: oracleKey,
      evidence: evidenceFor(contract, 'AUTHENTICATED_ORACLES', oracleKey)
    });
    const advanced = store.read(contract.contractId);
    const cetKey = 'stored:cets';
    const staleRejected = throws(() => store.transition(contract.contractId, 0, {
      to: 'CANONICAL_CETS_AND_REFUND',
      idempotencyKey: cetKey,
      evidence: evidenceFor(advanced, 'CANONICAL_CETS_AND_REFUND', cetKey)
    }), /stale DLC state revision/);
    const chain = store.verifyChain(contract.contractId);
    return staleRejected && chain.ok && chain.revisions === 2;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check('contract state rejects forged and altered validation receipts', 'validator-auth', 10, () => {
  const contract = createDlcContract({
    contractId: 'receipt-auth-contract',
    network: 'bitcoin-testnet4',
    contractDigest: sha256('receipt-auth-contract').toString('hex'),
    oraclePolicy: { threshold: 2, total: 3, pinnedPubkeys: ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)] },
    validatorPolicy
  });
  const idempotencyKey = 'receipt-auth:oracles';
  const validEvidence = evidenceFor(contract, 'AUTHENTICATED_ORACLES', idempotencyKey);
  const altered = JSON.parse(JSON.stringify(validEvidence));
  altered[0].digest = '00'.repeat(32);
  const alteredRejected = throws(() => transitionDlcContract(contract, {
    to: 'AUTHENTICATED_ORACLES',
    idempotencyKey,
    evidence: altered
  }), /signature is invalid/);
  const flagRejected = throws(() => transitionDlcContract(contract, {
    to: 'AUTHENTICATED_ORACLES',
    idempotencyKey,
    evidence: [{
      kind: 'oracle_policy',
      digest: sha256('forged-flag').toString('hex'),
      verified: true
    }]
  }), /pinned|signature/);
  return alteredRejected && flagRejected;
});

check('crypto provider defaults closed and forbids mainnet JavaScript signing', 'signer-boundary', 8, () => {
  const disabled = createDlcCryptoProvider({ network: 'bitcoin-testnet4' });
  const explicit = createDlcCryptoProvider({
    network: 'bitcoin-testnet4',
    mode: 'experimental-js',
    allowExperimental: true
  });
  return disabled.mode === 'disabled' && Object.keys(disabled.operations).length === 0 &&
    explicit.productionReady === false && explicit.capabilities.nativeSecretArithmetic === false &&
    throws(() => createDlcCryptoProvider({
      network: 'bitcoin-mainnet',
      mode: 'experimental-js',
      allowExperimental: true
    }), /mainnet/);
});

check('sealed oracle nonce state survives restart and conflicting outcome fails', 'oracle-persistence', 12, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-dlc-oracle-eval-'));
  const wrappingKey = sha256('oracle-eval-wrapping-key');
  try {
    const first = new DlcOracleEventStore({
      baseDirectory: directory,
      wrappingKey,
      network: 'bitcoin-testnet4'
    });
    const yes = sha256('persistent-eval:yes');
    const no = sha256('persistent-eval:no');
    const announcement = first.createEvent({
      oracleSecret: scalar('persistent-eval:key'),
      nonceSeed: scalar('persistent-eval:nonce'),
      eventId: 'persistent-eval-event',
      outcomeMessages: [yes, no]
    });
    first.close();
    const restarted = new DlcOracleEventStore({
      baseDirectory: directory,
      wrappingKey,
      network: 'bitcoin-testnet4'
    });
    const attestation = restarted.attest({
      oraclePubkey: announcement.px,
      eventId: announcement.eventId,
      outcomeMsg32: yes
    });
    const valid = dlc.verifyDlcAttestation(announcement, yes, attestation);
    const conflictRejected = throws(() => restarted.attest({
      oraclePubkey: announcement.px,
      eventId: announcement.eventId,
      outcomeMsg32: no
    }), /conflicting outcome/);
    const chain = restarted.verifyChain({ oraclePubkey: announcement.px, eventId: announcement.eventId });
    restarted.close();
    return valid && conflictRejected && chain.ok && chain.revisions === 2;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const earned = cases.filter((test) => test.passed).reduce((sum, test) => sum + test.points, 0);
const possible = cases.reduce((sum, test) => sum + test.points, 0);
const score = earned / possible;
const report = {
  benchmark: 'utxoref-dlc-security',
  version: 2,
  profile: profileName,
  seed,
  score,
  points: { earned, possible },
  passed: cases.filter((test) => test.passed).length,
  failed: cases.filter((test) => !test.passed).length,
  cases
};

if (jsonOnly) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
  console.log(`UTXORef DLC security eval (${profileName}, seed ${seed})`);
  for (const test of cases) {
    const mark = test.passed ? 'PASS' : 'FAIL';
    console.log(`${mark.padEnd(4)} ${String(test.points).padStart(2)}  [${test.category}] ${test.name}`);
    if (!test.passed && test.detail) console.log(`         ${test.detail}`);
  }
  console.log(`\nscore: ${score.toFixed(6)}`);
  console.log(`passed: ${report.passed}`);
  console.log(`failed: ${report.failed}`);
  console.log(`points: ${earned}/${possible}`);
}

if (requirePerfect && report.failed !== 0) process.exitCode = 1;
