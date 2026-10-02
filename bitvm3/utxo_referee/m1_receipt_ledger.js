/**
 * Milestone 1 - Deterministic Receipt Ledger
 *
 * 1 sat deposited => 1 receipt unit minted.
 * 1 receipt unit redeemed => 1 sat claim burned.
 */

const crypto = require('crypto');
const {
  canonicalStringify,
  normalizeEpochId,
  normalizeAmountSats,
  validatePayoutLeafRecord
} = require('./m1_spec');

function ensureNonEmptyString(v, fieldName) {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return v;
}

// MAIN-4: a chain deposit is identified by its funding outpoint, not by the
// caller's depositId, so one outpoint can never be credited twice.
function depositOutpointKey(chainTxRef) {
  if (chainTxRef === undefined || chainTxRef === null) return null;
  const txid = String(chainTxRef.txid || '').toLowerCase();
  const vout = Number(chainTxRef.vout);
  if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isSafeInteger(vout) || vout < 0 || vout > 0xffffffff) {
    throw new Error('chainTxRef must name a funding outpoint (32-byte txid, u32 vout)');
  }
  return `${txid}:${vout}`;
}

class ReceiptLedger {
  constructor(options = {}) {
    this.assetSymbol = options.assetSymbol || 'rLTC-SAT';
    this.network = options.network || 'litecoin-testnet';
    this.balances = new Map(); // accountId => BigInt
    this.depositEvents = new Map(); // depositId => event
    this.depositOutpoints = new Map(); // "txid:vout" => depositId (credited deposits only)
    this.redemptionEvents = new Map(); // redemptionId => event
  }

  applyDeposit(event) {
    const depositId = ensureNonEmptyString(event.depositId, 'depositId');
    const accountId = ensureNonEmptyString(event.accountId, 'accountId');
    const amountSats = normalizeAmountSats(event.amountSats);

    if (amountSats === 0n) {
      throw new Error('amountSats must be > 0');
    }
    if (this.depositEvents.has(depositId)) {
      throw new Error(`duplicate depositId: ${depositId}`);
    }
    const outpointKey = depositOutpointKey(event.chainTxRef);
    if (outpointKey && this.depositOutpoints.has(outpointKey)) {
      throw new Error(`deposit outpoint ${outpointKey} is already credited as ${this.depositOutpoints.get(outpointKey)}`);
    }

    const prev = this.balances.get(accountId) || 0n;
    const next = prev + amountSats;
    this.balances.set(accountId, next);
    if (outpointKey) this.depositOutpoints.set(outpointKey, depositId);

    this.depositEvents.set(depositId, {
      depositId,
      accountId,
      amountSats,
      chainTxRef: event.chainTxRef || null,
      status: 'credited',
      rollbackReason: null
    });

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
    if (this.redemptionEvents.has(redemptionId)) {
      throw new Error(`duplicate redemptionId: ${redemptionId}`);
    }

    const prev = this.balances.get(accountId) || 0n;
    if (prev < amountSats) {
      throw new Error(
        `insufficient balance for ${accountId}: have ${prev}, need ${amountSats}`
      );
    }

    const next = prev - amountSats;
    this.balances.set(accountId, next);

    this.redemptionEvents.set(redemptionId, {
      redemptionId,
      accountId,
      amountSats,
      targetScriptPubKey: event.targetScriptPubKey || null
    });

    return {
      burnedSats: amountSats,
      accountId,
      balanceSats: next
    };
  }

  rollbackDeposit(depositId, options = {}) {
    const id = ensureNonEmptyString(depositId, 'depositId');
    const deposit = this.depositEvents.get(id);
    if (!deposit) {
      throw new Error(`unknown depositId: ${id}`);
    }
    if (deposit.status === 'rolled_back') {
      throw new Error(`depositId already rolled back: ${id}`);
    }

    const prev = this.balances.get(deposit.accountId) || 0n;
    if (prev < deposit.amountSats) {
      throw new Error(
        `cannot roll back deposit ${id}: account ${deposit.accountId} has ${prev}, need ${deposit.amountSats}`
      );
    }

    const next = prev - deposit.amountSats;
    this.balances.set(deposit.accountId, next);
    // A rolled-back (e.g. reorged) outpoint may be credited again if it
    // re-confirms; the net effect is still one credit.
    const outpointKey = depositOutpointKey(deposit.chainTxRef);
    if (outpointKey && this.depositOutpoints.get(outpointKey) === id) this.depositOutpoints.delete(outpointKey);
    deposit.status = 'rolled_back';
    deposit.rollbackReason = options.reason || null;

    return {
      rolledBackSats: deposit.amountSats,
      accountId: deposit.accountId,
      balanceSats: next
    };
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

  getBalancesSorted() {
    const rows = [];
    for (const [accountId, balanceSats] of this.balances.entries()) {
      rows.push({ accountId, balanceSats });
    }

    rows.sort((a, b) => a.accountId.localeCompare(b.accountId));
    return rows;
  }

  getDeterministicSnapshot() {
    const snapshot = {
      assetSymbol: this.assetSymbol,
      network: this.network,
      totalSupplySats: this.totalSupplySats().toString(),
      balances: this.getBalancesSorted().map(r => ({
        accountId: r.accountId,
        balanceSats: r.balanceSats.toString()
      })),
      depositIds: Array.from(this.depositEvents.keys()).sort(),
      rolledBackDepositIds: Array.from(this.depositEvents.values())
        .filter(event => event.status === 'rolled_back')
        .map(event => event.depositId)
        .sort(),
      redemptionIds: Array.from(this.redemptionEvents.keys()).sort()
    };
    // Only ledgers with chain-referenced deposits carry the field, so the
    // snapshot hash of an off-chain-only ledger is unchanged.
    if (this.depositOutpoints.size) snapshot.creditedDepositOutpoints = Array.from(this.depositOutpoints.keys()).sort();
    return snapshot;
  }

  snapshotHashHex() {
    const canonical = canonicalStringify(this.getDeterministicSnapshot());
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  createEpochPayoutLeaves(epochId, accountScriptPubKeys) {
    const normalizedEpochId = normalizeEpochId(epochId);
    const leaves = [];

    for (const row of this.getBalancesSorted()) {
      if (row.balanceSats === 0n) {
        continue;
      }

      const scriptPubKey = accountScriptPubKeys[row.accountId];
      if (!scriptPubKey) {
        throw new Error(`missing scriptPubKey mapping for accountId=${row.accountId}`);
      }

      leaves.push(
        validatePayoutLeafRecord({
          epochId: normalizedEpochId,
          recipientScriptPubKey: scriptPubKey,
          amountSats: row.balanceSats
        })
      );
    }

    return leaves;
  }
}

module.exports = {
  ReceiptLedger,
  depositOutpointKey
};
