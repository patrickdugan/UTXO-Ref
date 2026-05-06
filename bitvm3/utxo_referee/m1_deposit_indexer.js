/**
 * Milestone 1 - Deposit Indexer
 *
 * Tracks watched chain deposits through:
 * observed -> confirmed -> credited -> rolled_back
 *
 * This module is chain-agnostic and works with sats-denominated UTXOs.
 */

const { normalizeAmountSats } = require('./m1_spec');

const DEPOSIT_STATUSES = Object.freeze([
  'observed',
  'confirmed',
  'credited',
  'rolled_back'
]);

function ensureNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function normalizeHeight(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return parsed;
}

function computeConfirmations(blockHeight, currentHeight) {
  if (blockHeight === null || blockHeight === undefined) {
    return 0;
  }
  if (currentHeight < blockHeight) {
    return 0;
  }
  return currentHeight - blockHeight + 1;
}

function cloneRecord(record) {
  return {
    depositId: record.depositId,
    accountId: record.accountId,
    amountSats: record.amountSats,
    txid: record.txid,
    vout: record.vout,
    blockHeight: record.blockHeight,
    confirmations: record.confirmations,
    status: record.status,
    creditedAtHeight: record.creditedAtHeight,
    observedAtHeight: record.observedAtHeight,
    lastSeenHeight: record.lastSeenHeight,
    rollbackReason: record.rollbackReason,
    targetScriptPubKey: record.targetScriptPubKey || null
  };
}

class ReceiptDepositIndexer {
  constructor(options = {}) {
    const minConfirmations = Number(options.minConfirmations || 1);
    if (!Number.isInteger(minConfirmations) || minConfirmations <= 0) {
      throw new Error('minConfirmations must be a positive integer');
    }

    this.network = options.network || 'litecoin-testnet';
    this.minConfirmations = minConfirmations;
    this.deposits = new Map(); // depositId => record
  }

  observeDeposit(event, currentHeight) {
    const seenHeight = normalizeHeight(currentHeight, 'currentHeight');
    const depositId = ensureNonEmptyString(event.depositId, 'depositId');
    const accountId = ensureNonEmptyString(event.accountId, 'accountId');
    const txid = ensureNonEmptyString(event.txid, 'txid');
    const vout = normalizeHeight(event.vout, 'vout');
    const amountSats = normalizeAmountSats(event.amountSats);
    const blockHeight = event.blockHeight === null || event.blockHeight === undefined
      ? null
      : normalizeHeight(event.blockHeight, 'blockHeight');

    const existing = this.deposits.get(depositId);
    if (existing) {
      if (
        existing.accountId !== accountId
        || existing.txid !== txid
        || existing.vout !== vout
        || existing.amountSats !== amountSats
      ) {
        throw new Error(`depositId conflict: ${depositId}`);
      }
      if (existing.status === 'rolled_back') {
        throw new Error(`cannot re-observe rolled back depositId: ${depositId}`);
      }

      existing.blockHeight = blockHeight !== null ? blockHeight : existing.blockHeight;
      existing.lastSeenHeight = seenHeight;
      existing.confirmations = computeConfirmations(existing.blockHeight, seenHeight);
      if (existing.status !== 'credited') {
        existing.status = existing.confirmations >= this.minConfirmations ? 'confirmed' : 'observed';
      }
      return cloneRecord(existing);
    }

    const confirmations = computeConfirmations(blockHeight, seenHeight);
    const record = {
      depositId,
      accountId,
      amountSats,
      txid,
      vout,
      blockHeight,
      confirmations,
      status: confirmations >= this.minConfirmations ? 'confirmed' : 'observed',
      creditedAtHeight: null,
      observedAtHeight: seenHeight,
      lastSeenHeight: seenHeight,
      rollbackReason: null,
      targetScriptPubKey: event.targetScriptPubKey || null
    };
    this.deposits.set(depositId, record);
    return cloneRecord(record);
  }

  observeDeposits(events, currentHeight) {
    return events.map(event => this.observeDeposit(event, currentHeight));
  }

