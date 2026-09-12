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
const {
  createDlcCryptoProvider,
  nativeCapabilityAttestationPayload
} = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_crypto_provider.js'));
const { DlcOracleEventStore } = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_oracle_event_store.js'));
const {
  P2A_SCRIPT_PUBKEY_HEX,
  parseCanonicalUnsignedTransaction,
  validateDlcTransactionSet,
  validateDlcTransactionSetCommitments
} = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_transaction_validator.js'));
const { serializeUnsignedTx, outpoint, bip341SighashDefault } = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'tradelayer_taproot.js'));
const {
  toBip341Transaction,
  cetIdentity,
  validateCetAdaptorSignatures,
  validateRefundSignature
} = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_signature_validator.js'));
const { evaluateDlcChainSnapshot } = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_chain_guard.js'));
const { observeAndEvaluateDlcChain } = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_bitcoin_core_observer.js'));
const {
  TESTNET4_CHAIN_HASH,
  TYPES: PEER_MESSAGE_TYPES,
  computeDlcContractId,
  computeOraclePolicyDigest,
  signDlcPeerMessage,
  validateDlcPeerTranscript
} = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_peer_transcript.js'));
const { DlcPeerSessionStore } = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_peer_session_store.js'));
const { DlcWatchtowerJournal } = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_watchtower_journal.js'));
const { evaluateDlcAnchorRecovery } = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_anchor_recovery_guard.js'));
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
let peerFixtureForEval;
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

check('crypto provider defaults closed and requires a pinned native audit attestation', 'signer-boundary', 12, () => {
  const disabled = createDlcCryptoProvider({ network: 'bitcoin-testnet4' });
  const explicit = createDlcCryptoProvider({
    network: 'bitcoin-testnet4',
    mode: 'experimental-js',
    allowExperimental: true
  });
  const auditKey = crypto.generateKeyPairSync('ed25519');
  const auditDer = auditKey.publicKey.export({ format: 'der', type: 'spki' });
  const auditKeyId = crypto.createHash('sha256').update(auditDer).digest('hex');
  const manifest = {
    apiVersion: 1,
    curve: 'secp256k1',
    adaptorScheme: 'bip340-schnorr',
    nativeSecretArithmetic: true,
    constantTimeSecretOperations: true,
    secretZeroization: true,
    processIsolated: true,
    binaryDigest: sha256('signer-eval:binary').toString('hex'),
    auditDigest: sha256('signer-eval:audit').toString('hex')
  };
  const implementation = {
    capabilities: {
      ...manifest,
      attestation: {
        keyId: auditKeyId,
        signature: crypto.sign(null, nativeCapabilityAttestationPayload(manifest), auditKey.privateKey).toString('base64')
      }
    },
    adaptorSign() {}, adaptorVerify() {}, adaptorComplete() {}, adaptorExtract() {}, schnorrVerify() {}
  };
  const trustedAuditKeys = [{ keyId: auditKeyId, publicKeySpki: auditDer.toString('base64') }];
  const native = createDlcCryptoProvider({
    network: 'bitcoin-testnet4', mode: 'native-isolated', implementation, trustedAuditKeys
  });
  const tamperedRejected = throws(() => createDlcCryptoProvider({
    network: 'bitcoin-testnet4',
    mode: 'native-isolated',
    implementation: {
      ...implementation,
      capabilities: { ...implementation.capabilities, binaryDigest: sha256('signer-eval:tampered').toString('hex') }
    },
    trustedAuditKeys
  }), /attestation is invalid/);
  return disabled.mode === 'disabled' && Object.keys(disabled.operations).length === 0 &&
    explicit.productionReady === false && explicit.capabilities.nativeSecretArithmetic === false &&
    native.capabilities.attestationVerified === true && native.productionReady === false && tamperedRejected &&
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

check('CET and refund set is canonically bound to one funding outpoint', 'transaction-safety', 12, () => {
  const funding = {
    txid: 'aa'.repeat(32),
    vout: 1,
    valueSats: 100000n,
    scriptPubKeyHex: `5120${'44'.repeat(32)}`
  };
  const oraclePubkeys = ['11'.repeat(32), '22'.repeat(32)];
  const feePolicy = {
    strategy: 'cpfp-anchor-v1',
    anchorAmountSats: 330n,
    anchorScriptPubKeyHex: `0014${'aa'.repeat(20)}`,
    maxRecoveryFeeSats: 150000n,
    maxRecoveryFeerateSatPerVb: 500,
    minRelayPeers: 2
  };
  const anchor = { valueSats: feePolicy.anchorAmountSats, scriptPubKeyHex: feePolicy.anchorScriptPubKeyHex };
  const cetOutputs = [
    { valueSats: 59000n, scriptPubKeyHex: `0014${'55'.repeat(20)}` },
    { valueSats: 40000n, scriptPubKeyHex: `0014${'66'.repeat(20)}` },
    anchor
  ];
  const refundOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `5120${'77'.repeat(32)}` }, anchor];
  const raw = (outputs, locktime, txid = funding.txid) => serializeUnsignedTx(
    2,
    [{ outpoint: outpoint(txid, funding.vout), sequence: 0xfffffffe }],
    outputs.map((output) => ({ valueSats: output.valueSats, script: output.scriptPubKeyHex })),
    locktime
  );
  const input = {
    funding,
    cets: [{
      outcomeMessage: sha256('transaction-eval:outcome').toString('hex'),
      oraclePubkeys,
      rawTxHex: raw(cetOutputs, 100),
      expectedOutputs: cetOutputs,
      locktime: 100
    }],
    refund: {
      rawTxHex: raw(refundOutputs, 200),
      expectedOutputs: refundOutputs,
      locktime: 200
    },
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy
  };
  const validated = validateDlcTransactionSet(input);
  const forged = {
    ...input,
    cets: [{ ...input.cets[0], rawTxHex: raw(cetOutputs, 100, 'bb'.repeat(32)) }]
  };
  return validated.cets.length === 1 && validated.refund.feeSats === '670' &&
    throws(() => validateDlcTransactionSet(forged), /committed funding outpoint/);
});

