'use strict';

const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dlc = require('./tradelayer_dlc_adaptor_sig');
const {
  ALL_EVIDENCE_KINDS,
  REQUIRED_EVIDENCE,
  canonicalJson,
  createDlcContract,
  normalizeDlcContract,
  signValidationReceipt,
  validateDlcContract,
  transitionDlcContract
} = require('./dlc_contract_state');
const { DlcStateStore, contractKey: stateContractKey } = require('./dlc_state_store');
const {
  validateOracleSet,
  buildThresholdOutcomeSets,
  combineThresholdAttestations
} = require('./dlc_threshold_oracle');
const { validateFundingAuthorization } = require('./m1_dlc_sign_finalize');
const {
  authorizeDlcAdaptorSign,
  createDlcAdaptorSignAuthorization,
  createDlcCryptoProvider,
  nativeCapabilityAttestationPayload,
  requireDlcSigningProvider
} = require('./dlc_crypto_provider');
const { DlcOracleEventStore } = require('./dlc_oracle_event_store');
const {
  DlcSigningAuthorizationStore,
  validateConsumptionRecord
} = require('./dlc_signing_authorization_store');
const {
  DlcRefundRecoveryStore,
  refundKey: refundRecoveryKey,
  recordHash: refundRecoveryRecordHash
} = require('./dlc_refund_recovery_store');
const {
  REQUEST_KIND: NATIVE_PROCESS_REQUEST_KIND,
  RESPONSE_KIND: NATIVE_PROCESS_RESPONSE_KIND,
  nativeSignerExecutableDigest,
  nativeSignerRuntimeDigest,
  responseSignaturePayload,
  DlcNativeSignerProcessClient
} = require('./dlc_native_signer_process_client');
const { serializeUnsignedTx, outpoint, bip341SighashDefault } = require('./tradelayer_taproot');
const {
  P2A_SCRIPT_PUBKEY_HEX,
  parseCanonicalSignedTaprootTransaction,
  parseCanonicalUnsignedTransaction,
  validateDlcTransactionSet,
  validateDlcTransactionSetCommitments,
  dlcFundingOutputForTransactionSet
} = require('./dlc_transaction_validator');
const {
  toBip341Transaction,
  cetIdentity,
  validateCetAdaptorSignatures,
  validateRefundSignature,
  settlementSighashForTransactionSet,
  assembleSignedSettlement,
  verifySettlementWitness
} = require('./dlc_signature_validator');
const {
  buildDlcFundingOutput,
  dlcFundingFields,
  deriveDlcFundingInternalXonly
} = require('./dlc_funding_output');
const taprootScript = require('./tradelayer_taproot_script');
const { evaluateDlcChainSnapshot } = require('./dlc_chain_guard');
const { captureDlcAnchorRecoverySnapshot, observeAndEvaluateDlcChain } = require('./dlc_bitcoin_core_observer');
const {
  TESTNET4_CHAIN_HASH,
  TYPES: PEER_MESSAGE_TYPES,
  computeDlcContractId,
  computeOraclePolicyDigest,
  signDlcPeerMessage,
  validateDlcPeerTranscript
} = require('./dlc_peer_transcript');
const { DlcPeerSessionStore } = require('./dlc_peer_session_store');
const { DlcWatchtowerJournal, contractKey: watchtowerContractKey } = require('./dlc_watchtower_journal');
const {
  createDlcJournalCheckpoint,
  normalizeDlcJournalCheckpoint,
  signDlcJournalCheckpoint,
  signedDlcJournalCheckpointHash,
  verifySignedDlcJournalCheckpoint
} = require('./dlc_journal_checkpoint');
const { settlementAnchor, evaluateDlcAnchorRecovery } = require('./dlc_anchor_recovery_guard');
const { validateFundingPrebroadcastPolicy } = require('./dlc_funding_prebroadcast_guard');
const { validateExecutionPrebroadcastPolicy } = require('./dlc_execution_prebroadcast_guard');
const { DlcBroadcastAuthorizationStore } = require('./dlc_broadcast_authorization_store');
const { readBoundedJson, writeJsonAppendOnce } = require('./dlc_durable_json_store');

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
const PARTY_SECRETS = Object.freeze([123456789n, 987654321n]);
const REFUND_CSV_BLOCKS = 144;
const validatorKeys = crypto.generateKeyPairSync('ed25519');
const validatorPublicKeySpki = validatorKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const validatorKeyId = crypto.createHash('sha256').update(Buffer.from(validatorPublicKeySpki, 'base64')).digest('hex');
const validatorPolicy = Object.fromEntries(ALL_EVIDENCE_KINDS.map((kind) => [kind, {
  keyId: validatorKeyId,
  publicKeySpki: validatorPublicKeySpki
}]));
const checkpointSignerKeys = crypto.generateKeyPairSync('ed25519');
const checkpointSignerPublicKeySpki = checkpointSignerKeys.publicKey
  .export({ format: 'der', type: 'spki' }).toString('base64');
const checkpointSignerKeyId = crypto.createHash('sha256')
  .update(Buffer.from(checkpointSignerPublicKeySpki, 'base64')).digest('hex');
const trustedCheckpointKeys = Object.freeze([Object.freeze({
  keyId: checkpointSignerKeyId,
  publicKeySpki: checkpointSignerPublicKeySpki
})]);

function requestFor(contract, to, suffix = to, overrides = {}) {
  const idempotencyKey = `transition:${suffix}`;
  const historicalEvidence = contract.history.flatMap((entry) => entry.evidence);
  const historicalDigest = (kind) => historicalEvidence.find((receipt) => receipt.kind === kind)?.digest;
  const digestFor = (kind) => {
    const override = overrides[kind];
    return typeof override === 'object' ? override.digest : (override || digest(`${to}:${kind}`));
  };
  return {
    to,
    idempotencyKey,
    evidence: REQUIRED_EVIDENCE[to].map((kind) => {
      const override = overrides[kind];
      let metadata = typeof override === 'object' ? override.metadata : undefined;
      if (metadata === undefined && kind === 'prebroadcast_bitcoin_core_policy') {
        const issuedAtUnixSeconds = Math.floor(Date.now() / 1000);
        metadata = {
          rawTransactionSha256: digestFor('broadcast_transaction'),
          txid: digest(`${suffix}:prebroadcast:txid`),
          wtxid: digest(`${suffix}:prebroadcast:wtxid`),
          contractRevision: contract.revision,
          contractTranscriptHash: contract.transcriptHash,
          fundingPsbtDigest: historicalDigest('funding_psbt_validation'),
          issuedAtUnixSeconds,
          expiresAtUnixSeconds: issuedAtUnixSeconds + 30,
          chainTip: digest(`${suffix}:prebroadcast:chain-tip`),
          chainHeight: 250,
          mempoolSequence: 1,
          corePolicyAllowed: true,
          signingAllowed: false,
          sendRawTransactionAllowed: false
        };
      }
      if (metadata === undefined && (kind === 'cet_prebroadcast_bitcoin_core_policy' ||
          kind === 'refund_prebroadcast_bitcoin_core_policy')) {
        const cet = kind.startsWith('cet_');
        const issuedAtUnixSeconds = Math.floor(Date.now() / 1000);
        metadata = {
          executionType: cet ? 'cet' : 'refund',
          rawTransactionSha256: digestFor(cet ? 'cet_broadcast_transaction' : 'refund_broadcast_transaction'),
          txid: digest(`${suffix}:${cet ? 'cet' : 'refund'}:txid`),
          wtxid: digest(`${suffix}:${cet ? 'cet' : 'refund'}:wtxid`),
          contractRevision: contract.revision,
          contractTranscriptHash: contract.transcriptHash,
          settlementCommitmentDigest: historicalDigest(cet ? 'cet_set' : 'refund_transaction'),
          executionEvidenceDigest: digestFor(cet ? 'oracle_threshold_attestation' : 'refund_maturity'),
          issuedAtUnixSeconds,
          expiresAtUnixSeconds: issuedAtUnixSeconds + 30,
          chainTip: digest(`${suffix}:${cet ? 'cet' : 'refund'}:chain-tip`),
          chainHeight: 250,
          mempoolSequence: 1,
          corePolicyAllowed: true,
          signingAllowed: false,
          sendRawTransactionAllowed: false
        };
      }
      return signValidationReceipt({
        privateKey: validatorKeys.privateKey,
        contractId: contract.contractId,
        contractDigest: contract.contractDigest,
        from: contract.stage,
        to,
        idempotencyKey,
        kind,
        digest: digestFor(kind),
        ...(metadata === undefined ? {} : { metadata })
      });
    })
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

test('canonical signed data rejects effectful and ambiguous JavaScript values', () => {
  const ownProto = JSON.parse('{"__proto__":{"polluted":true},"b":2,"a":1}');
  assert(canonicalJson(ownProto) === '{"__proto__":{"polluted":true},"a":1,"b":2}',
    'own __proto__ data was omitted or reordered ambiguously');
  assert(Object.prototype.polluted === undefined, 'canonicalization polluted Object.prototype');

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() { getterCalls++; return 1; }
  });
  expectThrow(() => canonicalJson(accessor), /enumerable data property/);
  assert(getterCalls === 0, 'canonicalization executed an accessor');

  const symbolBearing = { value: 1 };
  symbolBearing[Symbol('hidden')] = 2;
  expectThrow(() => canonicalJson(symbolBearing), /symbol properties/);
  expectThrow(() => canonicalJson(new Date(0)), /plain objects and arrays/);
  expectThrow(() => canonicalJson(-0), /unambiguous safe integers/);
  expectThrow(() => canonicalJson(1n), /unsupported data/);

  const sparse = new Array(2);
  sparse[1] = 1;
  expectThrow(() => canonicalJson(sparse), /dense array/);
  const decorated = [1];
  decorated.extra = true;
  expectThrow(() => canonicalJson(decorated), /dense array/);

  const cyclic = {};
  cyclic.self = cyclic;
  expectThrow(() => canonicalJson(cyclic), /cycle/);
  let tooDeep = true;
  for (let index = 0; index < 65; index++) tooDeep = { next: tooDeep };
  expectThrow(() => canonicalJson(tooDeep), /depth 64/);

  const receipt = signValidationReceipt({
    privateKey: validatorKeys.privateKey,
    contractId: 'canonical-data-contract',
    contractDigest: digest('canonical-data-contract'),
    from: 'DRAFT',
    to: 'AUTHENTICATED_ORACLES',
    idempotencyKey: 'canonical-data-transition',
    kind: 'oracle_policy',
    digest: digest('canonical-data-policy'),
    metadata: { nested: { accepted: true } }
  });
  assert(Object.isFrozen(receipt.metadata) && Object.isFrozen(receipt.metadata.nested),
    'signed metadata was not deeply frozen');
});

test('canonical signed data ignores inherited JSON hooks and rejects proxies without traps', () => {
  const objectHook = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const arrayHook = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let hookCalls = 0;
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value() { hookCalls++; return { forged: true }; }
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value() { hookCalls++; return ['forged']; }
    });
    assert(canonicalJson({ a: [1, { b: 2 }] }) === '{"a":[1,{"b":2}]}',
      'prototype toJSON hook changed canonical output');
    assert(hookCalls === 0, 'canonical encoding executed an inherited toJSON hook');
  } finally {
    if (objectHook) Object.defineProperty(Object.prototype, 'toJSON', objectHook);
    else delete Object.prototype.toJSON;
    if (arrayHook) Object.defineProperty(Array.prototype, 'toJSON', arrayHook);
    else delete Array.prototype.toJSON;
  }

  let proxyTraps = 0;
  const handler = {
    getPrototypeOf(target) { proxyTraps++; return Reflect.getPrototypeOf(target); },
    ownKeys(target) { proxyTraps++; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      proxyTraps++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    }
  };
  expectThrow(() => canonicalJson(new Proxy({ value: 1 }, handler)), /Proxy object/);
  const checkpoint = createDlcJournalCheckpoint({
    storeKind: 'contract-state',
    storeKey: digest('proxy-checkpoint-store'),
    recordCount: 1,
    headRecordHash: digest('proxy-checkpoint-head')
  });
  expectThrow(() => normalizeDlcJournalCheckpoint(new Proxy(checkpoint, handler)), /invalid DLC journal checkpoint/);
  assert(proxyTraps === 0, 'Proxy trap executed before rejection');
});

test('adaptor primitives snapshot points and pre-signatures without callbacks', () => {
  const signerSecret = 707n;
  const message = hash('adaptor-input-message');
  const adaptorSecret = 808n;
  const adaptorPoint = dlc.pointMul(dlc.G, adaptorSecret);
  let pointAccessorCalls = 0;
  const hostilePoint = { y: adaptorPoint.y };
  Object.defineProperty(hostilePoint, 'x', {
    enumerable: true,
    get() { pointAccessorCalls++; return adaptorPoint.x; }
  });
  expectThrow(() => dlc.adaptorSign(
    signerSecret, message, hostilePoint, hash('adaptor-input-aux')
  ), /enumerable data property/);
  assert(pointAccessorCalls === 0, 'adaptor point accessor executed before rejection');

  const presignature = dlc.adaptorSign(
    signerSecret, message, adaptorPoint, hash('adaptor-input-valid-aux')
  );
  assert(Object.isFrozen(presignature), 'adaptor pre-signature output was mutable');
  let presignatureAccessorCalls = 0;
  const hostilePresignature = { ...presignature };
  Object.defineProperty(hostilePresignature, 'R0x', {
    enumerable: true,
    get() { presignatureAccessorCalls++; return presignature.R0x; }
  });
  assert(dlc.adaptorVerify(dlc.xOnlyPubkey(signerSecret), message, hostilePresignature) === false,
    'adaptor verification accepted a getter-bearing pre-signature');
  expectThrow(() => dlc.adaptorComplete(hostilePresignature, adaptorSecret), /enumerable data property/);
  assert(presignatureAccessorCalls === 0, 'adaptor pre-signature accessor executed before rejection');
});

test('oracle envelopes and outcome arrays are snapshotted without callbacks', () => {
  const yes = hash('oracle-input-yes');
  const no = hash('oracle-input-no');
  let buildAccessorCalls = 0;
  const hostileBuildOptions = { outcomeMessages: [yes, no] };
  Object.defineProperty(hostileBuildOptions, 'eventId', {
    enumerable: true,
    get() { buildAccessorCalls++; return 'oracle-input-event'; }
  });
  expectThrow(() => dlc.buildDlcOracle(811n, 812n, hostileBuildOptions), /enumerable data property/);
  assert(buildAccessorCalls === 0, 'oracle build option accessor executed before rejection');

  let outcomeAccessorCalls = 0;
  const hostileOutcomes = [];
  Object.defineProperty(hostileOutcomes, '0', {
    enumerable: true,
    configurable: true,
    get() { outcomeAccessorCalls++; return yes; }
  });
  hostileOutcomes.length = 1;
  expectThrow(() => dlc.buildDlcOracle(813n, 814n, {
    eventId: 'oracle-input-hostile-outcomes', outcomeMessages: hostileOutcomes
  }), /enumerable data property/);
  assert(outcomeAccessorCalls === 0, 'oracle outcome array accessor executed before rejection');

  const oracle = dlc.buildDlcOracle(815n, 816n, {
    eventId: 'oracle-input-valid', outcomeMessages: [yes, no]
  });
  assert(Object.isFrozen(oracle) && Object.isFrozen(oracle.outcomeMessages),
    'oracle announcement snapshot was mutable');
  let announcementAccessorCalls = 0;
  const hostileAnnouncement = { ...oracle };
  Object.defineProperty(hostileAnnouncement, 'eventId', {
    enumerable: true,
    get() { announcementAccessorCalls++; return oracle.eventId; }
  });
  assert(dlc.verifyDlcOracleAnnouncement(hostileAnnouncement) === false,
    'getter-bearing oracle announcement verified');
  expectThrow(() => dlc.dlcOutcomePoint(hostileAnnouncement, yes), /enumerable data property/);
  assert(announcementAccessorCalls === 0, 'oracle announcement accessor executed before rejection');

  let announcementOutcomeAccessorCalls = 0;
  const hostileAnnouncementOutcomes = [];
  Object.defineProperty(hostileAnnouncementOutcomes, '0', {
    enumerable: true,
    configurable: true,
    get() { announcementOutcomeAccessorCalls++; return oracle.outcomeMessages[0]; }
  });
  hostileAnnouncementOutcomes.length = 1;
  assert(dlc.verifyDlcOracleAnnouncement({
    ...oracle, outcomeMessages: hostileAnnouncementOutcomes
  }) === false, 'getter-bearing announcement outcomes verified');
  assert(announcementOutcomeAccessorCalls === 0, 'announcement outcome accessor executed before rejection');

  const wrappingKey = hash('oracle-input-wrapping-key');
  const sealed = dlc.sealDlcOracleSignerState(oracle, wrappingKey);
  let sealedAccessorCalls = 0;
  const hostileSealed = { ...sealed };
  Object.defineProperty(hostileSealed, 'cipher', {
    enumerable: true,
    get() { sealedAccessorCalls++; return sealed.cipher; }
  });
  expectThrow(() => dlc.restoreDlcOracleSignerState(oracle, hostileSealed, wrappingKey),
    /enumerable data property/);
  assert(sealedAccessorCalls === 0, 'sealed oracle state accessor executed before rejection');
});

