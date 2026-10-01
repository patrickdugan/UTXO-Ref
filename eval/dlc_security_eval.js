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
  canonicalJson,
  createDlcContract,
  normalizeDlcContract,
  signValidationReceipt,
  transitionDlcContract
} = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_contract_state.js'));
const { DlcStateStore } = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_state_store.js'));
const {
  createDlcJournalCheckpoint,
  normalizeDlcJournalCheckpoint,
  signDlcJournalCheckpoint,
  signedDlcJournalCheckpointHash,
  verifySignedDlcJournalCheckpoint
} = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_journal_checkpoint.js'));
const { readBoundedJson, writeJsonAppendOnce } = require(path.join(
  __dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_durable_json_store.js'
));
const {
  buildThresholdOutcomeSets,
  combineThresholdAttestations
} = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_threshold_oracle.js'));
const { validateFundingAuthorization } = require(fundingFinalizerPath);
const {
  authorizeDlcAdaptorSign,
  createDlcAdaptorSignAuthorization,
  createDlcCryptoProvider,
  nativeCapabilityAttestationPayload
} = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_crypto_provider.js'));
const { DlcOracleEventStore } = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_oracle_event_store.js'));
const { DlcSigningAuthorizationStore, validateConsumptionRecord } = require(path.join(
  __dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_signing_authorization_store.js'
));
const {
  DlcRefundRecoveryStore,
  refundKey: refundRecoveryKey,
  recordHash: refundRecoveryRecordHash
} = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_refund_recovery_store.js'));
const nativeSignerClientPath = path.join(
  __dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_native_signer_process_client.js'
);
const {
  REQUEST_KIND: NATIVE_PROCESS_REQUEST_KIND,
  RESPONSE_KIND: NATIVE_PROCESS_RESPONSE_KIND,
  nativeSignerExecutableDigest,
  nativeSignerRuntimeDigest,
  responseSignaturePayload,
  DlcNativeSignerProcessClient
} = require(nativeSignerClientPath);
const {
  P2A_SCRIPT_PUBKEY_HEX,
  parseCanonicalSignedTaprootTransaction,
  parseCanonicalUnsignedTransaction,
  validateDlcTransactionSet,
  validateDlcTransactionSetCommitments
} = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_transaction_validator.js'));
const { serializeUnsignedTx, outpoint, bip341SighashDefault } = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'tradelayer_taproot.js'));
const {
  toBip341Transaction,
  cetIdentity,
  validateCetAdaptorSignatures,
  validateRefundSignature,
  settlementSighashForTransactionSet,
  assembleSignedSettlement
} = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_signature_validator.js'));
const { buildDlcFundingOutput, dlcFundingFields } = require(path.join(
  __dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_funding_output.js'
));
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
const { validateFundingPrebroadcastPolicy } = require(path.join(
  __dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_funding_prebroadcast_guard.js'
));
const { validateExecutionPrebroadcastPolicy } = require(path.join(
  __dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_execution_prebroadcast_guard.js'
));
const { DlcBroadcastAuthorizationStore } = require(path.join(
  __dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_broadcast_authorization_store.js'
));
const validatorKeys = crypto.generateKeyPairSync('ed25519');
const validatorSpki = validatorKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const validatorKeyId = crypto.createHash('sha256').update(Buffer.from(validatorSpki, 'base64')).digest('hex');
const validatorPolicy = Object.fromEntries(ALL_EVIDENCE_KINDS.map((kind) => [kind, {
  keyId: validatorKeyId,
  publicKeySpki: validatorSpki
}]));
const checkpointSignerKeys = crypto.generateKeyPairSync('ed25519');
const checkpointSignerSpki = checkpointSignerKeys.publicKey.export({ format: 'der', type: 'spki' });
const checkpointSignerKeyId = crypto.createHash('sha256').update(checkpointSignerSpki).digest('hex');
const trustedCheckpointKeys = [{
  keyId: checkpointSignerKeyId,
  publicKeySpki: checkpointSignerSpki.toString('base64')
}];

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

// Fixtures use the two-party DLC funding output: a NUMS-keyed Taproot output
// whose only spends are the 2-of-2 CET leaf and the CSV-gated 2-of-2 refund
// leaf. (They previously used a single-key or arbitrary P2TR script, which the
// transaction validator no longer accepts.)
const REFUND_CSV_BLOCKS = 144;
function partySecrets(label) {
  return [scalar(`${label}:party:0`), scalar(`${label}:party:1`)];
}
function twoPartyFunding({ label, txid, vout, valueSats }) {
  const secrets = partySecrets(label);
  const output = buildDlcFundingOutput({
    partyPubkeyXs: secrets.map((secret) => dlc.xOnlyPubkey(secret).toString('hex')).sort(),
    refundCsvBlocks: REFUND_CSV_BLOCKS
  });
  return { funding: { txid, vout, valueSats, ...dlcFundingFields(output) }, output, secrets };
}
function signSettlement({ transactionSet, executionType, cetTxid, secrets, auxLabel }) {
  const sighash = settlementSighashForTransactionSet({ transactionSet, executionType, cetTxid });
  const signatures = Object.fromEntries(secrets.map((secret, index) => [
    dlc.xOnlyPubkey(secret).toString('hex'),
    dlc.schnorrSign(secret, sighash, sha256(`${auxLabel}:${index}`)).toString('hex')
  ]));
  return assembleSignedSettlement({ transactionSet, executionType, cetTxid, signatures });
}

function evidenceFor(contract, stage, idempotencyKey, overrides = {}) {
  const historicalEvidence = contract.history.flatMap((entry) => entry.evidence);
  const historicalDigest = (kind) => historicalEvidence.find((receipt) => receipt.kind === kind)?.digest;
  const digestFor = (kind) => {
    const override = overrides[kind];
    return typeof override === 'object'
      ? override.digest
      : (override || sha256(`${stage}:${kind}`).toString('hex'));
  };
  return REQUIRED_EVIDENCE[stage].map((kind) => {
    const override = overrides[kind];
    let metadata = typeof override === 'object' ? override.metadata : undefined;
    if (metadata === undefined && kind === 'prebroadcast_bitcoin_core_policy') {
      const issuedAtUnixSeconds = Math.floor(Date.now() / 1000);
      metadata = {
        rawTransactionSha256: digestFor('broadcast_transaction'),
        txid: sha256(`${idempotencyKey}:prebroadcast:txid`).toString('hex'),
        wtxid: sha256(`${idempotencyKey}:prebroadcast:wtxid`).toString('hex'),
        contractRevision: contract.revision,
        contractTranscriptHash: contract.transcriptHash,
        fundingPsbtDigest: historicalDigest('funding_psbt_validation'),
        issuedAtUnixSeconds,
        expiresAtUnixSeconds: issuedAtUnixSeconds + 30,
        chainTip: sha256(`${idempotencyKey}:prebroadcast:chain-tip`).toString('hex'),
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
        txid: sha256(`${idempotencyKey}:${cet ? 'cet' : 'refund'}:txid`).toString('hex'),
        wtxid: sha256(`${idempotencyKey}:${cet ? 'cet' : 'refund'}:wtxid`).toString('hex'),
        contractRevision: contract.revision,
        contractTranscriptHash: contract.transcriptHash,
        settlementCommitmentDigest: historicalDigest(cet ? 'cet_set' : 'refund_transaction'),
        executionEvidenceDigest: digestFor(cet ? 'oracle_threshold_attestation' : 'refund_maturity'),
        issuedAtUnixSeconds,
        expiresAtUnixSeconds: issuedAtUnixSeconds + 30,
        chainTip: sha256(`${idempotencyKey}:${cet ? 'cet' : 'refund'}:chain-tip`).toString('hex'),
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
      to: stage,
      idempotencyKey,
      kind,
      digest: digestFor(kind),
      ...(metadata === undefined ? {} : { metadata })
    });
  });
}

const cases = [];
let peerFixtureForEval;
let prebroadcastFixtureForEval;
let signerAuthorizationFixtureForEval;
let providerConfigurationFixtureForEval;
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

check('adaptor primitives snapshot points and pre-signatures without callbacks', 'canonical-data', 12, () => {
  const signerSecret = scalar('adaptor-input-eval:signer');
  const message = sha256('adaptor-input-eval:message');
  const adaptorSecret = scalar('adaptor-input-eval:secret');
  const adaptorPoint = dlc.pointMul(dlc.G, adaptorSecret);
  let pointAccessorCalls = 0;
  const hostilePoint = { y: adaptorPoint.y };
  Object.defineProperty(hostilePoint, 'x', {
    enumerable: true,
    get() { pointAccessorCalls++; return adaptorPoint.x; }
  });
  const pointRejected = throws(
    () => dlc.adaptorSign(signerSecret, message, hostilePoint, sha256('adaptor-input-eval:aux')),
    /enumerable data property/
  );
  const presignature = dlc.adaptorSign(
    signerSecret, message, adaptorPoint, sha256('adaptor-input-eval:valid-aux')
  );
  let presignatureAccessorCalls = 0;
  const hostilePresignature = { ...presignature };
  Object.defineProperty(hostilePresignature, 'R0x', {
    enumerable: true,
    get() { presignatureAccessorCalls++; return presignature.R0x; }
  });
  const verificationRejected = dlc.adaptorVerify(
    dlc.xOnlyPubkey(signerSecret), message, hostilePresignature
  ) === false;
  const completionRejected = throws(
    () => dlc.adaptorComplete(hostilePresignature, adaptorSecret), /enumerable data property/
  );
  return pointRejected && verificationRejected && completionRejected &&
    pointAccessorCalls === 0 && presignatureAccessorCalls === 0 && Object.isFrozen(presignature);
});

