const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function normalizeHex(v) {
  return String(v || '').trim().toLowerCase();
}

function defaultBundlePath() {
  return process.env.TL_BITVM_BUNDLE_PATH
    || 'C:\\projects\\UTXORef\\UTXO-Ref\\bitvm3\\utxo_referee\\artifacts\\m1_challenge_bundle_latest.json';
}

function loadBundleFromPath(p) {
  const abs = path.resolve(p);
  const raw = fs.readFileSync(abs, 'utf8');
  const parsed = JSON.parse(raw);
  return { abs, parsed };
}

function computeBundleHash(bundleDoc) {
  const copy = { ...(bundleDoc || {}) };
  delete copy.bundleHash;
  return sha256Hex(JSON.stringify(copy));
}

async function verifyBundleHash(expectedBundleHash, explicitPath = '') {
  const want = normalizeHex(expectedBundleHash);
  if (!want) {
    return { valid: false, reason: 'Missing bundleHash' };
  }

  const bundlePath = explicitPath || defaultBundlePath();
  try {
    const { abs, parsed } = loadBundleFromPath(bundlePath);
    const declared = normalizeHex(parsed.bundleHash);
    const computed = normalizeHex(computeBundleHash(parsed));

    if (!declared) {
      return { valid: false, reason: `Bundle at ${abs} has no bundleHash` };
    }
    if (declared !== computed) {
      return { valid: false, reason: `Bundle hash self-check failed at ${abs}` };
    }
    if (declared !== want) {
      return { valid: false, reason: `Provided bundleHash does not match artifact at ${abs}` };
    }

    return {
      valid: true,
      bundlePath: abs,
      bundleHash: declared,
      selectedBucketPct: Number(parsed.selectedBucketPct || 0),
      sourceHashes: parsed.sourceHashes || {}
    };
  } catch (e) {
    return { valid: false, reason: `Bundle load/verify failed: ${String(e?.message || e || 'unknown')}` };
  }
}

module.exports = { verifyBundleHash, computeBundleHash };
