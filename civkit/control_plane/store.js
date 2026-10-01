const fs = require('fs');
const path = require('path');
const { ClassicLevel } = require('classic-level');
const { PostgresControlPlaneStore } = require('./postgres_store');
const { CaseRecord, JobRecord, AuditRecord, JOB_STATUSES } = require('./types');

const STORE_BACKENDS = Object.freeze({
  file: 'file',
  leveldb: 'leveldb',
  postgres: 'postgres'
});

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonArray(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return Array.isArray(parsed) ? parsed : [];
}

function writeJsonArray(filePath, rows) {
  ensureDirForFile(filePath);
  fs.writeFileSync(filePath, JSON.stringify(rows, null, 2));
}

function leaseExpired(job, nowMs) {
  return job.leaseUntilMs != null && job.leaseUntilMs <= nowMs;
}

function canLeaseJob(job, nowMs) {
  return job.runAfterMs <= nowMs &&
    (job.status === JOB_STATUSES.pending || (job.status === JOB_STATUSES.leased && leaseExpired(job, nowMs)));
}

function assertLeaseOwner(job, workerId) {
  if (workerId == null) {
    return;
  }
  if (job.leaseOwnerId !== workerId) {
    throw new Error(`Job ${job.jobId} is leased by ${job.leaseOwnerId || 'another_worker'}`);
  }
}

class FileControlPlaneStore {
  constructor({
    casesPath,
    jobsPath,
    auditPath
  }) {
    this.casesPath = String(casesPath || '').trim();
    this.jobsPath = String(jobsPath || '').trim();
    this.auditPath = String(auditPath || '').trim();
    if (!this.casesPath || !this.jobsPath || !this.auditPath) {
      throw new Error('casesPath, jobsPath, and auditPath are required');
    }
  }

  async listCases() {
    return readJsonArray(this.casesPath).map((row) => new CaseRecord(row));
  }

  async getCase(caseId) {
    return (await this.listCases()).find((row) => row.caseId === caseId) || null;
  }

  async upsertCase(caseLike) {
    const normalized = caseLike instanceof CaseRecord ? caseLike : new CaseRecord(caseLike);
    const rows = await this.listCases();
    const index = rows.findIndex((row) => row.caseId === normalized.caseId);
    if (index >= 0) {
      rows[index] = normalized;
    } else {
      rows.push(normalized);
    }
    writeJsonArray(this.casesPath, rows.map((row) => row.toJSON()));
    return normalized;
  }

  async listJobs() {
    return readJsonArray(this.jobsPath).map((row) => new JobRecord(row));
  }

  async findActiveJobByKey(threadId, role, action) {
    return (await this.listJobs()).find((job) =>
      job.threadId === threadId &&
      job.role === role &&
      job.action === action &&
      (job.status === JOB_STATUSES.pending || job.status === JOB_STATUSES.leased)
    ) || null;
  }

  async enqueueJob(jobLike) {
    const normalized = jobLike instanceof JobRecord ? jobLike : new JobRecord(jobLike);
    const existing = await this.findActiveJobByKey(
      normalized.threadId,
      normalized.role,
      normalized.action
    );
    if (existing) {
      return existing;
    }
    const rows = await this.listJobs();
    rows.push(normalized);
    writeJsonArray(this.jobsPath, rows.map((row) => row.toJSON()));
    return normalized;
  }

  async leaseDueJobs({ nowMs, workerId = null, limit = 10, leaseMs = 30000 }) {
    const rows = await this.listJobs();
    const leased = [];
    const nextRows = rows.map((job) => {
      if (leased.length >= limit || !canLeaseJob(job, nowMs)) {
        return job;
      }
      const updated = new JobRecord({
        ...job.toJSON(),
        status: JOB_STATUSES.leased,
        leasedAtMs: nowMs,
        leaseUntilMs: nowMs + leaseMs,
        leaseOwnerId: workerId,
        attempts: job.attempts + 1
      });
      leased.push(updated);
      return updated;
    });
    writeJsonArray(this.jobsPath, nextRows.map((row) => row.toJSON()));
    return leased;
  }