  syncConfirmations(currentHeight) {
    const height = normalizeHeight(currentHeight, 'currentHeight');
    for (const record of this.deposits.values()) {
      if (record.status === 'rolled_back' || record.status === 'credited') {
        continue;
      }
      record.confirmations = computeConfirmations(record.blockHeight, height);
      record.status = record.confirmations >= this.minConfirmations ? 'confirmed' : 'observed';
      record.lastSeenHeight = Math.max(record.lastSeenHeight, height);
    }
  }

  getDeposit(depositId) {
    const record = this.deposits.get(depositId);
    return record ? cloneRecord(record) : null;
  }

  getDepositsByStatus(status) {
    if (!DEPOSIT_STATUSES.includes(status)) {
      throw new Error(`unknown deposit status: ${status}`);
    }

    return Array.from(this.deposits.values())
      .filter(record => record.status === status)
      .sort((a, b) => a.depositId.localeCompare(b.depositId))
      .map(cloneRecord);
  }

  getCreditReadyDeposits() {
    return this.getDepositsByStatus('confirmed');
  }

  buildLedgerCreditEvent(depositId) {
    const record = this.deposits.get(depositId);
    if (!record) {
      throw new Error(`unknown depositId: ${depositId}`);
    }
    if (record.status !== 'confirmed') {
      throw new Error(`depositId is not credit-ready: ${depositId}`);
    }

    return {
      depositId: record.depositId,
      accountId: record.accountId,
      amountSats: record.amountSats,
      chainTxRef: {
        txid: record.txid,
        vout: record.vout,
        blockHeight: record.blockHeight,
        confirmations: record.confirmations,
        network: this.network
      }
    };
  }

  applyConfirmedDepositsToLedger(ledger, currentHeight) {
    this.syncConfirmations(currentHeight);

    const credited = [];
    for (const record of this.getCreditReadyDeposits()) {
      const ledgerEvent = this.buildLedgerCreditEvent(record.depositId);
      const result = ledger.applyDeposit(ledgerEvent);
      const mutable = this.deposits.get(record.depositId);
      mutable.status = 'credited';
      mutable.creditedAtHeight = normalizeHeight(currentHeight, 'currentHeight');
      credited.push({
        depositId: record.depositId,
        accountId: record.accountId,
        amountSats: record.amountSats,
        balanceSats: result.balanceSats
      });
    }

    return credited;
  }

  rollbackDeposit(depositId, options = {}) {
    const record = this.deposits.get(depositId);
    if (!record) {
      throw new Error(`unknown depositId: ${depositId}`);
    }
    if (record.status === 'rolled_back') {
      throw new Error(`depositId already rolled back: ${depositId}`);
    }

    if (record.status === 'credited') {
      if (!options.ledger) {
        throw new Error(`ledger is required to roll back credited depositId: ${depositId}`);
      }
      options.ledger.rollbackDeposit(depositId, { reason: options.reason || null });
    }

    record.status = 'rolled_back';
    record.rollbackReason = options.reason || 'chain reorg';
    return cloneRecord(record);
  }

  getDeterministicSnapshot() {
    const deposits = Array.from(this.deposits.values())
      .sort((a, b) => a.depositId.localeCompare(b.depositId))
      .map(record => ({
        depositId: record.depositId,
        accountId: record.accountId,
        amountSats: record.amountSats.toString(),
        txid: record.txid,
        vout: record.vout,
        blockHeight: record.blockHeight,
        confirmations: record.confirmations,
        status: record.status,
        creditedAtHeight: record.creditedAtHeight,
        observedAtHeight: record.observedAtHeight,
        lastSeenHeight: record.lastSeenHeight,
        rollbackReason: record.rollbackReason
      }));

    return {
      kind: 'receipt-deposit-indexer',
      network: this.network,
      minConfirmations: this.minConfirmations,
      deposits
    };
  }
}

module.exports = {
  DEPOSIT_STATUSES,
  ReceiptDepositIndexer,
  computeConfirmations
};