check('signed canonical data rejects hidden, effectful, and ambiguous values', 'canonical-data', 12, () => {
  const ownProto = JSON.parse('{"__proto__":{"polluted":true},"b":2,"a":1}');
  const ownProtoBound = canonicalJson(ownProto) ===
    '{"__proto__":{"polluted":true},"a":1,"b":2}' && Object.prototype.polluted === undefined;
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() { getterCalls++; return 1; }
  });
  const symbolBearing = { value: 1 };
  symbolBearing[Symbol('hidden')] = 2;
  const sparse = new Array(2);
  sparse[1] = 1;
  const cyclic = {};
  cyclic.self = cyclic;
  let tooDeep = true;
  for (let index = 0; index < 65; index++) tooDeep = { next: tooDeep };
  const receipt = signValidationReceipt({
    privateKey: validatorKeys.privateKey,
    contractId: 'eval-canonical-data',
    contractDigest: sha256('eval-canonical-contract').toString('hex'),
    from: 'DRAFT',
    to: 'AUTHENTICATED_ORACLES',
    idempotencyKey: 'eval-canonical-transition',
    kind: 'oracle_policy',
    digest: sha256('eval-canonical-policy').toString('hex'),
    metadata: { nested: { accepted: true } }
  });
  return ownProtoBound &&
    throws(() => canonicalJson(accessor), /enumerable data property/) && getterCalls === 0 &&
    throws(() => canonicalJson(symbolBearing), /symbol properties/) &&
    throws(() => canonicalJson(new Date(0)), /plain objects and arrays/) &&
    throws(() => canonicalJson(-0), /unambiguous safe integers/) &&
    throws(() => canonicalJson(1n), /unsupported data/) &&
    throws(() => canonicalJson(sparse), /dense array/) &&
    throws(() => canonicalJson(cyclic), /cycle/) &&
    throws(() => canonicalJson(tooDeep), /depth 64/) &&
    Object.isFrozen(receipt.metadata) && Object.isFrozen(receipt.metadata.nested);
});

check('canonical encoding executes no inherited hooks or Proxy traps', 'canonical-data', 12, () => {
  const objectHook = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const arrayHook = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let hookCalls = 0;
  let hookSafe = false;
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value() { hookCalls++; return { forged: true }; }
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value() { hookCalls++; return ['forged']; }
    });
    hookSafe = canonicalJson({ a: [1, { b: 2 }] }) === '{"a":[1,{"b":2}]}' && hookCalls === 0;
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
  const canonicalProxyRejected = throws(
    () => canonicalJson(new Proxy({ value: 1 }, handler)),
    /Proxy object/
  );
  const checkpoint = createDlcJournalCheckpoint({
    storeKind: 'contract-state',
    storeKey: sha256('eval-proxy-checkpoint-store').toString('hex'),
    recordCount: 1,
    headRecordHash: sha256('eval-proxy-checkpoint-head').toString('hex')
  });
  const checkpointProxyRejected = throws(
    () => normalizeDlcJournalCheckpoint(new Proxy(checkpoint, handler)),
    /invalid DLC journal checkpoint/
  );
  return hookSafe && canonicalProxyRejected && checkpointProxyRejected && proxyTraps === 0;
});

check('contract APIs reject callbacks before semantic field access', 'canonical-data', 12, () => {
  const pinnedPubkeys = [0, 1, 2].map((index) => sha256(`contract-input-oracle:${index}`).toString('hex'));
  const contract = createDlcContract({
    contractId: 'eval-contract-input-boundary',
    network: 'bitcoin-testnet4',
    contractDigest: sha256('eval-contract-input-boundary').toString('hex'),
    oraclePolicy: { threshold: 2, total: 3, pinnedPubkeys },
    validatorPolicy
  });
  let recordAccessorCalls = 0;
  const hostileRecord = { ...contract };
  Object.defineProperty(hostileRecord, 'stage', {
    enumerable: true,
    get() { recordAccessorCalls++; return 'DRAFT'; }
  });
  let requestAccessorCalls = 0;
  const hostileRequest = { idempotencyKey: 'eval-hostile-transition', evidence: [] };
  Object.defineProperty(hostileRequest, 'to', {
    enumerable: true,
    get() { requestAccessorCalls++; return 'AUTHENTICATED_ORACLES'; }
  });
  let receiptAccessorCalls = 0;
  const hostileReceiptArguments = {
    privateKey: validatorKeys.privateKey,
    contractId: contract.contractId,
    contractDigest: contract.contractDigest,
    from: 'DRAFT',
    to: 'AUTHENTICATED_ORACLES',
    idempotencyKey: 'eval-hostile-receipt',
    digest: sha256('eval-hostile-receipt').toString('hex')
  };
  Object.defineProperty(hostileReceiptArguments, 'kind', {
    enumerable: true,
    get() { receiptAccessorCalls++; return 'oracle_policy'; }
  });
  const proxy = new Proxy(contract, { get() { throw new Error('contract proxy trap executed'); } });
  return throws(() => normalizeDlcContract(hostileRecord), /enumerable data property/) &&
    throws(() => transitionDlcContract(contract, hostileRequest), /enumerable data property/) &&
    throws(() => signValidationReceipt(hostileReceiptArguments), /enumerable data property/) &&
    throws(() => normalizeDlcContract(proxy), /Proxy object/) &&
    recordAccessorCalls === 0 && requestAccessorCalls === 0 && receiptAccessorCalls === 0;
});

check('operator signatures authenticate external journal checkpoints', 'state-persistence', 14, () => {
  const checkpoint = createDlcJournalCheckpoint({
    storeKind: 'contract-state',
    storeKey: sha256('eval-signed-checkpoint-store').toString('hex'),
    recordCount: 3,
    headRecordHash: sha256('eval-signed-checkpoint-head').toString('hex')
  });
  const signed = signDlcJournalCheckpoint(checkpoint, checkpointSignerKeys.privateKey);
  const envelopeHash = signedDlcJournalCheckpointHash(signed);
  const verified = verifySignedDlcJournalCheckpoint(signed, trustedCheckpointKeys, envelopeHash);
  const forged = Buffer.from(signed.signature, 'base64');
  forged[0] ^= 1;
  const forgedEnvelope = {
    ...signed,
    signature: forged.toString('base64')
  };
  const forgedRejected = throws(() => verifySignedDlcJournalCheckpoint(
    forgedEnvelope, trustedCheckpointKeys, signedDlcJournalCheckpointHash(forgedEnvelope)
  ), /signature is invalid/);
  const otherKeys = crypto.generateKeyPairSync('ed25519');
  const otherSpki = otherKeys.publicKey.export({ format: 'der', type: 'spki' });
  const untrustedRejected = throws(() => verifySignedDlcJournalCheckpoint(signed, [{
    keyId: crypto.createHash('sha256').update(otherSpki).digest('hex'),
    publicKeySpki: otherSpki.toString('base64')
  }], envelopeHash), /key is not trusted/);
  const checkpointMutationRejected = throws(() => verifySignedDlcJournalCheckpoint({
    ...signed,
    checkpoint: { ...signed.checkpoint, recordCount: 4 }
  }, trustedCheckpointKeys, envelopeHash), /checkpoint hash mismatch/);
  return verified.signerKeyId === checkpointSignerKeyId &&
    verified.checkpoint.checkpointHash === checkpoint.checkpointHash &&
    Object.isFrozen(verified) && Object.isFrozen(verified.checkpoint) &&
    forgedRejected && untrustedRejected && checkpointMutationRejected;
});

