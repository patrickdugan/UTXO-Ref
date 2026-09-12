'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson, validateDlcContract } = require('./dlc_contract_state');
const { validateDlcTransactionSetCommitments } = require('./dlc_transaction_validator');
const { evaluateDlcChainSnapshot } = require('./dlc_chain_guard');
const { captureDlcAnchorRecoverySnapshot } = require('./dlc_bitcoin_core_observer');
const { evaluateDlcAnchorRecovery } = require('./dlc_anchor_recovery_guard');

const KIND = 'utxoref_dlc_watchtower_observation_v1';

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function requireHash(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be lowercase hash`);
  return value;
}
function requireId(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error(`${name} contains unsafe characters`);
  }
  return value;
}
function normalize(value) { return JSON.parse(canonicalJson(value)); }
function asPublicKey(key) {
  return key && key.type === 'public' ? key : crypto.createPublicKey(key);
}
function publicKeyDer(key) {
  const publicKey = asPublicKey(key);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('watchtower key must be Ed25519');
  return publicKey.export({ format: 'der', type: 'spki' });
}
function recordDigest(record) {
  const unsigned = { ...record };
  delete unsigned.recordDigest;
  delete unsigned.signature;
  delete unsigned.recordHash;
  return hash(Buffer.from(canonicalJson(unsigned), 'utf8'));
}
function recordHash(record) {
  const value = { ...record };
  delete value.recordHash;
  return hash(Buffer.from(canonicalJson(value), 'utf8'));
}
function contractKey(contractId) {
  requireId(contractId, 'contractId');
  return hash(Buffer.from(contractId, 'utf8'));
}
function observationType(record) { return record.observationType === undefined ? 'chain' : record.observationType; }

function validateObservationRecord(record, publicKey, expected = {}) {
  if (!record || record.kind !== KIND || !['bitcoin-testnet4', 'bitcoin-regtest'].includes(record.network) ||
      !['chain', 'anchor-recovery'].includes(observationType(record)) ||
      !Number.isSafeInteger(record.sequence) || record.sequence < 0 ||
      !Number.isSafeInteger(record.contractRevision) || record.contractRevision < 0 ||
      record.contractKey !== contractKey(record.contractId) ||
      record.previousRecordHash !== null && !/^[0-9a-f]{64}$/.test(record.previousRecordHash || '')) {
    throw new Error('DLC watchtower observation is malformed');
  }
  requireId(record.watchtowerId, 'watchtowerId');
  for (const [name, value] of Object.entries({
    watchtowerKeyId: record.watchtowerKeyId,
    contractDigest: record.contractDigest,
    contractStateRecordHash: record.contractStateRecordHash,
    transactionValidationDigest: record.transactionValidationDigest,
    snapshotDigest: record.snapshotDigest,
    recordDigest: record.recordDigest,
    recordHash: record.recordHash
  })) requireHash(value, name);
  if (!record.snapshot || !record.evaluation || typeof record.evaluation.ok !== 'boolean' ||
      record.evaluation.halt !== !record.evaluation.ok ||
      typeof record.evaluation.status !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(record.evaluation.status) ||
      typeof record.evaluation.reason !== 'string' || record.evaluation.reason.length < 1 || record.evaluation.reason.length > 512 ||
      record.snapshotDigest !== hash(Buffer.from(canonicalJson(record.snapshot), 'utf8'))) {
    throw new Error('DLC watchtower snapshot or evaluation is malformed');
  }
  if (observationType(record) === 'anchor-recovery') {
    const snapshot = record.snapshot;
    const anchorMatch = typeof snapshot.anchorOutpoint === 'string'
      ? /^([0-9a-f]{64}):(0|[1-9][0-9]{0,9})$/.exec(snapshot.anchorOutpoint)
      : null;
    if (record.observationType !== 'anchor-recovery' || snapshot.observer !== 'bitcoin-core-rpc-v1' ||
        !Number.isSafeInteger(snapshot.tipHeight) || snapshot.tipHeight < 0 ||
        !Number.isSafeInteger(snapshot.mempoolSequence) || snapshot.mempoolSequence < 0 ||
        !Number.isSafeInteger(snapshot.anchorConfirmations) || snapshot.anchorConfirmations < 0 ||
        typeof snapshot.anchorPresent !== 'boolean' || typeof snapshot.fullRbf !== 'boolean' ||
        !Number.isSafeInteger(snapshot.incrementalRelayFeeSatPerVb) || snapshot.incrementalRelayFeeSatPerVb < 1 ||
        !anchorMatch || anchorMatch[1] !== snapshot.settlementTxid || Number(anchorMatch[2]) > 0xffffffff ||
        !Array.isArray(snapshot.nodeViews) || snapshot.nodeViews.length < 1 || snapshot.nodeViews.length > 16 ||
        !Array.isArray(snapshot.expectedRecoveryTxids) ||
        new Set(snapshot.expectedRecoveryTxids).size !== snapshot.expectedRecoveryTxids.length) {
      throw new Error('DLC watchtower anchor observation is malformed');
    }
    requireHash(snapshot.bestBlockHash, 'anchor bestBlockHash');
    requireHash(snapshot.settlementTxid, 'anchor settlementTxid');
    const nodeIds = snapshot.nodeViews.map((view, index) => {
      if (!view || !Number.isSafeInteger(view.tipHeight) || view.tipHeight < 0 ||
          !Number.isSafeInteger(view.mempoolSequence) || view.mempoolSequence < 0) {
        throw new Error(`nodeViews[${index}] is malformed`);
      }
      requireHash(view.bestBlockHash, `nodeViews[${index}].bestBlockHash`);
      return requireId(view.nodeId, `nodeViews[${index}].nodeId`);
    });
    if (new Set(nodeIds).size !== nodeIds.length || snapshot.nodeViews[0].bestBlockHash !== snapshot.bestBlockHash ||
        snapshot.nodeViews[0].tipHeight !== snapshot.tipHeight ||
        snapshot.nodeViews[0].mempoolSequence !== snapshot.mempoolSequence) {
      throw new Error('DLC watchtower node views are inconsistent');
    }
    snapshot.expectedRecoveryTxids.forEach((txid, index) => requireHash(txid, `expectedRecoveryTxids[${index}]`));
    if (snapshot.proposedRecovery) {
      requireHash(snapshot.proposedRecovery.wtxid, 'proposedRecovery.wtxid');
      requireHash(snapshot.proposedRecovery.rawTxDigest, 'proposedRecovery.rawTxDigest');
      const corePolicy = snapshot.proposedRecovery.corePolicy;
      if (!Number.isSafeInteger(snapshot.proposedRecovery.version) || snapshot.proposedRecovery.version < 1 ||
          snapshot.proposedRecovery.version > 3 || !corePolicy || corePolicy.method !== 'testmempoolaccept' ||
          typeof corePolicy.allowed !== 'boolean' ||
          (corePolicy.allowed && corePolicy.rejectReason !== null) ||
          (!corePolicy.allowed && (typeof corePolicy.rejectReason !== 'string' ||
            corePolicy.rejectReason.length < 1 || corePolicy.rejectReason.length > 512))) {
        throw new Error('DLC watchtower proposed recovery policy evidence is malformed');
      }
    }
    if (snapshot.observedSpend && !snapshot.observedSpend.confirmed) {
      const relayNodeIds = snapshot.observedSpend.relayNodeIds;
      if (!Array.isArray(relayNodeIds) || relayNodeIds.length !== snapshot.observedSpend.relayPeers ||
          new Set(relayNodeIds).size !== relayNodeIds.length ||
          relayNodeIds.some((nodeId) => !nodeIds.includes(nodeId))) {
        throw new Error('DLC watchtower relay-node evidence is malformed');
      }
      relayNodeIds.forEach((nodeId, index) => requireId(nodeId, `relayNodeIds[${index}]`));
    }
  }
  if ((record.evaluation.halt && (!record.alert || record.alert.code !== record.evaluation.status ||
      record.alert.severity !== 'critical')) || (!record.evaluation.halt && record.alert !== null)) {
    throw new Error('DLC watchtower alert does not match its evaluation');
  }
  const der = publicKeyDer(publicKey);
  const keyId = hash(der);
  if (record.watchtowerKeyId !== keyId || (expected.watchtowerKeyId && expected.watchtowerKeyId !== keyId) ||
      (expected.watchtowerId && record.watchtowerId !== expected.watchtowerId) ||
      (expected.contractId && record.contractId !== expected.contractId) ||
      record.recordDigest !== recordDigest(record) || record.recordHash !== recordHash(record)) {
    throw new Error('DLC watchtower observation commitment mismatch');
  }
  let signature;
  try {
    signature = Buffer.from(record.signature, 'base64');
  } catch (_error) {
    throw new Error('DLC watchtower signature is malformed');
  }
  if (signature.length !== 64 || signature.toString('base64') !== record.signature ||
      !crypto.verify(null, Buffer.from(record.recordDigest, 'hex'), asPublicKey(publicKey), signature)) {
    throw new Error('DLC watchtower observation signature is invalid');
  }
  return true;
}

class DlcWatchtowerJournal {
  constructor(baseDirectory, { watchtowerId, publicKey, privateKey = null }) {
    if (typeof baseDirectory !== 'string' || baseDirectory.length === 0) throw new Error('baseDirectory is required');
    requireId(watchtowerId, 'watchtowerId');
    if (!publicKey && !privateKey) throw new Error('watchtower public key is required');
    const derivedPublicKey = privateKey ? crypto.createPublicKey(privateKey) : null;
    const effectivePublicKey = publicKey || derivedPublicKey;
    const der = publicKeyDer(effectivePublicKey);
    if (derivedPublicKey && !publicKeyDer(derivedPublicKey).equals(der)) throw new Error('watchtower key pair does not match');
    this.baseDirectory = path.resolve(baseDirectory);
    this.watchtowerId = watchtowerId;
    this.publicKey = asPublicKey(effectivePublicKey);
    this.privateKey = privateKey;
    this.watchtowerKeyId = hash(der);
    fs.mkdirSync(this.baseDirectory, { recursive: true, mode: 0o700 });
  }

  _directory(contractId) { return path.join(this.baseDirectory, contractKey(contractId)); }
  _files(contractId) {
    const directory = this._directory(contractId);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter((name) => /^observation-[0-9]{12}\.json$/.test(name)).sort();
  }
  _withLock(contractId, run) {
    const lock = path.join(this.baseDirectory, `.${contractKey(contractId)}.lock`);
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error(`DLC watchtower journal lock is held for ${contractId}`);
      throw error;
    }
    try { return run(); }
    finally { fs.rmSync(lock, { recursive: true, force: true }); }
  }
  _write(record) {
    const directory = this._directory(record.contractId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = `observation-${String(record.sequence).padStart(12, '0')}.json`;
    const finalPath = path.join(directory, name);
    if (fs.existsSync(finalPath)) throw new Error(`DLC watchtower observation ${record.sequence} already exists`);
    const temporaryPath = path.join(directory, `.${name}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    const fd = fs.openSync(temporaryPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try { fs.renameSync(temporaryPath, finalPath); }
    catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch (_cleanupError) {}
      throw error;
    }
  }

  _appendSignedRecord({ chain, contractState, transactionSet, observationType: type, snapshot, evaluation }) {
    const normalizedSnapshot = normalize(snapshot);
    const normalizedEvaluation = normalize(evaluation);
    const snapshotDigest = hash(Buffer.from(canonicalJson(normalizedSnapshot), 'utf8'));
    const latestSameType = [...chain.records].reverse().find((record) => observationType(record) === type);
    if (latestSameType && latestSameType.snapshotDigest === snapshotDigest &&
        latestSameType.contractStateRecordHash === contractState.recordHash) return latestSameType;
    const previous = chain.latest;
    const unsigned = {
      kind: KIND,
      observationType: type,
      network: contractState.network,
      watchtowerId: this.watchtowerId,
      watchtowerKeyId: this.watchtowerKeyId,
      contractKey: contractKey(contractState.contractId),
      contractId: contractState.contractId,
      contractDigest: contractState.contractDigest,
      contractStateRecordHash: requireHash(contractState.recordHash, 'contractState.recordHash'),
      contractRevision: contractState.revision,
      transactionValidationDigest: requireHash(transactionSet.validationDigest, 'transactionSet.validationDigest'),
      sequence: chain.observations,
      previousRecordHash: previous ? previous.recordHash : null,
      snapshot: normalizedSnapshot,
      snapshotDigest,
      evaluation: normalizedEvaluation,
      alert: normalizedEvaluation.halt ? { code: normalizedEvaluation.status, severity: 'critical' } : null
    };
    const digest = recordDigest(unsigned);
    const signed = { ...unsigned, recordDigest: digest };
    signed.signature = crypto.sign(null, Buffer.from(digest, 'hex'), this.privateKey).toString('base64');
    const record = Object.freeze({ ...signed, recordHash: recordHash(signed) });
    validateObservationRecord(record, this.publicKey, { watchtowerId: this.watchtowerId, contractId: contractState.contractId });
    this._write(record);
    return record;
  }

  verifyChain(contractId) {
    requireId(contractId, 'contractId');
    const files = this._files(contractId);
    let previous = null;
    const records = [];
    for (let sequence = 0; sequence < files.length; sequence++) {
      const record = JSON.parse(fs.readFileSync(path.join(this._directory(contractId), files[sequence]), 'utf8'));
      validateObservationRecord(record, this.publicKey, {
        watchtowerId: this.watchtowerId,
        watchtowerKeyId: this.watchtowerKeyId,
        contractId
      });
      if (record.sequence !== sequence || record.previousRecordHash !== (previous ? previous.recordHash : null)) {
        throw new Error('DLC watchtower observation chain is not contiguous');
      }
      if (previous && (record.network !== previous.network || record.contractDigest !== previous.contractDigest ||
          record.transactionValidationDigest !== previous.transactionValidationDigest ||
          record.contractRevision < previous.contractRevision)) {
        throw new Error('DLC watchtower contract binding regressed');
      }
      previous = record;
      records.push(Object.freeze(record));
    }
    return Object.freeze({
      ok: true,
      observations: files.length,
      latest: previous,
      records: Object.freeze(records)
    });
  }

  appendObservation({ contractState, transactionSet, snapshot, minConfirmations = 6 }) {
    if (!this.privateKey) throw new Error('watchtower journal is verification-only');
    validateDlcContract(contractState);
    validateDlcTransactionSetCommitments(transactionSet);
    return this._withLock(contractState.contractId, () => {
      const chain = this.verifyChain(contractState.contractId);
      const previous = [...chain.records].reverse().find((record) => observationType(record) === 'chain') || null;
      const normalizedSnapshot = normalize(snapshot);
      const evaluation = normalize(evaluateDlcChainSnapshot({
        contractState,
        transactionSet,
        current: normalizedSnapshot,
        previous: previous ? previous.snapshot : null,
        minConfirmations
      }));
      return this._appendSignedRecord({
        chain,
        contractState,
        transactionSet,
        observationType: 'chain',
        snapshot: normalizedSnapshot,
        evaluation
      });
    });
  }

  appendBitcoinCoreAnchorObservation(options) {
    if (!this.privateKey) throw new Error('watchtower journal is verification-only');
    validateDlcContract(options?.contractState);
    validateDlcTransactionSetCommitments(options?.transactionSet);
    return this._withLock(options.contractState.contractId, () => {
      const chain = this.verifyChain(options.contractState.contractId);
      const snapshot = captureDlcAnchorRecoverySnapshot(options);
      const evaluation = evaluateDlcAnchorRecovery({
        contractState: options.contractState,
        transactionSet: options.transactionSet,
        settlementTxid: options.settlementTxid,
        snapshot,
        expectedRecoveryTxids: snapshot.expectedRecoveryTxids,
        incrementalRelayFeeSatPerVb: snapshot.incrementalRelayFeeSatPerVb
      });
      return this._appendSignedRecord({
        chain,
        contractState: options.contractState,
        transactionSet: options.transactionSet,
        observationType: 'anchor-recovery',
        snapshot,
        evaluation
      });
    });
  }

  alerts(contractId) {
    const chain = this.verifyChain(contractId);
    return Object.freeze(chain.records.filter((record) => record.alert !== null).map((record) => Object.freeze({
      contractId: record.contractId,
      sequence: record.sequence,
      recordHash: record.recordHash,
      code: record.alert.code,
      severity: record.alert.severity
    })));
  }
}

module.exports = { KIND, DlcWatchtowerJournal, contractKey, validateObservationRecord };
