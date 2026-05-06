const { Pool } = require('pg');
const { CaseRecord, JobRecord, AuditRecord } = require('./types');

function normalizeSchema(schema) {
  const normalized = String(schema || 'public').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error('postgres schema must be a simple identifier');
  }
  return normalized;
}

function createPgPool({
  connectionString,
  max = 10,
  idleTimeoutMillis = 30000
}) {
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw new Error('postgres connectionString is required');
  }
  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis
  });
}

function caseRowToRecord(row) {
  return new CaseRecord({
    caseId: row.case_id,
    threadId: row.thread_id,
    status: row.status,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    summary: row.summary_json || {},
    signerJob: row.signer_job_json,
    latestDecisionId: row.latest_decision_id
  });
}

function jobRowToRecord(row) {
  return new JobRecord({
    jobId: row.job_id,
    caseId: row.case_id,
    threadId: row.thread_id,
    role: row.role,
    action: row.action,
    payload: row.payload_json || {},
    status: row.status,
    runAfterMs: row.run_after_ms,
    leaseUntilMs: row.lease_until_ms,
    leasedAtMs: row.leased_at_ms,
    leaseOwnerId: row.lease_owner_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error
  });
}

function auditRowToRecord(row) {
  return new AuditRecord({
    auditId: row.audit_id,
    caseId: row.case_id,
    threadId: row.thread_id,
    actor: row.actor,
    action: row.action,
    createdAtMs: row.created_at_ms,
    details: row.details_json || {}
  });
}

class PostgresControlPlaneStore {
  constructor({
    connectionString = null,
    schema = 'public',
    pool = null
  }) {
    this.schema = normalizeSchema(schema);
    this.pool = pool || createPgPool({ connectionString });
    this.ownsPool = pool == null;
    this.initPromise = null;
  }

  async ensureInitialized() {
    if (this.initPromise == null) {
      this.initPromise = this.initializeSchema();
    }
    await this.initPromise;
  }

