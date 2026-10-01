/**
 * Durable retrieval for tx30 relay blob-reference anchors.
 *
 * Bitcoin carries only `tlr1:<relayBlobHash>`. This module publishes the full
 * signed relay bundle to multiple simple replica directories and verifies that
 * any recovered copy matches the on-chain reference hash.
 */

const fs = require('fs');
const path = require('path');
const { stableStringify, sha256Hex } = require('./tradelayer_pnl_route_adapter');
const {
  RELAY_ANCHOR_KIND,
  buildTx30RelayBlobEnvelope,
  buildTx30RelayReference,
  buildTx30RelayAnchor,
  verifyTx30RelayAnchor
} = require('./tradelayer_tx30_relay_anchor');

const RELAY_BUNDLE_DOCUMENT_KIND = 'tradelayer_tx30_relay_bundle_document_v1';
const RELAY_RETRIEVAL_RESULT_KIND = 'tradelayer_tx30_relay_retrieval_result_v1';

function requireAnchor(anchor) {
  if (!anchor || anchor.kind !== RELAY_ANCHOR_KIND) throw new Error('tx30 relay anchor is required');
  const verified = verifyTx30RelayAnchor(anchor);
  if (!verified.ok) throw new Error(`invalid tx30 relay anchor: ${verified.errors.join('; ')}`);
  return anchor;
}

function relayDocumentCore(document) {
  return {
    kind: document.kind,
    relayBlobHash: document.relayBlobHash,
    envelopeHash: document.envelopeHash,
    referenceHash: document.referenceHash,
    chainTxid: document.chainTxid || null,
    source: document.source || {},
    relayBundle: document.relayBundle
  };
}

function buildRelayBundleDocument(anchor, options = {}) {
  const a = requireAnchor(anchor);
  const document = {
    kind: RELAY_BUNDLE_DOCUMENT_KIND,
    createdAt: options.createdAt || new Date().toISOString(),
    relayBlobHash: a.relayBlobHash,
    envelopeHash: a.envelopeHash,
    referenceHash: a.referenceHash,
    chainTxid: a.chainTxid || null,
    source: {
      ...a.envelope.source,
      replicaLabel: options.replicaLabel || null
    },
    relayBundle: a.envelope.relayBundle
  };
  document.documentHash = sha256Hex(relayDocumentCore(document));
  return document;
}

function relayBundlePath(replicaDir, relayBlobHash) {
  if (!/^[0-9a-f]{64}$/.test(String(relayBlobHash || ''))) {
    throw new Error('relayBlobHash must be a 32-byte lowercase hex string');
  }
  return path.join(replicaDir, `${relayBlobHash}.json`);
}

function writeRelayBundleDocument(replicaDir, document) {
  fs.mkdirSync(replicaDir, { recursive: true });
  const finalPath = relayBundlePath(replicaDir, document.relayBlobHash);
  const tmp = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(document, null, 2) + '\n');
  fs.renameSync(tmp, finalPath);
  return finalPath;
}

function publishRelayBundleToReplicas(anchor, replicaDirs, options = {}) {
  if (!Array.isArray(replicaDirs) || replicaDirs.length < 2) {
    throw new Error('at least two replica directories are required');
  }
  const writes = [];
  for (const [index, replicaDir] of replicaDirs.entries()) {
    const document = buildRelayBundleDocument(anchor, {
      createdAt: options.createdAt,
      replicaLabel: options.replicaLabels?.[index] || `replica-${index + 1}`
    });
    writes.push({
      replicaDir,
      path: writeRelayBundleDocument(replicaDir, document),
      relayBlobHash: document.relayBlobHash,
      documentHash: document.documentHash
    });
  }
  return {
    kind: 'tradelayer_tx30_relay_replica_publication_v1',
    relayBlobHash: anchor.relayBlobHash,
    replicaCount: writes.length,
    writes,
    publicationHash: sha256Hex({
      relayBlobHash: anchor.relayBlobHash,
      writes: writes.map((w) => ({ replicaDir: w.replicaDir, documentHash: w.documentHash }))
    })
  };
}

function readRelayBundleDocument(replicaDir, relayBlobHash) {
  const filePath = relayBundlePath(replicaDir, relayBlobHash);
  if (!fs.existsSync(filePath)) {
    return { found: false, replicaDir, path: filePath, reason: 'missing' };
  }
  try {
    return {
      found: true,
      replicaDir,
      path: filePath,
      document: JSON.parse(fs.readFileSync(filePath, 'utf8'))
    };
  } catch (err) {
    return { found: true, replicaDir, path: filePath, reason: `invalid_json: ${err.message}` };
  }
}

