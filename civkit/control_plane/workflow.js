const nostrRuntime = require('../nostr_agent/runtime');
const { CaseRecord, JobRecord, AuditRecord, CASE_STATUSES, sha256Hex } = require('./types');

function buildCaseId(threadId) {
  return `case:${sha256Hex(String(threadId || ''))}`;
}

function mapPhaseToCaseStatus(phase) {
  switch (String(phase || '').trim()) {
    case 'offer_open':
      return CASE_STATUSES.offerOpen;
    case 'escrow_live':
      return CASE_STATUSES.escrowLive;
    case 'dispute_open':
      return CASE_STATUSES.disputeOpen;
    case 'appeal_pending':
      return CASE_STATUSES.appealPending;
    case 'decision_ready':
      return CASE_STATUSES.decisionReady;
    default:
      return CASE_STATUSES.offerOpen;
  }
}

function buildCaseRecord(threadRuntime, nowMs, existingCase = null) {
  const caseId = existingCase?.caseId || buildCaseId(threadRuntime.threadId);
  const decisionHash = threadRuntime.decision?.content?.decisionHash || null;
  return new CaseRecord({
    caseId,
    threadId: threadRuntime.threadId,
    status: mapPhaseToCaseStatus(threadRuntime.phase),
    createdAtMs: existingCase?.createdAtMs || nowMs,
    updatedAtMs: nowMs,
    latestDecisionId: decisionHash,
    signerJob: threadRuntime.signerJob,
    summary: {
      phase: threadRuntime.phase,
      evidenceCount: Array.isArray(threadRuntime.evidence) ? threadRuntime.evidence.length : 0,
      hasAppeal: threadRuntime.appeal != null,
      invalidEventCount: Array.isArray(threadRuntime.invalidEvents)
        ? threadRuntime.invalidEvents.length
        : 0
    }
  });
}

function deriveControlJobs(caseRecord, threadRuntime, nowMs) {
  return (threadRuntime.operationalTasks || []).map((task) => new JobRecord({
    jobId: `job:${sha256Hex(`${caseRecord.caseId}:${task.role}:${task.action}`)}`,
    caseId: caseRecord.caseId,
    threadId: caseRecord.threadId,
    role: task.role,
    action: task.action,
    payload: {
      ...(task.payload || {}),
      threadId: caseRecord.threadId
    },
    runAfterMs: nowMs
  }));
}

async function syncThreadToControlPlane({
  threadId,
  events,
  store,
  nowMs = Date.now()
}) {
  const threadRuntime = nostrRuntime.summarizeThreadRuntime(events);
  if (threadRuntime.threadId == null) {
    threadRuntime.threadId = threadId;
  }
  const existingCase = await store.getCase(buildCaseId(threadRuntime.threadId));
  const caseRecord = buildCaseRecord(threadRuntime, nowMs, existingCase);
  await store.upsertCase(caseRecord);

  const jobs = [];
  for (const job of deriveControlJobs(caseRecord, threadRuntime, nowMs)) {
    jobs.push(await store.enqueueJob(job));
  }

  const audit = await store.appendAudit(new AuditRecord({
    auditId: `audit:${sha256Hex(`${caseRecord.caseId}:${nowMs}:${threadRuntime.phase}`)}`,
    caseId: caseRecord.caseId,
    threadId: caseRecord.threadId,
    actor: 'control_plane',
    action: 'sync_thread_runtime',
    createdAtMs: nowMs,
    details: {
      phase: threadRuntime.phase,
      enqueuedJobs: jobs.map((job) => ({
        role: job.role,
        action: job.action,
        jobId: job.jobId
      }))
    }
  }));

  return {
    caseRecord,
    jobs,
    audit,
    threadRuntime
  };
}

module.exports = {
  buildCaseId,
  mapPhaseToCaseStatus,
  buildCaseRecord,
  deriveControlJobs,
  syncThreadToControlPlane
};
