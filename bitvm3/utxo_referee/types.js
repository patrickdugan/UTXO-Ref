/**
 * UTXO Referee Types
 *
 * Deterministic serialization for commitment packages, payout leaves,
 * and sweep objects. All amounts are in sats (1:1 with receipt tokens).
 */

const crypto = require('crypto');

// Domain separator for leaf hashing (prevents cross-protocol attacks)
const LEAF_TAG = Buffer.from('UTXO_REFEREE_V1');

/**
 * Write u64 as little-endian 8 bytes
 */
function writeU64LE(value) {
  const buf = Buffer.alloc(8);
  // JavaScript BigInt for full u64 range
  const bigVal = BigInt(value);
  buf.writeBigUInt64LE(bigVal, 0);
  return buf;
}

/**
 * Read u64 from little-endian 8 bytes
 */
function readU64LE(buf, offset = 0) {
  return buf.readBigUInt64LE(offset);
}

/**
 * Write u32 as little-endian 4 bytes
 */
function writeU32LE(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

/**
 * Serialize scriptPubKey with length prefix (varint-style, max 520 bytes)
 */
function serializeScriptPubKey(spk) {
  const spkBuf = Buffer.isBuffer(spk) ? spk : Buffer.from(spk, 'hex');
  if (spkBuf.length > 520) {
    throw new Error('scriptPubKey exceeds max length (520 bytes)');
  }
  // Use 2-byte length prefix (sufficient for 520)
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16LE(spkBuf.length, 0);
  return Buffer.concat([lenBuf, spkBuf]);
}

/**
 * CommitmentPackage - The settlement commitment published on-chain
 *
 * Fields:
 *   epochId: u64 - Unique epoch identifier
 *   withdrawalRoot: 32 bytes - Merkle root of payout leaves
 *   capSats: u64 - Maximum total sats payable this epoch
 *   residualDest: bytes - scriptPubKey where residual must go
 */
class CommitmentPackage {
  constructor({ epochId, withdrawalRoot, capSats, residualDest }) {
    this.epochId = BigInt(epochId);
    this.withdrawalRoot = Buffer.isBuffer(withdrawalRoot)
      ? withdrawalRoot
      : Buffer.from(withdrawalRoot, 'hex');
    this.capSats = BigInt(capSats);
    this.residualDest = Buffer.isBuffer(residualDest)
      ? residualDest
      : Buffer.from(residualDest, 'hex');

    if (this.withdrawalRoot.length !== 32) {
      throw new Error('withdrawalRoot must be 32 bytes');
    }
    if (this.capSats < 0n) {
      throw new Error('capSats must be non-negative');
    }
  }

  /**
   * Deterministic serialization for commitment
   */
  serialize() {
    return Buffer.concat([
      writeU64LE(this.epochId),
      this.withdrawalRoot,
      writeU64LE(this.capSats),
      serializeScriptPubKey(this.residualDest)
    ]);
  }

  /**
   * Commitment hash (for on-chain anchoring)
   */
  hash() {
    return crypto.createHash('sha256').update(this.serialize()).digest();
  }

  static deserialize(buf) {
    let offset = 0;
    const epochId = readU64LE(buf, offset);
    offset += 8;
    const withdrawalRoot = buf.slice(offset, offset + 32);
    offset += 32;
    const capSats = readU64LE(buf, offset);
    offset += 8;
    const spkLen = buf.readUInt16LE(offset);
    offset += 2;
    const residualDest = buf.slice(offset, offset + spkLen);
    return new CommitmentPackage({ epochId, withdrawalRoot, capSats, residualDest });
  }
}

/**
 * PayoutLeaf - A single withdrawal in the payout tree
 *
 * Fields:
 *   epochId: u64 - Must match commitment epochId
 *   recipientScriptPubKey: bytes - Destination scriptPubKey
 *   amountSats: u64 - Amount in satoshis
 */
class PayoutLeaf {
  constructor({ epochId, recipientScriptPubKey, amountSats }) {
    this.epochId = BigInt(epochId);
    this.recipientScriptPubKey = Buffer.isBuffer(recipientScriptPubKey)
      ? recipientScriptPubKey
      : Buffer.from(recipientScriptPubKey, 'hex');
    this.amountSats = BigInt(amountSats);

    if (this.amountSats < 0n) {
      throw new Error('amountSats must be non-negative');
    }
  }

  /**
   * Deterministic serialization for leaf
   * Format: epochId || amountSats || recipientScriptPubKey
   */
  serialize() {
    return Buffer.concat([
      writeU64LE(this.epochId),
      writeU64LE(this.amountSats),
      serializeScriptPubKey(this.recipientScriptPubKey)
    ]);
  }

  /**
   * Compute leaf hash with domain separator
   * hash = SHA256(TAG || epochId || amountSats || recipientScriptPubKey)
   */
  hash() {
    return crypto.createHash('sha256')
      .update(LEAF_TAG)
      .update(this.serialize())
      .digest();
  }

  /**
   * Check if this leaf matches a payout output
   */
  matches(output) {
    const outSpk = Buffer.isBuffer(output.recipientScriptPubKey)
      ? output.recipientScriptPubKey
      : Buffer.from(output.recipientScriptPubKey, 'hex');
    return (
      this.recipientScriptPubKey.equals(outSpk) &&
      this.amountSats === BigInt(output.amountSats)
    );
  }
}

/**
 * PayoutOutput - A payout in the sweep transaction
 */
class PayoutOutput {
  constructor({ recipientScriptPubKey, amountSats, merkleProof }) {
    this.recipientScriptPubKey = Buffer.isBuffer(recipientScriptPubKey)
      ? recipientScriptPubKey
      : Buffer.from(recipientScriptPubKey, 'hex');
    this.amountSats = BigInt(amountSats);
    this.merkleProof = merkleProof; // { siblings: Buffer[], index: number }
  }
}

/**
 * ResidualOutput - The residual output in sweep transaction
 */
class ResidualOutput {
  constructor({ recipientScriptPubKey, amountSats }) {
    this.recipientScriptPubKey = Buffer.isBuffer(recipientScriptPubKey)
      ? recipientScriptPubKey
      : Buffer.from(recipientScriptPubKey, 'hex');
    this.amountSats = BigInt(amountSats);
  }
}

/**
 * SweepObject - Simplified representation of sweep transaction
 *
 * TODO: Add full Bitcoin tx parsing for production
 */
class SweepObject {
  constructor({ epochIdCommitted, payoutOutputs, residualOutput }) {
    this.epochIdCommitted = BigInt(epochIdCommitted);
    this.payoutOutputs = payoutOutputs.map(o =>
      o instanceof PayoutOutput ? o : new PayoutOutput(o)
    );
    this.residualOutput = residualOutput instanceof ResidualOutput
      ? residualOutput
      : new ResidualOutput(residualOutput);
  }

  /**
   * Sum of all payout amounts
   */
  totalPayoutSats() {
    return this.payoutOutputs.reduce(
      (sum, o) => sum + o.amountSats,
      0n
    );
  }
}

module.exports = {
  LEAF_TAG,
  writeU64LE,
  readU64LE,
  writeU32LE,
  serializeScriptPubKey,
  CommitmentPackage,
  PayoutLeaf,
  PayoutOutput,
  ResidualOutput,
  SweepObject
};
