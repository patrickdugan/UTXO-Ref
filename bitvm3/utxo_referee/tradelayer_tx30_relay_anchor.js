/**
 * TradeLayer tx30 Relay Blob Anchor
 *
 * A full signed tx30 relay bundle is too large for a standard OP_RETURN.
 * This module builds a deterministic off-chain envelope for the full blob and
 * a compact on-chain reference payload that commits to that envelope by hash.
 */

const { stableStringify, sha256Hex } = require('./tradelayer_pnl_route_adapter');

const RELAY_ANCHOR_KIND = 'tradelayer_tx30_relay_anchor_v1';
const RELAY_BLOB_ENVELOPE_KIND = 'tradelayer_tx30_relay_blob_envelope_v1';
const RELAY_REFERENCE_KIND = 'tradelayer_tx30_relay_reference_v1';
const RELAY_REFERENCE_PREFIX = 'tlr1:';
const MAX_STANDARD_OP_RETURN_PAYLOAD_BYTES = 80;

function parseRelayBlob(relayBlob) {
  if (!relayBlob) throw new Error('relayBlob is required');
  if (typeof relayBlob === 'object') return relayBlob;
  let raw = String(relayBlob);
  if (raw.startsWith('b64:')) {
    raw = Buffer.from(raw.slice(4), 'base64').toString('utf8');
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`relayBlob is not valid JSON: ${err.message}`);
  }
}

function normalizeRelayRecord(input = {}) {
  const relayBlob = input.relayBlob ?? input.blob ?? input.relayBundle;
  const relayBundle = parseRelayBlob(relayBlob);
  const canonicalRelayBlob = stableStringify(relayBundle);
  const relayBlobHash = sha256Hex(canonicalRelayBlob);
  return {
    relayBundle,
    canonicalRelayBlob,
    relayBlobHash,
    relayBlobBytes: Buffer.byteLength(canonicalRelayBlob, 'utf8')
  };
}

function buildTx30RelayBlobEnvelope(input = {}) {
  const normalized = normalizeRelayRecord(input);
  const relayBundle = normalized.relayBundle;
  const source = {
    chain: input.chain ? String(input.chain) : null,
    oracleId: input.oracleId ?? input.relayRecord?.oracleId ?? null,
    relayType: input.relayType ?? input.relayRecord?.relayType ?? null,
    stateHash: input.stateHash ?? input.relayRecord?.stateHash ?? relayBundle.stateHash ?? null,
    dlcRef: input.dlcRef ?? input.relayRecord?.dlcRef ?? null,
    settlementState: input.settlementState ?? relayBundle.outcome ?? null,
    blockHeight: input.blockHeight ?? input.relayRecord?.blockHeight ?? null,
    relayStoreKey: input.relayStoreKey ?? input.relayRecord?._id ?? null
  };

  const envelopeCore = {
    kind: RELAY_BLOB_ENVELOPE_KIND,
    relayBlobHash: normalized.relayBlobHash,
    relayBlobBytes: normalized.relayBlobBytes,
    relayBundle,
    source
  };

  return {
    ...envelopeCore,
    envelopeHash: sha256Hex(envelopeCore)
  };
}

function opReturnScriptHexForPayload(payloadText) {
  const payload = Buffer.from(payloadText, 'utf8');
  if (payload.length > MAX_STANDARD_OP_RETURN_PAYLOAD_BYTES) {
    throw new Error(`OP_RETURN payload is ${payload.length} bytes; max ${MAX_STANDARD_OP_RETURN_PAYLOAD_BYTES}`);
  }
  if (payload.length > 75) {
    return `6a4c${payload.length.toString(16).padStart(2, '0')}${payload.toString('hex')}`;
  }
  return `6a${payload.length.toString(16).padStart(2, '0')}${payload.toString('hex')}`;
}

function buildTx30RelayReference(input = {}) {
  const envelope = input.envelope?.kind === RELAY_BLOB_ENVELOPE_KIND
    ? input.envelope
    : buildTx30RelayBlobEnvelope(input);
  const relayBlobHash = String(envelope.relayBlobHash || '');
  if (!/^[0-9a-f]{64}$/.test(relayBlobHash)) {
    throw new Error('relayBlobHash must be a 32-byte lowercase hex string');
  }
  const payloadText = `${RELAY_REFERENCE_PREFIX}${relayBlobHash}`;
  const payloadHex = Buffer.from(payloadText, 'utf8').toString('hex');
  const payloadBytes = Buffer.byteLength(payloadText, 'utf8');
  const referenceCore = {
    kind: RELAY_REFERENCE_KIND,
    protocol: 'tradelayer-tx30-relay-ref',
    version: 1,
    relayBlobHash,
    payloadText,
    payloadHex,
    payloadBytes,
    opReturnScriptHex: opReturnScriptHexForPayload(payloadText)
  };
  return {
    ...referenceCore,
    referenceHash: sha256Hex(referenceCore)
  };
}

