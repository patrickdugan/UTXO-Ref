/**
 * TradeLayer Live Reserve Adapter
 *
 * Bridges live Litecoin Core `listunspent` output into the deposit side of the
 * tokenization system: each spendable UTXO on the watched reserve wallet is
 * observed as a confirmed deposit, credited into a ReceiptLedger, and exposed as
 * a ReceiptDepositIndexer snapshot. That snapshot is exactly the reserve source
 * accepted by tradelayer_reserve_reconciliation_referee, so the peg invariant
 * (withdrawal cap <= credited reserve) can be checked against real chain state
 * instead of a placeholder amount.
 *
 * Input row shape (from `litecoin-cli listunspent`, sats-normalized):
 *   { txid, vout, address, amountSats, confirmations }
 */

const { ReceiptDepositIndexer } = require('./m1_deposit_indexer');
const { ReceiptLedger } = require('./m1_receipt_ledger');

function toAmountSats(row) {
  if (row.amountSats !== undefined && row.amountSats !== null) {
    const n = Number(row.amountSats);
    if (!Number.isInteger(n) || n < 0) throw new Error(`invalid amountSats for ${row.txid}:${row.vout}`);
    return n;
  }
  if (row.amount !== undefined) {
    // Litecoin Core reports amount in whole LTC; convert to integer sats.
    return Math.round(Number(row.amount) * 1e8);
  }
  throw new Error(`UTXO ${row.txid}:${row.vout} has no amount`);
}

/**
 * Build a credited deposit reserve from live unspent outputs.
 *
 * Returns { indexer, ledger, snapshot, reservedSats, creditedCount, currentHeight }.
 * Only outputs with confirmations >= minConfirmations are credited into the
 * reserve; the rest remain observed and are excluded from reservedSats, matching
 * the indexer's confirmed -> credited lifecycle.
 */
function buildLiveReserveFromUnspent(unspent, options = {}) {
  if (!Array.isArray(unspent)) throw new Error('unspent must be an array of UTXO rows');
  const network = options.network || 'litecoin-testnet';
  const minConfirmations = Number(options.minConfirmations || 1);
  // Derive a synthetic tip so the indexer's height math yields the live
  // confirmation counts. If a real currentHeight is supplied, use it.
  const maxConfirmations = unspent.reduce((max, row) => Math.max(max, Number(row.confirmations || 0)), 0);
  const currentHeight = Number(options.currentHeight || maxConfirmations || 1);

  const indexer = new ReceiptDepositIndexer({ network, minConfirmations });
  const ledger = new ReceiptLedger({ network });

  for (const row of unspent) {
    if (!row || !row.txid || row.vout === undefined) {
      throw new Error('each UTXO row requires txid and vout');
    }
    const confirmations = Number(row.confirmations || 0);
    const amountSats = toAmountSats(row);
    if (amountSats <= 0) continue; // skip dust/zero outputs
    const blockHeight = confirmations > 0
      ? Math.max(0, currentHeight - confirmations + 1)
      : null;
    indexer.observeDeposit({
      depositId: `${row.txid}:${row.vout}`,
      accountId: String(row.address || `${row.txid}:${row.vout}`),
      txid: String(row.txid),
      vout: Number(row.vout),
      amountSats,
      blockHeight,
      targetScriptPubKey: row.scriptPubKey || null
    }, currentHeight);
  }

  indexer.applyConfirmedDepositsToLedger(ledger, currentHeight);
  const snapshot = indexer.getDeterministicSnapshot();
  const reservedSats = snapshot.deposits
    .filter((d) => d.status === 'credited')
    .reduce((sum, d) => sum + BigInt(d.amountSats), 0n);

  return {
    indexer,
    ledger,
    snapshot,
    reservedSats,
    creditedCount: snapshot.deposits.filter((d) => d.status === 'credited').length,
    observedCount: snapshot.deposits.length,
    currentHeight
  };
}

module.exports = {
  toAmountSats,
  buildLiveReserveFromUnspent
};
