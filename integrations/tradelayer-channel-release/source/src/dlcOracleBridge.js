const crypto = require('crypto');
const secp = require('tiny-secp256k1');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function canonicalRelayMessage(bundle) {
  const canonical = {
    eventId: String(bundle.eventId || ''),
    outcome: String(bundle.outcome || ''),
    outcomeIndex: Number(bundle.outcomeIndex || 0),
    stateHash: String(bundle.stateHash || ''),
    timestamp: Number(bundle.timestamp || 0)
  };
  if (bundle.payloadHash !== undefined && bundle.payloadHash !== null) {
    canonical.payloadHash = String(bundle.payloadHash);
  }
  return JSON.stringify(canonical);
}

function toPubkeyBuffer(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const clean = hex.trim();
  if (![66, 130].includes(clean.length)) return null;
  return Buffer.from(clean, 'hex');
}

function toSigBuffer(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const clean = hex.trim();
  if (clean.length !== 128) return null;
  return Buffer.from(clean, 'hex');
}

const DlcOracleBridge = {
  fromNodeDlcLike(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      eventId: raw.eventId || raw.oracleEventId || raw.event_id || '',
      outcome: raw.outcome || (Array.isArray(raw.outcomes) ? raw.outcomes[0] : '') || '',
      outcomeIndex: raw.outcomeIndex ?? raw.outcome_index ?? 0,
      stateHash: raw.stateHash || raw.tradeLayerStateHash || raw.state_hash || '',
      timestamp: raw.timestamp || raw.eventMaturityEpoch || raw.event_maturity_epoch || 0,
      payloadHash: raw.payloadHash || raw.payload_hash || '',
      balancePayloadB64: raw.balancePayloadB64 || raw.balance_payload_b64 || '',
      oraclePubkeyHex: raw.oraclePubkeyHex || raw.oraclePubkey || raw.oracle_public_key || '',
      signatureHex: raw.signatureHex || (Array.isArray(raw.signatures) ? raw.signatures[0] : '') || ''
    };
  },

  parseRelayBlob(relayBlob) {
    if (!relayBlob) return null;
    try {
      let raw = relayBlob;
      if (typeof relayBlob === 'string' && relayBlob.startsWith('b64:')) {
        raw = Buffer.from(relayBlob.slice(4), 'base64').toString('utf8');
      }
      const parsed = JSON.parse(raw);
      return this.fromNodeDlcLike(parsed) || parsed;
    } catch {
      return null;
    }
  },

  validateRelayBundle(bundle, expectedStateHash = '') {
    if (!bundle || typeof bundle !== 'object') {
      return { valid: false, reason: 'Missing relay bundle' };
    }
    const pubkey = toPubkeyBuffer(bundle.oraclePubkeyHex);
    const sig = toSigBuffer(bundle.signatureHex);
    if (!pubkey || !sig) {
      return { valid: false, reason: 'Invalid oracle pubkey/signature encoding' };
    }

    const message = canonicalRelayMessage(bundle);
    const msgHash = sha256(Buffer.from(message, 'utf8'));
    let verified = secp.verify(msgHash, pubkey, sig);
    if (!verified) {
      // Backward compatibility: legacy bundles did not include payloadHash in canonical signature body.
      const legacy = { ...bundle };
      delete legacy.payloadHash;
      const legacyHash = sha256(Buffer.from(canonicalRelayMessage(legacy), 'utf8'));
      verified = secp.verify(legacyHash, pubkey, sig);
    }
    if (!verified) {
      return { valid: false, reason: 'Invalid oracle relay signature' };
    }

    if (bundle.payloadHash) {
      const payloadHash = String(bundle.payloadHash);
      const hexLike = /^[0-9a-fA-F]{64}$/.test(payloadHash);
      if (!hexLike) {
        return { valid: false, reason: 'Invalid payloadHash format' };
      }
      if (bundle.balancePayloadB64) {
        const actual = sha256(Buffer.from(bundle.balancePayloadB64, 'base64')).toString('hex');
        if (actual !== payloadHash.toLowerCase()) {
          return { valid: false, reason: 'payloadHash mismatch for balance payload' };
        }
      }
    }

    if (expectedStateHash && String(bundle.stateHash || '') !== String(expectedStateHash)) {
      return { valid: false, reason: 'Relay state hash mismatch' };
    }
    return { valid: true };
  }
};

module.exports = DlcOracleBridge;