check('TRUC settlements commit version 3, P2A, and the two-transaction cluster limits', 'pinning-safety', 14, () => {
  const funding = {
    txid: 'ac'.repeat(32),
    vout: 0,
    valueSats: 100000n,
    scriptPubKeyHex: `5120${'46'.repeat(32)}`
  };
  const feePolicy = {
    strategy: 'truc-p2a-v1',
    anchorAmountSats: 0n,
    anchorScriptPubKeyHex: P2A_SCRIPT_PUBKEY_HEX,
    maxRecoveryFeeSats: 150000n,
    maxRecoveryFeerateSatPerVb: 500,
    minRelayPeers: 2
  };
  const anchor = { valueSats: 0n, scriptPubKeyHex: P2A_SCRIPT_PUBKEY_HEX };
  const cetOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `0014${'57'.repeat(20)}` }, anchor];
  const refundOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `5120${'68'.repeat(32)}` }, anchor];
  const raw = (version, outputs, locktime) => serializeUnsignedTx(
    version,
    [{ outpoint: outpoint(funding.txid, funding.vout), sequence: 0xfffffffe }],
    outputs.map((output) => ({ valueSats: output.valueSats, script: output.scriptPubKeyHex })),
    locktime
  );
  const input = {
    funding,
    cets: [{
      outcomeMessage: sha256('truc-eval:outcome').toString('hex'),
      oraclePubkeys: ['11'.repeat(32), '22'.repeat(32)],
      rawTxHex: raw(3, cetOutputs, 100),
      expectedOutputs: cetOutputs,
      locktime: 100
    }],
    refund: { rawTxHex: raw(3, refundOutputs, 200), expectedOutputs: refundOutputs, locktime: 200 },
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy
  };
  const validated = validateDlcTransactionSet(input);
  const v2Rejected = throws(() => validateDlcTransactionSet({
    ...input,
    cets: [{ ...input.cets[0], rawTxHex: raw(2, cetOutputs, 100) }]
  }), /version must be 3/);
  const forged = JSON.parse(JSON.stringify(validated));
  forged.feePolicy.maxUnconfirmedClusterTransactions = 3;
  const forgedRejected = throws(() => validateDlcTransactionSetCommitments(forged), /commitment mismatch/);
  return validated.cets[0].version === 3 && validated.refund.version === 3 &&
    validated.feePolicy.anchorScriptPubKeyHex === P2A_SCRIPT_PUBKEY_HEX &&
    validated.feePolicy.maxSettlementVsize === 10000 && validated.feePolicy.maxRecoveryVsize === 1000 &&
    validated.feePolicy.maxUnconfirmedClusterTransactions === 2 && v2Rejected && forgedRejected;
});

