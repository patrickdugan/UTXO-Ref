const crypto = require('crypto');
const tinysecp = require('../../node-dlc/packages/messaging/node_modules/tiny-secp256k1');
const schnorr = require('../../node-dlc/packages/messaging/node_modules/bip-schnorr');
const { normalizeTags } = require('./types');

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

function normalizePrivateKeyHex(privateKeyHex) {
  const hex = String(privateKeyHex || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('privateKeyHex must be a 32-byte hex string');
  }
  return hex;
}

function derivePubkeyHex(privateKeyHex) {
  const normalized = normalizePrivateKeyHex(privateKeyHex);
  const point = tinysecp.pointFromScalar(Buffer.from(normalized, 'hex'), true);
  if (!point) {
    throw new Error('Failed to derive secp256k1 pubkey');
  }
  return point.slice(1, 33).toString('hex');
}

function createUnsignedEvent({
  kind,
  pubkey,
  created_at = Math.floor(Date.now() / 1000),
  tags = [],
  content = ''
}) {
  const normalizedPubkey = String(pubkey || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedPubkey)) {
    throw new Error('pubkey must be a 32-byte hex string');
  }

  const event = {
    kind: Number(kind),
    pubkey: normalizedPubkey,
    created_at: Number(created_at),
    tags: normalizeTags(tags),
    content: typeof content === 'string' ? content : canonicalJsonString(content)
  };

  if (!Number.isInteger(event.kind)) {
    throw new Error('kind must be an integer');
  }
  if (!Number.isInteger(event.created_at) || event.created_at < 0) {
    throw new Error('created_at must be a non-negative integer');
  }

  return event;
}

function serializeEventForId(event) {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ]);
}

function computeEventId(event) {
  return crypto.createHash('sha256')
    .update(serializeEventForId(event))
    .digest('hex');
}

function signEvent(eventLike, privateKeyHex) {
  const normalizedPrivateKey = normalizePrivateKeyHex(privateKeyHex);
  const derivedPubkey = derivePubkeyHex(normalizedPrivateKey);
  const event = createUnsignedEvent({
    ...eventLike,
    pubkey: eventLike.pubkey || derivedPubkey
  });

  if (event.pubkey !== derivedPubkey) {
    throw new Error('pubkey does not match privateKeyHex');
  }

  const id = computeEventId(event);
  const sig = schnorr
    .sign(normalizedPrivateKey, Buffer.from(id, 'hex'))
    .toString('hex');

  return {
    ...event,
    id,
    sig
  };
}

function verifyEvent(event) {
  try {
    if (typeof event !== 'object' || event == null) {
      return false;
    }
    if (!/^[0-9a-f]{64}$/.test(String(event.id || ''))) {
      return false;
    }
    if (!/^[0-9a-f]{128}$/.test(String(event.sig || ''))) {
      return false;
    }

    const unsigned = createUnsignedEvent({
      kind: event.kind,
      pubkey: event.pubkey,
      created_at: event.created_at,
      tags: event.tags,
      content: event.content
    });
    const recomputedId = computeEventId(unsigned);
    if (recomputedId !== event.id) {
      return false;
    }

    schnorr.verify(
      Buffer.from(event.pubkey, 'hex'),
      Buffer.from(event.id, 'hex'),
      Buffer.from(event.sig, 'hex')
    );
    return true;
  } catch (error) {
    return false;
  }
}

function tagValue(event, key) {
  const tag = (event.tags || []).find((entry) => entry[0] === key);
  return tag ? tag[1] : null;
}

module.exports = {
  canonicalize,
  canonicalJsonString,
  normalizePrivateKeyHex,
  derivePubkeyHex,
  createUnsignedEvent,
  serializeEventForId,
  computeEventId,
  signEvent,
  verifyEvent,
  tagValue
};