  async completeJob(jobId, { workerId = null } = {}) {
    const rows = (await this.listJobs()).map((job) => {
      if (job.jobId !== jobId) {
        return job;
      }
      assertLeaseOwner(job, workerId);
      return new JobRecord({
        ...job.toJSON(),
        status: JOB_STATUSES.completed,
        leasedAtMs: null,
        leaseUntilMs: null,
        leaseOwnerId: null,
        lastError: null
      });
    });
    writeJsonArray(this.jobsPath, rows.map((row) => row.toJSON()));
  }

  async failJob(jobId, { error, retryDelayMs = 0, workerId = null }) {
    const rows = (await this.listJobs()).map((job) => {
      if (job.jobId !== jobId) {
        return job;
      }
      assertLeaseOwner(job, workerId);
      const exhausted = job.attempts >= job.maxAttempts;
      return new JobRecord({
        ...job.toJSON(),
        status: exhausted ? JOB_STATUSES.failed : JOB_STATUSES.pending,
        leasedAtMs: null,
        leaseUntilMs: null,
        leaseOwnerId: null,
        runAfterMs: exhausted ? job.runAfterMs : job.runAfterMs + Number(retryDelayMs || 0),
        lastError: String(error || 'job_failed')
      });
    });
    writeJsonArray(this.jobsPath, rows.map((row) => row.toJSON()));
  }

  async renewJobLease(jobId, { workerId, nowMs, leaseMs = 30000 }) {
    const rows = (await this.listJobs()).map((job) => {
      if (job.jobId !== jobId) {
        return job;
      }
      assertLeaseOwner(job, workerId);
      return new JobRecord({
        ...job.toJSON(),
        leasedAtMs: nowMs,
        leaseUntilMs: nowMs + leaseMs
      });
    });
    writeJsonArray(this.jobsPath, rows.map((row) => row.toJSON()));
  }

  async listAuditRecords() {
    return readJsonArray(this.auditPath).map((row) => new AuditRecord(row));
  }

  async appendAudit(recordLike) {
    const normalized = recordLike instanceof AuditRecord ? recordLike : new AuditRecord(recordLike);
    const rows = await this.listAuditRecords();
    rows.push(normalized);
    writeJsonArray(this.auditPath, rows.map((row) => row.toJSON()));
    return normalized;
  }

  async close() {}
}

function encodeKey(prefix, id) {
  return `${prefix}!${String(id || '')}`;
}

async function collectPrefix(db, prefix, mapper) {
  const rows = [];
  for await (const [, value] of db.iterator({
    gte: `${prefix}!`,
    lte: `${prefix}!\xff`
  })) {
    rows.push(mapper(value));
  }
  return rows;
}

class LevelControlPlaneStore {
  constructor({ dbPath }) {
    this.dbPath = String(dbPath || '').trim();
    if (this.dbPath === '') {
      throw new Error('dbPath is required');
    }
    fs.mkdirSync(this.dbPath, { recursive: true });
    this.db = new ClassicLevel(this.dbPath, {
      keyEncoding: 'utf8',
      valueEncoding: 'json'
    });
    this.openPromise = null;
  }

  async ensureOpen() {
    if (this.db.status === 'open') {
      return;
    }
    if (this.openPromise == null) {
      this.openPromise = this.db.open();
    }
    await this.openPromise;
  }

  async listCases() {
    await this.ensureOpen();
    return collectPrefix(this.db, 'case', (value) => new CaseRecord(value));
  }

  async getCase(caseId) {
    await this.ensureOpen();
    try {
      return new CaseRecord(await this.db.get(encodeKey('case', caseId)));
    } catch (error) {
      if (error && error.code === 'LEVEL_NOT_FOUND') {
        return null;
      }
      throw error;
    }
  }

  async upsertCase(caseLike) {
    await this.ensureOpen();
    const normalized = caseLike instanceof CaseRecord ? caseLike : new CaseRecord(caseLike);
    await this.db.put(encodeKey('case', normalized.caseId), normalized.toJSON());
    return normalized;
  }

  async listJobs() {
    await this.ensureOpen();
    return collectPrefix(this.db, 'job', (value) => new JobRecord(value));
  }

  async findActiveJobByKey(threadId, role, action) {
    return (await this.listJobs()).find((job) =>
      job.threadId === threadId &&
      job.role === role &&
      job.action === action &&
      (job.status === JOB_STATUSES.pending || job.status === JOB_STATUSES.leased)
    ) || null;
  }

