/**
 * Milestone 1 - Receipt Tally Map State
 *
 * Canonical, versioned JSON state blob for receipt-token balances.
 * This is the VM-friendly state object:
 * - exact satoshi accounting
 * - deterministic ordering
 * - replayable event stream
 * - hashable canonical serialization
 */

const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats, normalizeEpochId } = require('./m1_spec');

const BALANCE_TAG = Buffer.from('UTXO_REFEREE_BALANCE_V1');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

function hashPair(left, right) {
  return sha256(Buffer.concat([left, right]));
}

const ZERO_HASH = sha256(Buffer.alloc(32));

function ensureNonEmptyString(v, fieldName) {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return v;
}

function sortedObjectEntries(map) {
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

class ReceiptTallyMap {
  constructor(options = {}) {
    this.schemaVersion = Number(options.schemaVersion || 1);
    this.kind = 'receipt-tally-map';
    this.assetSymbol = options.assetSymbol || 'rLTC-SAT';
    this.network = options.network || 'litecoin-testnet';
    this.epochId = normalizeEpochId(options.epochId || 0n);
    this.prevSnapshotHash = options.prevSnapshotHash || null;
    const challengeWindowStart = normalizeEpochId(options.challengeWindowStart ?? this.epochId);
    if (options.challengeWindowLength !== undefined && options.challengeWindowLength !== null) {
      this.challengeWindowLength = normalizeEpochId(options.challengeWindowLength);
      this.challengeWindowStart = challengeWindowStart;
      this.challengeWindowEnd = normalizeEpochId(challengeWindowStart + this.challengeWindowLength);
    } else {
      this.challengeWindowStart = challengeWindowStart;
      this.challengeWindowEnd = normalizeEpochId(options.challengeWindowEnd ?? challengeWindowStart);
      if (this.challengeWindowEnd < this.challengeWindowStart) {
        throw new Error('challengeWindowEnd must be >= challengeWindowStart');
      }
      this.challengeWindowLength = normalizeEpochId(this.challengeWindowEnd - this.challengeWindowStart);
    }
    this.balances = new Map(); // accountId => BigInt
    this.depositIds = new Set(options.depositIds || []);
    this.redemptionIds = new Set(options.redemptionIds || []);

    if (options.balances) {
      for (const [accountId, balanceSats] of options.balances) {
        this.setBalance(accountId, balanceSats);
      }
    }
  }

  static fromLedger(ledger, options = {}) {
    const state = new ReceiptTallyMap({
      schemaVersion: options.schemaVersion || 1,
      assetSymbol: options.assetSymbol || ledger.assetSymbol,
      network: options.network || ledger.network,
      epochId: options.epochId || 0n,
      prevSnapshotHash: options.prevSnapshotHash || null,
      challengeWindowStart: options.challengeWindowStart ?? options.epochId ?? 0n,
      challengeWindowLength: options.challengeWindowLength,
      challengeWindowEnd: options.challengeWindowEnd ?? options.epochId ?? 0n
    });

    for (const row of ledger.getBalancesSorted()) {
      state.setBalance(row.accountId, row.balanceSats);
    }

    for (const [depositId] of ledger.depositEvents.entries()) {
      state.depositIds.add(depositId);
    }
    for (const [redemptionId] of ledger.redemptionEvents.entries()) {
      state.redemptionIds.add(redemptionId);
    }

    return state;
  }

  static fromSnapshot(snapshot) {
    const obj = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
    const state = new ReceiptTallyMap({
      schemaVersion: obj.schemaVersion,
      assetSymbol: obj.assetSymbol,
      network: obj.network,
      epochId: obj.epochId,
      prevSnapshotHash: obj.prevSnapshotHash || null,
      challengeWindowStart: obj.challengeWindowStart ?? obj.epochId ?? 0n,
      challengeWindowLength: obj.challengeWindowLength,
      challengeWindowEnd: obj.challengeWindowEnd ?? obj.epochId ?? 0n
    });

    for (const row of obj.balances || []) {
      state.setBalance(row.accountId, row.balanceSats);
    }
    for (const id of obj.depositIds || []) {
      state.depositIds.add(ensureNonEmptyString(id, 'depositId'));
    }
    for (const id of obj.redemptionIds || []) {
      state.redemptionIds.add(ensureNonEmptyString(id, 'redemptionId'));
    }

    return state;
  }

  clone() {
    return ReceiptTallyMap.fromSnapshot(this.toSnapshot());
  }

  setBalance(accountId, balanceSats) {
    const id = ensureNonEmptyString(accountId, 'accountId');
    const v = normalizeAmountSats(balanceSats, 'balanceSats');
    this.balances.set(id, v);
  }

  balanceOf(accountId) {
    return this.balances.get(accountId) || 0n;
  }

  totalSupplySats() {
    let sum = 0n;
    for (const v of this.balances.values()) {
      sum += v;
    }
    return sum;
  }

  applyDeposit(event) {
    const depositId = ensureNonEmptyString(event.depositId, 'depositId');
    const accountId = ensureNonEmptyString(event.accountId, 'accountId');
    const amountSats = normalizeAmountSats(event.amountSats);

    if (amountSats === 0n) {
      throw new Error('amountSats must be > 0');
    }
    if (this.depositIds.has(depositId)) {
      throw new Error(`duplicate depositId: ${depositId}`);
    }

    const next = this.balanceOf(accountId) + amountSats;
    this.balances.set(accountId, next);
    this.depositIds.add(depositId);

    return {
      mintedSats: amountSats,
      accountId,
      balanceSats: next
    };
  }

  applyRedemption(event) {
    const redemptionId = ensureNonEmptyString(event.redemptionId, 'redemptionId');
    const accountId = ensureNonEmptyString(event.accountId, 'accountId');
    const amountSats = normalizeAmountSats(event.amountSats);

    if (amountSats === 0n) {
      throw new Error('amountSats must be > 0');
    }
    if (this.redemptionIds.has(redemptionId)) {
      throw new Error(`duplicate redemptionId: ${redemptionId}`);
    }

    const prev = this.balanceOf(accountId);
    if (prev < amountSats) {
      throw new Error(`insufficient balance for ${accountId}: have ${prev}, need ${amountSats}`);
    }

    const next = prev - amountSats;
    this.balances.set(accountId, next);
    this.redemptionIds.add(redemptionId);

    return {
      burnedSats: amountSats,
      accountId,
      balanceSats: next
    };
  }

  applyEvent(event) {
    if (event && event.depositId) {
      return this.applyDeposit(event);
    }
    if (event && event.redemptionId) {
      return this.applyRedemption(event);
    }
    throw new Error('Unsupported event shape');
  }

  getBalancesSorted() {
    return sortedObjectEntries(this.balances).map(([accountId, balanceSats]) => ({
      accountId,
      balanceSats
    }));
  }

  getBalanceLeaves() {
    return this.getBalancesSorted().map(row => this._hashBalanceRow(row));
  }

  _hashBalanceRow(row) {
    return sha256(Buffer.concat([
      BALANCE_TAG,
      Buffer.from(String(row.accountId), 'utf8'),
      Buffer.from(':'),
      Buffer.from(row.balanceSats.toString(), 'utf8')
    ]));
  }

  _buildBalanceMerkleLevels() {
    const leaves = this.getBalanceLeaves();
    if (leaves.length === 0) {
      return [[ZERO_HASH]];
    }

    const levels = [leaves.slice()];
    let current = leaves.slice();

    while (current.length > 1) {
      const next = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i];
        const right = current[i + 1] || ZERO_HASH;
        next.push(hashPair(left, right));
      }
      levels.push(next);
      current = next;
    }

    return levels;
  }

  getBalanceMerkleRoot() {
    const levels = this._buildBalanceMerkleLevels();
    return levels[levels.length - 1][0];
  }

  getBalanceMerkleRootHex() {
    return this.getBalanceMerkleRoot().toString('hex');
  }

  getBalanceProof(accountId) {
    const id = ensureNonEmptyString(accountId, 'accountId');
    const rows = this.getBalancesSorted();
    const index = rows.findIndex(row => row.accountId === id);
    if (index === -1) {
      throw new Error(`unknown accountId: ${id}`);
    }

    const levels = this._buildBalanceMerkleLevels();
    const siblings = [];
    let idx = index;

    for (let level = 0; level < levels.length - 1; level++) {
      const siblingIdx = idx ^ 1;
      const sibling = levels[level][siblingIdx] || ZERO_HASH;
      siblings.push(sibling);
      idx = idx >> 1;
    }

    const row = rows[index];
    const leafHash = this._hashBalanceRow(row);
    return {
      accountId: id,
      balanceSats: row.balanceSats,
      leafHash,
      index,
      siblings,
      root: levels[levels.length - 1][0],
      epochId: this.epochId
    };
  }

  getBalanceClaim(accountId) {
    const proof = this.getBalanceProof(accountId);
    return {
      schemaVersion: this.schemaVersion,
      kind: 'receipt-balance-claim',
      assetSymbol: this.assetSymbol,
      network: this.network,
      epochId: this.epochId.toString(),
      accountId: proof.accountId,
      balanceSats: proof.balanceSats.toString(),
      leafHash: proof.leafHash.toString('hex'),
      index: proof.index,
      siblings: proof.siblings.map(s => s.toString('hex')),
      balanceRoot: proof.root.toString('hex'),
      challengeWindowStart: this.challengeWindowStart.toString(),
      challengeWindowLength: this.challengeWindowLength.toString(),
      challengeWindowEnd: this.challengeWindowEnd.toString(),
      snapshotHash: this.snapshotHashHex()
    };
  }

  static verifyBalanceProof(proof, expectedRoot) {
    const root = Buffer.isBuffer(expectedRoot)
      ? expectedRoot
      : Buffer.from(expectedRoot, 'hex');
    let current = Buffer.isBuffer(proof.leafHash)
      ? proof.leafHash
      : Buffer.from(proof.leafHash, 'hex');
    let idx = Number(proof.index);

    for (const sibling of proof.siblings || []) {
      const siblingBuf = Buffer.isBuffer(sibling) ? sibling : Buffer.from(sibling, 'hex');
      if (idx & 1) {
        current = hashPair(siblingBuf, current);
      } else {
        current = hashPair(current, siblingBuf);
      }
      idx = idx >> 1;
    }

    return current.equals(root);
  }

  static verifyBalanceClaim(claim, expectedRoot) {
    const proof = {
      accountId: claim.accountId,
      balanceSats: BigInt(claim.balanceSats),
      leafHash: claim.leafHash,
      index: Number(claim.index),
      siblings: (claim.siblings || []).map(s => Buffer.from(s, 'hex')),
      root: claim.balanceRoot,
      epochId: BigInt(claim.epochId)
    };

    return ReceiptTallyMap.verifyBalanceProof(proof, expectedRoot);
  }

  toSnapshot() {
    return {
      schemaVersion: this.schemaVersion,
      kind: this.kind,
      assetSymbol: this.assetSymbol,
      network: this.network,
      epochId: this.epochId.toString(),
      prevSnapshotHash: this.prevSnapshotHash,
      challengeWindowStart: this.challengeWindowStart.toString(),
      challengeWindowLength: this.challengeWindowLength.toString(),
      challengeWindowEnd: this.challengeWindowEnd.toString(),
      totalSupplySats: this.totalSupplySats().toString(),
      balanceRoot: this.getBalanceMerkleRootHex(),
      balances: this.getBalancesSorted().map(r => ({
        accountId: r.accountId,
        balanceSats: r.balanceSats.toString()
      })),
      depositIds: Array.from(this.depositIds).sort(),
      redemptionIds: Array.from(this.redemptionIds).sort()
    };
  }

  canonicalJson() {
    return canonicalStringify(this.toSnapshot());
  }

  snapshotHashHex() {
    return crypto.createHash('sha256').update(this.canonicalJson()).digest('hex');
  }

  getCommittedSnapshot() {
    const snapshot = this.toSnapshot();
    snapshot.snapshotHash = this.snapshotHashHex();
    return snapshot;
  }

  getAnnotatedSnapshot(deltaAnnotation = null) {
    const snapshot = this.getCommittedSnapshot();
    if (deltaAnnotation) {
      snapshot.deltaAnnotation = deltaAnnotation;
    }
    return snapshot;
  }

  toBlob() {
    return JSON.stringify(this.getCommittedSnapshot(), null, 2);
  }

  toAnnotatedBlob(deltaAnnotation = null) {
    return JSON.stringify(this.getAnnotatedSnapshot(deltaAnnotation), null, 2);
  }

  static fromBlob(blob) {
    return ReceiptTallyMap.fromSnapshot(blob);
  }

  finalizeEpoch(nextEpochId, prevSnapshotHash = null) {
    const next = this.clone();
    next.epochId = normalizeEpochId(nextEpochId);
    next.prevSnapshotHash = prevSnapshotHash || this.snapshotHashHex();
    next.challengeWindowStart = next.epochId;
    next.challengeWindowLength = this.challengeWindowLength;
    next.challengeWindowEnd = normalizeEpochId(next.challengeWindowStart + next.challengeWindowLength);
    return next;
  }
}

module.exports = {
  ReceiptTallyMap
};
