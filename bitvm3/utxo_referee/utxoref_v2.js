/**
 * Stable UTXORef V2 funding commitments.
 *
 * This compatibility module intentionally exposes the funding-set surface used
 * by BitAgent. The serialization and domain tags match the original V2
 * implementation so existing roots remain reproducible.
 */

const crypto = require('crypto');

const VERSION = 2;
const TAGS = Object.freeze({
  fundingLeaf: Buffer.from('UTXOREF_FUNDING_LEAF_V2\0', 'ascii'),
  fundingNode: Buffer.from('UTXOREF_FUNDING_NODE_V2\0', 'ascii'),
  fundingEmpty: Buffer.from('UTXOREF_FUNDING_EMPTY_V2\0', 'ascii')
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function assertHex(value, bytes, fieldName) {
  const text = String(value || '').toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(text)) {
    throw new Error(`${fieldName} must be ${bytes} bytes of hex`);
  }
  return text;
}

function assertHexAny(value, fieldName) {
  const text = String(value || '').toLowerCase();
  if (!/^[0-9a-f]*$/.test(text) || text.length % 2 !== 0) {
    throw new Error(`${fieldName} must be even-length hex`);
  }
  return text;
}

function toU64(value, fieldName) {
  let result;
  try {
    result = BigInt(value);
  } catch (_err) {
    throw new Error(`${fieldName} must be an unsigned integer`);
  }
  if (result < 0n || result > 0xffffffffffffffffn) {
    throw new Error(`${fieldName} must fit u64`);
  }
  return result;
}

function toU32(value, fieldName) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 0xffffffff) {
    throw new Error(`${fieldName} must fit u32`);
  }
  return result;
}

function u16le(value) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0 || result > 0xffff) {
    throw new Error('value must fit u16');
  }
  const out = Buffer.alloc(2);
  out.writeUInt16LE(result);
  return out;
}

function u32le(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(toU32(value, 'u32 value'));
  return out;
}

function u64le(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(toU64(value, 'u64 value'));
  return out;
}

function lengthPrefixed(value, fieldName, maxLength = 10000) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  if (buf.length > maxLength || buf.length > 0xffff) {
    throw new Error(`${fieldName} exceeds ${Math.min(maxLength, 0xffff)} bytes`);
  }
  return Buffer.concat([u16le(buf.length), buf]);
}

function scriptBuffer(value, fieldName) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  return Buffer.from(assertHexAny(value, fieldName), 'hex');
}

function normalizeFundingOutpoint(funding, index) {
  if (!funding || typeof funding !== 'object') throw new Error(`funding[${index}] must be an object`);
  const amountSats = toU64(funding.amountSats ?? funding.sats, `funding[${index}].amountSats`);
  if (amountSats === 0n) throw new Error(`funding[${index}].amountSats must be positive`);
  const script = scriptBuffer(funding.scriptPubKeyHex || funding.scriptPubKey, `funding[${index}].scriptPubKey`);
  if (!script.length) throw new Error(`funding[${index}].scriptPubKey is required`);
  return {
    index,
    txid: assertHex(funding.txid, 32, `funding[${index}].txid`),
    vout: toU32(funding.vout, `funding[${index}].vout`),
    amountSats: amountSats.toString(),
    scriptPubKeyHex: script.toString('hex')
  };
}

function fundingLeafHash(funding) {
  return sha256(Buffer.concat([
    TAGS.fundingLeaf,
    u32le(funding.index),
    Buffer.from(funding.txid, 'hex'),
    u32le(funding.vout),
    u64le(funding.amountSats),
    lengthPrefixed(Buffer.from(funding.scriptPubKeyHex, 'hex'), 'funding scriptPubKey')
  ]));
}

function emptyHash(tag, level) {
  return sha256(Buffer.concat([tag, u32le(level)]));
}

function merkleRootV2(hashes, nodeTag, emptyTag) {
  if (!Array.isArray(hashes) || !hashes.length) throw new Error('Merkle tree requires at least one leaf');
  let level = hashes.map((hash, index) => Buffer.from(assertHex(hash, 32, `leafHash[${index}]`), 'hex'));
  let depth = 0;
  while (level.length > 1) {
    if (level.length % 2) level.push(emptyHash(emptyTag, depth));
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256(Buffer.concat([nodeTag, level[i], level[i + 1]])));
    }
    level = next;
    depth++;
  }
  return level[0];
}

function buildFundingSetV2(fundingOutpoints) {
  if (!Array.isArray(fundingOutpoints) || !fundingOutpoints.length) {
    throw new Error('fundingOutpoints must be non-empty');
  }
  const funding = fundingOutpoints.map(normalizeFundingOutpoint);
  const seen = new Set();
  for (const item of funding) {
    const key = `${item.txid}:${item.vout}`;
    if (seen.has(key)) throw new Error(`duplicate funding outpoint: ${key}`);
    seen.add(key);
  }
  const leafHashes = funding.map((item) => fundingLeafHash(item).toString('hex'));
  return {
    funding,
    fundingRoot: merkleRootV2(leafHashes, TAGS.fundingNode, TAGS.fundingEmpty).toString('hex'),
    fundingCount: funding.length,
    fundingTotalSats: funding.reduce((sum, item) => sum + BigInt(item.amountSats), 0n).toString()
  };
}

module.exports = {
  VERSION,
  TAGS,
  normalizeFundingOutpoint,
  fundingLeafHash,
  merkleRootV2,
  buildFundingSetV2
};