check('chain guard halts on disconnected ancestry and uncommitted funding spends', 'chain-safety', 12, () => {
  const funding = {
    txid: 'ab'.repeat(32),
    vout: 2,
    valueSats: 100000n,
    scriptPubKeyHex: `5120${'44'.repeat(32)}`
  };
  const feePolicy = {
    strategy: 'cpfp-anchor-v1',
    anchorAmountSats: 330n,
    anchorScriptPubKeyHex: `0014${'aa'.repeat(20)}`,
    maxRecoveryFeeSats: 150000n,
    maxRecoveryFeerateSatPerVb: 500,
    minRelayPeers: 2
  };
  const anchor = { valueSats: feePolicy.anchorAmountSats, scriptPubKeyHex: feePolicy.anchorScriptPubKeyHex };
  const cetOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `0014${'55'.repeat(20)}` }, anchor];
  const refundOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `5120${'77'.repeat(32)}` }, anchor];
  const raw = (outputs, locktime) => serializeUnsignedTx(
    2,
    [{ outpoint: outpoint(funding.txid, funding.vout), sequence: 0xfffffffe }],
    outputs.map((item) => ({ valueSats: item.valueSats, script: item.scriptPubKeyHex })),
    locktime
  );
  const transactionSet = validateDlcTransactionSet({
    funding,
    cets: [{
      outcomeMessage: sha256('chain-guard:outcome').toString('hex'),
      oraclePubkeys: ['11'.repeat(32), '22'.repeat(32)],
      rawTxHex: raw(cetOutputs, 100),
      expectedOutputs: cetOutputs,
      locktime: 100
    }],
    refund: { rawTxHex: raw(refundOutputs, 200), expectedOutputs: refundOutputs, locktime: 200 },
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy
  });
  let contract = createDlcContract({
    contractId: 'eval-chain-guard',
    network: 'bitcoin-testnet4',
    contractDigest: sha256('eval-chain-guard:contract').toString('hex'),
    oraclePolicy: { threshold: 2, total: 3, pinnedPubkeys: ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)] },
    validatorPolicy
  });
  const stages = [
    'AUTHENTICATED_ORACLES',
    'CANONICAL_CETS_AND_REFUND',
    'COUNTERPARTY_SIGNATURES_VERIFIED',
    'LOCAL_SIGNATURES_PERSISTED',
    'FUNDING_PSBT_APPROVED',
    'FUNDING_BROADCAST',
    'CONFIRMED'
  ];
  for (const stage of stages) {
    const key = `eval-chain:${stage}`;
    const overrides = stage === 'CANONICAL_CETS_AND_REFUND' ? {
      cet_set: transactionSet.cetSetDigest,
      fee_policy: transactionSet.feePolicyDigest,
      funding_template: transactionSet.fundingTemplateDigest,
      refund_transaction: transactionSet.refundTransactionDigest
    } : {};
    contract = transitionDlcContract(contract, {
      to: stage,
      idempotencyKey: key,
      evidence: evidenceFor(contract, stage, key, overrides)
    });
  }
  peerFixtureForEval = { transactionSet, contract };
  const fundingOutpoint = `${transactionSet.funding.txid}:${transactionSet.funding.vout}`;
  const previous = {
    height: 205,
    bestBlockHash: sha256('chain-guard:block:205').toString('hex'),
    fundingOutpoint,
    fundingPresent: true,
    fundingConfirmations: 6,
    observedSpend: null
  };
  const current = {
    ...previous,
    height: 206,
    bestBlockHash: sha256('chain-guard:block:206').toString('hex'),
    ancestorHashAtPreviousHeight: sha256('chain-guard:foreign-ancestor').toString('hex'),
    fundingConfirmations: 7
  };
  const reorg = evaluateDlcChainSnapshot({ contractState: contract, transactionSet, current, previous });
  const unknown = evaluateDlcChainSnapshot({
    contractState: contract,
    transactionSet,
    current: {
      ...previous,
      fundingPresent: false,
      fundingConfirmations: 0,
      observedSpend: { txid: 'ff'.repeat(32), height: 205 }
    }
  });
  const earlyRefund = evaluateDlcChainSnapshot({
    contractState: contract,
    transactionSet,
    current: {
      ...previous,
      height: 199,
      bestBlockHash: sha256('chain-guard:block:199').toString('hex'),
      fundingPresent: false,
      fundingConfirmations: 0,
      observedSpend: { txid: transactionSet.refund.txid, height: 199 }
    }
  });
  const coreBestHash = sha256('chain-guard:core-tip').toString('hex');
  const coreObserved = observeAndEvaluateDlcChain({
    contractState: contract,
    transactionSet,
    rpc(method) {
      if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 205, bestblockhash: coreBestHash };
      if (method === 'getrawmempool') return { mempool_sequence: 11 };
      if (method === 'gettxout') return { bestblock: coreBestHash, confirmations: 6 };
      throw new Error(`unexpected mocked Core RPC ${method}`);
    }
  });
  return reorg.status === 'REORG_HALT' && reorg.halt &&
    unknown.status === 'UNKNOWN_SPEND_HALT' && unknown.halt &&
    earlyRefund.status === 'PREMATURE_REFUND_HALT' && earlyRefund.halt &&
    coreObserved.evaluation.status === 'FUNDING_CONFIRMED';
});