  async enqueueJob(jobLike) {
    await this.ensureOpen();
    const normalized = jobLike instanceof JobRecord ? jobLike : new JobRecord(jobLike);
    const existing = await this.findActiveJobByKey(
      normalized.threadId,
      normalized.role,
      normalized.action
    );
    if (existing) {
      return existing;
    }
    await this.db.put(encodeKey('job', normalized.jobId), normalized.toJSON());
    return normalized;
  }

  async leaseDueJobs({ nowMs, workerId = null, limit = 10, leaseMs = 30000 }) {
    await this.ensureOpen();
    const rows = await this.listJobs();
    const leased = [];
    for (const job of rows) {
      if (leased.length >= limit || !canLeaseJob(job, nowMs)) {
        continue;
      }
      const updated = new JobRecord({
        ...job.toJSON(),
        status: JOB_STATUSES.leased,
        leasedAtMs: nowMs,
        leaseUntilMs: nowMs + leaseMs,
        leaseOwnerId: workerId,
        attempts: job.attempts + 1
      });
      await this.db.put(encodeKey('job', updated.jobId), updated.toJSON());
      leased.push(updated);
    }
    return leased;
  }

  async completeJob(jobId, { workerId = null } = {}) {
    await this.ensureOpen();
    const current = (await this.listJobs()).find((job) => job.jobId === jobId);
    if (current == null) {
      return;
    }
    assertLeaseOwner(current, workerId);
    await this.db.put(encodeKey('job', jobId), new JobRecord({
      ...current.toJSON(),
      status: JOB_STATUSES.completed,
      leasedAtMs: null,
      leaseUntilMs: null,
      leaseOwnerId: null,
      lastError: null
    }).toJSON());
  }

  async failJob(jobId, { error, retryDelayMs = 0, workerId = null }) {
    await this.ensureOpen();
    const current = (await this.listJobs()).find((job) => job.jobId === jobId);
    if (current == null) {
      return;
    }
    assertLeaseOwner(current, workerId);
    const exhausted = current.attempts >= current.maxAttempts;
    await this.db.put(encodeKey('job', jobId), new JobRecord({
      ...current.toJSON(),
      status: exhausted ? JOB_STATUSES.failed : JOB_STATUSES.pending,
      leasedAtMs: null,
      leaseUntilMs: null,
      leaseOwnerId: null,
      runAfterMs: exhausted ? current.runAfterMs : current.runAfterMs + Number(retryDelayMs || 0),
      lastError: String(error || 'job_failed')
    }).toJSON());
  }

  async renewJobLease(jobId, { workerId, nowMs, leaseMs = 30000 }) {
    await this.ensureOpen();
    const current = (await this.listJobs()).find((job) => job.jobId === jobId);
    if (current == null) {
      return;
    }
    assertLeaseOwner(current, workerId);
    await this.db.put(encodeKey('job', jobId), new JobRecord({
      ...current.toJSON(),
      leasedAtMs: nowMs,
      leaseUntilMs: nowMs + leaseMs
    }).toJSON());
  }

  async listAuditRecords() {
    await this.ensureOpen();
    return collectPrefix(this.db, 'audit', (value) => new AuditRecord(value));
  }

  async appendAudit(recordLike) {
    await this.ensureOpen();
    const normalized = recordLike instanceof AuditRecord ? recordLike : new AuditRecord(recordLike);
    await this.db.put(encodeKey('audit', normalized.auditId), normalized.toJSON());
    return normalized;
  }

  async close() {
    if (this.db.status === 'open' || this.db.status === 'opening') {
      await this.db.close();
    }
  }
}

function createControlPlaneStore({
  backend = STORE_BACKENDS.file,
  connectionString,
  schema,
  pool,
  dbPath,
  casesPath,
  jobsPath,
  auditPath
}) {
  if (backend === STORE_BACKENDS.postgres) {
    return new PostgresControlPlaneStore({
      connectionString,
      schema,
      pool
    });
  }
  if (backend === STORE_BACKENDS.leveldb) {
    return new LevelControlPlaneStore({ dbPath });
  }
  return new FileControlPlaneStore({
    casesPath,
    jobsPath,
    auditPath
  });
}

module.exports = {
  STORE_BACKENDS,
  FileControlPlaneStore,
  LevelControlPlaneStore,
  PostgresControlPlaneStore,
  ControlPlaneStore: FileControlPlaneStore,
  createControlPlaneStore
};