test('operator-signed journal checkpoints reject forgery and untrusted keys', () => {
  const checkpoint = createDlcJournalCheckpoint({
    storeKind: 'contract-state',
    storeKey: digest('signed-checkpoint-store'),
    recordCount: 3,
    headRecordHash: digest('signed-checkpoint-head')
  });
  const signed = signDlcJournalCheckpoint(checkpoint, checkpointSignerKeys.privateKey);
  const envelopeHash = signedDlcJournalCheckpointHash(signed);
  const verified = verifySignedDlcJournalCheckpoint(signed, trustedCheckpointKeys, envelopeHash);
  assert(verified.checkpoint.checkpointHash === checkpoint.checkpointHash &&
    verified.signerKeyId === checkpointSignerKeyId, 'signed checkpoint lost its identity binding');
  assert(Object.isFrozen(verified) && Object.isFrozen(verified.checkpoint),
    'verified signed checkpoint was mutable');
  expectThrow(() => verifySignedDlcJournalCheckpoint(signed, trustedCheckpointKeys),
    /expected signed checkpoint envelope hash/);

  const forgedBytes = Buffer.from(signed.signature, 'base64');
  forgedBytes[0] ^= 1;
  const forgedEnvelope = {
    ...signed,
    signature: forgedBytes.toString('base64')
  };
  expectThrow(() => verifySignedDlcJournalCheckpoint(
    forgedEnvelope, trustedCheckpointKeys, signedDlcJournalCheckpointHash(forgedEnvelope)
  ), /signature is invalid/);
  const otherKeys = crypto.generateKeyPairSync('ed25519');
  const otherDer = otherKeys.publicKey.export({ format: 'der', type: 'spki' });
  expectThrow(() => verifySignedDlcJournalCheckpoint(signed, [{
    keyId: crypto.createHash('sha256').update(otherDer).digest('hex'),
    publicKeySpki: otherDer.toString('base64')
  }], envelopeHash), /key is not trusted/);
  expectThrow(() => verifySignedDlcJournalCheckpoint(
    signed, [trustedCheckpointKeys[0], trustedCheckpointKeys[0]], envelopeHash
  ), /duplicate/);
  expectThrow(() => verifySignedDlcJournalCheckpoint({
    ...signed,
    checkpoint: { ...signed.checkpoint, recordCount: signed.checkpoint.recordCount + 1 }
  }, trustedCheckpointKeys, envelopeHash), /checkpoint hash mismatch/);

  const older = signDlcJournalCheckpoint(createDlcJournalCheckpoint({
    storeKind: 'contract-state',
    storeKey: checkpoint.storeKey,
    recordCount: 2,
    headRecordHash: digest('older-signed-checkpoint-head')
  }), checkpointSignerKeys.privateKey);
  expectThrow(() => verifySignedDlcJournalCheckpoint(
    older, trustedCheckpointKeys, envelopeHash
  ), /replay or substitution/);

  let accessorCalls = 0;
  const accessorEnvelope = { ...signed };
  Object.defineProperty(accessorEnvelope, 'signature', {
    enumerable: true,
    get() { accessorCalls++; return signed.signature; }
  });
  expectThrow(() => verifySignedDlcJournalCheckpoint(accessorEnvelope, trustedCheckpointKeys, envelopeHash),
    /enumerable data property/);
  assert(accessorCalls === 0, 'signed checkpoint accessor executed before rejection');
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

function nativeSignerFixture(directory, signerSecret, label, options = {}) {
  const runtimeKey = crypto.generateKeyPairSync('ed25519');
  const runtimePublicDer = runtimeKey.publicKey.export({ format: 'der', type: 'spki' });
  const runtimePrivateDer = runtimeKey.privateKey.export({ format: 'der', type: 'pkcs8' });
  const helperPath = path.join(directory, `${label}.js`);
  const adaptorPath = require.resolve('./tradelayer_dlc_adaptor_sig');
  const clientPath = require.resolve('./dlc_native_signer_process_client');
  const source = `'use strict';
const crypto = require('crypto');
const fs = require('fs');
const dlc = require(${JSON.stringify(adaptorPath)});
const { RESPONSE_KIND, responseSignaturePayload } = require(${JSON.stringify(clientPath)});
const envelope = JSON.parse(fs.readFileSync(0, 'utf8'));
if (envelope.kind !== ${JSON.stringify(NATIVE_PROCESS_REQUEST_KIND)}) throw new Error('wrong process request kind');
if (process.env.UTXOREF_TEST_HOST_SECRET !== undefined) throw new Error('inherited host environment secret');
const request = envelope.request;
if (!request || request.secret !== undefined || request.keyHandle !== undefined) throw new Error('secret input rejected');
const validatorKey = crypto.createPublicKey({ key: Buffer.from(request.validatorPublicKeySpki, 'base64'), format: 'der', type: 'spki' });
if (!crypto.verify(null, Buffer.from(request.authorizationPayload, 'base64'), validatorKey, Buffer.from(request.authorization.signature, 'base64'))) throw new Error('authorization signature rejected');
const signedPayload = JSON.parse(Buffer.from(request.authorizationPayload, 'base64').toString('utf8'));
if (signedPayload.stateRecordHash !== request.stateRecordHash || signedPayload.signerPubkeyX !== request.signerPubkeyX || signedPayload.sighash !== request.sighash || signedPayload.adaptorPoint.x !== request.adaptorPoint.x || signedPayload.adaptorPoint.y !== request.adaptorPoint.y) throw new Error('request differs from signed payload');
${options.hang ? "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);" : ''}
${options.selfMutate ? "fs.appendFileSync(__filename, '\\n// mutation during signer execution\\n');" : ''}
const validPresignature = dlc.adaptorSign(${signerSecret}n, Buffer.from(request.sighash, 'hex'), { x: BigInt('0x' + request.adaptorPoint.x), y: BigInt('0x' + request.adaptorPoint.y) }, Buffer.alloc(32, 42));
const presignature = ${options.corruptResponse ? "{ ...validPresignature, s0: '00'.repeat(32) }" : 'validPresignature'};
const response = { kind: RESPONSE_KIND, challenge: ${options.wrongChallenge ? "'00'.repeat(32)" : 'envelope.challenge'}, requestDigest: envelope.requestDigest, executableSha256: ${options.wrongExecutableDigest ? "'00'.repeat(32)" : "crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex')"}, identityKeyId: ${JSON.stringify(crypto.createHash('sha256').update(runtimePublicDer).digest('hex'))}, presignature };
const runtimeKey = crypto.createPrivateKey({ key: Buffer.from(${JSON.stringify(runtimePrivateDer.toString('base64'))}, 'base64'), format: 'der', type: 'pkcs8' });
response.signature = crypto.sign(null, responseSignaturePayload(response), runtimeKey).toString('base64');
process.stdout.write(JSON.stringify(response));
`;
  fs.writeFileSync(helperPath, source, { encoding: 'utf8', mode: 0o600 });
  const launchSpec = { executablePath: fs.realpathSync(process.execPath), arguments: [helperPath], codePaths: [helperPath] };
  const manifest = {
    apiVersion: 1,
    curve: 'secp256k1',
    adaptorScheme: 'bip340-schnorr',
    nativeSecretArithmetic: true,
    constantTimeSecretOperations: true,
    secretZeroization: true,
    processIsolated: true,
    signingRequestKind: 'utxoref_dlc_native_adaptor_sign_request_v1',
    callerSuppliesSecret: false,
    keySelection: 'authorized-xonly-pubkey',
    independentAuthorizationVerification: true,
    processRequestKind: NATIVE_PROCESS_REQUEST_KIND,
    processResponseKind: NATIVE_PROCESS_RESPONSE_KIND,
    challengeBoundResponses: true,
    environmentPolicy: 'systemroot-only',
    runtimeIdentityKeyId: crypto.createHash('sha256').update(runtimePublicDer).digest('hex'),
    runtimeIdentityPublicKeySpki: runtimePublicDer.toString('base64'),
    executableSha256: nativeSignerExecutableDigest(launchSpec),
    binaryDigest: nativeSignerRuntimeDigest(launchSpec),
    auditDigest: digest(`${label}:audit`)
  };
  const auditKey = crypto.generateKeyPairSync('ed25519');
  const auditDer = auditKey.publicKey.export({ format: 'der', type: 'spki' });
  const capabilities = {
    ...manifest,
    attestation: {
      keyId: crypto.createHash('sha256').update(auditDer).digest('hex'),
      signature: crypto.sign(null, nativeCapabilityAttestationPayload(manifest), auditKey.privateKey).toString('base64')
    }
  };
  return {
    client: new DlcNativeSignerProcessClient({ ...launchSpec, capabilities, timeoutMs: options.timeoutMs || 10000 }),
    helperPath,
    manifest,
    capabilities,
    trustedAuditKeys: [{
      keyId: capabilities.attestation.keyId,
      publicKeySpki: auditDer.toString('base64')
    }]
  };
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
  assert(repeated.recordHash === contract.recordHash, 'identical transition retry must be idempotent');
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

test('contract entry points reject callbacks and durable reads return frozen snapshots', () => {
  let accessorCalls = 0;
  const contract = initialContract('callback-boundary-contract');
  const hostileRecord = { ...contract };
  Object.defineProperty(hostileRecord, 'stage', {
    enumerable: true,
    get() { accessorCalls++; return contract.stage; }
  });
  expectThrow(() => validateDlcContract(hostileRecord), /enumerable data property/);
  assert(accessorCalls === 0, 'contract record accessor executed before rejection');

  let requestAccessorCalls = 0;
  const request = requestFor(contract, 'AUTHENTICATED_ORACLES');
  const hostileRequest = { ...request };
  Object.defineProperty(hostileRequest, 'to', {
    enumerable: true,
    get() { requestAccessorCalls++; return request.to; }
  });
  expectThrow(() => transitionDlcContract(contract, hostileRequest), /enumerable data property/);
  assert(requestAccessorCalls === 0, 'transition request accessor executed before rejection');

  let creationAccessorCalls = 0;
  const creation = {
    contractId: 'hostile-create',
    network: 'bitcoin-testnet4',
    contractDigest: digest('hostile-create'),
    oraclePolicy: { threshold: 2, total: 3, pinnedPubkeys },
    validatorPolicy
  };
  Object.defineProperty(creation, 'network', {
    enumerable: true,
    get() { creationAccessorCalls++; return 'bitcoin-testnet4'; }
  });
  expectThrow(() => createDlcContract(creation), /enumerable data property/);
  assert(creationAccessorCalls === 0, 'contract creation accessor executed before rejection');

  let receiptAccessorCalls = 0;
  const receiptArguments = {
    privateKey: validatorKeys.privateKey,
    contractId: contract.contractId,
    contractDigest: contract.contractDigest,
    from: contract.stage,
    to: 'AUTHENTICATED_ORACLES',
    idempotencyKey: 'transition:hostile-receipt',
    kind: 'oracle_policy',
    digest: digest('hostile-receipt')
  };
  Object.defineProperty(receiptArguments, 'kind', {
    enumerable: true,
    get() { receiptAccessorCalls++; return 'oracle_policy'; }
  });
  expectThrow(() => signValidationReceipt(receiptArguments), /enumerable data property/);
  assert(receiptAccessorCalls === 0, 'receipt argument accessor executed before rejection');

  expectThrow(() => normalizeDlcContract(new Proxy(contract, {
    get() { throw new Error('proxy trap executed'); }
  })), /Proxy object/);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-frozen-state-'));
  try {
    const store = new DlcStateStore(directory);
    store.create(contract);
    const reloaded = new DlcStateStore(directory).read(contract.contractId);
    assert(Object.isFrozen(reloaded) && Object.isFrozen(reloaded.history) && Object.isFrozen(reloaded.oraclePolicy),
      'durable contract read did not return a deeply frozen snapshot');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('append-only store survives reload and rejects stale revisions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-dlc-state-'));
  try {
    const store = new DlcStateStore(directory);
    expectThrow(() => store.read('..'), /unsafe path/);
    expectThrow(() => store.read('.'), /unsafe path/);
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
    const revisionPath = path.join(directory, stateContractKey(initial.contractId), 'revision-000000000001.json');
    const checkpoint = store.checkpoint(initial.contractId);
    assert(store.verifyCheckpoint(initial.contractId, checkpoint).checkpointVerified === checkpoint.checkpointHash,
      'state checkpoint did not verify');
    const signedCheckpoint = signDlcJournalCheckpoint(checkpoint, checkpointSignerKeys.privateKey);
    assert(store.verifySignedCheckpoint(
      initial.contractId, signedCheckpoint, trustedCheckpointKeys,
      signedDlcJournalCheckpointHash(signedCheckpoint)
    ).checkpointSignerKeyId === checkpointSignerKeyId, 'signed state checkpoint did not verify');
    const revisionBytes = fs.readFileSync(revisionPath);
    fs.unlinkSync(revisionPath);
    assert(store.verifyChain(initial.contractId).revisions === 1, 'state tail deletion probe did not shorten the chain');
    expectThrow(() => store.verifyCheckpoint(initial.contractId, checkpoint), /rollback detected/);
    fs.writeFileSync(revisionPath, revisionBytes, { flag: 'wx', mode: 0o600 });
    const gappedPath = path.join(directory, stateContractKey(initial.contractId), 'revision-000000000002.json');
    fs.renameSync(revisionPath, gappedPath);
    expectThrow(() => store.verifyChain(initial.contractId), /filename sequence is not contiguous/);
    fs.renameSync(gappedPath, revisionPath);
    const revisionLink = path.join(directory, 'linked-state-revision.json');
    fs.linkSync(revisionPath, revisionLink);
    expectThrow(() => store.verifyChain(initial.contractId), /one bounded regular file/);
    fs.unlinkSync(revisionLink);
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

test('funding broadcast requires fresh transaction-bound Bitcoin Core policy', () => {
  const psbtBytes = Buffer.from('70736274ff01020304', 'hex');
  const psbtDigest = crypto.createHash('sha256').update(psbtBytes).digest('hex');
  const rawTxHex = '0200000000010100000000000000000000';
  const txid = digest('prebroadcast:txid');
  const wtxid = digest('prebroadcast:wtxid');
  const bestBlockHash = digest('prebroadcast:block');
  let contract = initialContract('prebroadcast-contract');
  for (const stage of [
    'AUTHENTICATED_ORACLES',
    'CANONICAL_CETS_AND_REFUND',
    'COUNTERPARTY_SIGNATURES_VERIFIED',
    'LOCAL_SIGNATURES_PERSISTED'
  ]) {
    contract = transitionDlcContract(contract, requestFor(contract, stage, `prebroadcast:${stage}`));
  }
  contract = transitionDlcContract(contract, requestFor(
    contract, 'FUNDING_PSBT_APPROVED', 'prebroadcast:approved', { funding_psbt_validation: psbtDigest }
  ));

  const methods = [];
  const rpc = (method, params) => {
    methods.push(method);
    if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 250, bestblockhash: bestBlockHash };
    if (method === 'getrawmempool') {
      assert(JSON.stringify(params) === JSON.stringify([false, true]), 'mempool sequence parameters changed');
      return { txids: [], mempool_sequence: 41 };
    }
    if (method === 'decoderawtransaction') {
      assert(params[0] === rawTxHex, 'Core decoded different funding bytes');
      return { txid, hash: wtxid, version: 2, size: 17, vsize: 17, weight: 68, locktime: 0 };
    }
    if (method === 'testmempoolaccept') {
      assert(params[0][0] === rawTxHex, 'Core policy checked different funding bytes');
      return [{ txid, wtxid, allowed: true }];
    }
    throw new Error(`unexpected prebroadcast RPC ${method}`);
  };
  const policyNow = new Date('2030-01-02T03:04:05.000Z');
  const checked = validateFundingPrebroadcastPolicy({
    contractState: contract, rawTxHex, rpc, now: policyNow, ttlSeconds: 30
  });
  assert(JSON.stringify(methods) === JSON.stringify([
    'getblockchaininfo', 'getrawmempool', 'decoderawtransaction',
    'testmempoolaccept', 'getrawmempool', 'getblockchaininfo'
  ]), 'prebroadcast guard called an unexpected RPC');
  assert(checked.record.contractRecordHash === contract.recordHash && checked.record.fundingPsbtDigest === psbtDigest,
    'prebroadcast record lost its contract or approved PSBT binding');
  assert(checked.record.txid === txid && checked.record.wtxid === wtxid &&
    checked.record.signingAllowed === false && checked.record.sendRawTransactionAllowed === false,
  'prebroadcast record overstated authority or lost transaction identity');
  expectThrow(() => transitionDlcContract(contract, requestFor(
    contract, 'FUNDING_BROADCAST', 'prebroadcast:substitution', {
      broadcast_transaction: digest('substituted-funding-transaction'),
      prebroadcast_bitcoin_core_policy: {
        digest: checked.policyDigest,
        metadata: checked.receiptMetadata
      }
    }
  )), /does not bind the broadcast transaction digest/);
  expectThrow(() => transitionDlcContract(contract, requestFor(
    contract, 'FUNDING_BROADCAST', 'prebroadcast:overlong', {
      broadcast_transaction: checked.record.rawTransactionSha256,
      prebroadcast_bitcoin_core_policy: {
        digest: checked.policyDigest,
        metadata: {
          ...checked.receiptMetadata,
          expiresAtUnixSeconds: checked.receiptMetadata.issuedAtUnixSeconds + 31
        }
      }
    }
  )), /validity window is invalid/);
  const broadcastRequest = requestFor(
    contract, 'FUNDING_BROADCAST', 'prebroadcast:broadcast', {
      broadcast_transaction: checked.record.rawTransactionSha256,
      prebroadcast_bitcoin_core_policy: {
        digest: checked.policyDigest,
        metadata: checked.receiptMetadata
      }
    }
  );
  const authorizationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-broadcast-authorization-'));
  try {
    const consumed = new DlcBroadcastAuthorizationStore(path.join(authorizationDirectory, 'single')).consume({
      contractState: contract,
      transitionRequest: broadcastRequest,
      rawTxHex,
      now: new Date(policyNow.getTime() + 10000)
    });
    assert(consumed.nextContractState.stage === 'FUNDING_BROADCAST' &&
      consumed.consumption.status === 'CONSUMED_BEFORE_BROADCAST',
    'broadcast authorization was not durably consumed before the transition');
    const requestHash = consumed.nextContractState.history[consumed.nextContractState.history.length - 1].requestHash;
    const store = new DlcBroadcastAuthorizationStore(path.join(authorizationDirectory, 'single'));
    assert(store.verifyAll().records === 1, 'broadcast authorization store lost its durable record');
    expectThrow(() => store.consume({
      contractState: contract,
      transitionRequest: broadcastRequest,
      rawTxHex,
      now: new Date(policyNow.getTime() + 11000)
    }), /already durably consumed/);
    expectThrow(() => new DlcBroadcastAuthorizationStore(path.join(authorizationDirectory, 'wrong-bytes')).consume({
      contractState: contract,
      transitionRequest: broadcastRequest,
      rawTxHex: `${rawTxHex.slice(0, -2)}01`,
      now: new Date(policyNow.getTime() + 10000)
    }), /does not match the exact transaction bytes/);
    expectThrow(() => new DlcBroadcastAuthorizationStore(path.join(authorizationDirectory, 'expired')).consume({
      contractState: contract,
      transitionRequest: broadcastRequest,
      rawTxHex,
      now: new Date(policyNow.getTime() + 31000)
    }), /has expired/);
    expectThrow(() => new DlcBroadcastAuthorizationStore(path.join(authorizationDirectory, 'future')).consume({
      contractState: contract,
      transitionRequest: broadcastRequest,
      rawTxHex,
      now: new Date(policyNow.getTime() - 6000)
    }), /future-dated/);

    const raceFixturePath = path.join(authorizationDirectory, 'race-fixture.json');
    fs.writeFileSync(raceFixturePath, JSON.stringify({
      contractState: contract,
      transitionRequest: broadcastRequest,
      rawTxHex,
      now: new Date(policyNow.getTime() + 10000).toISOString()
    }));
    const race = spawnSync(process.execPath, [
      path.join(__dirname, 'dlc_broadcast_authorization_race.js'),
      path.join(authorizationDirectory, 'race'),
      raceFixturePath,
      '16'
    ], { encoding: 'utf8', windowsHide: true });
    assert(race.status === 0, race.stderr || race.stdout || 'broadcast authorization race failed');
    const raceReport = JSON.parse(race.stdout);
    assert(raceReport.passed === true && raceReport.consumed === 1 && raceReport.rejected === 15 &&
      raceReport.records === 1, 'broadcast race did not select exactly one durable consumer');

    const recordPath = path.join(
      authorizationDirectory, 'single', consumed.consumption.authorizationKey, 'consumed.json'
    );
    const checkpoint = store.checkpoint(contract.contractId, broadcastRequest.idempotencyKey, requestHash);
    assert(store.verifyCheckpoint(
      contract.contractId, broadcastRequest.idempotencyKey, requestHash, checkpoint
    ).checkpointVerified === checkpoint.checkpointHash, 'broadcast authorization checkpoint did not verify');
    const recordBytes = fs.readFileSync(recordPath);
    fs.unlinkSync(recordPath);
    expectThrow(() => store.verifyCheckpoint(
      contract.contractId, broadcastRequest.idempotencyKey, requestHash, checkpoint
    ), /incomplete consumption marker/);
    fs.writeFileSync(recordPath, recordBytes, { flag: 'wx', mode: 0o600 });
    fs.linkSync(recordPath, path.join(authorizationDirectory, 'linked-consumption.json'));
    expectThrow(() => store.read(contract.contractId, broadcastRequest.idempotencyKey, requestHash),
      /one bounded regular file/);
  } finally {
    fs.rmSync(authorizationDirectory, { recursive: true, force: true });
  }
  contract = transitionDlcContract(contract, broadcastRequest);
  assert(contract.stage === 'FUNDING_BROADCAST', 'fresh Core policy receipt did not authorize the state transition');

  const approved = validatedChainFixture('prebroadcast-negative', 'FUNDING_PSBT_APPROVED').contract;
  const baselineRpc = (method) => {
    if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 250, bestblockhash: bestBlockHash };
    if (method === 'getrawmempool') return { mempool_sequence: 41 };
    if (method === 'decoderawtransaction') {
      return { txid, hash: wtxid, version: 2, size: 17, vsize: 17, weight: 68, locktime: 0 };
    }
    if (method === 'testmempoolaccept') return [{ txid, wtxid, allowed: true }];
    throw new Error(`unexpected prebroadcast RPC ${method}`);
  };
  expectThrow(() => validateFundingPrebroadcastPolicy({
    contractState: approved,
    rawTxHex,
    rpc(method, params) {
      if (method === 'testmempoolaccept') return [{ txid, wtxid, allowed: false, 'reject-reason': 'script failure' }];
      return baselineRpc(method, params);
    }
  }), /rejected.*script failure/);
  expectThrow(() => validateFundingPrebroadcastPolicy({
    contractState: approved,
    rawTxHex,
    rpc(method, params) {
      if (method === 'testmempoolaccept') return [{ txid: digest('wrong-txid'), wtxid, allowed: true }];
      return baselineRpc(method, params);
    }
  }), /identities differ/);
  let mempoolReads = 0;
  expectThrow(() => validateFundingPrebroadcastPolicy({
    contractState: approved,
    rawTxHex,
    maxAttempts: 1,
    rpc(method, params) {
      if (method === 'getrawmempool') return { mempool_sequence: ++mempoolReads };
      return baselineRpc(method, params);
    }
  }), /tip or mempool changed/);
  expectThrow(() => validateFundingPrebroadcastPolicy({
    contractState: approved,
    rawTxHex,
    rpc: async () => ({})
  }), /must be synchronous/);
  expectThrow(() => validateFundingPrebroadcastPolicy({ contractState: contract, rawTxHex, rpc }), /requires the FUNDING_PSBT_APPROVED stage/);
});

test('crypto provider defaults closed and confines JavaScript secrets to explicit test mode', () => {
  let optionAccessorCalls = 0;
  const hostileOptions = {};
  Object.defineProperty(hostileOptions, 'network', {
    enumerable: true,
    get() { optionAccessorCalls++; return 'bitcoin-testnet4'; }
  });
  expectThrow(() => createDlcCryptoProvider(hostileOptions), /enumerable data property/);
  assert(optionAccessorCalls === 0, 'provider option accessor executed before rejection');
  let proxyTrapCalls = 0;
  expectThrow(() => createDlcCryptoProvider(new Proxy({ network: 'bitcoin-testnet4' }, {
    getOwnPropertyDescriptor() { proxyTrapCalls++; return undefined; }
  })), /plain object, not a Proxy/);
  assert(proxyTrapCalls === 0, 'provider options Proxy trap executed before rejection');
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
  const storeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-provider-store-'));
  try {
    let subclassConsumeCalls = 0;
    class HostileAuthorizationStore extends DlcSigningAuthorizationStore {
      consume() { subclassConsumeCalls++; return {}; }
    }
    const hostileStore = new HostileAuthorizationStore(storeDirectory);
    expectThrow(() => createDlcCryptoProvider({
      network: 'bitcoin-testnet4',
      mode: 'experimental-js',
      allowExperimental: true,
      authorizationStore: hostileStore
    }), /authorizationStore/);
    assert(subclassConsumeCalls === 0, 'authorization store subclass callback executed');
    assert(Object.isFrozen(hostileStore), 'authorization store instance was not frozen');
  } finally {
    fs.rmSync(storeDirectory, { recursive: true, force: true });
  }
});

test('native provider rejects incomplete security capability claims', () => {
  expectThrow(() => createDlcCryptoProvider({
    network: 'bitcoin-testnet4',
    mode: 'native-isolated',
    implementation: { capabilities: { apiVersion: 1 } }
  }), /verified DlcNativeSignerProcessClient/);
});

test('native provider requires an operator-pinned audit signature over its exact binary capabilities', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-native-audit-'));
  try {
    const fixture = nativeSignerFixture(directory, 505n, 'audit-provider');
    const provider = createDlcCryptoProvider({
      network: 'bitcoin-testnet4',
      mode: 'native-isolated',
      implementation: fixture.client,
      trustedAuditKeys: fixture.trustedAuditKeys
    });
    assert(provider.capabilities.attestationVerified === true && provider.productionReady === false,
      'verified native candidate overstated production readiness or lost attestation state');
    let clientArgumentAccessorCalls = 0;
    const hostileClientArguments = {};
    Object.defineProperty(hostileClientArguments, 'executablePath', {
      enumerable: true,
      get() { clientArgumentAccessorCalls++; return fixture.client.launchSpec.executablePath; }
    });
    expectThrow(() => new DlcNativeSignerProcessClient(hostileClientArguments), /enumerable data property/);
    assert(clientArgumentAccessorCalls === 0, 'native client argument accessor executed before rejection');
    let clientCapabilityAccessorCalls = 0;
    const hostileClientCapabilities = { ...fixture.capabilities };
    Object.defineProperty(hostileClientCapabilities, 'apiVersion', {
      enumerable: true,
      get() { clientCapabilityAccessorCalls++; return 1; }
    });
    expectThrow(() => new DlcNativeSignerProcessClient({
      ...fixture.client.launchSpec,
      capabilities: hostileClientCapabilities
    }), /enumerable data property/);
    assert(clientCapabilityAccessorCalls === 0, 'native client capability accessor executed before rejection');
    let launchArgumentAccessorCalls = 0;
    const hostileLaunchArguments = [];
    Object.defineProperty(hostileLaunchArguments, '0', {
      enumerable: true,
      configurable: true,
      get() { launchArgumentAccessorCalls++; return fixture.helperPath; }
    });
    hostileLaunchArguments.length = 1;
    expectThrow(() => new DlcNativeSignerProcessClient({
      ...fixture.client.launchSpec,
      arguments: hostileLaunchArguments,
      capabilities: fixture.capabilities
    }), /enumerable data property/);
    assert(launchArgumentAccessorCalls === 0, 'native signer launch argument accessor executed before rejection');
    let nativeRequestAccessorCalls = 0;
    const hostileNativeRequest = {};
    Object.defineProperty(hostileNativeRequest, 'kind', {
      enumerable: true,
      get() { nativeRequestAccessorCalls++; return 'hostile'; }
    });
    expectThrow(() => fixture.client.adaptorSignAuthorized(hostileNativeRequest), /enumerable data property/);
    assert(nativeRequestAccessorCalls === 0, 'native signer request accessor executed before rejection');
    let responseArgumentAccessorCalls = 0;
    const hostileResponseArguments = {
      requestDigest: digest('response-request'),
      executableSha256: digest('response-executable'),
      presignature: { R: digest('response-r'), s0: digest('response-s') }
    };
    Object.defineProperty(hostileResponseArguments, 'challenge', {
      enumerable: true,
      get() { responseArgumentAccessorCalls++; return digest('response-challenge'); }
    });
    expectThrow(() => responseSignaturePayload(hostileResponseArguments), /enumerable data property/);
    assert(responseArgumentAccessorCalls === 0, 'native response argument accessor executed before rejection');
    let presignatureAccessorCalls = 0;
    const hostilePresignature = { s0: digest('response-s') };
    Object.defineProperty(hostilePresignature, 'R', {
      enumerable: true,
      get() { presignatureAccessorCalls++; return digest('response-r'); }
    });
    expectThrow(() => responseSignaturePayload({
      challenge: digest('response-challenge'),
      requestDigest: digest('response-request'),
      executableSha256: digest('response-executable'),
      presignature: hostilePresignature
    }), /enumerable data property/);
    assert(presignatureAccessorCalls === 0, 'native response presignature accessor executed before rejection');
    let manifestAccessorCalls = 0;
    const hostileManifest = { ...fixture.manifest };
    Object.defineProperty(hostileManifest, 'apiVersion', {
      enumerable: true,
      get() { manifestAccessorCalls++; return 1; }
    });
    expectThrow(() => nativeCapabilityAttestationPayload(hostileManifest), /enumerable data property/);
    assert(manifestAccessorCalls === 0, 'native capability accessor executed before rejection');
    expectThrow(() => nativeCapabilityAttestationPayload({ ...fixture.manifest, callerSuppliesSecret: true }),
      /required capability manifest/);
    const directImplementation = {
      capabilities: fixture.capabilities,
      adaptorSignAuthorized() {}, adaptorVerify() {}, adaptorComplete() {}, adaptorExtract() {}, schnorrVerify() {}
    };
    let directCapabilityCalls = 0;
    const hostileDirectImplementation = {};
    Object.defineProperty(hostileDirectImplementation, 'capabilities', {
      enumerable: true,
      get() { directCapabilityCalls++; return fixture.capabilities; }
    });
    expectThrow(() => createDlcCryptoProvider({
      network: 'bitcoin-testnet4',
      mode: 'native-isolated',
      implementation: hostileDirectImplementation,
      trustedAuditKeys: fixture.trustedAuditKeys
    }), /verified DlcNativeSignerProcessClient/);
    assert(directCapabilityCalls === 0, 'unverified implementation capability getter executed');
    expectThrow(() => createDlcCryptoProvider({
      network: 'bitcoin-testnet4',
      mode: 'native-isolated',
      implementation: directImplementation,
      trustedAuditKeys: fixture.trustedAuditKeys
    }), /verified DlcNativeSignerProcessClient/);
    const tamperedClient = new DlcNativeSignerProcessClient({
      ...fixture.client.launchSpec,
      capabilities: { ...fixture.capabilities, auditDigest: digest('tampered-audit') }
    });
    expectThrow(() => createDlcCryptoProvider({
      network: 'bitcoin-testnet4',
      mode: 'native-isolated',
      implementation: tamperedClient,
      trustedAuditKeys: fixture.trustedAuditKeys
    }), /attestation is invalid/);
    const unattestedClient = new DlcNativeSignerProcessClient({
      ...fixture.client.launchSpec,
      capabilities: fixture.manifest
    });
    expectThrow(() => createDlcCryptoProvider({
      network: 'bitcoin-testnet4',
      mode: 'native-isolated',
      implementation: unattestedClient,
      trustedAuditKeys: fixture.trustedAuditKeys
    }), /lacks a trusted audit attestation/);
    const untrustedKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
    let auditKeyAccessorCalls = 0;
    const hostileAuditKey = { publicKeySpki: fixture.trustedAuditKeys[0].publicKeySpki };
    Object.defineProperty(hostileAuditKey, 'keyId', {
      enumerable: true,
      get() { auditKeyAccessorCalls++; return fixture.trustedAuditKeys[0].keyId; }
    });
    expectThrow(() => createDlcCryptoProvider({
      network: 'bitcoin-testnet4',
      mode: 'native-isolated',
      implementation: fixture.client,
      trustedAuditKeys: [hostileAuditKey]
    }), /enumerable data property/);
    assert(auditKeyAccessorCalls === 0, 'trusted audit key accessor executed before rejection');
    expectThrow(() => createDlcCryptoProvider({
      network: 'bitcoin-testnet4',
      mode: 'native-isolated',
      implementation: fixture.client,
      trustedAuditKeys: [{
        keyId: crypto.createHash('sha256').update(untrustedKey).digest('hex'),
        publicKeySpki: untrustedKey.toString('base64')
      }]
    }), /lacks a trusted audit attestation/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('adaptor signing is short-lived, durably consumed, and bound to the contract transcript', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-signing-authorizations-'));
  try {
    const providerOptions = {
      network: 'bitcoin-testnet4',
      mode: 'experimental-js',
      allowExperimental: true,
      authorizationStore: new DlcSigningAuthorizationStore(directory)
    };
    let consumptionAccessorCalls = 0;
    const hostileConsumption = {
      contractId: 'hostile-consumption',
      authorizationId: 'cet:hostile',
      stateRecordHash: digest('hostile-consumption-state'),
      authorizationDigest: digest('hostile-consumption-authorization'),
      providerIdentity: digest('hostile-consumption-provider')
    };
    Object.defineProperty(hostileConsumption, 'network', {
      enumerable: true,
      get() { consumptionAccessorCalls++; return 'bitcoin-testnet4'; }
    });
    expectThrow(() => providerOptions.authorizationStore.consume(hostileConsumption), /enumerable data property/);
    assert(consumptionAccessorCalls === 0, 'signing consumption argument accessor executed before rejection');
    let consumptionRecordAccessorCalls = 0;
    const hostileConsumptionRecord = {};
    Object.defineProperty(hostileConsumptionRecord, 'kind', {
      enumerable: true,
      get() { consumptionRecordAccessorCalls++; return 'hostile'; }
    });
    expectThrow(() => validateConsumptionRecord(hostileConsumptionRecord), /enumerable data property/);
    assert(consumptionRecordAccessorCalls === 0, 'signing consumption record accessor executed before rejection');
    const provider = createDlcCryptoProvider(providerOptions);
    assert(provider.operations.adaptorSign === undefined, 'raw adaptor signing escaped the provider boundary');
    assert(provider.signingAuthorizationPersistence === 'durable-before-sign', 'durable signer store was not bound');
    expectThrow(() => requireDlcSigningProvider({
      kind: 'utxoref_dlc_crypto_provider_v1',
      mode: 'experimental-js',
      network: 'bitcoin-testnet4'
    }), /enabled DLC signing provider/);

    let contract = initialContract('adaptor-sign-authorization');
    contract = transitionDlcContract(contract, requestFor(contract, 'AUTHENTICATED_ORACLES', 'signing:oracles'));
    contract = transitionDlcContract(contract, requestFor(contract, 'CANONICAL_CETS_AND_REFUND', 'signing:cets', {
      cet_set: digest('signing:authenticated-cet-set')
    }));
    contract = transitionDlcContract(contract, requestFor(
      contract,
      'COUNTERPARTY_SIGNATURES_VERIFIED',
      'signing:counterparty'
    ));
    const sighash = digest('signing:cet-sighash');
    const adaptorPoint = dlc.pointMul(dlc.G, 4242n);
    const signerPubkeyX = dlc.xOnlyPubkey(909n).toString('hex');
    const authorization = createDlcAdaptorSignAuthorization({
      privateKey: validatorKeys.privateKey,
      contract,
      authorizationId: 'cet:0:oracle-set:0',
      signerPubkeyX,
      sighash,
      adaptorPoint
    });
    let creationAccessorCalls = 0;
    const hostileCreation = {
      privateKey: validatorKeys.privateKey,
      contract,
      signerPubkeyX,
      sighash,
      adaptorPoint
    };
    Object.defineProperty(hostileCreation, 'authorizationId', {
      enumerable: true,
      get() { creationAccessorCalls++; return 'cet:hostile-create'; }
    });
    expectThrow(() => createDlcAdaptorSignAuthorization(hostileCreation), /enumerable data property/);
    assert(creationAccessorCalls === 0, 'signing authorization argument accessor executed before rejection');
    let clockCallbackCalls = 0;
    class HostileClock extends Date {
      getTime() { clockCallbackCalls++; return super.getTime(); }
    }
    const clockAuthorization = createDlcAdaptorSignAuthorization({
      privateKey: validatorKeys.privateKey,
      contract,
      authorizationId: 'cet:hostile-clock',
      signerPubkeyX,
      sighash,
      adaptorPoint,
      now: new HostileClock('2026-01-01T00:00:00.000Z')
    });
    assert(clockAuthorization.issuedAtUnixSeconds === 1767225600,
      'signing authorization intrinsic clock snapshot was incorrect');
    assert(clockCallbackCalls === 0, 'signing authorization clock callback executed');
    let pointAccessorCalls = 0;
    const hostilePoint = { y: adaptorPoint.y };
    Object.defineProperty(hostilePoint, 'x', {
      enumerable: true,
      get() { pointAccessorCalls++; return adaptorPoint.x; }
    });
    expectThrow(() => createDlcAdaptorSignAuthorization({
      privateKey: validatorKeys.privateKey,
      contract,
      authorizationId: 'cet:hostile-point',
      signerPubkeyX,
      sighash,
      adaptorPoint: hostilePoint
    }), /enumerable data property/);
    assert(pointAccessorCalls === 0, 'adaptor point accessor executed before rejection');
    const expiredAuthorization = createDlcAdaptorSignAuthorization({
      privateKey: validatorKeys.privateKey,
      contract,
      authorizationId: 'cet:expired',
      signerPubkeyX,
      sighash,
      adaptorPoint,
      now: new Date(Date.now() - 10 * 60 * 1000),
      ttlSeconds: 60
    });
    expectThrow(() => authorizeDlcAdaptorSign(provider, {
      contract, authorization: expiredAuthorization
    }), /authorization has expired/);
    const futureAuthorization = createDlcAdaptorSignAuthorization({
      privateKey: validatorKeys.privateKey,
      contract,
      authorizationId: 'cet:future',
      signerPubkeyX,
      sighash,
      adaptorPoint,
      now: new Date(Date.now() + 2 * 60 * 1000),
      ttlSeconds: 60
    });
    expectThrow(() => authorizeDlcAdaptorSign(provider, {
      contract, authorization: futureAuthorization
    }), /authorization is not yet valid/);
    expectThrow(() => authorizeDlcAdaptorSign(provider, {
      contract,
      authorization: {
        ...authorization,
        expiresAtUnixSeconds: authorization.expiresAtUnixSeconds + 1
      }
    }), /authorization signature is invalid/);
    expectThrow(() => createDlcAdaptorSignAuthorization({
      privateKey: validatorKeys.privateKey,
      contract,
      authorizationId: 'cet:excessive-lifetime',
      signerPubkeyX,
      sighash,
      adaptorPoint,
      ttlSeconds: 301
    }), /ttlSeconds must be an integer from 1 through 300/);
    const noStoreProvider = createDlcCryptoProvider({
      network: 'bitcoin-testnet4', mode: 'experimental-js', allowExperimental: true
    });
    expectThrow(() => authorizeDlcAdaptorSign(noStoreProvider, { contract, authorization }), /durable authorizationStore/);
    let sessionArgumentAccessorCalls = 0;
    const hostileSessionArguments = { authorization };
    Object.defineProperty(hostileSessionArguments, 'contract', {
      enumerable: true,
      get() { sessionArgumentAccessorCalls++; return contract; }
    });
    expectThrow(() => authorizeDlcAdaptorSign(provider, hostileSessionArguments), /enumerable data property/);
    assert(sessionArgumentAccessorCalls === 0, 'signer session argument accessor executed before rejection');
    let authorizationAccessorCalls = 0;
    const hostileAuthorization = { ...authorization };
    Object.defineProperty(hostileAuthorization, 'sighash', {
      enumerable: true,
      get() { authorizationAccessorCalls++; return authorization.sighash; }
    });
    expectThrow(() => authorizeDlcAdaptorSign(provider, { contract, authorization: hostileAuthorization }),
      /enumerable data property/);
    assert(authorizationAccessorCalls === 0, 'signing authorization accessor executed before rejection');
    const mutableAuthorization = JSON.parse(JSON.stringify(authorization));
    const session = authorizeDlcAdaptorSign(provider, { contract, authorization: mutableAuthorization });
    mutableAuthorization.sighash = '00'.repeat(32);
    const presignature = session.execute(909n, hash('signing:aux'));
    assert(dlc.adaptorVerify(dlc.xOnlyPubkey(909n), Buffer.from(sighash, 'hex'), presignature),
      'authorized adaptor signature did not verify');
    assert(providerOptions.authorizationStore.verifyAll().records === 1, 'authorization was not persisted before signing');
    expectThrow(() => session.execute(909n, hash('signing:aux:replay')), /already consumed/);
    expectThrow(() => authorizeDlcAdaptorSign(provider, { contract, authorization }), /already consumed/);
    const restartedProvider = createDlcCryptoProvider({
      ...providerOptions,
      authorizationStore: new DlcSigningAuthorizationStore(directory)
    });
    const restartedSession = authorizeDlcAdaptorSign(restartedProvider, { contract, authorization });
    expectThrow(() => restartedSession.execute(909n, hash('signing:aux:restart')), /durably consumed/);
    const consumptionDirectory = path.join(directory, fs.readdirSync(directory)[0]);
    const consumptionPath = path.join(consumptionDirectory, 'consumed.json');
    const linkedPath = path.join(directory, 'linked-consumption.json');
    fs.linkSync(consumptionPath, linkedPath);
    expectThrow(() => providerOptions.authorizationStore.read(contract.contractId, authorization.authorizationId),
      /one bounded regular file/);
    fs.unlinkSync(linkedPath);
    const originalRecord = fs.readFileSync(consumptionPath);
    const checkpoint = providerOptions.authorizationStore.checkpoint(
      contract.contractId, authorization.authorizationId
    );
    assert(providerOptions.authorizationStore.verifyCheckpoint(
      contract.contractId, authorization.authorizationId, checkpoint
    ).checkpointVerified === checkpoint.checkpointHash, 'signing authorization checkpoint did not verify');
    const signedCheckpoint = signDlcJournalCheckpoint(checkpoint, checkpointSignerKeys.privateKey);
    assert(providerOptions.authorizationStore.verifySignedCheckpoint(
      contract.contractId, authorization.authorizationId, signedCheckpoint, trustedCheckpointKeys,
      signedDlcJournalCheckpointHash(signedCheckpoint)
    ).checkpointSignerKeyId === checkpointSignerKeyId,
    'signed signing-authorization checkpoint did not verify');
    const accessorCheckpoint = { ...checkpoint };
    Object.defineProperty(accessorCheckpoint, 'recordCount', { enumerable: true, get: () => 1 });
    expectThrow(() => providerOptions.authorizationStore.verifyCheckpoint(
      contract.contractId, authorization.authorizationId, accessorCheckpoint
    ), /plain data properties/);
    fs.unlinkSync(consumptionPath);
    expectThrow(() => providerOptions.authorizationStore.verifyCheckpoint(
      contract.contractId, authorization.authorizationId, checkpoint
    ), /incomplete consumption marker/);
    fs.writeFileSync(consumptionPath, originalRecord, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(consumptionPath, Buffer.alloc(32769, 0x20));
    expectThrow(() => providerOptions.authorizationStore.read(contract.contractId, authorization.authorizationId),
      /one bounded regular file/);
    fs.writeFileSync(consumptionPath, originalRecord);
    const conflictingAuthorization = createDlcAdaptorSignAuthorization({
      privateKey: validatorKeys.privateKey,
      contract,
      authorizationId: authorization.authorizationId,
      signerPubkeyX,
      sighash: digest('signing:conflicting-valid-sighash'),
      adaptorPoint
    });
    const conflictingSession = authorizeDlcAdaptorSign(restartedProvider, {
      contract,
      authorization: conflictingAuthorization
    });
    expectThrow(() => conflictingSession.execute(909n, hash('signing:aux:conflict')), /conflicts with a different/);
    expectThrow(() => authorizeDlcAdaptorSign(provider, {
      contract,
      authorization: { ...authorization, sighash: digest('signing:tampered-sighash') }
    }), /signature is invalid/);
    expectThrow(() => createDlcAdaptorSignAuthorization({
      privateKey: validatorKeys.privateKey,
      contract: initialContract('adaptor-sign-too-early'),
      authorizationId: 'too-early',
      signerPubkeyX,
      sighash,
      adaptorPoint
    }), /COUNTERPARTY_SIGNATURES_VERIFIED/);
    const tamperedRecord = JSON.parse(fs.readFileSync(consumptionPath, 'utf8'));
    tamperedRecord.providerIdentity = 'ff'.repeat(32);
    fs.writeFileSync(consumptionPath, JSON.stringify(tamperedRecord));
    expectThrow(() => providerOptions.authorizationStore.verifyAll(), /invalid DLC signing authorization/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('native proxy runtime closure requires and binds its public transport descriptor', () => {
  const launchSpec = {
    executablePath: fs.realpathSync(process.execPath),
    attestedExecutablePath: fs.realpathSync(__filename),
    arguments: [],
    codePaths: []
  };
  expectThrow(() => nativeSignerRuntimeDigest(launchSpec), /requires an attested transportDescriptor/);
  const first = nativeSignerRuntimeDigest({
    ...launchSpec,
    transportDescriptor: { kind: 'test_transport_v1', allowedClientSid: 'S-1-5-18' }
  });
  const second = nativeSignerRuntimeDigest({
    ...launchSpec,
    transportDescriptor: { kind: 'test_transport_v1', allowedClientSid: 'S-1-5-32-544' }
  });
  if (first === second) throw new Error('transport descriptor mutation did not change the runtime closure');
});

test('native signer runtime closure rejects hard links and mutation during hashing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-runtime-identity-'));
  const codePath = path.join(directory, 'signer-code.js');
  const linkedPath = path.join(directory, 'signer-code-link.js');
  const originalReadSync = fs.readSync;
  try {
    fs.writeFileSync(codePath, Buffer.alloc(131072, 0x61));
    fs.linkSync(codePath, linkedPath);
    expectThrow(() => nativeSignerRuntimeDigest({
      executablePath: fs.realpathSync(process.execPath), arguments: [], codePaths: [codePath]
    }), /one filesystem link/);
    fs.unlinkSync(linkedPath);
    const identity = fs.lstatSync(codePath, { bigint: true });
    let mutated = false;
    fs.readSync = function patchedReadSync(fd, buffer, offset, length, position) {
      const count = originalReadSync(fd, buffer, offset, length, position);
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!mutated && opened.dev === identity.dev && opened.ino === identity.ino && count > 0) {
        fs.appendFileSync(codePath, 'b');
        mutated = true;
      }
      return count;
    };
    expectThrow(() => nativeSignerRuntimeDigest({
      executablePath: fs.realpathSync(process.execPath), arguments: [], codePaths: [codePath]
    }), /changed while hashing/);
    assert(mutated, 'runtime identity test did not mutate the audited file');
  } finally {
    fs.readSync = originalReadSync;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('durable JSON rejects pathname swaps during reads and final publication flushes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-durable-path-swap-'));
  const options = { maxBytes: 4096, label: 'path-swap durable record' };
  const originalReadSync = fs.readSync;
  const originalFsyncSync = fs.fsyncSync;
  try {
    const junctionTarget = path.join(directory, 'junction-target');
    const junctionPath = path.join(directory, 'junction-path');
    fs.mkdirSync(junctionTarget);
    writeJsonAppendOnce(junctionTarget, 'record.json', { sequence: -1 }, options);
    fs.symlinkSync(junctionTarget, junctionPath, 'junction');
    expectThrow(
      () => readBoundedJson(path.join(junctionPath, 'record.json'), options),
      /directory must be a non-symlink directory|directory must not traverse filesystem links/
    );

    const recordPath = writeJsonAppendOnce(directory, 'record.json', { sequence: 0 }, options);
    const displacedReadPath = path.join(directory, 'record-read-displaced.json');
    const readReplacementPath = path.join(directory, 'record-read-replacement.json');
    fs.writeFileSync(readReplacementPath, `${JSON.stringify({ sequence: 1 })}\n`);
    let readSwapped = false;
    fs.readSync = function swappingReadSync(fd, buffer, offset, length, position) {
      const count = originalReadSync(fd, buffer, offset, length, position);
      if (!readSwapped && count > 0) {
        fs.renameSync(recordPath, displacedReadPath);
        fs.renameSync(readReplacementPath, recordPath);
        readSwapped = true;
      }
      return count;
    };
    expectThrow(() => readBoundedJson(recordPath, options), /path changed while reading/);
    assert(readSwapped, 'durable read path-swap test did not replace the record');
    fs.readSync = originalReadSync;

    const publishReplacementPath = path.join(directory, 'publish-replacement.json');
    const displacedPublishPath = path.join(directory, 'publish-displaced.json');
    fs.writeFileSync(publishReplacementPath, `${JSON.stringify({ sequence: 3 })}\n`);
    let fsyncCalls = 0;
    let publishSwapped = false;
    fs.fsyncSync = function swappingFsyncSync(fd) {
      const result = originalFsyncSync(fd);
      fsyncCalls++;
      if (fsyncCalls === 2) {
        const publishPath = path.join(directory, 'publish.json');
        fs.renameSync(publishPath, displacedPublishPath);
        fs.renameSync(publishReplacementPath, publishPath);
        publishSwapped = true;
      }
      return result;
    };
    expectThrow(
      () => writeJsonAppendOnce(directory, 'publish.json', { sequence: 2 }, options),
      /path changed during final flush/
    );
    assert(publishSwapped, 'durable publication path-swap test did not replace the record');
  } finally {
    fs.readSync = originalReadSync;
    fs.fsyncSync = originalFsyncSync;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('native isolated signing receives only an authenticated public request', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-native-signing-'));
  try {
    const nativeSecret = 606n;
    const signerPubkeyX = dlc.xOnlyPubkey(nativeSecret).toString('hex');
    const fixture = nativeSignerFixture(directory, nativeSecret, 'valid-signer');
    const provider = createDlcCryptoProvider({
      network: 'bitcoin-testnet4',
      mode: 'native-isolated',
      implementation: fixture.client,
      trustedAuditKeys: fixture.trustedAuditKeys,
      authorizationStore: new DlcSigningAuthorizationStore(directory)
    });
    let contract = initialContract('native-secretless-signing');
    for (const stage of ['AUTHENTICATED_ORACLES', 'CANONICAL_CETS_AND_REFUND', 'COUNTERPARTY_SIGNATURES_VERIFIED']) {
      contract = transitionDlcContract(contract, requestFor(contract, stage, `native:${stage}`));
    }
    const sighash = digest('native-request:sighash');
    const adaptorPoint = dlc.pointMul(dlc.G, 717n);
    const authorization = createDlcAdaptorSignAuthorization({
      privateKey: validatorKeys.privateKey,
      contract,
      authorizationId: 'native:cet:0',
      signerPubkeyX,
      sighash,
      adaptorPoint
    });
    const session = authorizeDlcAdaptorSign(provider, { contract, authorization });
    expectThrow(() => session.execute(nativeSecret), /accepts no host-supplied secret/);
    let presignature;
    process.env.UTXOREF_TEST_HOST_SECRET = 'must-not-reach-signer';
    try { presignature = session.execute(); }
    finally { delete process.env.UTXOREF_TEST_HOST_SECRET; }
    assert(dlc.adaptorVerify(Buffer.from(signerPubkeyX, 'hex'), Buffer.from(sighash, 'hex'), presignature),
      'native authorized response failed verification');
    const invalidDirectory = path.join(directory, 'invalid-response');
    fs.mkdirSync(invalidDirectory);
    const invalidFixture = nativeSignerFixture(invalidDirectory, nativeSecret, 'invalid-signer', {
      corruptResponse: true
    });
    const invalidProvider = createDlcCryptoProvider({
      network: 'bitcoin-testnet4',
      mode: 'native-isolated',
      implementation: invalidFixture.client,
      trustedAuditKeys: invalidFixture.trustedAuditKeys,
      authorizationStore: new DlcSigningAuthorizationStore(invalidDirectory)
    });
    const invalidAuthorization = createDlcAdaptorSignAuthorization({
      privateKey: validatorKeys.privateKey,
      contract,
      authorizationId: 'native:cet:invalid-response',
      signerPubkeyX,
      sighash,
      adaptorPoint
    });
    const invalidSession = authorizeDlcAdaptorSign(invalidProvider, {
      contract, authorization: invalidAuthorization
    });
    expectThrow(() => invalidSession.execute(), /returned an invalid authorized adaptor signature/);

    const challengeDirectory = path.join(directory, 'wrong-challenge');
    fs.mkdirSync(challengeDirectory);
    const challengeFixture = nativeSignerFixture(challengeDirectory, nativeSecret, 'wrong-challenge-signer', {
      wrongChallenge: true
    });
    const challengeProvider = createDlcCryptoProvider({
      network: 'bitcoin-testnet4', mode: 'native-isolated', implementation: challengeFixture.client,
      trustedAuditKeys: challengeFixture.trustedAuditKeys,
      authorizationStore: new DlcSigningAuthorizationStore(challengeDirectory)
    });
    const challengeAuthorization = createDlcAdaptorSignAuthorization({
      privateKey: validatorKeys.privateKey, contract, authorizationId: 'native:cet:wrong-challenge',
      signerPubkeyX, sighash, adaptorPoint
    });
    expectThrow(() => authorizeDlcAdaptorSign(challengeProvider, {
      contract, authorization: challengeAuthorization
    }).execute(), /not bound to this request challenge/);

    const executableDirectory = path.join(directory, 'wrong-executable');
    fs.mkdirSync(executableDirectory);
    const executableFixture = nativeSignerFixture(
      executableDirectory,
      nativeSecret,
      'wrong-executable-signer',
      { wrongExecutableDigest: true }
    );
    const executableProvider = createDlcCryptoProvider({
      network: 'bitcoin-testnet4', mode: 'native-isolated', implementation: executableFixture.client,
      trustedAuditKeys: executableFixture.trustedAuditKeys,
      authorizationStore: new DlcSigningAuthorizationStore(executableDirectory)
    });
    const executableAuthorization = createDlcAdaptorSignAuthorization({
      privateKey: validatorKeys.privateKey, contract, authorizationId: 'native:cet:wrong-executable',
      signerPubkeyX, sighash, adaptorPoint
    });
    expectThrow(() => authorizeDlcAdaptorSign(executableProvider, {
      contract, authorization: executableAuthorization
    }).execute(), /response executable digest does not match/);

    const timeoutDirectory = path.join(directory, 'timeout');
    fs.mkdirSync(timeoutDirectory);
    const timeoutFixture = nativeSignerFixture(timeoutDirectory, nativeSecret, 'timeout-signer', {
      hang: true, timeoutMs: 100
    });
    const timeoutProvider = createDlcCryptoProvider({
      network: 'bitcoin-testnet4', mode: 'native-isolated', implementation: timeoutFixture.client,
      trustedAuditKeys: timeoutFixture.trustedAuditKeys,
      authorizationStore: new DlcSigningAuthorizationStore(timeoutDirectory)
    });
    const timeoutAuthorization = createDlcAdaptorSignAuthorization({
      privateKey: validatorKeys.privateKey, contract, authorizationId: 'native:cet:timeout',
      signerPubkeyX, sighash, adaptorPoint
    });
    expectThrow(() => authorizeDlcAdaptorSign(timeoutProvider, {
      contract, authorization: timeoutAuthorization
    }).execute(), /native signer process failed|ETIMEDOUT/);

    const driftAuthorization = createDlcAdaptorSignAuthorization({
      privateKey: validatorKeys.privateKey,
      contract,
      authorizationId: 'native:cet:runtime-drift',
      signerPubkeyX,
      sighash,
      adaptorPoint
    });
    fs.appendFileSync(fixture.helperPath, '\n// runtime drift\n');
    const driftSession = authorizeDlcAdaptorSign(provider, { contract, authorization: driftAuthorization });
    expectThrow(() => driftSession.execute(), /runtime closure changed after audit/);

    const midflightDirectory = path.join(directory, 'midflight-drift');
    fs.mkdirSync(midflightDirectory);
    const midflightFixture = nativeSignerFixture(midflightDirectory, nativeSecret, 'midflight-signer', {
      selfMutate: true
    });
    const midflightProvider = createDlcCryptoProvider({
      network: 'bitcoin-testnet4', mode: 'native-isolated', implementation: midflightFixture.client,
      trustedAuditKeys: midflightFixture.trustedAuditKeys,
      authorizationStore: new DlcSigningAuthorizationStore(midflightDirectory)
    });
    const midflightAuthorization = createDlcAdaptorSignAuthorization({
      privateKey: validatorKeys.privateKey, contract, authorizationId: 'native:cet:midflight-drift',
      signerPubkeyX, sighash, adaptorPoint
    });
    expectThrow(() => authorizeDlcAdaptorSign(midflightProvider, {
      contract, authorization: midflightAuthorization
    }).execute(), /runtime closure changed during execution/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('concurrent signer workers permit exactly one durable authorization consumer', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-signing-race-'));
  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'dlc_signing_authorization_race.js'),
      directory,
      '16'
    ], { encoding: 'utf8', windowsHide: true });
    assert(result.status === 0, result.stderr || result.stdout || 'signing race probe failed');
    const report = JSON.parse(result.stdout);
    assert(report.passed === true && report.workers === 16 && report.consumed === 1 &&
      report.rejected === 15 && report.records === 1, 'signing race admitted multiple consumers');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
    const checkpoint = restartedStore.checkpoint({ oraclePubkey: announcement.px, eventId: announcement.eventId });
    assert(restartedStore.verifyCheckpoint(
      { oraclePubkey: announcement.px, eventId: announcement.eventId }, checkpoint
    ).checkpointVerified === checkpoint.checkpointHash, 'oracle checkpoint did not verify');
    const eventDirectoryName = fs.readdirSync(directory).find((name) => /^[0-9a-f]{64}$/.test(name));
    const eventRevisionPath = path.join(directory, eventDirectoryName, 'revision-000000000001.json');
    const eventRevisionBytes = fs.readFileSync(eventRevisionPath);
    fs.unlinkSync(eventRevisionPath);
    assert(restartedStore.verifyChain({ oraclePubkey: announcement.px, eventId: announcement.eventId }).revisions === 1,
      'oracle tail deletion probe did not shorten the chain');
    expectThrow(() => restartedStore.verifyCheckpoint(
      { oraclePubkey: announcement.px, eventId: announcement.eventId }, checkpoint
    ), /rollback detected/);
    fs.writeFileSync(eventRevisionPath, eventRevisionBytes, { flag: 'wx', mode: 0o600 });
    const eventRevisionLink = path.join(directory, 'linked-oracle-revision.json');
    fs.linkSync(eventRevisionPath, eventRevisionLink);
    expectThrow(() => restartedStore.verifyChain({ oraclePubkey: announcement.px, eventId: announcement.eventId }),
      /one bounded regular file/);
    fs.unlinkSync(eventRevisionLink);
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

// Two-party DLC funding fixture: a NUMS-keyed Taproot output whose only
// spends are the 2-of-2 CET leaf and the CSV-gated 2-of-2 refund leaf.
function twoPartyFunding({ txid, vout, valueSats, secrets = PARTY_SECRETS, refundCsvBlocks = REFUND_CSV_BLOCKS }) {
  const keys = secrets.map((secret) => ({ secret, pubkeyX: dlc.xOnlyPubkey(secret).toString('hex') }));
  const output = buildDlcFundingOutput({
    partyPubkeyXs: keys.map((key) => key.pubkeyX).sort(),
    refundCsvBlocks
  });
  return { funding: { txid, vout, valueSats, ...dlcFundingFields(output) }, output, keys };
}
// Both parties sign the committed settlement on its script path.
function signSettlement({ transactionSet, executionType, cetTxid, auxLabel, secrets = PARTY_SECRETS }) {
  const sighash = settlementSighashForTransactionSet({ transactionSet, executionType, cetTxid });
  const signatures = Object.fromEntries(secrets.map((secret, index) => [
    dlc.xOnlyPubkey(secret).toString('hex'),
    dlc.schnorrSign(secret, sighash, hash(`${auxLabel}:${index}`)).toString('hex')
  ]));
  return assembleSignedSettlement({ transactionSet, executionType, cetTxid, signatures });
}

function transactionFixture() {
  const { funding } = twoPartyFunding({ txid: 'aa'.repeat(32), vout: 1, valueSats: 100000n });
  const leftScript = `0014${'55'.repeat(20)}`;
  const rightScript = `0014${'66'.repeat(20)}`;
  const refundScript = `5120${'77'.repeat(32)}`;
  const feePolicy = {
    strategy: 'cpfp-anchor-v1',
    anchorAmountSats: 330n,
    anchorScriptPubKeyHex: `0014${'aa'.repeat(20)}`,
    maxRecoveryFeeSats: 150000n,
    maxRecoveryFeerateSatPerVb: 500,
    minRelayPeers: 2
  };
  const anchor = { valueSats: feePolicy.anchorAmountSats, scriptPubKeyHex: feePolicy.anchorScriptPubKeyHex };
  const spend = (outputs, locktime, sequence = 0xfffffffe, fundingTxid = funding.txid) => serializeUnsignedTx(
    2,
    [{ outpoint: outpoint(fundingTxid, funding.vout), sequence }],
    outputs.map((output) => ({ valueSats: output.valueSats, script: output.scriptPubKeyHex })),
    locktime
  );
  const firstOutputs = [
    { valueSats: 59000n, scriptPubKeyHex: leftScript },
    { valueSats: 40000n, scriptPubKeyHex: rightScript },
    anchor
  ];
  const secondOutputs = [
    { valueSats: 39000n, scriptPubKeyHex: leftScript },
    { valueSats: 60000n, scriptPubKeyHex: rightScript },
    anchor
  ];
  const refundOutputs = [{ valueSats: 99000n, scriptPubKeyHex: refundScript }, anchor];
  return {
    funding,
    cets: [
      {
        outcomeMessage: digest('transaction-outcome:left'),
        oraclePubkeys: ['11'.repeat(32), '22'.repeat(32)],
        rawTxHex: spend(firstOutputs, 100),
        expectedOutputs: firstOutputs,
        locktime: 100
      },
      {
        outcomeMessage: digest('transaction-outcome:right'),
        oraclePubkeys: ['11'.repeat(32), '33'.repeat(32)],
        rawTxHex: spend(secondOutputs, 100),
        expectedOutputs: secondOutputs,
        locktime: 100
      }
    ],
    refund: {
      rawTxHex: spend(refundOutputs, 200, REFUND_CSV_BLOCKS),
      expectedOutputs: refundOutputs,
      locktime: 200
    },
    feePolicy,
    spend,
    firstOutputs,
    refundOutputs
  };
}

test('transaction validator binds every CET and refund to the funding outpoint', () => {
  const fixture = transactionFixture();
  const result = validateDlcTransactionSet({
    funding: fixture.funding,
    cets: fixture.cets,
    refund: fixture.refund,
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy: fixture.feePolicy
  });
  assert(result.cets.length === 2 && result.refund.feeSats === '670', 'valid transaction set failed');
  assert(/^[0-9a-f]{64}$/.test(result.validationDigest), 'transaction validation digest is not canonical');
  let contract = initialContract('validated-transaction-contract');
  contract = transitionDlcContract(contract, requestFor(contract, 'AUTHENTICATED_ORACLES'));
  contract = transitionDlcContract(contract, requestFor(contract, 'CANONICAL_CETS_AND_REFUND', 'validated-transactions', {
    cet_set: result.cetSetDigest,
    fee_policy: result.feePolicyDigest,
    funding_template: result.fundingTemplateDigest,
    refund_transaction: result.refundTransactionDigest
  }));
  assert(contract.stage === 'CANONICAL_CETS_AND_REFUND', 'validated transaction receipts did not advance state');
  const feeReceipt = contract.history.at(-1).evidence.find((receipt) => receipt.kind === 'fee_policy');
  assert(feeReceipt && feeReceipt.digest === result.feePolicyDigest, 'signed state did not bind the recovery fee policy');
  const wrongOutpoint = {
    ...fixture.cets[0],
    rawTxHex: fixture.spend(fixture.firstOutputs, 100, 0xfffffffe, 'bb'.repeat(32))
  };
  expectThrow(() => validateDlcTransactionSet({
    funding: fixture.funding,
    cets: [wrongOutpoint, fixture.cets[1]],
    refund: fixture.refund,
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy: fixture.feePolicy
  }), /committed funding outpoint/);
  expectThrow(() => validateDlcTransactionSet({
    funding: fixture.funding,
    cets: [fixture.cets[0], { ...fixture.cets[0], outcomeMessage: digest('duplicate-cet-txid') }],
    refund: fixture.refund,
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy: fixture.feePolicy
  }), /unique transaction id/);
  const outputsWithoutAnchor = fixture.firstOutputs.slice(0, -1);
  const missingAnchor = {
    ...fixture.cets[0],
    rawTxHex: fixture.spend(outputsWithoutAnchor, 100),
    expectedOutputs: outputsWithoutAnchor
  };
  expectThrow(() => validateDlcTransactionSet({
    funding: fixture.funding,
    cets: [missingAnchor, fixture.cets[1]],
    refund: fixture.refund,
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy: fixture.feePolicy
  }), /CPFP anchor/);
  expectThrow(() => validateDlcTransactionSet({
    funding: fixture.funding,
    cets: fixture.cets,
    refund: fixture.refund,
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy: { ...fixture.feePolicy, anchorScriptPubKeyHex: '6a01ff' }
  }), /P2WPKH or P2TR/);
});

test('transaction parser rejects noncanonical counts and ineffective locktimes', () => {
  const fixture = transactionFixture();
  const valid = fixture.cets[0].rawTxHex;
  const nonCanonicalInputCount = `${valid.slice(0, 8)}fd0100${valid.slice(10)}`;
  expectThrow(() => parseCanonicalUnsignedTransaction(nonCanonicalInputCount), /non-canonical CompactSize/);
  const finalSequence = fixture.spend(fixture.firstOutputs, 100, 0xffffffff);
  expectThrow(() => parseCanonicalUnsignedTransaction(finalSequence), /locktime is disabled/);
  const truncated = valid.slice(0, -2);
  expectThrow(() => parseCanonicalUnsignedTransaction(truncated), /truncated/);
});

test('TRUC transaction sets bind version 3 and a zero-sat P2A anchor', () => {
  const { funding } = twoPartyFunding({ txid: 'bc'.repeat(32), vout: 0, valueSats: 100000n });
  const feePolicy = {
    strategy: 'truc-p2a-v1',
    anchorAmountSats: 0n,
    anchorScriptPubKeyHex: P2A_SCRIPT_PUBKEY_HEX,
    maxRecoveryFeeSats: 150000n,
    maxRecoveryFeerateSatPerVb: 500,
    minRelayPeers: 2
  };
  const anchor = { valueSats: 0n, scriptPubKeyHex: P2A_SCRIPT_PUBKEY_HEX };
  const cetOutputs = [
    { valueSats: 59000n, scriptPubKeyHex: `0014${'56'.repeat(20)}` },
    { valueSats: 40000n, scriptPubKeyHex: `0014${'67'.repeat(20)}` },
    anchor
  ];
  const refundOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `5120${'78'.repeat(32)}` }, anchor];
  const raw = (version, outputs, locktime, sequence = 0xfffffffe) => serializeUnsignedTx(
    version,
    [{ outpoint: outpoint(funding.txid, funding.vout), sequence }],
    outputs.map((output) => ({ valueSats: output.valueSats, script: output.scriptPubKeyHex })),
    locktime
  );
  const input = {
    funding,
    cets: [{
      outcomeMessage: digest('truc-transaction-outcome'),
      oraclePubkeys: ['11'.repeat(32), '22'.repeat(32)],
      rawTxHex: raw(3, cetOutputs, 100),
      expectedOutputs: cetOutputs,
      locktime: 100
    }],
    refund: {
      rawTxHex: raw(3, refundOutputs, 200, REFUND_CSV_BLOCKS),
      expectedOutputs: refundOutputs,
      locktime: 200
    },
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy
  };
  const validated = validateDlcTransactionSet(input);
  assert(validated.cets[0].version === 3 && validated.refund.version === 3, 'TRUC transaction version was not committed');
  assert(validated.feePolicy.transactionVersion === 3 && validated.feePolicy.maxRecoveryVsize === 1000 &&
    validated.feePolicy.maxUnconfirmedClusterTransactions === 2, 'TRUC policy limits were not committed');
  assert(validateDlcTransactionSetCommitments(validated), 'TRUC transaction set commitments did not verify');
  assert(Object.isFrozen(validated) && Object.isFrozen(validated.cets) &&
    Object.isFrozen(validated.cets[0]) && Object.isFrozen(validated.cets[0].outputs) &&
    Object.isFrozen(validated.cets[0].outputs[0]), 'validated transaction set was not deeply frozen');
  let transactionAccessorCalls = 0;
  const hostile = { ...validated };
  Object.defineProperty(hostile, 'funding', {
    enumerable: true,
    get() { transactionAccessorCalls++; return validated.funding; }
  });
  expectThrow(() => validateDlcTransactionSetCommitments(hostile), /enumerable data property/);
  assert(transactionAccessorCalls === 0, 'transaction-set accessor executed before rejection');
  let constructionAccessorCalls = 0;
  const hostileFunding = { ...funding };
  Object.defineProperty(hostileFunding, 'vout', {
    enumerable: true,
    get() { constructionAccessorCalls++; return funding.vout; }
  });
  expectThrow(() => validateDlcTransactionSet({ ...input, funding: hostileFunding }), /enumerable data property/);
  assert(constructionAccessorCalls === 0, 'transaction construction accessor executed before rejection');
  let constructionProxyTraps = 0;
  const constructionProxy = new Proxy(input, {
    getPrototypeOf(target) { constructionProxyTraps++; return Reflect.getPrototypeOf(target); },
    ownKeys(target) { constructionProxyTraps++; return Reflect.ownKeys(target); }
  });
  expectThrow(() => validateDlcTransactionSet(constructionProxy), /Proxy object/);
  assert(constructionProxyTraps === 0, 'transaction construction Proxy trap executed before rejection');

  expectThrow(() => validateDlcTransactionSet({
    ...input,
    cets: [{ ...input.cets[0], rawTxHex: raw(2, cetOutputs, 100) }]
  }), /version must be 3/);
  expectThrow(() => validateDlcTransactionSet({
    ...input,
    feePolicy: { ...feePolicy, anchorAmountSats: 1n }
  }), /zero-sat P2A anchor/);
  expectThrow(() => validateDlcTransactionSet({
    ...input,
    feePolicy: {
      ...feePolicy,
      strategy: 'cpfp-anchor-v1',
      anchorAmountSats: 330n,
      anchorScriptPubKeyHex: `0014${'aa'.repeat(20)}`
    }
  }), /version must be 2/);
  const tampered = JSON.parse(JSON.stringify(validated));
  tampered.feePolicy.maxRecoveryVsize = 999;
  expectThrow(() => validateDlcTransactionSetCommitments(tampered), /commitment mismatch/);
});

test('CET adaptor and refund signatures bind to validated BIP341 sighashes', () => {
  const { funding, output: fundingOutput, keys } = twoPartyFunding({ txid: '99'.repeat(32), vout: 0, valueSats: 100000n });
  const signerSecret = keys[0].secret;
  const signerPubkey = keys[0].pubkeyX;
  const counterpartySecret = keys[1].secret;
  const counterpartyPubkey = keys[1].pubkeyX;
  const thresholdSets = buildThresholdOutcomeSets({ announcements, threshold: 2, pinnedPubkeys, outcomeMsg32: outcome });
  const selected = thresholdSets[0];
  const cetOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `0014${'88'.repeat(20)}` }];
  const feePolicy = {
    strategy: 'cpfp-anchor-v1',
    anchorAmountSats: 330n,
    anchorScriptPubKeyHex: `0014${'aa'.repeat(20)}`,
    maxRecoveryFeeSats: 150000n,
    maxRecoveryFeerateSatPerVb: 500,
    minRelayPeers: 2
  };
  const anchor = { valueSats: feePolicy.anchorAmountSats, scriptPubKeyHex: feePolicy.anchorScriptPubKeyHex };
  cetOutputs.push(anchor);
  const refundOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `5120${'77'.repeat(32)}` }, anchor];
  const raw = (outputs, locktime, sequence = 0xfffffffe) => serializeUnsignedTx(
    2,
    [{ outpoint: outpoint(funding.txid, funding.vout), sequence }],
    outputs.map((item) => ({ valueSats: item.valueSats, script: item.scriptPubKeyHex })),
    locktime
  );
  const validated = validateDlcTransactionSet({
    funding,
    cets: [{
      outcomeMessage: outcome.toString('hex'),
      oraclePubkeys: selected.oraclePubkeys,
      rawTxHex: raw(cetOutputs, 100),
      expectedOutputs: cetOutputs,
      locktime: 100
    }],
    refund: {
      rawTxHex: raw(refundOutputs, 200, REFUND_CSV_BLOCKS), expectedOutputs: refundOutputs, locktime: 200
    },
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy
  });
  const cet = validated.cets[0];
  const thresholdOutcomeSets = [{
    outcomeMessage: outcome.toString('hex'),
    oraclePubkeys: selected.oraclePubkeys,
    outcomePoint: selected.outcomePoint
  }];
  // Both parties sign the BIP341 script-path sighash of the CET leaf.
  const cetSighash = settlementSighashForTransactionSet({
    transactionSet: validated, executionType: 'cet', cetTxid: cet.txid
  });
  const keyPathCetSighash = bip341SighashDefault(
    toBip341Transaction(parseCanonicalUnsignedTransaction(cet.rawTxHex)),
    [{ amountSats: funding.valueSats, scriptPubKey: funding.scriptPubKeyHex }],
    0
  );
  assert(!cetSighash.equals(keyPathCetSighash), 'CET sighash is not a script-path sighash');
  const adaptorArgs = (secret, pubkey, presignature) => ({
    transactionSet: validated,
    funding,
    signerPubkeyX: pubkey,
    signatures: [{ identity: cetIdentity(cet), signerPubkeyX: pubkey, presignature }],
    thresholdOutcomeSets
  });
  const presignature = dlc.adaptorSign(signerSecret, cetSighash, selected.outcomePoint, hash('signature-validator:aux'));
  const validatedSignatures = validateCetAdaptorSignatures(adaptorArgs(signerSecret, signerPubkey, presignature));
  assert(/^[0-9a-f]{64}$/.test(validatedSignatures.digest), 'CET signature digest missing');
  const counterpartyPresignature = dlc.adaptorSign(
    counterpartySecret, cetSighash, selected.outcomePoint, hash('signature-validator:counterparty-aux')
  );
  assert(/^[0-9a-f]{64}$/.test(validateCetAdaptorSignatures(
    adaptorArgs(counterpartySecret, counterpartyPubkey, counterpartyPresignature)
  ).digest), 'counterparty CET signature digest missing');
  const refundSighash = settlementSighashForTransactionSet({ transactionSet: validated, executionType: 'refund' });
  const refundSignature = dlc.schnorrSign(signerSecret, refundSighash, hash('refund-signature:aux'));
  const validatedRefund = validateRefundSignature({
    transactionSet: validated,
    funding,
    signerPubkeyX: signerPubkey,
    signature: refundSignature
  });
  assert(/^[0-9a-f]{64}$/.test(validatedRefund.digest), 'refund signature digest missing');
  const forged = {
    ...presignature,
    s0: `${presignature.s0.slice(0, -1)}${presignature.s0.endsWith('0') ? '1' : '0'}`
  };
  expectThrow(() => validateCetAdaptorSignatures(adaptorArgs(signerSecret, signerPubkey, forged)), /invalid/);

  // MAIN-1: a signature over the key-path sighash is not a settlement signature.
  expectThrow(() => validateCetAdaptorSignatures(adaptorArgs(signerSecret, signerPubkey,
    dlc.adaptorSign(signerSecret, keyPathCetSighash, selected.outcomePoint, hash('signature-validator:keypath-aux'))
  )), /adaptor signature is invalid/);
  // MAIN-1: only the two committed parties can sign; a third key is refused
  // even when its signature is valid for that key.
  const outsiderSecret = 555555555n;
  const outsiderPubkey = dlc.xOnlyPubkey(outsiderSecret).toString('hex');
  expectThrow(() => validateCetAdaptorSignatures(adaptorArgs(outsiderSecret, outsiderPubkey,
    dlc.adaptorSign(outsiderSecret, cetSighash, selected.outcomePoint, hash('signature-validator:outsider-aux'))
  )), /not a party to the two-party DLC funding output/);
  expectThrow(() => validateRefundSignature({
    transactionSet: validated,
    funding,
    signerPubkeyX: outsiderPubkey,
    signature: dlc.schnorrSign(outsiderSecret, refundSighash, hash('refund-signature:outsider-aux'))
  }), /not a party to the two-party DLC funding output/);
  // The funding handed to the validator must be the committed funding.
  expectThrow(() => validateRefundSignature({
    transactionSet: validated,
    funding: { ...funding, scriptPubKeyHex: `5120${signerPubkey}` },
    signerPubkeyX: signerPubkey,
    signature: refundSignature
  }), /does not match the validated DLC transaction set/);
  expectThrow(() => validateRefundSignature({
    transactionSet: validated,
    funding: { ...funding, valueSats: funding.valueSats + 1n },
    signerPubkeyX: signerPubkey,
    signature: refundSignature
  }), /does not match the validated DLC transaction set/);

  // Both signatures together form a witness the script accepts; either alone does not.
  const signedRefundTxHex = assembleSignedSettlement({
    transactionSet: validated,
    executionType: 'refund',
    signatures: {
      [signerPubkey]: refundSignature.toString('hex'),
      [counterpartyPubkey]: dlc.schnorrSign(counterpartySecret, refundSighash, hash('refund-signature:counterparty-aux')).toString('hex')
    }
  });
  const parsedRefund = verifySettlementWitness({
    transactionSet: validated, executionType: 'refund', signedTxHex: signedRefundTxHex
  });
  assert(parsedRefund.witness[0][2] === fundingOutput.refundLeaf.scriptHex &&
    parsedRefund.witness[0][3] === fundingOutput.refundLeaf.controlBlock, 'refund witness does not reveal the CSV refund leaf');
  expectThrow(() => assembleSignedSettlement({
    transactionSet: validated,
    executionType: 'refund',
    signatures: { [signerPubkey]: refundSignature.toString('hex'), [counterpartyPubkey]: refundSignature.toString('hex') }
  }), /valid signature from both parties/);
  expectThrow(() => assembleSignedSettlement({
    transactionSet: validated,
    executionType: 'refund',
    signatures: { [signerPubkey]: refundSignature.toString('hex') }
  }), /signature is required for party/);
});

test('DLC funding output is a NUMS-keyed two-party Taproot output with CET and CSV refund leaves', () => {
  const { funding, output, keys } = twoPartyFunding({ txid: '9a'.repeat(32), vout: 0, valueSats: 100000n });
  const [first, second] = output.partyPubkeyXs;
  assert(output.internalXonly === deriveDlcFundingInternalXonly(), 'funding internal key is not the derived NUMS key');
  assert(output.cetLeaf.scriptHex === `20${first}ad20${second}ac`, 'CET leaf is not A CHECKSIGVERIFY B CHECKSIG');
  assert(output.refundLeaf.scriptHex === `029000b27520${first}ad20${second}ac`,
    'refund leaf is not <144> CSV DROP A CHECKSIGVERIFY B CHECKSIG');
  assert(output.cetLeaf.controlBlock.slice(2, 66) === output.internalXonly &&
    output.refundLeaf.controlBlock.slice(2, 66) === output.internalXonly, 'control blocks do not reveal the NUMS internal key');
  // Neither party's key, nor their sum, is the output key: there is no key path.
  assert(!keys.some((key) => funding.scriptPubKeyHex === `5120${key.pubkeyX}`), 'funding output is a single party key');
  assert(funding.scriptPubKeyHex === `5120${output.outputKeyXonly}`, 'funding script is not the tweaked NUMS output');
  // DLC-6 (port of the readiness-assessment poc5): when the internal key was a
  // key one party knew, that party signed on the key path with d + tweak and
  // skipped the CSV 2-of-2. Here no party key, used as the internal key over
  // the same script tree, reproduces the output key, so no party holds a
  // key-path secret; and the refund leaf sits on the same output as the CETs.
  const merkleRoot = Buffer.from(output.merkleRoot, 'hex');
  for (const key of keys) {
    const keyPathOutput = taprootScript.taprootTweakWithRoot(Buffer.from(key.pubkeyX, 'hex'), merkleRoot);
    assert(keyPathOutput.xonly.toString('hex') !== output.outputKeyXonly, 'a party key is the funding internal key');
    const tweakedSecret = dlc.mod(key.secret + keyPathOutput.tweak, dlc.N);
    assert(dlc.xOnlyPubkey(tweakedSecret).toString('hex') !== output.outputKeyXonly,
      'a party can derive the funding output key-path secret');
  }
  assert(taprootScript.taprootTweakWithRoot(Buffer.from(output.internalXonly, 'hex'), merkleRoot)
    .xonly.toString('hex') === output.outputKeyXonly, 'output key is not the NUMS key tweaked by the two-leaf tree');
  assert(taprootScript.tapBranchHash(Buffer.from(output.cetLeaf.leafHash, 'hex'), Buffer.from(output.refundLeaf.leafHash, 'hex'))
    .toString('hex') === output.merkleRoot, 'CET and refund leaves are not the two leaves of the funding output');
  // The output is a function of the key set and delay only.
  const again = buildDlcFundingOutput({ partyPubkeyXs: [first, second], refundCsvBlocks: REFUND_CSV_BLOCKS });
  assert(again.scriptPubKeyHex === output.scriptPubKeyHex, 'funding output derivation is not deterministic');
  assert(buildDlcFundingOutput({ partyPubkeyXs: [first, second], refundCsvBlocks: 145 }).scriptPubKeyHex !== output.scriptPubKeyHex,
    'refund delay is not committed by the funding output');
  // DLC-6: a caller-chosen internal key would restore a key path.
  expectThrow(() => buildDlcFundingOutput({
    partyPubkeyXs: [first, second], refundCsvBlocks: REFUND_CSV_BLOCKS, internalXonly: first
  }), /custom internal key is forbidden/);
  expectThrow(() => buildDlcFundingOutput({ partyPubkeyXs: [second, first], refundCsvBlocks: REFUND_CSV_BLOCKS }), /sorted/);
  expectThrow(() => buildDlcFundingOutput({ partyPubkeyXs: [first, first], refundCsvBlocks: REFUND_CSV_BLOCKS }), /distinct/);
  expectThrow(() => buildDlcFundingOutput({ partyPubkeyXs: [first], refundCsvBlocks: REFUND_CSV_BLOCKS }), /exactly two/);
  expectThrow(() => buildDlcFundingOutput({ partyPubkeyXs: [first, second], refundCsvBlocks: 0 }), /refundCsvBlocks/);

  // MAIN-1: the transaction validator refuses any funding script that is not
  // this output, including the single-key P2TR shape the previous validator accepted.
  const fixture = transactionFixture();
  const build = (fundingOverride, refundOverride = fixture.refund) => validateDlcTransactionSet({
    funding: fundingOverride,
    cets: fixture.cets,
    refund: refundOverride,
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy: fixture.feePolicy
  });
  expectThrow(() => build({ ...fixture.funding, scriptPubKeyHex: `5120${keys[0].pubkeyX}` }),
    /not the two-party DLC output/);
  expectThrow(() => build({
    txid: fixture.funding.txid, vout: fixture.funding.vout, valueSats: fixture.funding.valueSats,
    scriptPubKeyHex: `5120${keys[0].pubkeyX}`
  }), /partyPubkeyXs must contain exactly two/);
  expectThrow(() => build({ ...fixture.funding, refundCsvBlocks: REFUND_CSV_BLOCKS + 1 }), /not the two-party DLC output/);
  // The refund must be able to satisfy the CSV leaf it spends.
  expectThrow(() => build(fixture.funding, {
    ...fixture.refund, rawTxHex: fixture.spend(fixture.refundOutputs, 200, 0xfffffffe)
  }), /refund input sequence must equal the committed refund CSV delay/);
  const validated = build(fixture.funding);
  assert(validated.funding.partyPubkeyXs.join(':') === fixture.funding.partyPubkeyXs.join(':') &&
    validated.funding.refundCsvBlocks === REFUND_CSV_BLOCKS &&
    validated.funding.cetLeafHash === dlcFundingOutputForTransactionSet(validated).cetLeaf.leafHash,
  'validated set does not commit the party keys, refund delay and leaf hashes');
  // A re-digested set that swaps the funding script for a single key is rejected.
  const swapped = JSON.parse(JSON.stringify(validated));
  swapped.funding.scriptPubKeyHex = `5120${keys[0].pubkeyX}`;
  const sha = (value) => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
  swapped.fundingTemplateDigest = sha(swapped.funding);
  swapped.validationDigest = sha({
    fundingTemplateDigest: swapped.fundingTemplateDigest,
    cetSetDigest: swapped.cetSetDigest,
    refundTransactionDigest: swapped.refundTransactionDigest,
    feePolicyDigest: swapped.feePolicyDigest
  });
  expectThrow(() => validateDlcTransactionSetCommitments(swapped), /not the two-party DLC output/);
});

test('fully signed refund is append-once, witness-verified, and restorable before funding', () => {
  const { funding, keys } = twoPartyFunding({ txid: 'ab'.repeat(32), vout: 1, valueSats: 100000n });
  const feePolicy = {
    strategy: 'cpfp-anchor-v1',
    anchorAmountSats: 330n,
    anchorScriptPubKeyHex: `0014${'ac'.repeat(20)}`,
    maxRecoveryFeeSats: 150000n,
    maxRecoveryFeerateSatPerVb: 500,
    minRelayPeers: 2
  };
  const anchor = { valueSats: 330n, scriptPubKeyHex: feePolicy.anchorScriptPubKeyHex };
  const raw = (outputs, locktime, sequence = 0xfffffffe) => serializeUnsignedTx(
    2,
    [{ outpoint: outpoint(funding.txid, funding.vout), sequence }],
    outputs.map((item) => ({ valueSats: item.valueSats, script: item.scriptPubKeyHex })),
    locktime
  );
  const cetOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `0014${'ad'.repeat(20)}` }, anchor];
  const refundOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `5120${'ae'.repeat(32)}` }, anchor];
  const transactionSet = validateDlcTransactionSet({
    funding,
    cets: [{
      outcomeMessage: digest('refund-recovery-outcome'),
      oraclePubkeys: ['11'.repeat(32), '22'.repeat(32)],
      rawTxHex: raw(cetOutputs, 100),
      expectedOutputs: cetOutputs,
      locktime: 100
    }],
    refund: {
      rawTxHex: raw(refundOutputs, 200, REFUND_CSV_BLOCKS), expectedOutputs: refundOutputs, locktime: 200
    },
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy
  });
  let contract = initialContract('refund-recovery-contract');
  contract = transitionDlcContract(contract, requestFor(contract, 'AUTHENTICATED_ORACLES', 'refund-recovery:oracles'));
  contract = transitionDlcContract(contract, requestFor(contract, 'CANONICAL_CETS_AND_REFUND', 'refund-recovery:transactions', {
    cet_set: transactionSet.cetSetDigest,
    fee_policy: transactionSet.feePolicyDigest,
    funding_template: transactionSet.fundingTemplateDigest,
    refund_transaction: transactionSet.refundTransactionDigest
  }));
  contract = transitionDlcContract(contract, requestFor(
    contract, 'COUNTERPARTY_SIGNATURES_VERIFIED', 'refund-recovery:counterparty'
  ));
  const unsigned = transactionSet.refund.rawTxHex;
  const signedRefund = (auxiliary) => signSettlement({ transactionSet, executionType: 'refund', auxLabel: auxiliary });
  const signedRefundTxHex = signedRefund('refund-recovery:aux');
  const parsed = parseCanonicalSignedTaprootTransaction(signedRefundTxHex);
  assert(parsed.strippedRawTxHex === unsigned && parsed.txid === transactionSet.refund.txid,
    'signed refund did not preserve the committed transaction identity');
  // MAIN-1 / DLC-6: the previous single-signature key-path witness is not a refund.
  const refundKeyPathSighash = bip341SighashDefault(
    toBip341Transaction(parseCanonicalUnsignedTransaction(unsigned)),
    [{ amountSats: funding.valueSats, scriptPubKey: funding.scriptPubKeyHex }],
    0
  );
  const keyPathSignature = dlc.schnorrSign(keys[0].secret, refundKeyPathSighash, hash('refund-recovery:keypath')).toString('hex');
  const keyPathRefund = `${unsigned.slice(0, 8)}0001${unsigned.slice(8, -8)}0140${keyPathSignature}${unsigned.slice(-8)}`;
  expectThrow(() => parseCanonicalSignedTaprootTransaction(keyPathRefund), /two-signature Taproot script-path witness/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-refund-recovery-'));
  try {
    const store = new DlcRefundRecoveryStore(directory);
    const stored = store.store({ contractState: contract, transactionSet, signedRefundTxHex });
    const restored = new DlcRefundRecoveryStore(directory).restore({ contractState: contract, transactionSet });
    assert(stored.recordHash === restored.restoreDigest && restored.refundWtxid === parsed.wtxid,
      'refund did not survive independent restore');
    assert(store.store({ contractState: contract, transactionSet, signedRefundTxHex }).recordHash === stored.recordHash,
      'identical refund retry was not idempotent');
    // Corrupting either party's signature makes the refund unstorable.
    for (const witnessIndex of [0, 1]) {
      const original = parsed.witness[0][witnessIndex];
      const forgedSignature = Buffer.from(original, 'hex');
      forgedSignature[63] ^= 1;
      const forged = signedRefundTxHex.replace(original, forgedSignature.toString('hex'));
      assert(forged !== signedRefundTxHex, 'forged refund fixture did not change the witness');
      expectThrow(() => store.store({ contractState: contract, transactionSet, signedRefundTxHex: forged }), /witness is invalid/);
    }
    expectThrow(() => store.store({ contractState: contract, transactionSet, signedRefundTxHex: keyPathRefund }),
      /two-signature Taproot script-path witness/);
    // A refund witness that reveals the CET leaf skips the CSV delay and is refused.
    const fundingOutput = dlcFundingOutputForTransactionSet(transactionSet);
    const wrongLeaf = signedRefundTxHex
      .replace(`${(fundingOutput.refundLeaf.scriptHex.length / 2).toString(16)}${fundingOutput.refundLeaf.scriptHex}`,
        `${(fundingOutput.cetLeaf.scriptHex.length / 2).toString(16)}${fundingOutput.cetLeaf.scriptHex}`)
      .replace(fundingOutput.refundLeaf.controlBlock, fundingOutput.cetLeaf.controlBlock);
    assert(wrongLeaf !== signedRefundTxHex, 'wrong-leaf refund fixture did not change the witness');
    expectThrow(() => store.store({ contractState: contract, transactionSet, signedRefundTxHex: wrongLeaf }),
      /does not spend the committed refund leaf/);
    const fixturePath = path.join(directory, 'race-fixture.json');
    fs.writeFileSync(fixturePath, JSON.stringify({
      contractState: contract,
      transactionSet,
      signedRefunds: Array.from({ length: 16 }, (_, index) => signedRefund(`refund-recovery:race:${index}`))
    }));
    const race = spawnSync(process.execPath, [
      path.join(__dirname, 'dlc_refund_recovery_race.js'),
      path.join(directory, 'race-store'),
      fixturePath,
      '16'
    ], { encoding: 'utf8', windowsHide: true });
    assert(race.status === 0, race.stderr || race.stdout || 'refund recovery race failed');
    const raceReport = JSON.parse(race.stdout);
    assert(raceReport.passed === true && raceReport.stored === 1 && raceReport.rejected === 15 && raceReport.records === 1,
      'refund recovery race did not select exactly one signed artifact');
    contract = transitionDlcContract(contract, requestFor(
      contract, 'LOCAL_SIGNATURES_PERSISTED', 'refund-recovery:local', { refund_restore_test: restored.restoreDigest }
    ));
    assert(new DlcRefundRecoveryStore(directory).restore({ contractState: contract, transactionSet }).restoreDigest === stored.recordHash,
      'refund could not be restored after the contract advanced');
    expectThrow(() => store.store({ contractState: contract, transactionSet, signedRefundTxHex }), /before local signatures/);
    const recordPath = path.join(directory, refundRecoveryKey(contract.contractId), 'refund.json');
    const originalRecordBytes = fs.readFileSync(recordPath);
    const checkpoint = store.checkpoint(contract.contractId);
    assert(store.verifyCheckpoint(contract.contractId, checkpoint).checkpointVerified === checkpoint.checkpointHash,
      'refund recovery checkpoint did not verify');
    fs.unlinkSync(recordPath);
    expectThrow(() => store.verifyCheckpoint(contract.contractId, checkpoint), /incomplete persistence marker/);
    fs.writeFileSync(recordPath, originalRecordBytes, { flag: 'wx', mode: 0o600 });
    const replacement = JSON.parse(originalRecordBytes.toString('utf8'));
    replacement.storedAt = new Date(Date.parse(replacement.storedAt) + 1).toISOString();
    replacement.recordHash = refundRecoveryRecordHash(replacement);
    fs.writeFileSync(recordPath, `${JSON.stringify(replacement, null, 2)}\n`);
    expectThrow(() => store.restore({ contractState: contract, transactionSet }), /restore receipt digest/);
    fs.writeFileSync(recordPath, originalRecordBytes);
    const linkedPath = path.join(directory, 'linked-refund.json');
    fs.linkSync(recordPath, linkedPath);
    expectThrow(() => store.restore({ contractState: contract, transactionSet }), /one bounded regular file/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function validatedChainFixture(contractId, targetStage) {
  const fixture = transactionFixture();
  const transactionSet = validateDlcTransactionSet({
    funding: fixture.funding,
    cets: fixture.cets,
    refund: fixture.refund,
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy: fixture.feePolicy
  });
  let contract = initialContract(contractId);
  contract = transitionDlcContract(contract, requestFor(contract, 'AUTHENTICATED_ORACLES', `${contractId}:oracles`));
  contract = transitionDlcContract(contract, requestFor(contract, 'CANONICAL_CETS_AND_REFUND', `${contractId}:transactions`, {
    cet_set: transactionSet.cetSetDigest,
    fee_policy: transactionSet.feePolicyDigest,
    funding_template: transactionSet.fundingTemplateDigest,
    refund_transaction: transactionSet.refundTransactionDigest
  }));
  const remaining = [
    'COUNTERPARTY_SIGNATURES_VERIFIED',
    'LOCAL_SIGNATURES_PERSISTED',
    'FUNDING_PSBT_APPROVED',
    'FUNDING_BROADCAST',
    'CONFIRMED'
  ];
  for (const stage of remaining) {
    if (contract.stage === targetStage) break;
    contract = transitionDlcContract(contract, requestFor(contract, stage, `${contractId}:${stage}`));
  }
  return { contract, transactionSet };
}

test('CET and refund execution require fresh Core policy for the committed signed transaction', () => {
  const signed = (transactionSet, executionType, transaction, label) => signSettlement({
    transactionSet,
    executionType,
    ...(executionType === 'cet' ? { cetTxid: transaction.txid } : {}),
    auxLabel: label
  });
  const runGuard = ({ contract, transactionSet, executionType, transaction, evidenceDigest, height = 250 }) => {
    const signedTxHex = signed(transactionSet, executionType, transaction, `execution:${executionType}`);
    const parsed = parseCanonicalSignedTaprootTransaction(signedTxHex);
    const bestBlockHash = digest(`execution:${executionType}:block`);
    const methods = [];
    const rpc = (method) => {
      methods.push(method);
      if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: height, bestblockhash: bestBlockHash };
      if (method === 'getrawmempool') return { mempool_sequence: 61 };
      if (method === 'decoderawtransaction') {
        const strippedSize = parsed.strippedRawTxHex.length / 2;
        const totalSize = signedTxHex.length / 2;
        const weight = strippedSize * 4 + totalSize - strippedSize;
        return {
          txid: parsed.txid, hash: parsed.wtxid, version: parsed.version,
          size: totalSize, vsize: Math.ceil(weight / 4), weight,
          locktime: parsed.locktime
        };
      }
      if (method === 'testmempoolaccept') return [{ txid: parsed.txid, wtxid: parsed.wtxid, allowed: true }];
      throw new Error(`unexpected execution RPC ${method}`);
    };
    const checked = validateExecutionPrebroadcastPolicy({
      contractState: contract,
      transactionSet,
      executionType,
      ...(executionType === 'cet' ? { cetTxid: transaction.txid } : {}),
      signedTxHex,
      executionEvidenceDigest: evidenceDigest,
      rpc
    });
    assert(methods.every((method) => method !== 'sendrawtransaction'), 'execution guard attempted broadcast');
    return { checked, signedTxHex, rpc };
  };

  const cetFixture = validatedChainFixture('cet-prebroadcast-contract', 'CONFIRMED');
  const cet = cetFixture.transactionSet.cets[0];
  const oracleDigest = digest('cet-prebroadcast:oracle-attestation');
  const cetResult = runGuard({
    ...cetFixture, executionType: 'cet', transaction: cet, evidenceDigest: oracleDigest
  });
  expectThrow(() => transitionDlcContract(cetFixture.contract, requestFor(
    cetFixture.contract, 'CET_EXECUTED', 'cet-prebroadcast:substitution', {
      cet_broadcast_transaction: digest('different-cet-bytes'),
      oracle_threshold_attestation: oracleDigest,
      cet_prebroadcast_bitcoin_core_policy: {
        digest: cetResult.checked.policyDigest,
        metadata: cetResult.checked.receiptMetadata
      }
    }
  )), /does not bind the broadcast transaction digest/);
  const cetRequest = requestFor(
    cetFixture.contract, 'CET_EXECUTED', 'cet-prebroadcast:execute', {
      cet_broadcast_transaction: cetResult.checked.record.rawTransactionSha256,
      oracle_threshold_attestation: oracleDigest,
      cet_prebroadcast_bitcoin_core_policy: {
        digest: cetResult.checked.policyDigest,
        metadata: cetResult.checked.receiptMetadata
      }
    }
  );
  const cetExecuted = transitionDlcContract(cetFixture.contract, cetRequest);
  assert(cetExecuted.stage === 'CET_EXECUTED', 'CET execution policy did not authorize its exact transaction');
  const cetGuardInput = {
    contractState: cetFixture.contract,
    transactionSet: cetFixture.transactionSet,
    executionType: 'cet',
    cetTxid: cet.txid,
    signedTxHex: cetResult.signedTxHex,
    executionEvidenceDigest: oracleDigest
  };
  expectThrow(() => validateExecutionPrebroadcastPolicy({
    ...cetGuardInput,
    rpc(method, params) {
      if (method === 'testmempoolaccept') {
        const parsed = parseCanonicalSignedTaprootTransaction(cetResult.signedTxHex);
        return [{ txid: parsed.txid, wtxid: parsed.wtxid, allowed: false, 'reject-reason': 'script failure' }];
      }
      return cetResult.rpc(method, params);
    }
  }), /rejected.*script failure/);
  expectThrow(() => validateExecutionPrebroadcastPolicy({
    ...cetGuardInput,
    rpc(method, params) {
      const result = cetResult.rpc(method, params);
      return method === 'decoderawtransaction' ? { ...result, size: result.size + 1 } : result;
    }
  }), /size, weight, and vsize are inconsistent/);
  let executionMempoolReads = 0;
  expectThrow(() => validateExecutionPrebroadcastPolicy({
    ...cetGuardInput,
    maxAttempts: 1,
    rpc(method, params) {
      if (method === 'getrawmempool') return { mempool_sequence: ++executionMempoolReads };
      return cetResult.rpc(method, params);
    }
  }), /tip or mempool changed/);
  expectThrow(() => validateExecutionPrebroadcastPolicy({
    ...cetGuardInput,
    signedTxHex: signed(cetFixture.transactionSet, 'cet', cetFixture.transactionSet.cets[1], 'execution:wrong-cet'),
    rpc: cetResult.rpc
  }), /differs from the committed settlement transaction/);
  // MAIN-1: Core is never consulted for a settlement that lacks a valid
  // signature from both parties over the committed leaf.
  const parsedCet = parseCanonicalSignedTaprootTransaction(cetResult.signedTxHex);
  for (const witnessIndex of [0, 1]) {
    let coreCalls = 0;
    expectThrow(() => validateExecutionPrebroadcastPolicy({
      ...cetGuardInput,
      signedTxHex: cetResult.signedTxHex.replace(parsedCet.witness[0][witnessIndex], digest(`garbage:${witnessIndex}`).repeat(2)),
      rpc(method, params) { coreCalls++; return cetResult.rpc(method, params); }
    }), /witness is invalid.*valid signature from both parties/);
    assert(coreCalls === 0, 'execution guard consulted Core for an unsigned settlement');
  }

  const refundFixture = validatedChainFixture('refund-prebroadcast-contract', 'CONFIRMED');
  const maturityDigest = digest('refund-prebroadcast:maturity');
  const refundResult = runGuard({
    ...refundFixture,
    executionType: 'refund',
    transaction: refundFixture.transactionSet.refund,
    evidenceDigest: maturityDigest,
    height: refundFixture.transactionSet.refund.locktime
  });
  const refundRequest = requestFor(
    refundFixture.contract, 'REFUND_EXECUTED', 'refund-prebroadcast:execute', {
      refund_broadcast_transaction: refundResult.checked.record.rawTransactionSha256,
      refund_maturity: maturityDigest,
      refund_prebroadcast_bitcoin_core_policy: {
        digest: refundResult.checked.policyDigest,
        metadata: refundResult.checked.receiptMetadata
      }
    }
  );
  const refundExecuted = transitionDlcContract(refundFixture.contract, refundRequest);
  assert(refundExecuted.stage === 'REFUND_EXECUTED', 'refund policy did not authorize its exact mature transaction');
  const executionAuthorizationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-execution-authorization-'));
  try {
    const store = new DlcBroadcastAuthorizationStore(executionAuthorizationDirectory);
    const consumedCet = store.consume({
      contractState: cetFixture.contract,
      transitionRequest: cetRequest,
      rawTxHex: cetResult.signedTxHex
    });
    const consumedRefund = store.consume({
      contractState: refundFixture.contract,
      transitionRequest: refundRequest,
      rawTxHex: refundResult.signedTxHex
    });
    assert(consumedCet.consumption.toStage === 'CET_EXECUTED' &&
      consumedRefund.consumption.toStage === 'REFUND_EXECUTED' && store.verifyAll().records === 2,
    'durable broadcast store did not cover both execution paths');
  } finally {
    fs.rmSync(executionAuthorizationDirectory, { recursive: true, force: true });
  }
  expectThrow(() => runGuard({
    ...refundFixture,
    executionType: 'refund',
    transaction: refundFixture.transactionSet.refund,
    evidenceDigest: maturityDigest,
    height: refundFixture.transactionSet.refund.locktime - 1
  }), /refund is immature/);
});

function chainSnapshot(transactionSet, overrides = {}) {
  return {
    height: 205,
    bestBlockHash: digest('chain:block:205'),
    fundingOutpoint: `${transactionSet.funding.txid}:${transactionSet.funding.vout}`,
    fundingPresent: true,
    fundingConfirmations: 6,
    observedSpend: null,
    ...overrides
  };
}

test('chain guard binds snapshots to signed transactions and halts on reorgs or unknown spends', () => {
  const { contract, transactionSet } = validatedChainFixture('chain-guard-confirmed', 'CONFIRMED');
  const confirmed = evaluateDlcChainSnapshot({ contractState: contract, transactionSet, current: chainSnapshot(transactionSet) });
  assert(confirmed.ok && confirmed.status === 'FUNDING_CONFIRMED', 'confirmed funding was not accepted');

  const previous = chainSnapshot(transactionSet);
  const disconnected = chainSnapshot(transactionSet, {
    height: 206,
    bestBlockHash: digest('chain:block:206-reorg'),
    ancestorHashAtPreviousHeight: digest('chain:foreign-ancestor'),
    fundingConfirmations: 7
  });
  const reorg = evaluateDlcChainSnapshot({ contractState: contract, transactionSet, current: disconnected, previous });
  assert(!reorg.ok && reorg.status === 'REORG_HALT', 'disconnected chain ancestry did not halt');

  const unknown = chainSnapshot(transactionSet, {
    fundingPresent: false,
    fundingConfirmations: 0,
    observedSpend: { txid: 'ff'.repeat(32), height: 205 }
  });
  const unknownResult = evaluateDlcChainSnapshot({ contractState: contract, transactionSet, current: unknown });
  assert(!unknownResult.ok && unknownResult.status === 'UNKNOWN_SPEND_HALT', 'unknown funding spend did not halt');
  const alternateSet = validateDlcTransactionSet({
    funding: transactionFixture().funding,
    cets: transactionFixture().cets.map((cet, index) => index === 0
      ? { ...cet, outcomeMessage: digest('alternate-chain-outcome') }
      : cet),
    refund: transactionFixture().refund,
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy: transactionFixture().feePolicy
  });
  expectThrow(() => evaluateDlcChainSnapshot({
    contractState: contract,
    transactionSet: alternateSet,
    current: chainSnapshot(alternateSet)
  }), /signed contract validation receipts/);
  expectThrow(() => evaluateDlcChainSnapshot({
    contractState: contract,
    transactionSet: { ...transactionSet, funding: { ...transactionSet.funding, vout: 3 } },
    current: chainSnapshot(transactionSet)
  }), /commitment mismatch/);
});

test('chain guard accepts only stage-consistent CETs and mature refunds', () => {
  const confirmedFixture = validatedChainFixture('chain-spend-confirmed', 'CONFIRMED');
  const cetSpend = chainSnapshot(confirmedFixture.transactionSet, {
    fundingPresent: false,
    fundingConfirmations: 0,
    observedSpend: { txid: confirmedFixture.transactionSet.cets[0].txid, height: 205 }
  });
  const cet = evaluateDlcChainSnapshot({
    contractState: confirmedFixture.contract,
    transactionSet: confirmedFixture.transactionSet,
    current: cetSpend
  });
  assert(cet.ok && cet.status === 'CET_OBSERVED', 'confirmed CET was not recognized');

  const earlyFixture = validatedChainFixture('chain-spend-early', 'CANONICAL_CETS_AND_REFUND');
  const earlyCet = evaluateDlcChainSnapshot({
    contractState: earlyFixture.contract,
    transactionSet: earlyFixture.transactionSet,
    current: chainSnapshot(earlyFixture.transactionSet, {
      fundingPresent: false,
      fundingConfirmations: 0,
      observedSpend: { txid: earlyFixture.transactionSet.cets[0].txid, height: 205 }
    })
  });
  assert(!earlyCet.ok && earlyCet.status === 'PREMATURE_CET_HALT', 'early CET did not halt');

  const earlyRefund = evaluateDlcChainSnapshot({
    contractState: confirmedFixture.contract,
    transactionSet: confirmedFixture.transactionSet,
    current: chainSnapshot(confirmedFixture.transactionSet, {
      height: 199,
      bestBlockHash: digest('chain:block:199'),
      fundingPresent: false,
      fundingConfirmations: 0,
      observedSpend: { txid: confirmedFixture.transactionSet.refund.txid, height: 199 }
    })
  });
  assert(!earlyRefund.ok && earlyRefund.status === 'PREMATURE_REFUND_HALT', 'immature refund did not halt');
  const matureRefund = evaluateDlcChainSnapshot({
    contractState: confirmedFixture.contract,
    transactionSet: confirmedFixture.transactionSet,
    current: chainSnapshot(confirmedFixture.transactionSet, {
      fundingPresent: false,
      fundingConfirmations: 0,
      observedSpend: { txid: confirmedFixture.transactionSet.refund.txid, height: 205 }
    })
  });
  assert(matureRefund.ok && matureRefund.status === 'REFUND_OBSERVED', 'mature refund was not recognized');
});

test('Bitcoin Core observer captures a stable testnet4 tip and scans committed spends', () => {
  const { contract, transactionSet } = validatedChainFixture('core-observer-confirmed', 'CONFIRMED');
  const bestBlockHash = digest('core-observer:block:205');
  const confirmedRpc = (method) => {
    if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 205, bestblockhash: bestBlockHash };
    if (method === 'getrawmempool') return { mempool_sequence: 9 };
    if (method === 'gettxout') return { bestblock: bestBlockHash, confirmations: 6 };
    throw new Error(`unexpected RPC ${method}`);
  };
  const confirmed = observeAndEvaluateDlcChain({ contractState: contract, transactionSet, rpc: confirmedRpc });
  assert(confirmed.evaluation.status === 'FUNDING_CONFIRMED', 'Core observer lost confirmed funding');
  assert(confirmed.snapshot.fundingOutpoint === `${transactionSet.funding.txid}:${transactionSet.funding.vout}`,
    'Core observer monitored the wrong funding outpoint');

  const mutableContract = JSON.parse(JSON.stringify(contract));
  const mutableTransactionSet = JSON.parse(JSON.stringify(transactionSet));
  let mutationInjected = false;
  const mutatingRpc = (method) => {
    if (!mutationInjected) {
      mutationInjected = true;
      mutableContract.stage = 'DRAFT';
      mutableTransactionSet.funding.vout = 99;
    }
    if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 205, bestblockhash: bestBlockHash };
    if (method === 'getrawmempool') return { mempool_sequence: 9 };
    if (method === 'gettxout') return { bestblock: bestBlockHash, confirmations: 6 };
    throw new Error(`unexpected RPC ${method}`);
  };
  const mutationSafe = observeAndEvaluateDlcChain({
    contractState: mutableContract,
    transactionSet: mutableTransactionSet,
    rpc: mutatingRpc
  });
  assert(mutationInjected && mutableContract.stage === 'DRAFT' && mutableTransactionSet.funding.vout === 99 &&
    mutationSafe.evaluation.status === 'FUNDING_CONFIRMED',
    'Core callback mutated validated contract or transaction-set snapshots');

  const cetRpc = (method, params) => {
    if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 205, bestblockhash: bestBlockHash };
    if (method === 'getrawmempool') return { mempool_sequence: 9 };
    if (method === 'gettxout') return null;
    if (method === 'gettxspendingprevout') return [{}];
    if (method === 'getblockhash') return bestBlockHash;
    if (method === 'getblock') return {
      tx: [{
        txid: transactionSet.cets[0].txid,
        vin: [{ txid: transactionSet.funding.txid, vout: transactionSet.funding.vout }]
      }]
    };
    throw new Error(`unexpected RPC ${method} ${JSON.stringify(params)}`);
  };
  const cet = observeAndEvaluateDlcChain({
    contractState: contract,
    transactionSet,
    rpc: cetRpc,
    scanDepth: 1
  });
  assert(cet.evaluation.status === 'CET_OBSERVED', 'Core block scan did not recognize the committed CET');

  const wrongChainRpc = (method) => {
    if (method === 'getblockchaininfo') return { chain: 'main', blocks: 205, bestblockhash: bestBlockHash };
    throw new Error(`unexpected RPC ${method}`);
  };
  expectThrow(() => observeAndEvaluateDlcChain({
    contractState: contract,
    transactionSet,
    rpc: wrongChainRpc
  }), /must report testnet4/);
});

test('signed watchtower journal preserves halt alerts and detects tampering after restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-watchtower-'));
  try {
    const { contract, transactionSet } = validatedChainFixture('watchtower-journal-contract', 'CONFIRMED');
    const keys = crypto.generateKeyPairSync('ed25519');
    const journal = new DlcWatchtowerJournal(directory, {
      watchtowerId: 'independent-watchtower-1',
      publicKey: keys.publicKey,
      privateKey: keys.privateKey
    });
    const firstSnapshot = chainSnapshot(transactionSet);
    const first = journal.appendObservation({ contractState: contract, transactionSet, snapshot: firstSnapshot });
    const retry = journal.appendObservation({ contractState: contract, transactionSet, snapshot: firstSnapshot });
    assert(retry.recordHash === first.recordHash, 'identical watchtower observation was not idempotent');
    const reorg = journal.appendObservation({
      contractState: contract,
      transactionSet,
      snapshot: chainSnapshot(transactionSet, {
        height: 206,
        bestBlockHash: digest('watchtower:block:206'),
        ancestorHashAtPreviousHeight: digest('watchtower:foreign-ancestor'),
        fundingConfirmations: 7
      })
    });
    assert(reorg.evaluation.status === 'REORG_HALT' && reorg.alert.code === 'REORG_HALT',
      'watchtower did not persist its reorg alert');

    const restarted = new DlcWatchtowerJournal(directory, {
      watchtowerId: 'independent-watchtower-1',
      publicKey: keys.publicKey
    });
    const verified = restarted.verifyChain(contract.contractId);
    assert(verified.observations === 2 && restarted.alerts(contract.contractId).length === 1,
      'restart lost the watchtower observation or alert chain');
    const checkpoint = restarted.checkpoint(contract.contractId);
    assert(restarted.verifyCheckpoint(contract.contractId, checkpoint).checkpointVerified === checkpoint.checkpointHash,
      'watchtower checkpoint did not verify');
    expectThrow(() => restarted.appendObservation({
      contractState: contract,
      transactionSet,
      snapshot: firstSnapshot
    }), /verification-only/);

    const secondPath = path.join(
      directory,
      watchtowerContractKey(contract.contractId),
      'observation-000000000001.json'
    );
    const secondBytes = fs.readFileSync(secondPath);
    fs.unlinkSync(secondPath);
    assert(restarted.verifyChain(contract.contractId).observations === 1,
      'watchtower tail deletion probe did not shorten the chain');
    expectThrow(() => restarted.verifyCheckpoint(contract.contractId, checkpoint), /rollback detected/);
    fs.writeFileSync(secondPath, secondBytes, { flag: 'wx', mode: 0o600 });
    const linkedObservation = path.join(directory, 'linked-watchtower-observation.json');
    fs.linkSync(secondPath, linkedObservation);
    expectThrow(() => restarted.verifyChain(contract.contractId), /one bounded regular file/);
    fs.unlinkSync(linkedObservation);
    const forged = JSON.parse(fs.readFileSync(secondPath, 'utf8'));
    forged.evaluation.reason = 'tampered after restart';
    fs.writeFileSync(secondPath, `${JSON.stringify(forged, null, 2)}\n`, 'utf8');
    expectThrow(() => restarted.verifyChain(contract.contractId), /commitment mismatch/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('watchtower signs direct Bitcoin Core anchor, replacement-policy, and peer relay observations', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-anchor-watchtower-'));
  try {
    const { contract, transactionSet } = validatedChainFixture('anchor-watchtower-contract', 'CONFIRMED');
    const settlementTxid = transactionSet.cets[0].txid;
    const anchor = settlementAnchor(transactionSet, settlementTxid);
    const pinTxid = digest('anchor-watchtower:pin');
    const bestBlockHash = digest('anchor-watchtower:block:205');
    const walletTxid = digest('anchor-watchtower:wallet-input');
    const walletValue = 200000n;
    const recoveryRaw = (feeSats) => serializeUnsignedTx(
      2,
      [
        { outpoint: outpoint(anchor.txid, anchor.vout), sequence: 0xfffffffd },
        { outpoint: outpoint(walletTxid, 0), sequence: 0xfffffffd }
      ],
      [{ valueSats: 330n + walletValue - feeSats, script: `0014${'98'.repeat(20)}` }],
      0
    );
    const cheapRecoveryRaw = recoveryRaw(9098n);
    const rescueRaw = recoveryRaw(100000n);
    const decodedRecovery = (rawTxHex) => {
      const parsed = parseCanonicalUnsignedTransaction(rawTxHex);
      return {
        txid: parsed.txid,
        hash: parsed.txid,
        version: parsed.version,
        vsize: 300,
        vin: parsed.inputs,
        vout: parsed.outputs.map((output) => ({ value: Number(output.valueSats) / 100000000 }))
      };
    };
    const primaryRpc = (method, params) => {
      if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 205, bestblockhash: bestBlockHash };
      if (method === 'getrawmempool') return { mempool_sequence: 17 };
      if (method === 'getmempoolinfo') return { fullrbf: true, incrementalrelayfee: 0.00001 };
      if (method === 'gettxout' && params[0] === walletTxid) {
        return { bestblock: bestBlockHash, confirmations: 6, value: 0.002, scriptPubKey: { hex: `0014${'97'.repeat(20)}` } };
      }
      if (method === 'gettxout') return null;
      if (method === 'gettxspendingprevout') return [{ spendingtxid: pinTxid }];
      if (method === 'getmempoolentry') {
        return { vsize: 467, fees: { base: 0.00093338 }, 'bip125-replaceable': false };
      }
      if (method === 'decoderawtransaction') return decodedRecovery(params[0]);
      if (method === 'testmempoolaccept') {
        const decoded = decodedRecovery(params[0][0]);
        return [{ txid: decoded.txid, wtxid: decoded.hash, allowed: true }];
      }
      throw new Error(`unexpected primary anchor RPC ${method}`);
    };
    const peerRpc = (method, params) => {
      if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 205, bestblockhash: bestBlockHash };
      if (method === 'getrawmempool' && params[1] === true) return { mempool_sequence: 9 };
      if (method === 'getrawmempool') return [pinTxid];
      throw new Error(`unexpected peer anchor RPC ${method}`);
    };
    const captured = captureDlcAnchorRecoverySnapshot({
      contractState: contract,
      transactionSet,
      settlementTxid,
      rpc: primaryRpc,
      peerNodes: [{ nodeId: 'peer-1', rpc: peerRpc }],
      proposedRecoveryRawTxHex: cheapRecoveryRaw
    });
    assert(captured.observedSpend.txid === pinTxid && captured.observedSpend.relayPeers === 2,
      'Core observer did not count the primary and peer mempools');
    assert(captured.fullRbf && captured.incrementalRelayFeeSatPerVb === 1,
      'Core observer did not bind replacement policy');
    assert(captured.proposedRecovery.version === 2 && captured.proposedRecovery.corePolicy.allowed === true &&
      captured.proposedRecovery.corePolicy.method === 'testmempoolaccept',
    'Core observer did not bind direct proposal acceptance');
    expectThrow(() => captureDlcAnchorRecoverySnapshot({
      contractState: contract,
      transactionSet,
      settlementTxid,
      rpc(method, params) {
        if (method === 'testmempoolaccept') {
          return [{ txid: digest('wrong-policy-txid'), wtxid: digest('wrong-policy-wtxid'), allowed: true }];
        }
        return primaryRpc(method, params);
      },
      peerNodes: [{ nodeId: 'peer-1', rpc: peerRpc }],
      proposedRecoveryRawTxHex: cheapRecoveryRaw,
      maxAttempts: 1
    }), /different proposal/);
    expectThrow(() => captureDlcAnchorRecoverySnapshot({
      contractState: contract,
      transactionSet,
      settlementTxid,
      rpc: primaryRpc,
      primaryNodeId: 'peer-1',
      peerNodes: [{ nodeId: 'peer-1', rpc: peerRpc }],
      proposedRecoveryRawTxHex: cheapRecoveryRaw
    }), /node IDs must be unique/);
    expectThrow(() => captureDlcAnchorRecoverySnapshot({
      contractState: contract,
      transactionSet,
      settlementTxid,
      rpc: primaryRpc,
      peerNodes: [{
        nodeId: 'wrong-chain',
        rpc(method) {
          if (method === 'getblockchaininfo') return { chain: 'main', blocks: 205, bestblockhash: bestBlockHash };
          throw new Error(`unexpected wrong-chain RPC ${method}`);
        }
      }],
      proposedRecoveryRawTxHex: cheapRecoveryRaw,
      maxAttempts: 1
    }), /must report testnet4/);

    const confirmedRecoveryTxid = digest('anchor-watchtower:confirmed-recovery');
    const confirmedRpc = (method) => {
      if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 205, bestblockhash: bestBlockHash };
      if (method === 'getrawmempool') return { mempool_sequence: 18 };
      if (method === 'getmempoolinfo') return { fullrbf: true, incrementalrelayfee: 0.00001 };
      if (method === 'gettxout') return null;
      if (method === 'gettxspendingprevout') return [{}];
      if (method === 'getblockhash') return bestBlockHash;
      if (method === 'getblock') return {
        tx: [{
          txid: confirmedRecoveryTxid,
          fee: 0.00001,
          vsize: 200,
          vin: [{ txid: anchor.txid, vout: anchor.vout, sequence: 0xfffffffe }]
        }]
      };
      throw new Error(`unexpected confirmed anchor RPC ${method}`);
    };
    const confirmedSnapshot = captureDlcAnchorRecoverySnapshot({
      contractState: contract,
      transactionSet,
      settlementTxid,
      rpc: confirmedRpc,
      expectedRecoveryTxids: [confirmedRecoveryTxid],
      scanDepth: 1
    });
    const confirmedEvaluation = evaluateDlcAnchorRecovery({
      contractState: contract,
      transactionSet,
      settlementTxid,
      snapshot: confirmedSnapshot,
      expectedRecoveryTxids: confirmedSnapshot.expectedRecoveryTxids,
      incrementalRelayFeeSatPerVb: confirmedSnapshot.incrementalRelayFeeSatPerVb
    });
    assert(confirmedEvaluation.status === 'RECOVERY_CONFIRMED',
      'Core block scan did not accept the confirmed expected recovery');

    const keys = crypto.generateKeyPairSync('ed25519');
    const journal = new DlcWatchtowerJournal(directory, {
      watchtowerId: 'anchor-watchtower-1',
      publicKey: keys.publicKey,
      privateKey: keys.privateKey
    });
    const pinned = journal.appendBitcoinCoreAnchorObservation({
      contractState: contract,
      transactionSet,
      settlementTxid,
      rpc: primaryRpc,
      peerNodes: [{ nodeId: 'peer-1', rpc: peerRpc }],
      proposedRecoveryRawTxHex: cheapRecoveryRaw
    });
    assert(pinned.observationType === 'anchor-recovery' && pinned.evaluation.status === 'FEE_PIN_HALT' &&
      pinned.alert.code === 'FEE_PIN_HALT', 'watchtower did not persist the directly observed fee pin');
    const rescued = journal.appendBitcoinCoreAnchorObservation({
      contractState: contract,
      transactionSet,
      settlementTxid,
      rpc: primaryRpc,
      peerNodes: [{ nodeId: 'peer-1', rpc: peerRpc }],
      proposedRecoveryRawTxHex: rescueRaw
    });
    assert(rescued.evaluation.status === 'FEE_PIN_RESCUE_READY' && rescued.alert === null,
      'watchtower did not authorize the in-budget replacement from direct Core evidence');
    const chainRecord = journal.appendObservation({
      contractState: contract,
      transactionSet,
      snapshot: chainSnapshot(transactionSet)
    });
    const rescueRetry = journal.appendBitcoinCoreAnchorObservation({
      contractState: contract,
      transactionSet,
      settlementTxid,
      rpc: primaryRpc,
      peerNodes: [{ nodeId: 'peer-1', rpc: peerRpc }],
      proposedRecoveryRawTxHex: rescueRaw
    });
    assert(chainRecord.observationType === 'chain' && rescueRetry.recordHash === rescued.recordHash,
      'mixed observation types broke anchor idempotency');

    const restarted = new DlcWatchtowerJournal(directory, {
      watchtowerId: 'anchor-watchtower-1',
      publicKey: keys.publicKey
    });
    const verified = restarted.verifyChain(contract.contractId);
    assert(verified.observations === 3 && restarted.alerts(contract.contractId).length === 1,
      'direct Core anchor observations did not survive journal restart');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('anchor recovery guard enforces signed budgets, relay quorum, and full-RBF fee-pin deltas', () => {
  const { contract, transactionSet } = validatedChainFixture('anchor-recovery-contract', 'CANONICAL_CETS_AND_REFUND');
  const settlementTxid = transactionSet.cets[0].txid;
  const anchor = settlementAnchor(transactionSet, settlementTxid);
  assert(anchor.vout === transactionSet.cets[0].outputs.length - 1, 'guard selected the wrong settlement anchor');
  const pin = {
    txid: digest('anchor-guard:pin'),
    feeSats: '93338',
    vsize: 467,
    relayPeers: 2,
    signalsRbf: false,
    confirmed: false
  };
  const cheapRecovery = {
    txid: digest('anchor-guard:cheap-recovery'),
    version: 2,
    feeSats: '9098',
    vsize: 467,
    relayPeers: 0,
    signalsRbf: true,
    confirmed: false,
    corePolicy: { method: 'testmempoolaccept', allowed: true, rejectReason: null }
  };
  const rescue = {
    txid: digest('anchor-guard:rescue'),
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
    snapshot: { anchorOutpoint: anchor.outpoint, anchorPresent: false, fullRbf: true, observedSpend: pin, proposedRecovery: cheapRecovery }
  });
  assert(!pinned.ok && pinned.status === 'FEE_PIN_HALT', 'cheaper recovery bypassed the economic fee pin');
  const rescued = evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    snapshot: { anchorOutpoint: anchor.outpoint, anchorPresent: false, fullRbf: true, observedSpend: pin, proposedRecovery: rescue }
  });
  assert(rescued.ok && rescued.status === 'FEE_PIN_RESCUE_READY', 'higher-fee recovery was not authorized inside budget');
  const noFullRbf = evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    snapshot: { anchorOutpoint: anchor.outpoint, anchorPresent: false, fullRbf: false, observedSpend: pin, proposedRecovery: rescue }
  });
  assert(!noFullRbf.ok && noFullRbf.status === 'FEE_PIN_HALT', 'non-RBF pin bypassed the observed replacement policy');
  const confirmedConflict = evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    snapshot: {
      anchorOutpoint: anchor.outpoint,
      anchorPresent: false,
      fullRbf: true,
      observedSpend: { ...pin, confirmed: true, relayPeers: 0 },
      proposedRecovery: rescue
    }
  });
  assert(!confirmedConflict.ok && confirmedConflict.status === 'ANCHOR_SPENT_HALT',
    'confirmed conflicting anchor spend was treated as replaceable');
  const overBudget = evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    snapshot: {
      anchorOutpoint: anchor.outpoint,
      anchorPresent: true,
      fullRbf: true,
      observedSpend: null,
      proposedRecovery: { ...rescue, txid: digest('anchor-guard:over-budget'), feeSats: '150001' }
    }
  });
  assert(!overBudget.ok && overBudget.status === 'RECOVERY_BUDGET_HALT', 'recovery exceeded the signed absolute fee budget');
  const underReplicated = evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    expectedRecoveryTxids: [rescue.txid],
    snapshot: {
      anchorOutpoint: anchor.outpoint,
      anchorPresent: false,
      fullRbf: true,
      observedSpend: { ...rescue, relayPeers: 1 },
      proposedRecovery: null
    }
  });
  assert(!underReplicated.ok && underReplicated.status === 'RECOVERY_PROPAGATION_HALT',
    'recovery without the signed relay quorum was accepted');
});