function buildTx30RelayAnchor(input = {}) {
  const envelope = input.envelope?.kind === RELAY_BLOB_ENVELOPE_KIND
    ? input.envelope
    : buildTx30RelayBlobEnvelope(input);
  const reference = input.reference?.kind === RELAY_REFERENCE_KIND
    ? input.reference
    : buildTx30RelayReference({ envelope });
  const anchorCore = {
    kind: RELAY_ANCHOR_KIND,
    envelopeHash: envelope.envelopeHash,
    relayBlobHash: envelope.relayBlobHash,
    referenceHash: reference.referenceHash,
    payloadText: reference.payloadText,
    opReturnScriptHex: reference.opReturnScriptHex,
    chainTxid: input.chainTxid || null,
    explorer: input.explorer || null
  };
  return {
    ...anchorCore,
    envelope,
    reference,
    anchorHash: sha256Hex(anchorCore)
  };
}

function verifyTx30RelayAnchor(anchor = {}) {
  const errors = [];
  if (anchor.kind !== RELAY_ANCHOR_KIND) errors.push('anchor kind mismatch');
  const envelope = anchor.envelope || {};
  const reference = anchor.reference || {};
  try {
    const rebuiltEnvelope = buildTx30RelayBlobEnvelope({
      relayBlob: envelope.relayBundle,
      chain: envelope.source?.chain,
      oracleId: envelope.source?.oracleId,
      relayType: envelope.source?.relayType,
      stateHash: envelope.source?.stateHash,
      dlcRef: envelope.source?.dlcRef,
      settlementState: envelope.source?.settlementState,
      blockHeight: envelope.source?.blockHeight,
      relayStoreKey: envelope.source?.relayStoreKey
    });
    if (rebuiltEnvelope.relayBlobHash !== envelope.relayBlobHash) errors.push('relay blob hash mismatch');
    if (rebuiltEnvelope.envelopeHash !== envelope.envelopeHash) errors.push('envelope hash mismatch');
    const rebuiltReference = buildTx30RelayReference({ envelope: rebuiltEnvelope });
    if (rebuiltReference.payloadText !== reference.payloadText) errors.push('reference payload mismatch');
    if (rebuiltReference.opReturnScriptHex !== reference.opReturnScriptHex) errors.push('OP_RETURN script mismatch');
    if (rebuiltReference.referenceHash !== reference.referenceHash) errors.push('reference hash mismatch');
  } catch (err) {
    errors.push(err.message);
  }

  if (reference.payloadBytes > MAX_STANDARD_OP_RETURN_PAYLOAD_BYTES) {
    errors.push('reference payload exceeds standard OP_RETURN budget');
  }
  if (!envelope.relayBundle?.signatureHex) errors.push('relay bundle missing signatureHex');
  if (!envelope.relayBundle?.oraclePubkeyHex) errors.push('relay bundle missing oraclePubkeyHex');
  if (!envelope.relayBundle?.payloadHash) errors.push('relay bundle missing payloadHash');

  const rebuiltCore = {
    kind: RELAY_ANCHOR_KIND,
    envelopeHash: envelope.envelopeHash,
    relayBlobHash: envelope.relayBlobHash,
    referenceHash: reference.referenceHash,
    payloadText: reference.payloadText,
    opReturnScriptHex: reference.opReturnScriptHex,
    chainTxid: anchor.chainTxid || null,
    explorer: anchor.explorer || null
  };
  if (anchor.anchorHash && sha256Hex(rebuiltCore) !== anchor.anchorHash) {
    errors.push('anchor hash mismatch');
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function readLatestRelayRecordFromNeDb(filePath, filters = {}) {
  const fs = require('fs');
  if (!fs.existsSync(filePath)) throw new Error(`relay db not found: ${filePath}`);
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  const records = [];
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== 'relay') continue;
    if (filters.dlcRef && String(row.dlcRef) !== String(filters.dlcRef)) continue;
    if (filters.oracleId && Number(row.oracleId) !== Number(filters.oracleId)) continue;
    if (filters.relayType && Number(row.relayType) !== Number(filters.relayType)) continue;
    records.push(row);
  }
  if (!records.length) throw new Error('no matching relay record found');
  return records[records.length - 1];
}

function artifactHashForTx30RelayAnchorArtifact(artifact) {
  return sha256Hex(stableStringify({
    kind: artifact.kind,
    relayBlobHash: artifact.anchor?.relayBlobHash,
    envelopeHash: artifact.anchor?.envelopeHash,
    referenceHash: artifact.anchor?.referenceHash,
    chainTxid: artifact.anchor?.chainTxid || null,
    broadcastTxid: artifact.broadcast?.txid || null
  }));
}

module.exports = {
  RELAY_ANCHOR_KIND,
  RELAY_BLOB_ENVELOPE_KIND,
  RELAY_REFERENCE_KIND,
  RELAY_REFERENCE_PREFIX,
  MAX_STANDARD_OP_RETURN_PAYLOAD_BYTES,
  parseRelayBlob,
  normalizeRelayRecord,
  buildTx30RelayBlobEnvelope,
  buildTx30RelayReference,
  buildTx30RelayAnchor,
  verifyTx30RelayAnchor,
  readLatestRelayRecordFromNeDb,
  artifactHashForTx30RelayAnchorArtifact
};