check('caller-held signed checkpoint pins reject valid older replay', 'state-persistence', 12, () => {
  const storeKey = sha256('eval-checkpoint-replay-store').toString('hex');
  const older = signDlcJournalCheckpoint(createDlcJournalCheckpoint({
    storeKind: 'contract-state',
    storeKey,
    recordCount: 2,
    headRecordHash: sha256('eval-checkpoint-replay-old').toString('hex')
  }), checkpointSignerKeys.privateKey);
  const current = signDlcJournalCheckpoint(createDlcJournalCheckpoint({
    storeKind: 'contract-state',
    storeKey,
    recordCount: 3,
    headRecordHash: sha256('eval-checkpoint-replay-current').toString('hex')
  }), checkpointSignerKeys.privateKey);
  const currentHash = signedDlcJournalCheckpointHash(current);
  return verifySignedDlcJournalCheckpoint(current, trustedCheckpointKeys, currentHash).checkpoint.recordCount === 3 &&
    throws(() => verifySignedDlcJournalCheckpoint(
      older, trustedCheckpointKeys, currentHash
    ), /replay or substitution/);
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

check('oracle envelopes and outcome arrays reject callbacks before verification', 'oracle-auth', 12, () => {
  const yes = sha256('oracle-input-eval:yes');
  const no = sha256('oracle-input-eval:no');
  let buildAccessorCalls = 0;
  const hostileBuildOptions = { outcomeMessages: [yes, no] };
  Object.defineProperty(hostileBuildOptions, 'eventId', {
    enumerable: true,
    get() { buildAccessorCalls++; return 'oracle-input-eval'; }
  });
  const buildRejected = throws(
    () => dlc.buildDlcOracle(scalar('oracle-input-eval:key-a'), scalar('oracle-input-eval:nonce-a'), hostileBuildOptions),
    /enumerable data property/
  );
  let outcomeAccessorCalls = 0;
  const hostileOutcomes = [];
  Object.defineProperty(hostileOutcomes, '0', {
    enumerable: true,
    configurable: true,
    get() { outcomeAccessorCalls++; return yes; }
  });
  hostileOutcomes.length = 1;
  const outcomesRejected = throws(() => dlc.buildDlcOracle(
    scalar('oracle-input-eval:key-b'), scalar('oracle-input-eval:nonce-b'),
    { eventId: 'oracle-input-eval-outcomes', outcomeMessages: hostileOutcomes }
  ), /enumerable data property/);
  const oracle = dlc.buildDlcOracle(
    scalar('oracle-input-eval:key-c'), scalar('oracle-input-eval:nonce-c'),
    { eventId: 'oracle-input-eval-valid', outcomeMessages: [yes, no] }
  );
  let announcementAccessorCalls = 0;
  const hostileAnnouncement = { ...oracle };
  Object.defineProperty(hostileAnnouncement, 'eventId', {
    enumerable: true,
    get() { announcementAccessorCalls++; return oracle.eventId; }
  });
  const announcementRejected = dlc.verifyDlcOracleAnnouncement(hostileAnnouncement) === false &&
    throws(() => dlc.dlcOutcomePoint(hostileAnnouncement, yes), /enumerable data property/);
  let nestedAccessorCalls = 0;
  const hostileAnnouncementOutcomes = [];
  Object.defineProperty(hostileAnnouncementOutcomes, '0', {
    enumerable: true,
    configurable: true,
    get() { nestedAccessorCalls++; return oracle.outcomeMessages[0]; }
  });
  hostileAnnouncementOutcomes.length = 1;
  const nestedRejected = dlc.verifyDlcOracleAnnouncement({
    ...oracle, outcomeMessages: hostileAnnouncementOutcomes
  }) === false;
  const wrappingKey = sha256('oracle-input-eval:wrapping');
  const sealed = dlc.sealDlcOracleSignerState(oracle, wrappingKey);
  let sealedAccessorCalls = 0;
  const hostileSealed = { ...sealed };
  Object.defineProperty(hostileSealed, 'cipher', {
    enumerable: true,
    get() { sealedAccessorCalls++; return sealed.cipher; }
  });
  const sealedRejected = throws(
    () => dlc.restoreDlcOracleSignerState(oracle, hostileSealed, wrappingKey), /enumerable data property/
  );
  return buildRejected && outcomesRejected && announcementRejected && nestedRejected && sealedRejected &&
    buildAccessorCalls === 0 && outcomeAccessorCalls === 0 && announcementAccessorCalls === 0 &&
    nestedAccessorCalls === 0 && sealedAccessorCalls === 0 &&
    Object.isFrozen(oracle) && Object.isFrozen(oracle.outcomeMessages);
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

check('fresh Core policy binds the exact funding transaction before broadcast', 'funding-safety', 10, () => {
  const pinnedPubkeys = ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)];
  const psbtDigest = sha256('prebroadcast-eval:psbt').toString('hex');
  let contract = createDlcContract({
    contractId: 'prebroadcast-eval-contract',
    network: 'bitcoin-testnet4',
    contractDigest: sha256('prebroadcast-eval-contract').toString('hex'),
    oraclePolicy: { threshold: 2, total: 3, pinnedPubkeys },
    validatorPolicy
  });
  for (const stage of [
    'AUTHENTICATED_ORACLES',
    'CANONICAL_CETS_AND_REFUND',
    'COUNTERPARTY_SIGNATURES_VERIFIED',
    'LOCAL_SIGNATURES_PERSISTED',
    'FUNDING_PSBT_APPROVED'
  ]) {
    const idempotencyKey = `prebroadcast-eval:${stage}`;
    contract = transitionDlcContract(contract, {
      to: stage,
      idempotencyKey,
      evidence: evidenceFor(contract, stage, idempotencyKey,
        stage === 'FUNDING_PSBT_APPROVED' ? { funding_psbt_validation: psbtDigest } : {})
    });
  }
  const rawTxHex = '0200000000010100000000000000000000';
  const txid = sha256('prebroadcast-eval:txid').toString('hex');
  const wtxid = sha256('prebroadcast-eval:wtxid').toString('hex');
  const bestBlockHash = sha256('prebroadcast-eval:block').toString('hex');
  const methods = [];
  const rpc = (method) => {
    methods.push(method);
    if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 250, bestblockhash: bestBlockHash };
    if (method === 'getrawmempool') return { mempool_sequence: 52 };
    if (method === 'decoderawtransaction') {
      return { txid, hash: wtxid, version: 2, size: 17, vsize: 17, weight: 68, locktime: 0 };
    }
    if (method === 'testmempoolaccept') return [{ txid, wtxid, allowed: true }];
    throw new Error(`unexpected prebroadcast RPC ${method}`);
  };
  const policyNow = new Date('2030-01-02T03:04:05.000Z');
  const checked = validateFundingPrebroadcastPolicy({
    contractState: contract, rawTxHex, rpc, now: policyNow, ttlSeconds: 30
  });
  const denied = throws(() => validateFundingPrebroadcastPolicy({
    contractState: contract,
    rawTxHex,
    rpc(method) {
      if (method === 'testmempoolaccept') return [{ txid, wtxid, allowed: false, 'reject-reason': 'policy denial' }];
      return rpc(method);
    }
  }), /rejected.*policy denial/);
  prebroadcastFixtureForEval = { contract, rawTxHex, checked, policyNow };
  return checked.record.contractRecordHash === contract.recordHash &&
    checked.record.fundingPsbtDigest === psbtDigest && checked.record.txid === txid && checked.record.wtxid === wtxid &&
    checked.record.signingAllowed === false && checked.record.sendRawTransactionAllowed === false &&
    methods.every((method) => method !== 'sendrawtransaction') && denied;
});

check('broadcast authorization is short-lived and exactly one process can consume it', 'funding-safety', 12, () => {
  if (!prebroadcastFixtureForEval) return false;
  const { contract, rawTxHex, checked, policyNow } = prebroadcastFixtureForEval;
  const idempotencyKey = 'prebroadcast-eval:broadcast';
  const transitionRequest = {
    to: 'FUNDING_BROADCAST',
    idempotencyKey,
    evidence: evidenceFor(contract, 'FUNDING_BROADCAST', idempotencyKey, {
      broadcast_transaction: checked.record.rawTransactionSha256,
      prebroadcast_bitcoin_core_policy: { digest: checked.policyDigest, metadata: checked.receiptMetadata }
    })
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-broadcast-eval-'));
  try {
    const store = new DlcBroadcastAuthorizationStore(path.join(directory, 'single'));
    const consumed = store.consume({
      contractState: contract,
      transitionRequest,
      rawTxHex,
      now: new Date(policyNow.getTime() + 10000)
    });
    const checkpoint = store.checkpoint(
      contract.contractId, idempotencyKey, consumed.consumption.transitionRequestHash
    );
    const checkpointVerified = store.verifyCheckpoint(
      contract.contractId, idempotencyKey, consumed.consumption.transitionRequestHash, checkpoint
    ).checkpointVerified === checkpoint.checkpointHash;
    const replayRejected = throws(() => store.consume({
      contractState: contract,
      transitionRequest,
      rawTxHex,
      now: new Date(policyNow.getTime() + 11000)
    }), /already durably consumed/);
    const expiredRejected = throws(() => new DlcBroadcastAuthorizationStore(path.join(directory, 'expired')).consume({
      contractState: contract,
      transitionRequest,
      rawTxHex,
      now: new Date(policyNow.getTime() + 31000)
    }), /has expired/);
    const fixturePath = path.join(directory, 'race-fixture.json');
    fs.writeFileSync(fixturePath, JSON.stringify({
      contractState: contract,
      transitionRequest,
      rawTxHex,
      now: new Date(policyNow.getTime() + 10000).toISOString()
    }));
    const race = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_broadcast_authorization_race.js'),
      path.join(directory, 'race'),
      fixturePath,
      '16'
    ], { encoding: 'utf8', windowsHide: true });
    if (race.status !== 0) return race.stderr || race.stdout || 'broadcast authorization race failed';
    const report = JSON.parse(race.stdout);
    return consumed.nextContractState.stage === 'FUNDING_BROADCAST' && checkpointVerified &&
      store.verifyAll().records === 1 &&
      replayRejected && expiredRejected && report.passed === true && report.consumed === 1 &&
      report.rejected === 15 && report.records === 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
    const checkpoint = store.checkpoint(contract.contractId);
    const revisionPath = path.join(directory, crypto.createHash('sha256').update(contract.contractId).digest('hex'),
      'revision-000000000001.json');
    const revisionBytes = fs.readFileSync(revisionPath);
    fs.unlinkSync(revisionPath);
    const shorterChainAcceptedWithoutCheckpoint = store.verifyChain(contract.contractId).revisions === 1;
    const rollbackRejected = throws(() => store.verifyCheckpoint(contract.contractId, checkpoint), /rollback detected/);
    fs.writeFileSync(revisionPath, revisionBytes, { flag: 'wx', mode: 0o600 });
    const checkpointVerified = store.verifyCheckpoint(contract.contractId, checkpoint).checkpointVerified ===
      checkpoint.checkpointHash;
    const signedCheckpoint = signDlcJournalCheckpoint(checkpoint, checkpointSignerKeys.privateKey);
    const signedCheckpointVerified = store.verifySignedCheckpoint(
      contract.contractId, signedCheckpoint, trustedCheckpointKeys,
      signedDlcJournalCheckpointHash(signedCheckpoint)
    ).checkpointSignerKeyId === checkpointSignerKeyId;
    return staleRejected && chain.ok && chain.revisions === 2 && shorterChainAcceptedWithoutCheckpoint &&
      rollbackRejected && checkpointVerified && signedCheckpointVerified;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check('durable DLC journals publish without replacement and reject linked or oversized records',
  'state-persistence', 10, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-durable-json-eval-'));
  const options = { maxBytes: 1024, label: 'eval durable record' };
  try {
    const first = { kind: 'eval_durable_record_v1', sequence: 0, digest: sha256('durable:first').toString('hex') };
    writeJsonAppendOnce(directory, 'record.json', first, options);
    const firstRead = readBoundedJson(path.join(directory, 'record.json'), options);
    const replacementRejected = throws(
      () => writeJsonAppendOnce(directory, 'record.json', { ...first, sequence: 1 }, options),
      /EEXIST|exist/i
    );
    const afterReplacement = readBoundedJson(path.join(directory, 'record.json'), options);
    const linkedPath = path.join(directory, 'record-link.json');
    fs.linkSync(path.join(directory, 'record.json'), linkedPath);
    const linkedRejected = throws(
      () => readBoundedJson(path.join(directory, 'record.json'), options),
      /one bounded regular file/
    );
    fs.unlinkSync(linkedPath);
    const oversizedPath = path.join(directory, 'oversized.json');
    fs.writeFileSync(oversizedPath, Buffer.alloc(1025, 0x20));
    const oversizedRejected = throws(
      () => readBoundedJson(oversizedPath, options),
      /one bounded regular file/
    );
    const traversalRejected = throws(() => new DlcStateStore(directory).read('..'), /unsafe path/);
    const swapPath = path.join(directory, 'swap.json');
    const displacedPath = path.join(directory, 'swap-displaced.json');
    const replacementPath = path.join(directory, 'swap-replacement.json');
    writeJsonAppendOnce(directory, 'swap.json', { sequence: 0 }, options);
    fs.writeFileSync(replacementPath, `${JSON.stringify({ sequence: 1 })}\n`);
    const originalReadSync = fs.readSync;
    let pathSwapRejected;
    try {
      let swapped = false;
      fs.readSync = function swappingReadSync(fd, buffer, offset, length, position) {
        const count = originalReadSync(fd, buffer, offset, length, position);
        if (!swapped && count > 0) {
          fs.renameSync(swapPath, displacedPath);
          fs.renameSync(replacementPath, swapPath);
          swapped = true;
        }
        return count;
      };
      pathSwapRejected = throws(() => readBoundedJson(swapPath, options), /path changed while reading/);
    } finally { fs.readSync = originalReadSync; }
    return firstRead.digest === first.digest && afterReplacement.digest === first.digest &&
      replacementRejected && linkedRejected && oversizedRejected && traversalRejected && pathSwapRejected;
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

check('crypto provider requires short-lived authorization and an audited signer subprocess', 'signer-boundary', 32, () => {
  const authorizationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-signer-eval-'));
  try {
  const disabled = createDlcCryptoProvider({ network: 'bitcoin-testnet4' });
  const explicit = createDlcCryptoProvider({
    network: 'bitcoin-testnet4',
    mode: 'experimental-js',
    allowExperimental: true,
    authorizationStore: new DlcSigningAuthorizationStore(authorizationDirectory)
  });
  const nativeSecret = scalar('signer-eval:native-secret');
  const runtimeKey = crypto.generateKeyPairSync('ed25519');
  const runtimePublicDer = runtimeKey.publicKey.export({ format: 'der', type: 'spki' });
  const runtimePrivateDer = runtimeKey.privateKey.export({ format: 'der', type: 'pkcs8' });
  const helperPath = path.join(authorizationDirectory, 'native-signer-eval.js');
  fs.writeFileSync(helperPath, `'use strict';
const crypto = require('crypto');
const fs = require('fs');
const dlc = require(${JSON.stringify(implementationPath)});
const { RESPONSE_KIND, responseSignaturePayload } = require(${JSON.stringify(nativeSignerClientPath)});
const envelope = JSON.parse(fs.readFileSync(0, 'utf8'));
if (envelope.kind !== ${JSON.stringify(NATIVE_PROCESS_REQUEST_KIND)}) throw new Error('wrong request kind');
const request = envelope.request;
if (request.secret !== undefined || request.keyHandle !== undefined) throw new Error('host secret rejected');
const validatorKey = crypto.createPublicKey({ key: Buffer.from(request.validatorPublicKeySpki, 'base64'), format: 'der', type: 'spki' });
if (!crypto.verify(null, Buffer.from(request.authorizationPayload, 'base64'), validatorKey, Buffer.from(request.authorization.signature, 'base64'))) throw new Error('authorization rejected');
const signedPayload = JSON.parse(Buffer.from(request.authorizationPayload, 'base64').toString('utf8'));
if (signedPayload.stateRecordHash !== request.stateRecordHash || signedPayload.signerPubkeyX !== request.signerPubkeyX || signedPayload.sighash !== request.sighash) throw new Error('signed request mismatch');
const presignature = dlc.adaptorSign(${nativeSecret}n, Buffer.from(request.sighash, 'hex'), { x: BigInt('0x' + request.adaptorPoint.x), y: BigInt('0x' + request.adaptorPoint.y) }, Buffer.alloc(32, 19));
const response = { kind: RESPONSE_KIND, challenge: envelope.challenge, requestDigest: envelope.requestDigest, executableSha256: crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'), identityKeyId: ${JSON.stringify(crypto.createHash('sha256').update(runtimePublicDer).digest('hex'))}, presignature };
const runtimeKey = crypto.createPrivateKey({ key: Buffer.from(${JSON.stringify(runtimePrivateDer.toString('base64'))}, 'base64'), format: 'der', type: 'pkcs8' });
response.signature = crypto.sign(null, responseSignaturePayload(response), runtimeKey).toString('base64');
process.stdout.write(JSON.stringify(response));
`, { encoding: 'utf8', mode: 0o600 });
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
    auditDigest: sha256('signer-eval:audit').toString('hex')
  };
  const auditKey = crypto.generateKeyPairSync('ed25519');
  const auditDer = auditKey.publicKey.export({ format: 'der', type: 'spki' });
  const auditKeyId = crypto.createHash('sha256').update(auditDer).digest('hex');
  const capabilities = {
    ...manifest,
    attestation: {
      keyId: auditKeyId,
      signature: crypto.sign(null, nativeCapabilityAttestationPayload(manifest), auditKey.privateKey).toString('base64')
    }
  };
  const implementation = new DlcNativeSignerProcessClient({ ...launchSpec, capabilities });
  const trustedAuditKeys = [{ keyId: auditKeyId, publicKeySpki: auditDer.toString('base64') }];
  const native = createDlcCryptoProvider({
    network: 'bitcoin-testnet4',
    mode: 'native-isolated',
    implementation,
    trustedAuditKeys,
    authorizationStore: new DlcSigningAuthorizationStore(path.join(authorizationDirectory, 'native'))
  });
  providerConfigurationFixtureForEval = { implementation, trustedAuditKeys, manifest };
  const tamperedClient = new DlcNativeSignerProcessClient({
    ...launchSpec,
    capabilities: { ...capabilities, auditDigest: sha256('signer-eval:tampered').toString('hex') }
  });
  const tamperedRejected = throws(() => createDlcCryptoProvider({
    network: 'bitcoin-testnet4',
    mode: 'native-isolated',
    implementation: tamperedClient,
    trustedAuditKeys
  }), /attestation is invalid/);
  const directObjectRejected = throws(() => createDlcCryptoProvider({
    network: 'bitcoin-testnet4',
    mode: 'native-isolated',
    implementation: {
      capabilities,
      adaptorSignAuthorized() {}, adaptorVerify() {}, adaptorComplete() {}, adaptorExtract() {}, schnorrVerify() {}
    },
    trustedAuditKeys
  }), /verified DlcNativeSignerProcessClient/);

  let contract = createDlcContract({
    contractId: 'signer-authorization-eval',
    network: 'bitcoin-testnet4',
    contractDigest: sha256('signer-authorization-eval').toString('hex'),
    oraclePolicy: { threshold: 2, total: 3, pinnedPubkeys: ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)] },
    validatorPolicy
  });
  for (const stage of ['AUTHENTICATED_ORACLES', 'CANONICAL_CETS_AND_REFUND', 'COUNTERPARTY_SIGNATURES_VERIFIED']) {
    const idempotencyKey = `signer-eval:${stage}`;
    contract = transitionDlcContract(contract, {
      to: stage,
      idempotencyKey,
      evidence: evidenceFor(contract, stage, idempotencyKey)
    });
  }
  const sighash = sha256('signer-eval:cet-sighash').toString('hex');
  const adaptorPoint = dlc.pointMul(dlc.G, scalar('signer-eval:adaptor'));
  const signerSecret = scalar('signer-eval:secret');
  const signerPubkeyX = dlc.xOnlyPubkey(signerSecret).toString('hex');
  signerAuthorizationFixtureForEval = { contract, sighash, adaptorPoint, signerSecret, signerPubkeyX };
  const authorization = createDlcAdaptorSignAuthorization({
    privateKey: validatorKeys.privateKey,
    contract,
    authorizationId: 'cet:0:oracle-set:0',
    signerPubkeyX,
    sighash,
    adaptorPoint
  });
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
  const expiredAuthorizationRejected = throws(() => authorizeDlcAdaptorSign(explicit, {
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
  const futureAuthorizationRejected = throws(() => authorizeDlcAdaptorSign(explicit, {
    contract, authorization: futureAuthorization
  }), /authorization is not yet valid/);
  const excessiveLifetimeRejected = throws(() => createDlcAdaptorSignAuthorization({
    privateKey: validatorKeys.privateKey,
    contract,
    authorizationId: 'cet:excessive-lifetime',
    signerPubkeyX,
    sighash,
    adaptorPoint,
    ttlSeconds: 301
  }), /ttlSeconds/);
  const session = authorizeDlcAdaptorSign(explicit, { contract, authorization });
  const presignature = session.execute(signerSecret, sha256('signer-eval:aux'));
  const signed = dlc.adaptorVerify(dlc.xOnlyPubkey(signerSecret), Buffer.from(sighash, 'hex'), presignature);
  const replayRejected = throws(() => session.execute(signerSecret, sha256('signer-eval:replay')), /already consumed/);
  const restartedProvider = createDlcCryptoProvider({
    network: 'bitcoin-testnet4',
    mode: 'experimental-js',
    allowExperimental: true,
    authorizationStore: new DlcSigningAuthorizationStore(authorizationDirectory)
  });
  const restartedSession = authorizeDlcAdaptorSign(restartedProvider, { contract, authorization });
  const restartReplayRejected = throws(
    () => restartedSession.execute(signerSecret, sha256('signer-eval:restart-replay')),
    /durably consumed/
  );
  const tamperedRequestRejected = throws(() => authorizeDlcAdaptorSign(explicit, {
    contract,
    authorization: { ...authorization, sighash: sha256('signer-eval:wrong-sighash').toString('hex') }
  }), /signature is invalid/);
  const tamperedLifetimeRejected = throws(() => authorizeDlcAdaptorSign(explicit, {
    contract,
    authorization: {
      ...authorization,
      expiresAtUnixSeconds: authorization.expiresAtUnixSeconds + 1
    }
  }), /signature is invalid/);
  const nativeSignerPubkeyX = dlc.xOnlyPubkey(nativeSecret).toString('hex');
  const nativeAuthorization = createDlcAdaptorSignAuthorization({
    privateKey: validatorKeys.privateKey,
    contract,
    authorizationId: 'native:cet:0:oracle-set:0',
    signerPubkeyX: nativeSignerPubkeyX,
    sighash,
    adaptorPoint
  });
  const nativeSession = authorizeDlcAdaptorSign(native, { contract, authorization: nativeAuthorization });
  const nativeSecretRejected = throws(() => nativeSession.execute(nativeSecret), /accepts no host-supplied secret/);
  const nativePresignature = nativeSession.execute();
  const nativeResponseValid = dlc.adaptorVerify(
    Buffer.from(nativeSignerPubkeyX, 'hex'), Buffer.from(sighash, 'hex'), nativePresignature
  );
  const nativeRequestPublicOnly = nativeResponseValid && implementation.capabilities.callerSuppliesSecret === false &&
    implementation.capabilities.challengeBoundResponses === true;
  return disabled.mode === 'disabled' && Object.keys(disabled.operations).length === 0 &&
    explicit.productionReady === false && explicit.capabilities.nativeSecretArithmetic === false &&
    explicit.operations.adaptorSign === undefined && explicit.signingAuthorizationPersistence === 'durable-before-sign' &&
    signed && replayRejected && restartReplayRejected && tamperedRequestRejected && tamperedLifetimeRejected &&
    expiredAuthorizationRejected && futureAuthorizationRejected && excessiveLifetimeRejected &&
    nativeSecretRejected && nativeResponseValid && nativeRequestPublicOnly &&
    native.capabilities.attestationVerified === true && native.productionReady === false &&
    tamperedRejected && directObjectRejected &&
    throws(() => createDlcCryptoProvider({
      network: 'bitcoin-mainnet',
      mode: 'experimental-js',
      allowExperimental: true
    }), /mainnet/);
  } finally {
    fs.rmSync(authorizationDirectory, { recursive: true, force: true });
  }
});

check('provider configuration rejects callbacks before signer capability access', 'signer-boundary', 12, () => {
  if (!providerConfigurationFixtureForEval) return false;
  const { implementation, trustedAuditKeys, manifest } = providerConfigurationFixtureForEval;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-provider-input-eval-'));
  try {
    let clientArgumentAccessorCalls = 0;
    const hostileClientArguments = {};
    Object.defineProperty(hostileClientArguments, 'executablePath', {
      enumerable: true,
      get() { clientArgumentAccessorCalls++; return implementation.launchSpec.executablePath; }
    });
    const clientArgumentsRejected = throws(
      () => new DlcNativeSignerProcessClient(hostileClientArguments), /enumerable data property/
    );
    let clientCapabilityAccessorCalls = 0;
    const hostileClientCapabilities = { ...implementation.capabilities };
    Object.defineProperty(hostileClientCapabilities, 'apiVersion', {
      enumerable: true,
      get() { clientCapabilityAccessorCalls++; return 1; }
    });
    const clientCapabilitiesRejected = throws(() => new DlcNativeSignerProcessClient({
      ...implementation.launchSpec, capabilities: hostileClientCapabilities
    }), /enumerable data property/);
    let launchArgumentAccessorCalls = 0;
    const hostileLaunchArguments = [];
    Object.defineProperty(hostileLaunchArguments, '0', {
      enumerable: true,
      configurable: true,
      get() { launchArgumentAccessorCalls++; return 'hostile.js'; }
    });
    hostileLaunchArguments.length = 1;
    const launchArgumentsRejected = throws(() => new DlcNativeSignerProcessClient({
      ...implementation.launchSpec,
      arguments: hostileLaunchArguments,
      capabilities: implementation.capabilities
    }), /enumerable data property/);
    let optionAccessorCalls = 0;
    const hostileOptions = {};
    Object.defineProperty(hostileOptions, 'network', {
      enumerable: true,
      get() { optionAccessorCalls++; return 'bitcoin-testnet4'; }
    });
    const optionRejected = throws(() => createDlcCryptoProvider(hostileOptions), /enumerable data property/);
    let proxyTrapCalls = 0;
    const proxyRejected = throws(() => createDlcCryptoProvider(new Proxy({ network: 'bitcoin-testnet4' }, {
      getOwnPropertyDescriptor() { proxyTrapCalls++; return undefined; }
    })), /plain object, not a Proxy/);
    let manifestAccessorCalls = 0;
    const hostileManifest = { ...manifest };
    Object.defineProperty(hostileManifest, 'apiVersion', {
      enumerable: true,
      get() { manifestAccessorCalls++; return 1; }
    });
    const manifestRejected = throws(
      () => nativeCapabilityAttestationPayload(hostileManifest), /enumerable data property/
    );
    let directCapabilityCalls = 0;
    const hostileImplementation = {};
    Object.defineProperty(hostileImplementation, 'capabilities', {
      enumerable: true,
      get() { directCapabilityCalls++; return implementation.capabilities; }
    });
    const unverifiedRejected = throws(() => createDlcCryptoProvider({
      network: 'bitcoin-testnet4', mode: 'native-isolated',
      implementation: hostileImplementation, trustedAuditKeys
    }), /verified DlcNativeSignerProcessClient/);
    let auditKeyAccessorCalls = 0;
    const hostileAuditKey = { publicKeySpki: trustedAuditKeys[0].publicKeySpki };
    Object.defineProperty(hostileAuditKey, 'keyId', {
      enumerable: true,
      get() { auditKeyAccessorCalls++; return trustedAuditKeys[0].keyId; }
    });
    const auditKeyRejected = throws(() => createDlcCryptoProvider({
      network: 'bitcoin-testnet4', mode: 'native-isolated', implementation,
      trustedAuditKeys: [hostileAuditKey]
    }), /enumerable data property/);
    const store = new DlcSigningAuthorizationStore(directory);
    let storeProxyTrapCalls = 0;
    const proxiedStore = new Proxy(store, {
      getPrototypeOf(target) { storeProxyTrapCalls++; return Reflect.getPrototypeOf(target); }
    });
    const storeRejected = throws(() => createDlcCryptoProvider({
      network: 'bitcoin-testnet4', mode: 'experimental-js', allowExperimental: true,
      authorizationStore: proxiedStore
    }), /authorizationStore/);
    let subclassConsumeCalls = 0;
    class HostileAuthorizationStore extends DlcSigningAuthorizationStore {
      consume() { subclassConsumeCalls++; return {}; }
    }
    const hostileStore = new HostileAuthorizationStore(path.join(directory, 'hostile-store'));
    const storeSubclassRejected = throws(() => createDlcCryptoProvider({
      network: 'bitcoin-testnet4', mode: 'experimental-js', allowExperimental: true,
      authorizationStore: hostileStore
    }), /authorizationStore/);
    const mutableOptions = {
      network: 'bitcoin-testnet4', mode: 'experimental-js', allowExperimental: true,
      authorizationStore: store
    };
    const provider = createDlcCryptoProvider(mutableOptions);
    mutableOptions.network = 'bitcoin-mainnet';
    mutableOptions.mode = 'disabled';
    return clientArgumentsRejected && clientCapabilitiesRejected && launchArgumentsRejected &&
      optionRejected && proxyRejected && manifestRejected && unverifiedRejected &&
      auditKeyRejected && storeRejected && storeSubclassRejected && optionAccessorCalls === 0 && proxyTrapCalls === 0 &&
      manifestAccessorCalls === 0 && directCapabilityCalls === 0 && auditKeyAccessorCalls === 0 &&
      storeProxyTrapCalls === 0 && subclassConsumeCalls === 0 && Object.isFrozen(hostileStore) &&
      clientArgumentAccessorCalls === 0 &&
      clientCapabilityAccessorCalls === 0 && launchArgumentAccessorCalls === 0 &&
      provider.network === 'bitcoin-testnet4' &&
      provider.mode === 'experimental-js';
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check('signer protocol payloads reject callbacks before process or durable effects', 'signer-boundary', 12, () => {
  if (!providerConfigurationFixtureForEval) return false;
  const { implementation } = providerConfigurationFixtureForEval;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-signer-protocol-input-eval-'));
  try {
    const store = new DlcSigningAuthorizationStore(directory);
    let consumptionAccessorCalls = 0;
    const hostileConsumption = {
      contractId: 'signer-protocol-eval',
      authorizationId: 'cet:hostile',
      stateRecordHash: sha256('signer-protocol:state').toString('hex'),
      authorizationDigest: sha256('signer-protocol:authorization').toString('hex'),
      providerIdentity: sha256('signer-protocol:provider').toString('hex')
    };
    Object.defineProperty(hostileConsumption, 'network', {
      enumerable: true,
      get() { consumptionAccessorCalls++; return 'bitcoin-testnet4'; }
    });
    const consumptionRejected = throws(
      () => store.consume(hostileConsumption), /enumerable data property/
    );
    let recordAccessorCalls = 0;
    const hostileRecord = {};
    Object.defineProperty(hostileRecord, 'kind', {
      enumerable: true,
      get() { recordAccessorCalls++; return 'hostile'; }
    });
    const recordRejected = throws(
      () => validateConsumptionRecord(hostileRecord), /enumerable data property/
    );
    let responseArgumentAccessorCalls = 0;
    const hostileResponse = {
      requestDigest: sha256('signer-protocol:request').toString('hex'),
      executableSha256: sha256('signer-protocol:executable').toString('hex'),
      presignature: { R: sha256('signer-protocol:r').toString('hex'), s0: sha256('signer-protocol:s').toString('hex') }
    };
    Object.defineProperty(hostileResponse, 'challenge', {
      enumerable: true,
      get() { responseArgumentAccessorCalls++; return sha256('signer-protocol:challenge').toString('hex'); }
    });
    const responseRejected = throws(
      () => responseSignaturePayload(hostileResponse), /enumerable data property/
    );
    let presignatureAccessorCalls = 0;
    const hostilePresignature = { s0: sha256('signer-protocol:s').toString('hex') };
    Object.defineProperty(hostilePresignature, 'R', {
      enumerable: true,
      get() { presignatureAccessorCalls++; return sha256('signer-protocol:r').toString('hex'); }
    });
    const presignatureRejected = throws(() => responseSignaturePayload({
      challenge: sha256('signer-protocol:challenge').toString('hex'),
      requestDigest: sha256('signer-protocol:request').toString('hex'),
      executableSha256: sha256('signer-protocol:executable').toString('hex'),
      presignature: hostilePresignature
    }), /enumerable data property/);
    let requestAccessorCalls = 0;
    const hostileRequest = {};
    Object.defineProperty(hostileRequest, 'kind', {
      enumerable: true,
      get() { requestAccessorCalls++; return 'hostile'; }
    });
    const requestRejected = throws(
      () => implementation.adaptorSignAuthorized(hostileRequest), /enumerable data property/
    );
    return consumptionRejected && recordRejected && responseRejected && presignatureRejected &&
      requestRejected && consumptionAccessorCalls === 0 && recordAccessorCalls === 0 &&
      responseArgumentAccessorCalls === 0 && presignatureAccessorCalls === 0 &&
      requestAccessorCalls === 0 && fs.readdirSync(directory).length === 0;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check('signer authorization snapshots reject callbacks and survive caller mutation', 'signer-boundary', 12, () => {
  if (!signerAuthorizationFixtureForEval) return false;
  const { contract, sighash, adaptorPoint, signerSecret, signerPubkeyX } = signerAuthorizationFixtureForEval;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-signer-input-eval-'));
  try {
    const provider = createDlcCryptoProvider({
      network: 'bitcoin-testnet4',
      mode: 'experimental-js',
      allowExperimental: true,
      authorizationStore: new DlcSigningAuthorizationStore(directory)
    });
    let argumentAccessorCalls = 0;
    const hostileArguments = { privateKey: validatorKeys.privateKey, contract, signerPubkeyX, sighash, adaptorPoint };
    Object.defineProperty(hostileArguments, 'authorizationId', {
      enumerable: true,
      get() { argumentAccessorCalls++; return 'signer-eval:hostile'; }
    });
    const argumentsRejected = throws(
      () => createDlcAdaptorSignAuthorization(hostileArguments), /enumerable data property/
    );
    let clockCallbackCalls = 0;
    class HostileClock extends Date {
      getTime() { clockCallbackCalls++; return super.getTime(); }
    }
    const clockAuthorization = createDlcAdaptorSignAuthorization({
      privateKey: validatorKeys.privateKey,
      contract,
      authorizationId: 'signer-eval:hostile-clock',
      signerPubkeyX,
      sighash,
      adaptorPoint,
      now: new HostileClock('2026-01-01T00:00:00.000Z')
    });
    const authorization = createDlcAdaptorSignAuthorization({
      privateKey: validatorKeys.privateKey,
      contract,
      authorizationId: 'signer-eval:mutation-safe',
      signerPubkeyX,
      sighash,
      adaptorPoint
    });
    let authorizationAccessorCalls = 0;
    const hostileAuthorization = { ...authorization };
    Object.defineProperty(hostileAuthorization, 'sighash', {
      enumerable: true,
      get() { authorizationAccessorCalls++; return authorization.sighash; }
    });
    const authorizationRejected = throws(
      () => authorizeDlcAdaptorSign(provider, { contract, authorization: hostileAuthorization }),
      /enumerable data property/
    );
    const mutableAuthorization = JSON.parse(JSON.stringify(authorization));
    const session = authorizeDlcAdaptorSign(provider, { contract, authorization: mutableAuthorization });
    mutableAuthorization.sighash = '00'.repeat(32);
    const presignature = session.execute(signerSecret, sha256('signer-input-eval:aux'));
    return argumentsRejected && authorizationRejected && argumentAccessorCalls === 0 &&
      authorizationAccessorCalls === 0 && clockCallbackCalls === 0 &&
      clockAuthorization.issuedAtUnixSeconds === 1767225600 &&
      dlc.adaptorVerify(Buffer.from(signerPubkeyX, 'hex'), Buffer.from(sighash, 'hex'), presignature);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check('signing consumption records reject filesystem aliasing, oversized data, and incomplete markers',
  'signer-boundary', 8, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-signing-store-eval-'));
  try {
    const store = new DlcSigningAuthorizationStore(directory);
    const contractId = 'signing-store-filesystem-eval';
    const authorizationId = 'cet:filesystem-boundary';
    store.consume({
      network: 'bitcoin-testnet4',
      contractId,
      authorizationId,
      stateRecordHash: sha256('signing-store:state').toString('hex'),
      authorizationDigest: sha256('signing-store:authorization').toString('hex'),
      providerIdentity: sha256('signing-store:provider').toString('hex')
    });
    const restartReadable = new DlcSigningAuthorizationStore(directory).read(contractId, authorizationId);
    const checkpoint = store.checkpoint(contractId, authorizationId);
    const checkpointVerified = store.verifyCheckpoint(contractId, authorizationId, checkpoint).checkpointVerified ===
      checkpoint.checkpointHash;
    const accessorCheckpoint = { ...checkpoint };
    Object.defineProperty(accessorCheckpoint, 'recordCount', { enumerable: true, get: () => 1 });
    const accessorRejected = throws(
      () => store.verifyCheckpoint(contractId, authorizationId, accessorCheckpoint),
      /plain data properties/
    );
    const recordDirectory = path.join(directory, restartReadable.consumptionKey);
    const recordPath = path.join(recordDirectory, 'consumed.json');
    const linkedPath = path.join(directory, 'linked-consumption.json');
    fs.linkSync(recordPath, linkedPath);
    const linkedRejected = throws(() => store.read(contractId, authorizationId), /one bounded regular file/);
    fs.unlinkSync(linkedPath);
    const original = fs.readFileSync(recordPath);
    fs.writeFileSync(recordPath, Buffer.alloc(32769, 0x20));
    const oversizedRejected = throws(() => store.read(contractId, authorizationId), /one bounded regular file/);
    fs.writeFileSync(recordPath, original);
    const incompleteDirectory = path.join(directory, sha256('signing-store:incomplete').toString('hex'));
    fs.mkdirSync(incompleteDirectory);
    const incompleteRejected = throws(() => store.verifyAll(), /incomplete consumption marker/);
    return restartReadable.status === 'CONSUMED_BEFORE_SIGN' && checkpointVerified && accessorRejected &&
      linkedRejected && oversizedRejected && incompleteRejected;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check('signer runtime closure binds file identity and detects mutation during execution', 'signer-boundary', 8, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-signer-midflight-eval-'));
  try {
    const runtimeKey = crypto.generateKeyPairSync('ed25519');
    const runtimePublicDer = runtimeKey.publicKey.export({ format: 'der', type: 'spki' });
    const helperPath = path.join(directory, 'self-mutating-signer.js');
    fs.writeFileSync(helperPath, `'use strict';
const fs = require('fs');
fs.readFileSync(0, 'utf8');
fs.appendFileSync(__filename, '\\n// midflight mutation\\n');
process.stdout.write('{}');
`, { encoding: 'utf8', mode: 0o600 });
    const linkedPath = path.join(directory, 'linked-signer.js');
    fs.linkSync(helperPath, linkedPath);
    const linkedRejected = throws(() => nativeSignerRuntimeDigest({
      executablePath: fs.realpathSync(process.execPath),
      arguments: [helperPath],
      codePaths: [helperPath]
    }), /one filesystem link/);
    fs.unlinkSync(linkedPath);
    const launchSpec = {
      executablePath: fs.realpathSync(process.execPath),
      arguments: [helperPath],
      codePaths: [helperPath]
    };
    const capabilities = {
      binaryDigest: nativeSignerRuntimeDigest(launchSpec),
      executableSha256: nativeSignerExecutableDigest(launchSpec),
      runtimeIdentityKeyId: crypto.createHash('sha256').update(runtimePublicDer).digest('hex'),
      runtimeIdentityPublicKeySpki: runtimePublicDer.toString('base64')
    };
    const client = new DlcNativeSignerProcessClient({ ...launchSpec, capabilities });
    return linkedRejected && throws(
      () => client.adaptorSignAuthorized({ kind: 'midflight-runtime-drift-probe' }),
      /runtime closure changed during execution/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check('16 concurrent signer workers admit exactly one authorization consumer', 'signer-concurrency', 8, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-signer-race-eval-'));
  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_signing_authorization_race.js'),
      directory,
      '16'
    ], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) return result.stderr || result.stdout || 'signer concurrency probe failed';
    const report = JSON.parse(result.stdout);
    return report.passed === true && report.workers === 16 && report.consumed === 1 &&
      report.rejected === 15 && report.records === 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
    const checkpoint = restarted.checkpoint({ oraclePubkey: announcement.px, eventId: announcement.eventId });
    const checkpointVerified = restarted.verifyCheckpoint(
      { oraclePubkey: announcement.px, eventId: announcement.eventId }, checkpoint
    ).checkpointVerified === checkpoint.checkpointHash;
    restarted.close();
    return valid && conflictRejected && chain.ok && chain.revisions === 2 && checkpointVerified;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

check('CET and refund set is canonically bound to one funding outpoint', 'transaction-safety', 12, () => {
  const { funding } = twoPartyFunding({
    label: 'transaction-eval', txid: 'aa'.repeat(32), vout: 1, valueSats: 100000n
  });
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
  const raw = (outputs, locktime, txid = funding.txid, sequence = 0xfffffffe) => serializeUnsignedTx(
    2,
    [{ outpoint: outpoint(txid, funding.vout), sequence }],
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
      rawTxHex: raw(refundOutputs, 200, funding.txid, REFUND_CSV_BLOCKS),
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
  const { funding } = twoPartyFunding({
    label: 'truc-eval', txid: 'ac'.repeat(32), vout: 0, valueSats: 100000n
  });
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
  const raw = (version, outputs, locktime, sequence = 0xfffffffe) => serializeUnsignedTx(
    version,
    [{ outpoint: outpoint(funding.txid, funding.vout), sequence }],
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
    refund: {
      rawTxHex: raw(3, refundOutputs, 200, REFUND_CSV_BLOCKS), expectedOutputs: refundOutputs, locktime: 200
    },
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

check('transaction construction rejects getters and Proxy traps before validation', 'canonical-data', 12, () => {
  let accessorCalls = 0;
  const funding = { txid: 'ab'.repeat(32), valueSats: 100000n, scriptPubKeyHex: `5120${'44'.repeat(32)}` };
  Object.defineProperty(funding, 'vout', {
    enumerable: true,
    get() { accessorCalls++; return 0; }
  });
  const input = { funding, cets: [], refund: {}, minFeeSats: 0n, maxFeeSats: 1000n, feePolicy: {} };
  let proxyTraps = 0;
  const proxy = new Proxy(input, {
    getPrototypeOf(target) { proxyTraps++; return Reflect.getPrototypeOf(target); },
    ownKeys(target) { proxyTraps++; return Reflect.ownKeys(target); }
  });
  return throws(() => validateDlcTransactionSet(input), /enumerable data property/) && accessorCalls === 0 &&
    throws(() => validateDlcTransactionSet(proxy), /Proxy object/) && proxyTraps === 0;
});

check('chain guard halts on disconnected ancestry and uncommitted funding spends', 'chain-safety', 12, () => {
  const { funding, secrets: fundingSecrets } = twoPartyFunding({
    label: 'chain-guard', txid: 'ab'.repeat(32), vout: 2, valueSats: 100000n
  });
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
  const raw = (outputs, locktime, sequence = 0xfffffffe) => serializeUnsignedTx(
    2,
    [{ outpoint: outpoint(funding.txid, funding.vout), sequence }],
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
    refund: {
      rawTxHex: raw(refundOutputs, 200, REFUND_CSV_BLOCKS), expectedOutputs: refundOutputs, locktime: 200
    },
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
  peerFixtureForEval = { transactionSet, contract, fundingSecrets };
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

check('contract and transaction snapshots survive mutation during external Core RPC', 'chain-safety', 12, () => {
  if (!peerFixtureForEval) return false;
  const { contract, transactionSet } = peerFixtureForEval;
  const mutableContract = JSON.parse(JSON.stringify(contract));
  const mutableTransactionSet = JSON.parse(JSON.stringify(transactionSet));
  const bestBlockHash = sha256('contract-snapshot:core-tip').toString('hex');
  let mutationInjected = false;
  const observed = observeAndEvaluateDlcChain({
    contractState: mutableContract,
    transactionSet: mutableTransactionSet,
    rpc(method) {
      if (!mutationInjected) {
        mutationInjected = true;
        mutableContract.stage = 'DRAFT';
        mutableTransactionSet.funding.vout = 99;
      }
      if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 205, bestblockhash: bestBlockHash };
      if (method === 'getrawmempool') return { mempool_sequence: 11 };
      if (method === 'gettxout') return { bestblock: bestBlockHash, confirmations: 6 };
      throw new Error(`unexpected mocked Core RPC ${method}`);
    }
  });
  return mutationInjected && mutableContract.stage === 'DRAFT' && mutableTransactionSet.funding.vout === 99 &&
    observed.evaluation.status === 'FUNDING_CONFIRMED';
});

check('CET and refund policy receipts bind exact committed execution bytes', 'funding-safety', 10, () => {
  if (!peerFixtureForEval) return false;
  const { contract, transactionSet, fundingSecrets } = peerFixtureForEval;
  // The execution guard now verifies the settlement witness, so the fixture
  // carries both parties' real signatures instead of 64 arbitrary bytes.
  const checkExecution = (executionType, transaction, executionEvidenceDigest) => {
    const signedTxHex = signSettlement({
      transactionSet,
      executionType,
      ...(executionType === 'cet' ? { cetTxid: transaction.txid } : {}),
      secrets: fundingSecrets,
      auxLabel: `execution-eval:${executionType}`
    });
    const parsed = parseCanonicalSignedTaprootTransaction(signedTxHex);
    const bestBlockHash = sha256(`execution-eval:${executionType}:block`).toString('hex');
    return validateExecutionPrebroadcastPolicy({
      contractState: contract,
      transactionSet,
      executionType,
      ...(executionType === 'cet' ? { cetTxid: transaction.txid } : {}),
      signedTxHex,
      executionEvidenceDigest,
      rpc(method) {
        if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 205, bestblockhash: bestBlockHash };
        if (method === 'getrawmempool') return { mempool_sequence: 71 };
        if (method === 'decoderawtransaction') {
          const strippedSize = parsed.strippedRawTxHex.length / 2;
          const totalSize = signedTxHex.length / 2;
          const weight = strippedSize * 4 + totalSize - strippedSize;
          return {
            txid: parsed.txid, hash: parsed.wtxid, version: parsed.version,
            size: totalSize, vsize: Math.ceil(weight / 4), weight, locktime: parsed.locktime
          };
        }
        if (method === 'testmempoolaccept') return [{ txid: parsed.txid, wtxid: parsed.wtxid, allowed: true }];
        throw new Error(`unexpected execution eval RPC ${method}`);
      }
    });
  };
  const oracleDigest = sha256('execution-eval:oracle').toString('hex');
  const cet = checkExecution('cet', transactionSet.cets[0], oracleDigest);
  const cetKey = 'execution-eval:cet';
  const cetExecuted = transitionDlcContract(contract, {
    to: 'CET_EXECUTED',
    idempotencyKey: cetKey,
    evidence: evidenceFor(contract, 'CET_EXECUTED', cetKey, {
      cet_broadcast_transaction: cet.record.rawTransactionSha256,
      oracle_threshold_attestation: oracleDigest,
      cet_prebroadcast_bitcoin_core_policy: { digest: cet.policyDigest, metadata: cet.receiptMetadata }
    })
  });
  const maturityDigest = sha256('execution-eval:maturity').toString('hex');
  const refund = checkExecution('refund', transactionSet.refund, maturityDigest);
  const refundKey = 'execution-eval:refund';
  const refundExecuted = transitionDlcContract(contract, {
    to: 'REFUND_EXECUTED',
    idempotencyKey: refundKey,
    evidence: evidenceFor(contract, 'REFUND_EXECUTED', refundKey, {
      refund_broadcast_transaction: refund.record.rawTransactionSha256,
      refund_maturity: maturityDigest,
      refund_prebroadcast_bitcoin_core_policy: { digest: refund.policyDigest, metadata: refund.receiptMetadata }
    })
  });
  const substitutionRejected = throws(() => transitionDlcContract(contract, {
    to: 'CET_EXECUTED',
    idempotencyKey: 'execution-eval:substitution',
    evidence: evidenceFor(contract, 'CET_EXECUTED', 'execution-eval:substitution', {
      cet_broadcast_transaction: sha256('execution-eval:different-bytes').toString('hex'),
      oracle_threshold_attestation: oracleDigest,
      cet_prebroadcast_bitcoin_core_policy: { digest: cet.policyDigest, metadata: cet.receiptMetadata }
    })
  }), /does not bind the broadcast transaction digest/);
  return cetExecuted.stage === 'CET_EXECUTED' && refundExecuted.stage === 'REFUND_EXECUTED' && substitutionRejected &&
    cet.record.sendRawTransactionAllowed === false && refund.record.sendRawTransactionAllowed === false;
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
    const checkpoint = verifier.checkpoint(contract.contractId);
    const checkpointVerified = verifier.verifyCheckpoint(contract.contractId, checkpoint).checkpointVerified ===
      checkpoint.checkpointHash;
    return first.recordHash === retry.recordHash && halt.evaluation.status === 'REORG_HALT' &&
      halt.alert.code === 'REORG_HALT' && chain.observations === 2 &&
      checkpointVerified && verifier.alerts(contract.contractId).length === 1 &&
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
    const checkpoint = store.checkpoint('eval-offerer', temporaryContractId);
    const restarted = new DlcPeerSessionStore(directory);
    durableReplay = restarted.knownTemporaryContractIds('eval-offerer').includes(temporaryContractId) &&
      restarted.verifyCheckpoint('eval-offerer', temporaryContractId, checkpoint).checkpointVerified ===
        checkpoint.checkpointHash;
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
  const { funding, secrets: [signerSecret] } = twoPartyFunding({
    label: 'signature-eval', txid: '99'.repeat(32), vout: 0, valueSats: 100000n
  });
  const signerPubkeyX = dlc.xOnlyPubkey(signerSecret).toString('hex');
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
  const raw = (outputs, locktime, sequence = 0xfffffffe) => serializeUnsignedTx(
    2,
    [{ outpoint: outpoint(funding.txid, funding.vout), sequence }],
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
    refund: {
      rawTxHex: raw(refundOutputs, 200, REFUND_CSV_BLOCKS), expectedOutputs: refundOutputs, locktime: 200
    },
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy
  });
  const cet = transactionSet.cets[0];
  // Settlement signatures commit to the BIP341 script-path sighash of the leaf spent.
  const cetSighash = settlementSighashForTransactionSet({ transactionSet, executionType: 'cet', cetTxid: cet.txid });
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
  const refundSighash = settlementSighashForTransactionSet({ transactionSet, executionType: 'refund' });
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

check('signed refund recovery survives restart and rejects artifact substitution', 'funding-safety', 16, () => {
  const { funding, secrets: fundingSecrets } = twoPartyFunding({
    label: 'refund-recovery-eval', txid: '98'.repeat(32), vout: 0, valueSats: 100000n
  });
  const feePolicy = {
    strategy: 'cpfp-anchor-v1',
    anchorAmountSats: 330n,
    anchorScriptPubKeyHex: `0014${'a9'.repeat(20)}`,
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
  const cetOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `0014${'b9'.repeat(20)}` }, anchor];
  const refundOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `5120${'c9'.repeat(32)}` }, anchor];
  const transactionSet = validateDlcTransactionSet({
    funding,
    cets: [{
      outcomeMessage: sha256('refund-recovery-eval:outcome').toString('hex'),
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
  let contract = createDlcContract({
    contractId: 'refund-recovery-eval',
    network: 'bitcoin-testnet4',
    contractDigest: sha256('refund-recovery-eval:contract').toString('hex'),
    oraclePolicy: { threshold: 2, total: 3, pinnedPubkeys: ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)] },
    validatorPolicy
  });
  for (const stage of ['AUTHENTICATED_ORACLES', 'CANONICAL_CETS_AND_REFUND', 'COUNTERPARTY_SIGNATURES_VERIFIED']) {
    const idempotencyKey = `refund-recovery-eval:${stage}`;
    const overrides = stage === 'CANONICAL_CETS_AND_REFUND' ? {
      cet_set: transactionSet.cetSetDigest,
      fee_policy: transactionSet.feePolicyDigest,
      funding_template: transactionSet.fundingTemplateDigest,
      refund_transaction: transactionSet.refundTransactionDigest
    } : {};
    contract = transitionDlcContract(contract, {
      to: stage,
      idempotencyKey,
      evidence: evidenceFor(contract, stage, idempotencyKey, overrides)
    });
  }
  // The stored refund carries both parties' signatures on the CSV refund leaf.
  const signed = (auxiliary) => signSettlement({
    transactionSet, executionType: 'refund', secrets: fundingSecrets, auxLabel: auxiliary
  });
  const signedRefundTxHex = signed('refund-recovery-eval:aux:one');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-refund-recovery-eval-'));
  try {
    const store = new DlcRefundRecoveryStore(directory);
    const stored = store.store({ contractState: contract, transactionSet, signedRefundTxHex });
    const restartRestored = new DlcRefundRecoveryStore(directory).restore({ contractState: contract, transactionSet });
    const checkpoint = store.checkpoint(contract.contractId);
    const checkpointVerified = store.verifyCheckpoint(contract.contractId, checkpoint).checkpointVerified ===
      checkpoint.checkpointHash;
    const raceFixturePath = path.join(directory, 'race-fixture.json');
    fs.writeFileSync(raceFixturePath, JSON.stringify({
      contractState: contract,
      transactionSet,
      signedRefunds: Array.from({ length: 16 }, (_, index) => signed(`refund-recovery-eval:race:${index}`))
    }));
    const race = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'bitvm3', 'utxo_referee', 'dlc_refund_recovery_race.js'),
      path.join(directory, 'race-store'),
      raceFixturePath,
      '16'
    ], { encoding: 'utf8', windowsHide: true });
    if (race.status !== 0) return race.stderr || race.stdout || 'refund recovery race failed';
    const raceReport = JSON.parse(race.stdout);
    const racePassed = raceReport.passed === true && raceReport.stored === 1 &&
      raceReport.rejected === 15 && raceReport.records === 1;
    const idempotencyKey = 'refund-recovery-eval:LOCAL_SIGNATURES_PERSISTED';
    contract = transitionDlcContract(contract, {
      to: 'LOCAL_SIGNATURES_PERSISTED',
      idempotencyKey,
      evidence: evidenceFor(contract, 'LOCAL_SIGNATURES_PERSISTED', idempotencyKey, {
        refund_restore_test: restartRestored.restoreDigest
      })
    });
    const postTransitionRestored = new DlcRefundRecoveryStore(directory).restore({ contractState: contract, transactionSet });
    const recordPath = path.join(directory, refundRecoveryKey(contract.contractId), 'refund.json');
    const original = fs.readFileSync(recordPath);
    const replacement = JSON.parse(original.toString('utf8'));
    replacement.signedRefundTxHex = signed('refund-recovery-eval:aux:two');
    replacement.refundWtxid = parseCanonicalSignedTaprootTransaction(replacement.signedRefundTxHex).wtxid;
    replacement.recordHash = refundRecoveryRecordHash(replacement);
    fs.writeFileSync(recordPath, `${JSON.stringify(replacement, null, 2)}\n`);
    const substitutionRejected = throws(
      () => store.restore({ contractState: contract, transactionSet }),
      /restore receipt digest/
    );
    fs.writeFileSync(recordPath, original);
    const linkedPath = path.join(directory, 'refund-link.json');
    fs.linkSync(recordPath, linkedPath);
    const linkedRejected = throws(
      () => store.restore({ contractState: contract, transactionSet }),
      /one bounded regular file/
    );
    return stored.recordHash === restartRestored.restoreDigest && checkpointVerified &&
      postTransitionRestored.restoreDigest === stored.recordHash && racePassed && substitutionRejected && linkedRejected;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function twoPartyTransactionSet(label, fundingTxid) {
  const fixture = twoPartyFunding({ label, txid: fundingTxid, vout: 0, valueSats: 100000n });
  const feePolicy = {
    strategy: 'cpfp-anchor-v1',
    anchorAmountSats: 330n,
    anchorScriptPubKeyHex: `0014${'aa'.repeat(20)}`,
    maxRecoveryFeeSats: 150000n,
    maxRecoveryFeerateSatPerVb: 500,
    minRelayPeers: 2
  };
  const anchor = { valueSats: feePolicy.anchorAmountSats, scriptPubKeyHex: feePolicy.anchorScriptPubKeyHex };
  const cetOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `0014${'88'.repeat(20)}` }, anchor];
  const refundOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `5120${'77'.repeat(32)}` }, anchor];
  const raw = (outputs, locktime, sequence) => serializeUnsignedTx(
    2,
    [{ outpoint: outpoint(fundingTxid, 0), sequence }],
    outputs.map((item) => ({ valueSats: item.valueSats, script: item.scriptPubKeyHex })),
    locktime
  );
  const input = (funding, refundSequence = REFUND_CSV_BLOCKS) => ({
    funding,
    cets: [{
      outcomeMessage: sha256(`${label}:outcome`).toString('hex'),
      oraclePubkeys: ['11'.repeat(32), '22'.repeat(32)],
      rawTxHex: raw(cetOutputs, 100, 0xfffffffe),
      expectedOutputs: cetOutputs,
      locktime: 100
    }],
    refund: { rawTxHex: raw(refundOutputs, 200, refundSequence), expectedOutputs: refundOutputs, locktime: 200 },
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy
  });
  return { ...fixture, input, transactionSet: validateDlcTransactionSet(input(fixture.funding)) };
}

check('funding output is the NUMS-keyed two-party script and no single key can fund a DLC', 'funding-safety', 14, () => {
  const { funding, output, secrets, input, transactionSet } = twoPartyTransactionSet('two-party-funding-eval', '97'.repeat(32));
  const partyKeys = secrets.map((secret) => dlc.xOnlyPubkey(secret).toString('hex'));
  const singleKeyRejected = partyKeys.every((key) => throws(
    () => validateDlcTransactionSet(input({ ...funding, scriptPubKeyHex: `5120${key}` })),
    /not the two-party DLC output/
  ));
  const legacyShapeRejected = throws(() => validateDlcTransactionSet(input({
    txid: funding.txid, vout: funding.vout, valueSats: funding.valueSats, scriptPubKeyHex: `5120${partyKeys[0]}`
  })), /partyPubkeyXs must contain exactly two/);
  const customInternalKeyRejected = throws(() => buildDlcFundingOutput({
    partyPubkeyXs: output.partyPubkeyXs, refundCsvBlocks: REFUND_CSV_BLOCKS, internalXonly: partyKeys[0]
  }), /custom internal key is forbidden/);
  const refundWithoutCsvRejected = throws(
    () => validateDlcTransactionSet(input(funding, 0xfffffffe)),
    /refund input sequence must equal the committed refund CSV delay/
  );
  const [first, second] = output.partyPubkeyXs;
  return singleKeyRejected && legacyShapeRejected && customInternalKeyRejected && refundWithoutCsvRejected &&
    !partyKeys.includes(output.internalXonly) && !partyKeys.includes(output.outputKeyXonly) &&
    output.cetLeaf.scriptHex === `20${first}ad20${second}ac` &&
    output.refundLeaf.scriptHex === `029000b27520${first}ad20${second}ac` &&
    transactionSet.funding.cetLeafHash === output.cetLeaf.leafHash &&
    transactionSet.funding.refundLeafHash === output.refundLeaf.leafHash;
});

check('settlement requires both parties on the committed leaf and rejects outsiders and key-path signatures',
  'signature-safety', 14, () => {
    const { funding, output, secrets, transactionSet } = twoPartyTransactionSet('two-party-witness-eval', '96'.repeat(32));
    const [localSecret, counterpartySecret] = secrets;
    const pubkey = (secret) => dlc.xOnlyPubkey(secret).toString('hex');
    const refundSighash = settlementSighashForTransactionSet({ transactionSet, executionType: 'refund' });
    const keyPathSighash = bip341SighashDefault(
      toBip341Transaction(parseCanonicalUnsignedTransaction(transactionSet.refund.rawTxHex)),
      [{ amountSats: funding.valueSats, scriptPubKey: funding.scriptPubKeyHex }],
      0
    );
    const sign = (secret, sighash, label) => dlc.schnorrSign(secret, sighash, sha256(label)).toString('hex');
    const local = sign(localSecret, refundSighash, 'two-party-witness-eval:local');
    const counterparty = sign(counterpartySecret, refundSighash, 'two-party-witness-eval:counterparty');
    const signedTxHex = assembleSignedSettlement({
      transactionSet,
      executionType: 'refund',
      signatures: { [pubkey(localSecret)]: local, [pubkey(counterpartySecret)]: counterparty }
    });
    const parsed = parseCanonicalSignedTaprootTransaction(signedTxHex);
    const oneSignerRejected = throws(() => assembleSignedSettlement({
      transactionSet,
      executionType: 'refund',
      signatures: { [pubkey(localSecret)]: local, [pubkey(counterpartySecret)]: local }
    }), /valid signature from both parties/);
    const keyPathSignatureRejected = throws(() => validateRefundSignature({
      transactionSet, funding, signerPubkeyX: pubkey(localSecret),
      signature: sign(localSecret, keyPathSighash, 'two-party-witness-eval:keypath')
    }), /refund signature is invalid/);
    const outsiderSecret = scalar('two-party-witness-eval:outsider');
    const outsiderRejected = throws(() => validateRefundSignature({
      transactionSet, funding, signerPubkeyX: pubkey(outsiderSecret),
      signature: sign(outsiderSecret, refundSighash, 'two-party-witness-eval:outsider')
    }), /not a party to the two-party DLC funding output/);
    const unsigned = transactionSet.refund.rawTxHex;
    const keyPathWitnessRejected = throws(() => parseCanonicalSignedTaprootTransaction(
      `${unsigned.slice(0, 8)}0001${unsigned.slice(8, -8)}0140${local}${unsigned.slice(-8)}`
    ), /two-signature Taproot script-path witness/);
    return parsed.witness[0].length === 4 && parsed.witness[0][2] === output.refundLeaf.scriptHex &&
      parsed.witness[0][3] === output.refundLeaf.controlBlock && !refundSighash.equals(keyPathSighash) &&
      oneSignerRejected && keyPathSignatureRejected && outsiderRejected && keyPathWitnessRejected;
  });

const earned = cases.filter((test) => test.passed).reduce((sum, test) => sum + test.points, 0);
const possible = cases.reduce((sum, test) => sum + test.points, 0);
const score = earned / possible;
const report = {
  benchmark: 'utxoref-dlc-security',
  version: 41,
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