test('TRUC recovery requires direct Core acceptance, version 3, and a child no larger than 1000 vB', () => {
  const { funding } = twoPartyFunding({ txid: 'bd'.repeat(32), vout: 0, valueSats: 100000n });
  const feePolicy = {
    strategy: 'truc-p2a-v1',
    anchorAmountSats: 0n,
    anchorScriptPubKeyHex: P2A_SCRIPT_PUBKEY_HEX,
    maxRecoveryFeeSats: 150000n,
    maxRecoveryFeerateSatPerVb: 500,
    minRelayPeers: 2
  };
  const anchorOutput = { valueSats: 0n, scriptPubKeyHex: P2A_SCRIPT_PUBKEY_HEX };
  const cetOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `0014${'59'.repeat(20)}` }, anchorOutput];
  const refundOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `5120${'69'.repeat(32)}` }, anchorOutput];
  const raw = (outputs, locktime, sequence = 0xfffffffd) => serializeUnsignedTx(
    3,
    [{ outpoint: outpoint(funding.txid, funding.vout), sequence }],
    outputs.map((output) => ({ valueSats: output.valueSats, script: output.scriptPubKeyHex })),
    locktime
  );
  const transactionSet = validateDlcTransactionSet({
    funding,
    cets: [{
      outcomeMessage: digest('truc-recovery:outcome'),
      oraclePubkeys: ['11'.repeat(32), '22'.repeat(32)],
      rawTxHex: raw(cetOutputs, 100),
      expectedOutputs: cetOutputs,
      locktime: 100
    }],
    refund: {
      rawTxHex: raw(refundOutputs, 200, REFUND_CSV_BLOCKS), expectedOutputs: refundOutputs, locktime: 200
    },
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy
  });
  let contract = initialContract('truc-core-policy-contract');
  contract = transitionDlcContract(contract, requestFor(contract, 'AUTHENTICATED_ORACLES', 'truc-core-policy:oracles'));
  contract = transitionDlcContract(contract, requestFor(contract, 'CANONICAL_CETS_AND_REFUND', 'truc-core-policy:transactions', {
    cet_set: transactionSet.cetSetDigest,
    fee_policy: transactionSet.feePolicyDigest,
    funding_template: transactionSet.fundingTemplateDigest,
    refund_transaction: transactionSet.refundTransactionDigest
  }));
  const settlementTxid = transactionSet.cets[0].txid;
  const anchor = settlementAnchor(transactionSet, settlementTxid);
  const candidate = {
    txid: digest('truc-core-policy:recovery'),
    version: 3,
    feeSats: '5000',
    vsize: 153,
    relayPeers: 0,
    signalsRbf: true,
    confirmed: false,
    corePolicy: { method: 'testmempoolaccept', allowed: true, rejectReason: null }
  };
  const evaluate = (proposedRecovery) => evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    snapshot: {
      anchorOutpoint: anchor.outpoint,
      anchorPresent: true,
      fullRbf: true,
      observedSpend: null,
      proposedRecovery
    }
  });
  assert(evaluate(candidate).status === 'RECOVERY_READY', 'Core-accepted TRUC recovery did not pass');
  const rejected = evaluate({
    ...candidate,
    corePolicy: { method: 'testmempoolaccept', allowed: false, rejectReason: 'TRUC-violation' }
  });
  assert(!rejected.ok && rejected.status === 'RECOVERY_POLICY_HALT' &&
    rejected.coreRejectReason === 'TRUC-violation', 'Core policy rejection did not halt recovery');
  assert(evaluate({ ...candidate, version: 2 }).status === 'RECOVERY_POLICY_HALT',
    'wrong-version TRUC child did not halt');
  assert(evaluate({ ...candidate, vsize: 1001 }).status === 'RECOVERY_POLICY_HALT',
    'oversized TRUC child did not halt');
  expectThrow(() => evaluate({ ...candidate, corePolicy: undefined }), /lacks canonical Bitcoin Core policy evidence/);
});