check('independent watchtower journal survives restart and preserves signed halt alerts', 'watchtower', 12, () => {
  if (!peerFixtureForEval) return false;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-eval-watchtower-'));
  try {
    const { transactionSet, contract } = peerFixtureForEval;
    const keys = crypto.generateKeyPairSync('ed25519');
    const fundingOutpoint = `${transactionSet.funding.txid}:${transactionSet.funding.vout}`;
    const journal = new DlcWatchtowerJournal(directory, {
      watchtowerId: 'eval-independent-watchtower',
      publicKey: keys.publicKey,
      privateKey: keys.privateKey
    });
    const stable = {
      height: 205,
      bestBlockHash: sha256('watchtower-eval:block:205').toString('hex'),
      fundingOutpoint,
      fundingPresent: true,
      fundingConfirmations: 6,
      observedSpend: null
    };
    const first = journal.appendObservation({ contractState: contract, transactionSet, snapshot: stable });
    const retry = journal.appendObservation({ contractState: contract, transactionSet, snapshot: stable });
    const halt = journal.appendObservation({
      contractState: contract,
      transactionSet,
      snapshot: {
        ...stable,
        height: 206,
        bestBlockHash: sha256('watchtower-eval:block:206').toString('hex'),
        ancestorHashAtPreviousHeight: sha256('watchtower-eval:foreign').toString('hex'),
        fundingConfirmations: 7
      }
    });
    const verifier = new DlcWatchtowerJournal(directory, {
      watchtowerId: 'eval-independent-watchtower',
      publicKey: keys.publicKey
    });
    const chain = verifier.verifyChain(contract.contractId);
    return first.recordHash === retry.recordHash && halt.evaluation.status === 'REORG_HALT' &&
      halt.alert.code === 'REORG_HALT' && chain.observations === 2 &&
      verifier.alerts(contract.contractId).length === 1 &&
      throws(() => verifier.appendObservation({ contractState: contract, transactionSet, snapshot: stable }), /verification-only/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check('watchtower signs direct Core anchor and independent peer relay evidence', 'anchor-observer', 14, () => {
  if (!peerFixtureForEval) return false;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-eval-anchor-observer-'));
  try {
    const { transactionSet, contract } = peerFixtureForEval;
    const settlementTxid = transactionSet.cets[0].txid;
    const anchorVout = transactionSet.cets[0].outputs.length - 1;
    const pinTxid = sha256('anchor-observer-eval:pin').toString('hex');
    const bestBlockHash = sha256('anchor-observer-eval:tip').toString('hex');
    const walletTxid = sha256('anchor-observer-eval:wallet-input').toString('hex');
    const proposedRecoveryRawTxHex = serializeUnsignedTx(
      2,
      [
        { outpoint: outpoint(settlementTxid, anchorVout), sequence: 0xfffffffd },
        { outpoint: outpoint(walletTxid, 0), sequence: 0xfffffffd }
      ],
      [{ valueSats: 191232n, script: `0014${'98'.repeat(20)}` }],
      0
    );
    const primaryRpc = (method, params) => {
      if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 205, bestblockhash: bestBlockHash };
      if (method === 'getrawmempool') return { mempool_sequence: 21 };
      if (method === 'getmempoolinfo') return { fullrbf: true, incrementalrelayfee: 0.00001 };
      if (method === 'gettxout' && params[0] === walletTxid) {
        return { bestblock: bestBlockHash, confirmations: 6, value: 0.002 };
      }
      if (method === 'gettxout') return null;
      if (method === 'gettxspendingprevout') return [{ spendingtxid: pinTxid }];
      if (method === 'getmempoolentry') {
        return { vsize: 467, fees: { base: 0.00093338 }, 'bip125-replaceable': false };
      }
      if (method === 'decoderawtransaction') {
        const parsed = parseCanonicalUnsignedTransaction(params[0]);
        return {
          txid: parsed.txid,
          hash: parsed.txid,
          version: parsed.version,
          vsize: 300,
          vin: parsed.inputs,
          vout: parsed.outputs.map((output) => ({ value: Number(output.valueSats) / 100000000 }))
        };
      }
      if (method === 'testmempoolaccept') {
        const parsed = parseCanonicalUnsignedTransaction(params[0][0]);
        return [{ txid: parsed.txid, wtxid: parsed.txid, allowed: true }];
      }
      throw new Error(`unexpected anchor observer RPC ${method}`);
    };
    const peerRpc = (method, params) => {
      if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 205, bestblockhash: bestBlockHash };
      if (method === 'getrawmempool' && params[1] === true) return { mempool_sequence: 8 };
      if (method === 'getrawmempool') return [pinTxid];
      throw new Error(`unexpected anchor peer RPC ${method}`);
    };
    const keys = crypto.generateKeyPairSync('ed25519');
    const journal = new DlcWatchtowerJournal(directory, {
      watchtowerId: 'eval-anchor-observer',
      publicKey: keys.publicKey,
      privateKey: keys.privateKey
    });
    const record = journal.appendBitcoinCoreAnchorObservation({
      contractState: contract,
      transactionSet,
      settlementTxid,
      rpc: primaryRpc,
      peerNodes: [{ nodeId: 'peer-1', rpc: peerRpc }],
      proposedRecoveryRawTxHex
    });
    const verifier = new DlcWatchtowerJournal(directory, {
      watchtowerId: 'eval-anchor-observer',
      publicKey: keys.publicKey
    });
    const verified = verifier.verifyChain(contract.contractId);
    return record.observationType === 'anchor-recovery' && record.snapshot.observer === 'bitcoin-core-rpc-v1' &&
      record.snapshot.observedSpend.txid === pinTxid && record.snapshot.observedSpend.relayPeers === 2 &&
      record.snapshot.proposedRecovery.feeSats === '9098' &&
      record.snapshot.proposedRecovery.version === 2 &&
      record.snapshot.proposedRecovery.corePolicy.method === 'testmempoolaccept' &&
      record.snapshot.proposedRecovery.corePolicy.allowed === true &&
      record.snapshot.incrementalRelayFeeSatPerVb === 1 && record.evaluation.status === 'FEE_PIN_HALT' &&
      record.alert.code === 'FEE_PIN_HALT' && verified.observations === 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check('signed anchor policy requires Core acceptance, economic fee safety, and relay quorum', 'anchor-recovery', 14, () => {
  if (!peerFixtureForEval) return false;
  const { transactionSet, contract } = peerFixtureForEval;
  const settlementTxid = transactionSet.cets[0].txid;
  const anchorOutpoint = `${settlementTxid}:${transactionSet.cets[0].outputs.length - 1}`;
  const pin = {
    txid: sha256('anchor-eval:pin').toString('hex'),
    feeSats: '93338',
    vsize: 467,
    relayPeers: 2,
    signalsRbf: false,
    confirmed: false
  };
  const cheap = {
    txid: sha256('anchor-eval:cheap').toString('hex'),
    version: 2,
    feeSats: '9098',
    vsize: 467,
    relayPeers: 0,
    signalsRbf: true,
    confirmed: false,
    corePolicy: { method: 'testmempoolaccept', allowed: true, rejectReason: null }
  };
  const rescue = {
    txid: sha256('anchor-eval:rescue').toString('hex'),
    version: 2,
    feeSats: '140138',
    vsize: 467,
    relayPeers: 0,
    signalsRbf: true,
    confirmed: false,
    corePolicy: { method: 'testmempoolaccept', allowed: true, rejectReason: null }
  };
  const pinned = evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    snapshot: { anchorOutpoint, anchorPresent: false, fullRbf: true, observedSpend: pin, proposedRecovery: cheap }
  });
  const rescued = evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    snapshot: { anchorOutpoint, anchorPresent: false, fullRbf: true, observedSpend: pin, proposedRecovery: rescue }
  });
  const noFullRbf = evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    snapshot: { anchorOutpoint, anchorPresent: false, fullRbf: false, observedSpend: pin, proposedRecovery: rescue }
  });
  const underReplicated = evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    expectedRecoveryTxids: [rescue.txid],
    snapshot: {
      anchorOutpoint,
      anchorPresent: false,
      fullRbf: true,
      observedSpend: { ...rescue, relayPeers: 1 },
      proposedRecovery: null
    }
  });
  const coreRejected = evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    snapshot: {
      anchorOutpoint,
      anchorPresent: true,
      fullRbf: true,
      observedSpend: null,
      proposedRecovery: {
        ...rescue,
        corePolicy: { method: 'testmempoolaccept', allowed: false, rejectReason: 'insufficient fee' }
      }
    }
  });
  const missingPolicyRejected = throws(() => evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    snapshot: {
      anchorOutpoint,
      anchorPresent: true,
      fullRbf: true,
      observedSpend: null,
      proposedRecovery: { ...rescue, corePolicy: undefined }
    }
  }), /lacks canonical Bitcoin Core policy evidence/);
  return pinned.status === 'FEE_PIN_HALT' && pinned.halt &&
    rescued.status === 'FEE_PIN_RESCUE_READY' && rescued.ok &&
    noFullRbf.status === 'FEE_PIN_HALT' && noFullRbf.halt &&
    underReplicated.status === 'RECOVERY_PROPAGATION_HALT' && underReplicated.halt &&
    coreRejected.status === 'RECOVERY_POLICY_HALT' && coreRejected.coreRejectReason === 'insufficient fee' &&
    missingPolicyRejected;
});

