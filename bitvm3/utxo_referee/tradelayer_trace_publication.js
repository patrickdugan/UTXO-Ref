/**
 * Trace publication and data-availability (SECURITY_BLOCKERS.md #6).
 *
 * To localize a single bad gate among a bonded BitVM circuit's disprove
 * leaves (up to ~447k of them for the SHA256 circuit), a challenger needs
 * the operator's full wire-commitment execution trace - e.g. the wireMap
 * produced by `commitCircuitWires()` in tradelayer_bitvm_comparator.js /
 * tradelayer_bitvm_sha256.js. Nothing in this repo previously specified
 * where that trace is published, in what format, for how long, or what
 * happens if the operator bonds a claim and simply withholds it - if
 * withholding isn't itself punishable, an operator can bond a fraudulent
 * claim and data-starve any would-be challenger until the CSV timeout
 * expires uncontested.
 *
 * This module is the interim (single-operator-process) mechanism:
 *   - publishTrace(): hash-commits the trace and writes it to a
 *     retrievable location (a local artifacts path, standing in for the
 *     retrievable/mirrored location a real deployment would use - a
 *     webserver, IPFS, a gist, whatever; the hash-commitment discipline is
 *     what actually matters and transfers directly).
 *   - retrieveTrace(): reads it back and verifies the hash matches what
 *     was committed - detects substitution as well as absence.
 *   - checkPublicationFault(): the actual soundness rule - if the trace is
 *     not retrievable within `slaBlocks` of the bonding transaction
 *     confirming, that is ITSELF treated as a fault, independent of
 *     whether the circuit claim turns out to be honest or not.
 *
 * Residual gap, stated plainly: this is a local-filesystem implementation
 * of the retrieval side. A real deployment needs the trace mirrored
 * somewhere an independent challenger can reach without the operator's
 * cooperation (this repo's operator and challenger are still the same
 * process/wallet either way - see SECURITY_BLOCKERS.md #3). Retention (
 * "for how long") is not enforced here at all - nothing deletes a
 * published trace in this demo, which sidesteps rather than answers the
 * retention question a real system needs to specify.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalStringify } = require('./m1_spec');

const DEFAULT_TRACE_DIR = path.join(__dirname, 'artifacts', 'live', 'traces');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashTrace(trace) {
  return sha256Hex(canonicalStringify(trace));
}

/**
 * Publish a trace (any JSON-serializable value - typically a circuit
 * wireMap) to a retrievable location, hash-committed.
 *
 * Returns a TracePublicationCommitment: { traceHash, retrievalPath,
 * publishedAtHeight, sizeBytes }. `traceHash` is what should be folded
 * into the bonded output's own commitment (e.g. alongside the circuit's
 * taproot root), so a challenger can verify a retrieved trace actually
 * matches what the operator committed to, not a substituted one.
 */
function publishTrace(trace, options = {}) {
  const traceDir = options.traceDir || DEFAULT_TRACE_DIR;
  const traceHash = hashTrace(trace);
  const retrievalPath = options.retrievalPath || path.join(traceDir, `${traceHash}.json`);
  const serialized = `${JSON.stringify(trace, null, 2)}\n`;

  fs.mkdirSync(path.dirname(retrievalPath), { recursive: true });
  const tmp = `${retrievalPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, serialized);
  fs.renameSync(tmp, retrievalPath);

  return {
    kind: 'tradelayer_trace_publication_commitment',
    traceHash,
    retrievalPath,
    publishedAtHeight: options.publishedAtHeight ?? null,
    publishedAt: new Date().toISOString(),
    sizeBytes: Buffer.byteLength(serialized)
  };
}

/**
 * Retrieve a previously-published trace and verify it matches the
 * committed hash. Throws if missing or if the retrieved content's hash
 * does not match `expectedTraceHash` (tamper/substitution detection).
 */
function retrieveTrace(expectedTraceHash, retrievalPath) {
  if (!fs.existsSync(retrievalPath)) {
    const err = new Error(`trace not retrievable at ${retrievalPath}`);
    err.code = 'TRACE_NOT_AVAILABLE';
    throw err;
  }
  const trace = JSON.parse(fs.readFileSync(retrievalPath, 'utf8'));
  const actualHash = hashTrace(trace);
  if (actualHash !== expectedTraceHash) {
    const err = new Error(`trace hash mismatch: expected ${expectedTraceHash}, got ${actualHash} (substituted or corrupted)`);
    err.code = 'TRACE_HASH_MISMATCH';
    throw err;
  }
  return trace;
}

/**
 * The soundness rule: a bonded circuit assertion whose trace is not
 * retrievable (or fails hash verification) within `slaBlocks` of the
 * bonding transaction (`bondedAtHeight`) confirming is itself a fault,
 * independent of whether the underlying circuit claim is honest. This is
 * what stops an operator from bonding a fraudulent claim and simply
 * data-starving any would-be challenger until a CSV timeout expires
 * uncontested.
 *
 * Returns { fault, reason, retrievable, ageBlocks, withinSla }.
 */
function checkPublicationFault({ traceHash, retrievalPath, bondedAtHeight, currentHeight, slaBlocks }) {
  if (bondedAtHeight === undefined || bondedAtHeight === null || currentHeight === undefined || currentHeight === null) {
    throw new Error('checkPublicationFault requires both bondedAtHeight and currentHeight');
  }
  const ageBlocks = Number(currentHeight) - Number(bondedAtHeight);
  const withinSla = ageBlocks <= Number(slaBlocks);

  let retrievable = false;
  let retrievalError = null;
  try {
    retrieveTrace(traceHash, retrievalPath);
    retrievable = true;
  } catch (err) {
    retrievalError = err;
  }

  if (retrievable) {
    return { fault: false, reason: 'trace retrievable and hash-verified', retrievable: true, ageBlocks, withinSla };
  }
  if (withinSla) {
    // Not yet published, but still inside the grace period - not a fault yet.
    return { fault: false, reason: `not yet published, but within SLA (${ageBlocks}/${slaBlocks} blocks)`, retrievable: false, ageBlocks, withinSla };
  }
  return {
    fault: true,
    reason: `TRACE_WITHHOLDING_FAULT: not retrievable after ${ageBlocks} blocks (SLA ${slaBlocks}) - ${retrievalError ? retrievalError.message : 'unknown reason'}`,
    retrievable: false,
    ageBlocks,
    withinSla
  };
}

module.exports = {
  hashTrace,
  publishTrace,
  retrieveTrace,
  checkPublicationFault,
  DEFAULT_TRACE_DIR
};
