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

class ReceiptLedger {
  constructor(options = {}) {
    this.assetSymbol = options.assetSymbol || 'rLTC-SAT';
    this.network = options.network || 'litecoin-testnet';
    this.balances = new Map(); // accountId => BigInt
    this.depositEvents = new Map(); // depositId => event
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

    const prev = this.balances.get(accountId) || 0n;
    const next = prev + amountSats;
    this.balances.set(accountId, next);

    this.depositEvents.set(depositId, {
      depositId,
      accountId,
      amountSats,
      chainTxRef: event.chainTxRef || null
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
    return {
      assetSymbol: this.assetSymbol,
      network: this.network,
      totalSupplySats: this.totalSupplySats().toString(),
      balances: this.getBalancesSorted().map(r => ({
        accountId: r.accountId,
        balanceSats: r.balanceSats.toString()
      })),
      depositIds: Array.from(this.depositEvents.keys()).sort(),
      redemptionIds: Array.from(this.redemptionEvents.keys()).sort()
    };
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
  ReceiptLedger
};