check('authenticated offer/accept/sign transcript enforces IDs and global serial uniqueness', 'peer-protocol', 12, () => {
  if (!peerFixtureForEval) return false;
  const { transactionSet, contract } = peerFixtureForEval;
  const offerer = crypto.generateKeyPairSync('ed25519');
  const accepter = crypto.generateKeyPairSync('ed25519');
  const temporaryContractId = sha256('peer-eval:temporary').toString('hex');
  const expectedSignatures = {
    accepterCet: sha256('peer-eval:accepter-cets').toString('hex'),
    accepterRefund: sha256('peer-eval:accepter-refund').toString('hex'),
    offererCet: sha256('peer-eval:offerer-cets').toString('hex'),
    offererRefund: sha256('peer-eval:offerer-refund').toString('hex'),
    fundingWitnesses: sha256('peer-eval:funding-witnesses').toString('hex')
  };
  const terms = {
    contractDigest: contract.contractDigest,
    oraclePolicyDigest: computeOraclePolicyDigest(contract.oraclePolicy)
  };
  const offer = signDlcPeerMessage({
    messageType: PEER_MESSAGE_TYPES.OFFER,
    peerId: 'eval-offerer',
    body: {
      protocolVersion: 1,
      chainHash: TESTNET4_CHAIN_HASH,
      temporaryContractId,
      fundingOutputSerialId: '30',
      payoutSerialId: '5',
      changeSerialId: '20',
      fundingInputSerialIds: ['2', '10'],
      ...terms,
      transactionValidationDigest: transactionSet.validationDigest
    },
    privateKey: offerer.privateKey
  });
  const makeAccept = (fundingInputSerialIds) => signDlcPeerMessage({
    messageType: PEER_MESSAGE_TYPES.ACCEPT,
    peerId: 'eval-accepter',
    previousMessageDigest: offer.messageDigest,
    body: {
      protocolVersion: 1,
      temporaryContractId,
      payoutSerialId: '6',
      changeSerialId: '21',
      fundingInputSerialIds,
      ...terms,
      transactionValidationDigest: transactionSet.validationDigest,
      cetSignaturesDigest: expectedSignatures.accepterCet,
      refundSignatureDigest: expectedSignatures.accepterRefund
    },
    privateKey: accepter.privateKey
  });
  const makeSign = (accept) => signDlcPeerMessage({
    messageType: PEER_MESSAGE_TYPES.SIGN,
    peerId: 'eval-offerer',
    previousMessageDigest: accept.messageDigest,
    body: {
      protocolVersion: 1,
      contractId: computeDlcContractId(transactionSet.funding.txid, transactionSet.funding.vout, temporaryContractId),
      fundingWitnessInputSerialIds: ['2', '10'],
      fundingWitnessesDigest: expectedSignatures.fundingWitnesses,
      ...terms,
      transactionValidationDigest: transactionSet.validationDigest,
      cetSignaturesDigest: expectedSignatures.offererCet,
      refundSignatureDigest: expectedSignatures.offererRefund
    },
    privateKey: offerer.privateKey
  });
  const validate = (accept, sign, overrides = {}) => validateDlcPeerTranscript({
    offer,
    accept,
    sign,
    offererPublicKey: offerer.publicKey,
    accepterPublicKey: accepter.publicKey,
    transactionSet,
    contractState: contract,
    fundingTxid: transactionSet.funding.txid,
    fundingOutputIndex: transactionSet.funding.vout,
    expectedSignatures,
    verifyFundingWitnesses: () => true,
    ...overrides
  });
  const accept = makeAccept(['3', '11']);
  const sign = makeSign(accept);
  const valid = validate(accept, sign);
  const duplicateAccept = makeAccept(['2', '11']);
  const duplicateRejected = throws(() => validate(duplicateAccept, makeSign(duplicateAccept)), /globally unique/);
  const replayRejected = throws(() => validate(accept, sign, {
    knownTemporaryContractIds: [temporaryContractId]
  }), /already used/);
  const wrongFundingRejected = throws(() => validate(accept, sign, {
    fundingTxid: 'ff'.repeat(32)
  }), /funding outpoint/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-peer-eval-'));
  let durableReplay;
  try {
    const store = new DlcPeerSessionStore(directory);
    store.claimOffer({ offer, offererPublicKey: offerer.publicKey });
    store.commitTranscript(valid);
    durableReplay = new DlcPeerSessionStore(directory)
      .knownTemporaryContractIds('eval-offerer')
      .includes(temporaryContractId);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  return valid.ok && duplicateRejected && replayRejected && wrongFundingRejected && durableReplay;
});

check('CET adaptor and refund signatures bind to validated BIP341 sighashes', 'signature-safety', 14, () => {
  const outcomeMessage = sha256('signature-eval:outcome');
  const announcements = [0, 1, 2].map((index) => dlc.buildDlcOracle(
    scalar(`signature-eval:${index}:key`),
    scalar(`signature-eval:${index}:nonce`),
    { eventId: 'signature-eval-event', outcomeMessages: [outcomeMessage] }
  ));
  const pinnedPubkeys = announcements.map((announcement) => announcement.px);
  const selected = buildThresholdOutcomeSets({
    announcements,
    threshold: 2,
    pinnedPubkeys,
    outcomeMsg32: outcomeMessage
  })[0];
  const signerSecret = scalar('signature-eval:signer');
  const signerPubkeyX = dlc.xOnlyPubkey(signerSecret).toString('hex');
  const funding = {
    txid: '99'.repeat(32),
    vout: 0,
    valueSats: 100000n,
    scriptPubKeyHex: `5120${signerPubkeyX}`
  };
  const feePolicy = {
    strategy: 'cpfp-anchor-v1',
    anchorAmountSats: 330n,
    anchorScriptPubKeyHex: `0014${'aa'.repeat(20)}`,
    maxRecoveryFeeSats: 150000n,
    maxRecoveryFeerateSatPerVb: 500,
    minRelayPeers: 2
  };
  const anchor = { valueSats: feePolicy.anchorAmountSats, scriptPubKeyHex: feePolicy.anchorScriptPubKeyHex };
  const cetOutputs = [
    { valueSats: 99000n, scriptPubKeyHex: `0014${'88'.repeat(20)}` },
    anchor
  ];
  const refundOutputs = [
    { valueSats: 99000n, scriptPubKeyHex: `5120${'77'.repeat(32)}` },
    anchor
  ];
  const raw = (outputs, locktime) => serializeUnsignedTx(
    2,
    [{ outpoint: outpoint(funding.txid, funding.vout), sequence: 0xfffffffe }],
    outputs.map((item) => ({ valueSats: item.valueSats, script: item.scriptPubKeyHex })),
    locktime
  );
  const transactionSet = validateDlcTransactionSet({
    funding,
    cets: [{
      outcomeMessage: outcomeMessage.toString('hex'),
      oraclePubkeys: selected.oraclePubkeys,
      rawTxHex: raw(cetOutputs, 100),
      expectedOutputs: cetOutputs,
      locktime: 100
    }],
    refund: { rawTxHex: raw(refundOutputs, 200), expectedOutputs: refundOutputs, locktime: 200 },
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy
  });
  const cet = transactionSet.cets[0];
  const cetSighash = bip341SighashDefault(
    toBip341Transaction(parseCanonicalUnsignedTransaction(cet.rawTxHex)),
    [{ amountSats: funding.valueSats, scriptPubKey: funding.scriptPubKeyHex }],
    0
  );
  const presignature = dlc.adaptorSign(signerSecret, cetSighash, selected.outcomePoint, sha256('signature-eval:cet-aux'));
  const cetResult = validateCetAdaptorSignatures({
    transactionSet,
    funding,
    signerPubkeyX,
    signatures: [{ identity: cetIdentity(cet), signerPubkeyX, presignature }],
    thresholdOutcomeSets: [{
      outcomeMessage: outcomeMessage.toString('hex'),
      oraclePubkeys: selected.oraclePubkeys,
      outcomePoint: selected.outcomePoint
    }]
  });
  const refundSighash = bip341SighashDefault(
    toBip341Transaction(parseCanonicalUnsignedTransaction(transactionSet.refund.rawTxHex)),
    [{ amountSats: funding.valueSats, scriptPubKey: funding.scriptPubKeyHex }],
    0
  );
  const refundSignature = dlc.schnorrSign(signerSecret, refundSighash, sha256('signature-eval:refund-aux'));
  const refundResult = validateRefundSignature({
    transactionSet,
    funding,
    signerPubkeyX,
    signature: refundSignature
  });
  const forged = {
    ...presignature,
    s0: `${presignature.s0.slice(0, -1)}${presignature.s0.endsWith('0') ? '1' : '0'}`
  };
  const forgedRejected = throws(() => validateCetAdaptorSignatures({
    transactionSet,
    funding,
    signerPubkeyX,
    signatures: [{ identity: cetIdentity(cet), signerPubkeyX, presignature: forged }],
    thresholdOutcomeSets: [{
      outcomeMessage: outcomeMessage.toString('hex'),
      oraclePubkeys: selected.oraclePubkeys,
      outcomePoint: selected.outcomePoint
    }]
  }), /invalid/);
  return /^[0-9a-f]{64}$/.test(cetResult.digest) && /^[0-9a-f]{64}$/.test(refundResult.digest) && forgedRejected;
});

const earned = cases.filter((test) => test.passed).reduce((sum, test) => sum + test.points, 0);
const possible = cases.reduce((sum, test) => sum + test.points, 0);
const score = earned / possible;
const report = {
  benchmark: 'utxoref-dlc-security',
  version: 11,
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