function verifyRelayBundleDocument(document, expected = {}) {
  const errors = [];
  if (!document || document.kind !== RELAY_BUNDLE_DOCUMENT_KIND) errors.push('relay document kind mismatch');
  if (expected.relayBlobHash && document.relayBlobHash !== expected.relayBlobHash) errors.push('relay blob hash mismatch');
  if (expected.envelopeHash && document.envelopeHash !== expected.envelopeHash) errors.push('envelope hash mismatch');
  if (expected.referenceHash && document.referenceHash !== expected.referenceHash) errors.push('reference hash mismatch');
  if (!document?.relayBundle?.signatureHex) errors.push('relay bundle missing signatureHex');
  if (!document?.relayBundle?.oraclePubkeyHex) errors.push('relay bundle missing oraclePubkeyHex');
  if (!document?.relayBundle?.payloadHash) errors.push('relay bundle missing payloadHash');
  if (stableStringify(document || {}).match(/priv(?:ate)?key|secret/i)) errors.push('relay document appears to contain private key material');

  if (document?.documentHash) {
    const rebuilt = sha256Hex(relayDocumentCore(document));
    if (rebuilt !== document.documentHash) errors.push('relay document hash mismatch');
  }

  try {
    const envelope = buildTx30RelayBlobEnvelope({
      relayBlob: document.relayBundle,
      chain: document.source?.chain,
      oracleId: document.source?.oracleId,
      relayType: document.source?.relayType,
      stateHash: document.source?.stateHash,
      dlcRef: document.source?.dlcRef,
      settlementState: document.source?.settlementState,
      blockHeight: document.source?.blockHeight,
      relayStoreKey: document.source?.relayStoreKey
    });
    const reference = buildTx30RelayReference({ envelope });
    const anchor = buildTx30RelayAnchor({
      envelope,
      reference,
      chainTxid: document.chainTxid || null,
      explorer: expected.explorer || null
    });
    const verifiedAnchor = verifyTx30RelayAnchor(anchor);
    if (!verifiedAnchor.ok) errors.push(...verifiedAnchor.errors);
    if (envelope.relayBlobHash !== document.relayBlobHash) errors.push('document relay hash does not match bundle');
    if (envelope.envelopeHash !== document.envelopeHash) errors.push('document envelope hash does not match bundle');
    if (reference.referenceHash !== document.referenceHash) errors.push('document reference hash does not match bundle');
  } catch (err) {
    errors.push(err.message);
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function retrieveRelayBundleFromReplicas({ relayBlobHash, replicaDirs, expected = {} }) {
  if (!Array.isArray(replicaDirs) || replicaDirs.length === 0) throw new Error('replicaDirs are required');
  const attempts = [];
  for (const replicaDir of replicaDirs) {
    const read = readRelayBundleDocument(replicaDir, relayBlobHash);
    if (!read.found || read.reason) {
      attempts.push({ replicaDir, path: read.path, ok: false, reason: read.reason || 'missing' });
      continue;
    }
    const verification = verifyRelayBundleDocument(read.document, { relayBlobHash, ...expected });
    attempts.push({
      replicaDir,
      path: read.path,
      ok: verification.ok,
      reason: verification.ok ? null : verification.errors.join('; '),
      documentHash: read.document.documentHash || null
    });
    if (verification.ok) {
      return {
        kind: RELAY_RETRIEVAL_RESULT_KIND,
        ok: true,
        relayBlobHash,
        document: read.document,
        recoveredFrom: replicaDir,
        attempts,
        retrievalHash: sha256Hex({ relayBlobHash, recoveredFrom: replicaDir, documentHash: read.document.documentHash })
      };
    }
  }
  return {
    kind: RELAY_RETRIEVAL_RESULT_KIND,
    ok: false,
    relayBlobHash,
    document: null,
    recoveredFrom: null,
    attempts,
    retrievalHash: sha256Hex({ relayBlobHash, attempts })
  };
}

function buildRelayRetrievalFault(anchor, retrievalResult, options = {}) {
  const a = requireAnchor(anchor);
  const result = retrievalResult || {};
  return {
    kind: 'tradelayer_tx30_relay_retrieval_fault_v1',
    fault: result.ok !== true,
    severity: result.ok === true ? 'none' : 'block',
    relayBlobHash: a.relayBlobHash,
    chainTxid: a.chainTxid || null,
    checkedAtHeight: options.checkedAtHeight ?? null,
    reason: result.ok === true ? null : 'signed_relay_bundle_unavailable_or_invalid',
    attempts: result.attempts || [],
    faultHash: sha256Hex({
      relayBlobHash: a.relayBlobHash,
      chainTxid: a.chainTxid || null,
      ok: result.ok === true,
      attempts: result.attempts || []
    })
  };
}

module.exports = {
  RELAY_BUNDLE_DOCUMENT_KIND,
  RELAY_RETRIEVAL_RESULT_KIND,
  buildRelayBundleDocument,
  publishRelayBundleToReplicas,
  readRelayBundleDocument,
  verifyRelayBundleDocument,
  retrieveRelayBundleFromReplicas,
  buildRelayRetrievalFault,
  relayBundlePath
};
