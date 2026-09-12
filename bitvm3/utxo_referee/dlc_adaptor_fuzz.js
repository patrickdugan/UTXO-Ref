/**
 * Parallel deterministic stress/fuzz harness for the DLC adaptor boundary.
 *
 * Environment:
 *   DLC_FUZZ_CASES=2000
 *   DLC_FUZZ_WORKERS=4
 */

const crypto = require('crypto');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const a = require('./tradelayer_dlc_adaptor_sig');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function scalar(label) {
  return (a.bufToBig(sha256(label)) % (a.N - 1n)) + 1n;
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

function mustThrow(fn, pattern, message) {
  try {
    fn();
  } catch (error) {
    if (pattern.test(error.message)) return;
    throw new Error(`${message}: unexpected error: ${error.message}`);
  }
  throw new Error(`${message}: did not throw`);
}

function runCases(start, count, workerId) {
  const metrics = {
    workerId,
    cases: 0,
    adaptorRoundTrips: 0,
    relatedPointAttemptsBlocked: 0,
    malformedInputsRejected: 0,
    oracleEvents: 0,
    oracleEquivocationsBlocked: 0,
    crossEventNonceReusesBlocked: 0,
    announcementMutationsRejected: 0
  };

  for (let offset = 0; offset < count; offset++) {
    const caseId = start + offset;
    const secret = scalar(`signer:${caseId}`);
    const adaptorSecret = scalar(`adaptor:${caseId}`);
    const message = sha256(`message:${caseId}`);
    const aux = sha256(`aux:${caseId}`);
    const publicKey = a.xOnlyPubkey(secret);
    const point = a.pointMul(a.G, adaptorSecret);
    const opposite = a.pointNegate(point);

    const presignature = a.adaptorSign(secret, message, point, aux);
    must(a.adaptorVerify(publicKey, message, presignature), `case ${caseId}: pre-signature failed`);
    const completed = a.adaptorComplete(presignature, adaptorSecret);
    must(a.schnorrVerify(publicKey, message, completed), `case ${caseId}: completion failed`);
    must(
      a.adaptorExtract(presignature, completed, publicKey, message) === adaptorSecret,
      `case ${caseId}: extracted scalar mismatch`
    );
    metrics.adaptorRoundTrips++;

    const oppositePresignature = a.adaptorSign(secret, message, opposite, aux);
    must(
      presignature.R0x !== oppositePresignature.R0x || presignature.R0y !== oppositePresignature.R0y,
      `case ${caseId}: T/-T nonce collision`
    );
    metrics.relatedPointAttemptsBlocked++;

    const nonCanonical = { ...presignature, s0: `00${presignature.s0}` };
    must(!a.adaptorVerify(publicKey, message, nonCanonical), `case ${caseId}: non-canonical s0 accepted`);
    must(!a.schnorrVerify(publicKey, message, sha256(`short:${caseId}`)), `case ${caseId}: short signature accepted`);
    must(!a.schnorrVerify(Buffer.alloc(0), message, completed), `case ${caseId}: short public key accepted`);
    metrics.malformedInputsRejected += 3;

    if (caseId % 10 === 0) {
      const up = sha256(`event:${caseId}:up`);
      const down = sha256(`event:${caseId}:down`);
      const oracleSecret = scalar(`oracle-key:${caseId}`);
      const nonceSeed = scalar(`oracle-nonce-seed:${caseId}`);
      const announcement = a.buildDlcOracle(oracleSecret, nonceSeed, {
        eventId: `event-${caseId}`,
        outcomeMessages: [up, down]
      });
      must(a.verifyDlcOracleAnnouncement(announcement), `case ${caseId}: announcement failed`);
      a.dlcOutcomePoint(announcement, up);
      const attestation = a.dlcAttest(announcement, up);
      must(a.verifyDlcAttestation(announcement, up, attestation), `case ${caseId}: attestation failed`);
      metrics.oracleEvents++;

      mustThrow(
        () => a.dlcAttest(announcement, down),
        /conflicting outcome/,
        `case ${caseId}: oracle equivocation`
      );
      metrics.oracleEquivocationsBlocked++;

      mustThrow(
        () => a.dlcAttest({ ...announcement }, up),
        /signer state is unavailable/,
        `case ${caseId}: cloned signer state`
      );

      const otherEvent = a.buildDlcOracle(oracleSecret, nonceSeed, {
        eventId: `other-event-${caseId}`,
        outcomeMessages: [down]
      });
      must(announcement.rx !== otherEvent.rx, `case ${caseId}: cross-event nonce reused`);
      metrics.crossEventNonceReusesBlocked++;

      must(
        !a.verifyDlcOracleAnnouncement({ ...announcement, eventId: `mutated-${caseId}` }),
        `case ${caseId}: mutated announcement accepted`
      );
      metrics.announcementMutationsRejected++;
    }

    metrics.cases++;
  }
  return metrics;
}

if (!isMainThread) {
  try {
    parentPort.postMessage({ ok: true, metrics: runCases(workerData.start, workerData.count, workerData.workerId) });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error.message, workerId: workerData.workerId });
  }
} else {
  const totalCases = Number(process.env.DLC_FUZZ_CASES || 2000);
  const requestedWorkers = Number(process.env.DLC_FUZZ_WORKERS || 4);
  if (!Number.isSafeInteger(totalCases) || totalCases < 1 || totalCases > 100000) {
    throw new Error('DLC_FUZZ_CASES must be in 1..100000');
  }
  if (!Number.isSafeInteger(requestedWorkers) || requestedWorkers < 1 || requestedWorkers > 32) {
    throw new Error('DLC_FUZZ_WORKERS must be in 1..32');
  }
  const workerCount = Math.min(requestedWorkers, totalCases);
  const startedAt = Date.now();
  const jobs = [];
  let nextStart = 0;
  for (let workerId = 0; workerId < workerCount; workerId++) {
    const remainingWorkers = workerCount - workerId;
    const count = Math.ceil((totalCases - nextStart) / remainingWorkers);
    const start = nextStart;
    nextStart += count;
    jobs.push(new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: { start, count, workerId } });
      worker.once('message', (message) => message.ok ? resolve(message.metrics) : reject(new Error(message.error)));
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`worker ${workerId} exited ${code}`));
      });
    }));
  }

  Promise.all(jobs).then((rows) => {
    const totals = {};
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        if (key === 'workerId') continue;
        totals[key] = (totals[key] || 0) + value;
      }
    }
    console.log(JSON.stringify({
      schema: 'utxoref_dlc_adaptor_fuzz_v1',
      ok: totals.cases === totalCases,
      workers: workerCount,
      elapsedMs: Date.now() - startedAt,
      totals
    }, null, 2));
  }).catch((error) => {
    console.error(JSON.stringify({
      schema: 'utxoref_dlc_adaptor_fuzz_v1',
      ok: false,
      error: error.message
    }, null, 2));
    process.exitCode = 1;
  });
}
