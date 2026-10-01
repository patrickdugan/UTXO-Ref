const crypto = require('crypto');

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('hex');
  }
  return value;
}

function canonicalJsonString(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(value) {
  return crypto.createHash('sha256')
    .update(typeof value === 'string' ? value : canonicalJsonString(value))
    .digest('hex');
}

function normalizeNonNegativeInt(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return normalized;
}

function normalizeString(value, label) {
  const normalized = String(value || '').trim();
  if (normalized === '') {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

const CASE_STATUSES = Object.freeze({
  offerOpen: 'offer_open',
  escrowLive: 'escrow_live',
  disputeOpen: 'dispute_open',
  decisionReady: 'decision_ready',
  appealPending: 'appeal_pending',
  settlementPending: 'settlement_pending',
  settled: 'settled'
});

const JOB_STATUSES = Object.freeze({
  pending: 'pending',
  leased: 'leased',
  completed: 'completed',
  failed: 'failed'
});

class CaseRecord {
  constructor({
    caseId,
    threadId,
    status,
    createdAtMs,
    updatedAtMs,
    summary = {},
    signerJob = null,
    latestDecisionId = null
  }) {
    this.caseId = normalizeString(caseId, 'caseId');
    this.threadId = normalizeString(threadId, 'threadId');
    this.status = normalizeString(status, 'status');
    this.createdAtMs = normalizeNonNegativeInt(createdAtMs, 'createdAtMs');
    this.updatedAtMs = normalizeNonNegativeInt(updatedAtMs, 'updatedAtMs');
    this.summary = summary && typeof summary === 'object' ? summary : {};
    this.signerJob = signerJob && typeof signerJob === 'object' ? signerJob : null;
    this.latestDecisionId = latestDecisionId == null ? null : String(latestDecisionId);
  }

  toJSON() {
    return {
      caseId: this.caseId,
      threadId: this.threadId,
      status: this.status,
      createdAtMs: this.createdAtMs,
      updatedAtMs: this.updatedAtMs,
      summary: this.summary,
      signerJob: this.signerJob,
      latestDecisionId: this.latestDecisionId
    };
  }
}

class JobRecord {
  constructor({
    jobId,
    caseId,
    threadId,
    role,
    action,
    payload = {},
    status = JOB_STATUSES.pending,
    runAfterMs = 0,
    leaseUntilMs = null,
    leasedAtMs = null,
    leaseOwnerId = null,
    attempts = 0,
    maxAttempts = 3,
    lastError = null
  }) {
    this.jobId = normalizeString(jobId, 'jobId');
    this.caseId = normalizeString(caseId, 'caseId');
    this.threadId = normalizeString(threadId, 'threadId');
    this.role = normalizeString(role, 'role');
    this.action = normalizeString(action, 'action');
    this.payload = payload && typeof payload === 'object' ? payload : {};
    this.status = normalizeString(status, 'status');
    this.runAfterMs = normalizeNonNegativeInt(runAfterMs, 'runAfterMs');
    this.leaseUntilMs = leaseUntilMs == null ? null : normalizeNonNegativeInt(leaseUntilMs, 'leaseUntilMs');
    this.leasedAtMs = leasedAtMs == null ? null : normalizeNonNegativeInt(leasedAtMs, 'leasedAtMs');
    this.leaseOwnerId = leaseOwnerId == null ? null : String(leaseOwnerId);
    this.attempts = normalizeNonNegativeInt(attempts, 'attempts');
    this.maxAttempts = normalizeNonNegativeInt(maxAttempts, 'maxAttempts');
    this.lastError = lastError == null ? null : String(lastError);
  }

  toJSON() {
    return {
      jobId: this.jobId,
      caseId: this.caseId,
      threadId: this.threadId,
      role: this.role,
      action: this.action,
      payload: this.payload,
      status: this.status,
      runAfterMs: this.runAfterMs,
      leaseUntilMs: this.leaseUntilMs,
      leasedAtMs: this.leasedAtMs,
      leaseOwnerId: this.leaseOwnerId,
      attempts: this.attempts,
      maxAttempts: this.maxAttempts,
      lastError: this.lastError
    };
  }
}

class AuditRecord {
  constructor({
    auditId,
    caseId,
    threadId,
    actor,
    action,
    createdAtMs,
    details = {}
  }) {
    this.auditId = normalizeString(auditId, 'auditId');
    this.caseId = normalizeString(caseId, 'caseId');
    this.threadId = normalizeString(threadId, 'threadId');
    this.actor = normalizeString(actor, 'actor');
    this.action = normalizeString(action, 'action');
    this.createdAtMs = normalizeNonNegativeInt(createdAtMs, 'createdAtMs');
    this.details = details && typeof details === 'object' ? details : {};
  }

  toJSON() {
    return {
      auditId: this.auditId,
      caseId: this.caseId,
      threadId: this.threadId,
      actor: this.actor,
      action: this.action,
      createdAtMs: this.createdAtMs,
      details: this.details
    };
  }
}

module.exports = {
  canonicalize,
  canonicalJsonString,
  sha256Hex,
  CASE_STATUSES,
  JOB_STATUSES,
  CaseRecord,
  JobRecord,
  AuditRecord
};
