'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalize, canonicalJson } = require('./dlc_contract_state');
const { TYPES, verifyDlcPeerMessage } = require('./dlc_peer_transcript');
const {
  assertNonSymlinkDirectory,
  ensureNonSymlinkDirectory,
  readBoundedJson,
  writeJsonAppendOnce
} = require('./dlc_durable_json_store');
const {
  createDlcJournalCheckpoint,
  normalizeDlcJournalCheckpoint,
  assertDlcJournalCheckpoint
} = require('./dlc_journal_checkpoint');

const CLAIM_KIND = 'utxoref_dlc_peer_offer_claim_v1';
const COMMIT_KIND = 'utxoref_dlc_peer_transcript_commit_v1';
const MAX_RECORD_BYTES = 131072;

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function requireHash(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be lowercase hash`);
  return value;
}
function requirePeerId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error('peerId is invalid');
  return value;
}
function recordHash(record) {
  const value = { ...canonicalize(record, 'DLC peer session record') };
  delete value.recordHash;
  return hash(Buffer.from(canonicalJson(value), 'utf8'));
}
function sessionKey(peerId, temporaryContractId) {
  requirePeerId(peerId);
  requireHash(temporaryContractId, 'temporaryContractId');
  return hash(Buffer.from(`${peerId}:${temporaryContractId}`, 'utf8'));
}
function validateClaim(record) {
  if (!record || record.kind !== CLAIM_KIND || record.network !== 'bitcoin-testnet4' ||
      record.sessionKey !== sessionKey(record.peerId, record.temporaryContractId) ||
      !/^[0-9a-f]{64}$/.test(record.offerMessageDigest || '') || record.recordHash !== recordHash(record)) {
    throw new Error('invalid DLC peer offer claim');
  }
  return true;
}
function validateCommit(record, claim) {
  if (!record || record.kind !== COMMIT_KIND || record.network !== 'bitcoin-testnet4' ||
      record.sessionKey !== claim.sessionKey || record.claimRecordHash !== claim.recordHash ||
      record.temporaryContractId !== claim.temporaryContractId ||
      !/^[0-9a-f]{64}$/.test(record.contractId || '') ||
      !/^[0-9a-f]{64}$/.test(record.transcriptDigest || '') || record.recordHash !== recordHash(record)) {
    throw new Error('invalid DLC peer transcript commit');
  }
  return true;
}

class DlcPeerSessionStore {
  constructor(baseDirectory) {
    if (typeof baseDirectory !== 'string' || baseDirectory.length === 0) throw new Error('baseDirectory is required');
    this.baseDirectory = path.resolve(baseDirectory);
    ensureNonSymlinkDirectory(this.baseDirectory, 'DLC peer session store');
  }

  _directory(peerId, temporaryContractId) {
    return path.join(this.baseDirectory, sessionKey(peerId, temporaryContractId));
  }

  _writeAtomic(directory, name, record) {
    return writeJsonAppendOnce(directory, name, record, {
      maxBytes: MAX_RECORD_BYTES,
      label: 'DLC peer session record'
    });
  }

  _readClaim(directory) {
    assertNonSymlinkDirectory(directory, 'DLC peer session');
    const claimPath = path.join(directory, 'claim.json');
    if (!fs.existsSync(claimPath)) throw new Error('DLC peer offer claim is incomplete; manual recovery is required');
    const claim = readBoundedJson(claimPath, { maxBytes: MAX_RECORD_BYTES, label: 'DLC peer offer claim' });
    validateClaim(claim);
    if (claim.sessionKey !== path.basename(directory)) throw new Error('DLC peer session directory key mismatch');
    return claim;
  }

  _readCommit(directory, claim) {
    const commit = readBoundedJson(path.join(directory, 'commit.json'), {
      maxBytes: MAX_RECORD_BYTES,
      label: 'DLC peer transcript commit'
    });
    validateCommit(commit, claim);
    return commit;
  }

  claimOffer({ offer, offererPublicKey }) {
    verifyDlcPeerMessage(offer, offererPublicKey);
    if (offer.messageType !== TYPES.OFFER || offer.previousMessageDigest !== null) {
      throw new Error('only an initial offer_dlc_v0 can be claimed');
    }
    const temporaryContractId = offer.body.temporaryContractId;
    const directory = this._directory(offer.peerId, temporaryContractId);
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = this._readClaim(directory);
      if (existing.offerMessageDigest === offer.messageDigest) return existing;
      throw new Error('temporaryContractId was already claimed by a different offer from this peer');
    }
    const unsigned = {
      kind: CLAIM_KIND,
      network: 'bitcoin-testnet4',
      sessionKey: path.basename(directory),
      peerId: offer.peerId,
      temporaryContractId,
      offerMessageDigest: offer.messageDigest
    };
    const claim = Object.freeze({ ...unsigned, recordHash: recordHash(unsigned) });
    this._writeAtomic(directory, 'claim.json', claim);
    return claim;
  }

  commitTranscript(validatedTranscript) {
    if (!validatedTranscript || validatedTranscript.ok !== true) throw new Error('validated peer transcript is required');
    const directory = this._directory(validatedTranscript.offererPeerId, validatedTranscript.temporaryContractId);
    const claim = this._readClaim(directory);
    const unsigned = {
      kind: COMMIT_KIND,
      network: 'bitcoin-testnet4',
      sessionKey: claim.sessionKey,
      claimRecordHash: claim.recordHash,
      temporaryContractId: claim.temporaryContractId,
      contractId: requireHash(validatedTranscript.contractId, 'contractId'),
      transcriptDigest: requireHash(validatedTranscript.transcriptDigest, 'transcriptDigest'),
      transactionValidationDigest: requireHash(
        validatedTranscript.transactionValidationDigest,
        'transactionValidationDigest'
      )
    };
    const commit = Object.freeze({ ...unsigned, recordHash: recordHash(unsigned) });
    try {
      this._writeAtomic(directory, 'commit.json', commit);
      return commit;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = this._readCommit(directory, claim);
      if (existing.recordHash === commit.recordHash) return existing;
      throw new Error('DLC peer session already committed a different transcript');
    }
  }

  knownTemporaryContractIds(peerId) {
    requirePeerId(peerId);
    const ids = [];
    for (const name of fs.readdirSync(this.baseDirectory).sort()) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      const directory = path.join(this.baseDirectory, name);
      assertNonSymlinkDirectory(directory, 'DLC peer session');
      const claim = this._readClaim(directory);
      if (claim.peerId === peerId) ids.push(claim.temporaryContractId);
    }
    return Object.freeze(ids.sort());
  }

  _checkpointState(peerId, temporaryContractId) {
    const directory = this._directory(peerId, temporaryContractId);
    const claim = this._readClaim(directory);
    const commitPath = path.join(directory, 'commit.json');
    const commit = fs.existsSync(commitPath) ? this._readCommit(directory, claim) : null;
    return Object.freeze({
      storeKey: sessionKey(peerId, temporaryContractId),
      recordCount: commit ? 2 : 1,
      records: Object.freeze(commit ? [claim, commit] : [claim])
    });
  }

  checkpoint(peerId, temporaryContractId) {
    const state = this._checkpointState(peerId, temporaryContractId);
    return createDlcJournalCheckpoint({
      storeKind: 'peer-session',
      storeKey: state.storeKey,
      recordCount: state.recordCount,
      headRecordHash: state.records[state.recordCount - 1].recordHash
    });
  }

  verifyCheckpoint(peerId, temporaryContractId, expectedCheckpoint) {
    expectedCheckpoint = normalizeDlcJournalCheckpoint(expectedCheckpoint);
    const state = this._checkpointState(peerId, temporaryContractId);
    const pinned = state.recordCount >= expectedCheckpoint.recordCount
      ? state.records[expectedCheckpoint.recordCount - 1]
      : null;
    assertDlcJournalCheckpoint(expectedCheckpoint, {
      storeKind: 'peer-session',
      storeKey: state.storeKey,
      currentRecordCount: state.recordCount,
      recordHashAtCheckpoint: pinned && pinned.recordHash
    });
    return Object.freeze({
      ok: true,
      records: state.recordCount,
      checkpointVerified: expectedCheckpoint.checkpointHash
    });
  }
}

module.exports = { MAX_RECORD_BYTES, DlcPeerSessionStore, sessionKey, validateClaim, validateCommit };