function peerTranscriptFixture(overrides = {}) {
  const { contract, transactionSet } = validatedChainFixture('peer-transcript-contract', 'CANONICAL_CETS_AND_REFUND');
  const offerer = crypto.generateKeyPairSync('ed25519');
  const accepter = crypto.generateKeyPairSync('ed25519');
  const temporaryContractId = digest('peer-transcript:temporary-contract');
  const signatureDigests = {
    accepterCet: digest('peer-transcript:accepter-cets'),
    accepterRefund: digest('peer-transcript:accepter-refund'),
    offererCet: digest('peer-transcript:offerer-cets'),
    offererRefund: digest('peer-transcript:offerer-refund'),
    fundingWitnesses: digest('peer-transcript:funding-witnesses')
  };
  const terms = {
    contractDigest: contract.contractDigest,
    oraclePolicyDigest: computeOraclePolicyDigest(contract.oraclePolicy)
  };
  const offer = signDlcPeerMessage({
    messageType: PEER_MESSAGE_TYPES.OFFER,
    peerId: 'offerer-peer',
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
  const acceptBody = {
    protocolVersion: 1,
    temporaryContractId,
    payoutSerialId: '6',
    changeSerialId: '21',
    fundingInputSerialIds: ['3', '11'],
    ...terms,
    transactionValidationDigest: transactionSet.validationDigest,
    cetSignaturesDigest: signatureDigests.accepterCet,
    refundSignatureDigest: signatureDigests.accepterRefund,
    ...overrides.acceptBody
  };
  const accept = signDlcPeerMessage({
    messageType: PEER_MESSAGE_TYPES.ACCEPT,
    peerId: 'accepter-peer',
    previousMessageDigest: offer.messageDigest,
    body: acceptBody,
    privateKey: accepter.privateKey
  });
  const contractId = computeDlcContractId(
    transactionSet.funding.txid,
    transactionSet.funding.vout,
    temporaryContractId
  );
  const sign = signDlcPeerMessage({
    messageType: PEER_MESSAGE_TYPES.SIGN,
    peerId: 'offerer-peer',
    previousMessageDigest: accept.messageDigest,
    body: {
      protocolVersion: 1,
      contractId,
      fundingWitnessInputSerialIds: ['2', '10'],
      fundingWitnessesDigest: signatureDigests.fundingWitnesses,
      ...terms,
      transactionValidationDigest: transactionSet.validationDigest,
      cetSignaturesDigest: signatureDigests.offererCet,
      refundSignatureDigest: signatureDigests.offererRefund
    },
    privateKey: offerer.privateKey
  });
  return {
    contract, transactionSet, offerer, accepter, offer, accept, sign, contractId,
    temporaryContractId, signatureDigests
  };
}

test('peer transcript authenticates offer/accept/sign and binds serial ordering to validated transactions', () => {
  const fixture = peerTranscriptFixture();
  assert(computeDlcContractId('00'.repeat(32), 513, '00'.repeat(32)).endsWith('0201'),
    'contract ID did not XOR the big-endian funding output index');
  const validated = validateDlcPeerTranscript({
    offer: fixture.offer,
    accept: fixture.accept,
    sign: fixture.sign,
    offererPublicKey: fixture.offerer.publicKey,
    accepterPublicKey: fixture.accepter.publicKey,
    transactionSet: fixture.transactionSet,
    contractState: fixture.contract,
    fundingTxid: fixture.transactionSet.funding.txid,
    fundingOutputIndex: fixture.transactionSet.funding.vout,
    expectedSignatures: fixture.signatureDigests,
    verifyFundingWitnesses: ({ fundingWitnessesDigest }) =>
      fundingWitnessesDigest === fixture.signatureDigests.fundingWitnesses
  });
  assert(validated.ok && validated.contractId === fixture.contractId, 'valid peer transcript failed');
  assert(/^[0-9a-f]{64}$/.test(validated.transcriptDigest), 'peer transcript digest is invalid');

  let accessorCalls = 0;
  const accessorBody = { ...fixture.offer.body };
  Object.defineProperty(accessorBody, 'payoutSerialId', {
    enumerable: true,
    get() { accessorCalls++; return fixture.offer.body.payoutSerialId; }
  });
  expectThrow(() => signDlcPeerMessage({
    messageType: PEER_MESSAGE_TYPES.OFFER,
    peerId: fixture.offer.peerId,
    body: accessorBody,
    privateKey: fixture.offerer.privateKey
  }), /enumerable data property/);
  assert(accessorCalls === 0, 'peer body accessor executed before rejection');

  const duplicate = peerTranscriptFixture({ acceptBody: { fundingInputSerialIds: ['2', '11'] } });
  expectThrow(() => validateDlcPeerTranscript({
    offer: duplicate.offer,
    accept: duplicate.accept,
    sign: duplicate.sign,
    offererPublicKey: duplicate.offerer.publicKey,
    accepterPublicKey: duplicate.accepter.publicKey,
    transactionSet: duplicate.transactionSet,
    contractState: duplicate.contract,
    fundingTxid: duplicate.transactionSet.funding.txid,
    fundingOutputIndex: duplicate.transactionSet.funding.vout,
    expectedSignatures: duplicate.signatureDigests,
    verifyFundingWitnesses: () => true
  }), /globally unique/);

  expectThrow(() => validateDlcPeerTranscript({
    offer: fixture.offer,
    accept: fixture.accept,
    sign: fixture.sign,
    offererPublicKey: fixture.offerer.publicKey,
    accepterPublicKey: fixture.accepter.publicKey,
    transactionSet: fixture.transactionSet,
    contractState: fixture.contract,
    fundingTxid: fixture.transactionSet.funding.txid,
    fundingOutputIndex: fixture.transactionSet.funding.vout,
    expectedSignatures: fixture.signatureDigests,
    verifyFundingWitnesses: () => true,
    knownTemporaryContractIds: [fixture.temporaryContractId]
  }), /already used/);
});

test('peer session store preserves temporary-ID replay protection across restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-peer-session-'));
  try {
    const fixture = peerTranscriptFixture();
    const transcript = validateDlcPeerTranscript({
      offer: fixture.offer,
      accept: fixture.accept,
      sign: fixture.sign,
      offererPublicKey: fixture.offerer.publicKey,
      accepterPublicKey: fixture.accepter.publicKey,
      transactionSet: fixture.transactionSet,
      contractState: fixture.contract,
      fundingTxid: fixture.transactionSet.funding.txid,
      fundingOutputIndex: fixture.transactionSet.funding.vout,
      expectedSignatures: fixture.signatureDigests,
      verifyFundingWitnesses: () => true
    });
    const first = new DlcPeerSessionStore(directory);
    const claim = first.claimOffer({ offer: fixture.offer, offererPublicKey: fixture.offerer.publicKey });
    const retry = first.claimOffer({ offer: fixture.offer, offererPublicKey: fixture.offerer.publicKey });
    assert(retry.recordHash === claim.recordHash, 'identical offer claim was not idempotent');
    const committed = first.commitTranscript(transcript);
    assert(first.commitTranscript(transcript).recordHash === committed.recordHash, 'transcript commit was not idempotent');
    const checkpoint = first.checkpoint(fixture.offer.peerId, fixture.temporaryContractId);
    assert(first.verifyCheckpoint(
      fixture.offer.peerId, fixture.temporaryContractId, checkpoint
    ).checkpointVerified === checkpoint.checkpointHash, 'peer session checkpoint did not verify');

    const restarted = new DlcPeerSessionStore(directory);
    assert(restarted.knownTemporaryContractIds('offerer-peer').includes(fixture.temporaryContractId),
      'restart lost temporary contract replay protection');
    const conflictingOffer = signDlcPeerMessage({
      messageType: PEER_MESSAGE_TYPES.OFFER,
      peerId: fixture.offer.peerId,
      body: { ...fixture.offer.body, payoutSerialId: '7' },
      privateKey: fixture.offerer.privateKey
    });
    expectThrow(() => restarted.claimOffer({
      offer: conflictingOffer,
      offererPublicKey: fixture.offerer.publicKey
    }), /already claimed/);
    const sessionDirectoryName = fs.readdirSync(directory).find((name) => /^[0-9a-f]{64}$/.test(name));
    const sessionDirectory = path.join(directory, sessionDirectoryName);
    const commitPath = path.join(sessionDirectory, 'commit.json');
    const commitBytes = fs.readFileSync(commitPath);
    fs.unlinkSync(commitPath);
    expectThrow(() => restarted.verifyCheckpoint(
      fixture.offer.peerId, fixture.temporaryContractId, checkpoint
    ), /rollback detected/);
    fs.writeFileSync(commitPath, commitBytes, { flag: 'wx', mode: 0o600 });
    const linkedClaim = path.join(directory, 'linked-peer-claim.json');
    fs.linkSync(path.join(sessionDirectory, 'claim.json'), linkedClaim);
    expectThrow(() => restarted.knownTemporaryContractIds('offerer-peer'), /one bounded regular file/);
    fs.unlinkSync(linkedClaim);
    const linkedCommit = path.join(directory, 'linked-peer-commit.json');
    fs.linkSync(path.join(sessionDirectory, 'commit.json'), linkedCommit);
    expectThrow(() => restarted.commitTranscript(transcript), /one bounded regular file/);
    fs.unlinkSync(linkedCommit);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}
console.log(`\nPASS: ${passed} tests\n`);