  async initializeSchema() {
    const schema = this.schema;
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.control_cases (
        case_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        signer_job_json JSONB NULL,
        latest_decision_id TEXT NULL
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.control_jobs (
        job_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL,
        run_after_ms BIGINT NOT NULL,
        lease_until_ms BIGINT NULL,
        leased_at_ms BIGINT NULL,
        lease_owner_id TEXT NULL,
        attempts INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        last_error TEXT NULL
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS control_jobs_runnable_idx
      ON ${schema}.control_jobs (status, run_after_ms, lease_until_ms)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS control_jobs_active_key_idx
      ON ${schema}.control_jobs (thread_id, role, action)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.control_audits (
        audit_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        created_at_ms BIGINT NOT NULL,
        details_json JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
  }

  async listCases() {
    await this.ensureInitialized();
    const result = await this.pool.query(`
      SELECT case_id, thread_id, status, created_at_ms, updated_at_ms, summary_json, signer_job_json, latest_decision_id
      FROM ${this.schema}.control_cases
      ORDER BY created_at_ms ASC, case_id ASC
    `);
    return result.rows.map(caseRowToRecord);
  }

  async getCase(caseId) {
    await this.ensureInitialized();
    const result = await this.pool.query(`
      SELECT case_id, thread_id, status, created_at_ms, updated_at_ms, summary_json, signer_job_json, latest_decision_id
      FROM ${this.schema}.control_cases
      WHERE case_id = $1
    `, [caseId]);
    return result.rows[0] ? caseRowToRecord(result.rows[0]) : null;
  }

  async upsertCase(caseLike) {
    await this.ensureInitialized();
    const normalized = caseLike instanceof CaseRecord ? caseLike : new CaseRecord(caseLike);
    await this.pool.query(`
      INSERT INTO ${this.schema}.control_cases
        (case_id, thread_id, status, created_at_ms, updated_at_ms, summary_json, signer_job_json, latest_decision_id)
      VALUES
        ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
      ON CONFLICT (case_id) DO UPDATE SET
        thread_id = EXCLUDED.thread_id,
        status = EXCLUDED.status,
        created_at_ms = EXCLUDED.created_at_ms,
        updated_at_ms = EXCLUDED.updated_at_ms,
        summary_json = EXCLUDED.summary_json,
        signer_job_json = EXCLUDED.signer_job_json,
        latest_decision_id = EXCLUDED.latest_decision_id
    `, [
      normalized.caseId,
      normalized.threadId,
      normalized.status,
      normalized.createdAtMs,
      normalized.updatedAtMs,
      JSON.stringify(normalized.summary || {}),
      normalized.signerJob == null ? null : JSON.stringify(normalized.signerJob),
      normalized.latestDecisionId
    ]);
    return normalized;
  }

  async listJobs() {
    await this.ensureInitialized();
    const result = await this.pool.query(`
      SELECT job_id, case_id, thread_id, role, action, payload_json, status, run_after_ms, lease_until_ms, leased_at_ms, lease_owner_id, attempts, max_attempts, last_error
      FROM ${this.schema}.control_jobs
      ORDER BY run_after_ms ASC, job_id ASC
    `);
    return result.rows.map(jobRowToRecord);
  }

  async findActiveJobByKey(threadId, role, action) {
    await this.ensureInitialized();
    const result = await this.pool.query(`
      SELECT job_id, case_id, thread_id, role, action, payload_json, status, run_after_ms, lease_until_ms, leased_at_ms, lease_owner_id, attempts, max_attempts, last_error
      FROM ${this.schema}.control_jobs
      WHERE thread_id = $1
        AND role = $2
        AND action = $3
        AND status IN ('pending', 'leased')
      ORDER BY job_id ASC
      LIMIT 1
    `, [threadId, role, action]);
    return result.rows[0] ? jobRowToRecord(result.rows[0]) : null;
  }

  async enqueueJob(jobLike) {
    await this.ensureInitialized();
    const normalized = jobLike instanceof JobRecord ? jobLike : new JobRecord(jobLike);
    const existing = await this.findActiveJobByKey(
      normalized.threadId,
      normalized.role,
      normalized.action
    );
    if (existing) {
      return existing;
    }

    await this.pool.query(`
      INSERT INTO ${this.schema}.control_jobs
        (job_id, case_id, thread_id, role, action, payload_json, status, run_after_ms, lease_until_ms, leased_at_ms, lease_owner_id, attempts, max_attempts, last_error)
      VALUES
        ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (job_id) DO NOTHING
    `, [
      normalized.jobId,
      normalized.caseId,
      normalized.threadId,
      normalized.role,
      normalized.action,
      JSON.stringify(normalized.payload || {}),
      normalized.status,
      normalized.runAfterMs,
      normalized.leaseUntilMs,
      normalized.leasedAtMs,
      normalized.leaseOwnerId,
      normalized.attempts,
      normalized.maxAttempts,
      normalized.lastError
    ]);

    const current = await this.pool.query(`
      SELECT job_id, case_id, thread_id, role, action, payload_json, status, run_after_ms, lease_until_ms, leased_at_ms, lease_owner_id, attempts, max_attempts, last_error
      FROM ${this.schema}.control_jobs
      WHERE job_id = $1
    `, [normalized.jobId]);
    return current.rows[0] ? jobRowToRecord(current.rows[0]) : normalized;
  }

  async leaseDueJobs({ nowMs, workerId = null, limit = 10, leaseMs = 30000 }) {
    await this.ensureInitialized();
    const result = await this.pool.query(`
      WITH candidates AS (
        SELECT job_id
        FROM ${this.schema}.control_jobs
        WHERE run_after_ms <= $1
          AND (
            status = 'pending'
            OR (status = 'leased' AND lease_until_ms IS NOT NULL AND lease_until_ms <= $1)
          )
        ORDER BY run_after_ms ASC, job_id ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ${this.schema}.control_jobs AS jobs
      SET status = 'leased',
          leased_at_ms = $1,
          lease_until_ms = $1 + $3,
          lease_owner_id = $4,
          attempts = jobs.attempts + 1
      FROM candidates
      WHERE jobs.job_id = candidates.job_id
      RETURNING jobs.job_id, jobs.case_id, jobs.thread_id, jobs.role, jobs.action, jobs.payload_json, jobs.status, jobs.run_after_ms, jobs.lease_until_ms, jobs.leased_at_ms, jobs.lease_owner_id, jobs.attempts, jobs.max_attempts, jobs.last_error
    `, [nowMs, limit, leaseMs, workerId]);
    return result.rows.map(jobRowToRecord);
  }

  async completeJob(jobId, { workerId = null } = {}) {
    await this.ensureInitialized();
    const result = await this.pool.query(`
      UPDATE ${this.schema}.control_jobs
      SET status = 'completed',
          leased_at_ms = NULL,
          lease_until_ms = NULL,
          lease_owner_id = NULL,
          last_error = NULL
      WHERE job_id = $1
        AND ($2::text IS NULL OR lease_owner_id = $2)
      RETURNING job_id
    `, [jobId, workerId]);
    if (workerId != null && result.rowCount === 0) {
      throw new Error(`Job ${jobId} is leased by another_worker`);
    }
  }

  async failJob(jobId, { error, retryDelayMs = 0, workerId = null }) {
    await this.ensureInitialized();
    const result = await this.pool.query(`
      UPDATE ${this.schema}.control_jobs
      SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
          leased_at_ms = NULL,
          lease_until_ms = NULL,
          lease_owner_id = NULL,
          run_after_ms = CASE WHEN attempts >= max_attempts THEN run_after_ms ELSE run_after_ms + $2 END,
          last_error = $3
      WHERE job_id = $1
        AND ($4::text IS NULL OR lease_owner_id = $4)
      RETURNING job_id
    `, [jobId, Number(retryDelayMs || 0), String(error || 'job_failed'), workerId]);
    if (workerId != null && result.rowCount === 0) {
      throw new Error(`Job ${jobId} is leased by another_worker`);
    }
  }

  async renewJobLease(jobId, { workerId, nowMs, leaseMs = 30000 }) {
    await this.ensureInitialized();
    const result = await this.pool.query(`
      UPDATE ${this.schema}.control_jobs
      SET leased_at_ms = $2,
          lease_until_ms = $2 + $3
      WHERE job_id = $1
        AND lease_owner_id = $4
      RETURNING job_id
    `, [jobId, nowMs, leaseMs, workerId]);
    if (result.rowCount === 0) {
      throw new Error(`Job ${jobId} is leased by another_worker`);
    }
  }

  async listAuditRecords() {
    await this.ensureInitialized();
    const result = await this.pool.query(`
      SELECT audit_id, case_id, thread_id, actor, action, created_at_ms, details_json
      FROM ${this.schema}.control_audits
      ORDER BY created_at_ms ASC, audit_id ASC
    `);
    return result.rows.map(auditRowToRecord);
  }

  async appendAudit(recordLike) {
    await this.ensureInitialized();
    const normalized = recordLike instanceof AuditRecord ? recordLike : new AuditRecord(recordLike);
    await this.pool.query(`
      INSERT INTO ${this.schema}.control_audits
        (audit_id, case_id, thread_id, actor, action, created_at_ms, details_json)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (audit_id) DO NOTHING
    `, [
      normalized.auditId,
      normalized.caseId,
      normalized.threadId,
      normalized.actor,
      normalized.action,
      normalized.createdAtMs,
      JSON.stringify(normalized.details || {})
    ]);
    return normalized;
  }

  async close() {
    if (this.ownsPool && this.pool && typeof this.pool.end === 'function') {
      await this.pool.end();
    }
  }
}

module.exports = {
  normalizeSchema,
  createPgPool,
  PostgresControlPlaneStore
};
