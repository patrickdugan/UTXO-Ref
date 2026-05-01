const {
  stableStringify,
  sha256Hex
} = require('./tradelayer_pnl_route_adapter');

const DEFAULT_UNIT_SCALE = 100000000n;

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function pick(value, ...keys) {
  for (const key of keys) {
    if (value && value[key] !== undefined && value[key] !== null && value[key] !== '') {
      return value[key];
    }
  }
  return undefined;
}

function parseIntegerLike(value, fieldName) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${fieldName} must be a safe integer`);
    return String(value);
  }
  const text = String(value);
  if (!/^-?\d+$/.test(text)) throw new Error(`${fieldName} must be an integer`);
  return text;
}

function decimalToUnits(value, fieldName, unitScale = DEFAULT_UNIT_SCALE) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${fieldName} is required`);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);

  const text = String(value);
  if (/^-?\d+$/.test(text)) return text;
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`${fieldName} must be numeric`);

  const negative = text.startsWith('-');
  const clean = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = clean.split('.');
  const scaleDigits = unitScale.toString().length - 1;
  if (fraction.length > scaleDigits) {
    throw new Error(`${fieldName} has more than ${scaleDigits} decimal places`);
  }
  const units = BigInt(whole) * unitScale + BigInt((fraction + '0'.repeat(scaleDigits)).slice(0, scaleDigits));
  return `${negative ? '-' : ''}${units.toString()}`;
}

function normalizeTxType(row) {
  const raw = pick(row, 'txType', 'txNumber', 'type', 'transactionType');
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function isConsensusValid(row) {
  if (row.valid === false || row.consensusValid === false || row.isValid === false) return false;
  if (typeof row.status === 'string' && /invalid|rejected|failed/i.test(row.status)) return false;
  if (row.reason && row.valid === false) return false;
  return true;
}

function isSendCandidate(row) {
  const txType = normalizeTxType(row);
  if (txType !== null) return txType === 2;
  return Boolean(
    pick(row, 'toAddress', 'recipientAddress', 'receiverAddress', 'address')
    && pick(row, 'fromAddress', 'senderAddress', 'sender')
    && pick(row, 'propertyId', 'propertyIds')
    && pick(row, 'amount', 'amounts', 'amountUnits')
  );
}

function normalizeOneSend(row, index, options = {}) {
  const unitScale = options.unitScale !== undefined ? BigInt(options.unitScale) : DEFAULT_UNIT_SCALE;
  const txid = String(pick(row, 'txid', 'txId', 'hash', 'transactionHash') || '');
  if (!txid) throw new Error(`send row ${index} missing txid`);

  const fromAddress = String(pick(row, 'fromAddress', 'senderAddress', 'sender') || '');
  const toAddress = String(pick(row, 'toAddress', 'recipientAddress', 'receiverAddress', 'address') || '');
  if (!fromAddress) throw new Error(`send row ${index} missing sender/from address`);
  if (!toAddress) throw new Error(`send row ${index} missing recipient/to address`);

  const propertyId = pick(row, 'propertyId', 'propertyID', 'property');
  if (propertyId === undefined) throw new Error(`send row ${index} missing propertyId`);

  const amountUnits = row.amountUnits !== undefined || row.tokenAmountUnits !== undefined
    ? parseIntegerLike(pick(row, 'amountUnits', 'tokenAmountUnits'), `send row ${index} amountUnits`)
    : decimalToUnits(pick(row, 'amount', 'amounts'), `send row ${index} amount`, unitScale);

  return {
    id: String(pick(row, 'id', 'sendId') || `${txid}:${index}`),
    txid,
    blockHeight: pick(row, 'blockHeight', 'block', 'height') ?? null,
    txIndex: pick(row, 'txIndex', 'index') ?? null,
    fromAddress,
    toAddress,
    propertyId: Number(propertyId),
    amountUnits,
    depositUnits: row.depositUnits !== undefined || row.depositTokenUnits !== undefined
      ? parseIntegerLike(pick(row, 'depositUnits', 'depositTokenUnits'), `send row ${index} depositUnits`)
      : undefined,
    source: {
      txType: normalizeTxType(row),
      valid: isConsensusValid(row),
      reason: row.reason || null
    }
  };
}

function expandSendRow(row, rowIndex, options = {}) {
  const propertyIds = toArray(pick(row, 'propertyIds', 'propertyId'));
  const amounts = toArray(pick(row, 'amounts', 'amount', 'amountUnits'));
  const addresses = toArray(pick(row, 'recipientAddresses', 'toAddresses', 'address', 'toAddress', 'recipientAddress', 'receiverAddress'));

  const isMulti = propertyIds.length > 1 || amounts.length > 1 || addresses.length > 1;
  if (!isMulti) return [normalizeOneSend(row, rowIndex, options)];
  if (propertyIds.length !== amounts.length || propertyIds.length !== addresses.length) {
    throw new Error(`multi-send row ${rowIndex} has mismatched property/address/amount lengths`);
  }

  return propertyIds.map((propertyId, i) => normalizeOneSend({
    ...row,
    id: `${pick(row, 'id', 'sendId') || pick(row, 'txid', 'txId', 'hash', 'transactionHash')}:${i}`,
    propertyId,
    amount: amounts[i],
    amountUnits: row.amountUnits !== undefined ? amounts[i] : undefined,
    toAddress: addresses[i],
    address: addresses[i]
  }, i, options));
}

function sourceRowsFromInput(input) {
  if (Array.isArray(input)) return input;
  return input.transactions
    || input.txs
    || input.records
    || input.sends
    || input.sendRecords
    || input.tokenSends
    || [];
}

function buildTradeLayerSendStateOracleFromConsensus(input, options = {}) {
  if (!input || typeof input !== 'object') throw new Error('consensus input must be an object or array');
  const rows = sourceRowsFromInput(input);
  if (!Array.isArray(rows)) throw new Error('consensus input rows must be an array');

  const sourceHash = sha256Hex(rows);
  const skipped = [];
  const sends = [];

  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object') {
      skipped.push({ index, reason: 'row is not an object' });
      return;
    }
    if (!isSendCandidate(row)) {
      skipped.push({ index, txid: pick(row, 'txid', 'txId', 'hash', 'transactionHash') || null, reason: 'not tx type 2 send' });
      return;
    }
    if (!isConsensusValid(row)) {
      skipped.push({ index, txid: pick(row, 'txid', 'txId', 'hash', 'transactionHash') || null, reason: row.reason || 'consensus invalid' });
      return;
    }
    for (const send of expandSendRow(row, index, options)) {
      sends.push(send);
    }
  });

  if (!sends.length) throw new Error('no consensus-valid TradeLayer sends found');

  const selectedSendId = options.selectedSendId
    || input.selectedSendId
    || (options.selectedSendTxid
      ? (sends.find((send) => send.txid === options.selectedSendTxid)?.id)
      : null)
    || sends[0].id;
  const selected = sends.find((send) => send.id === selectedSendId);
  if (!selected) throw new Error(`selected send not found after extraction: ${selectedSendId}`);

  const depositUnits = options.depositUnits
    ?? input.depositUnits
    ?? selected.depositUnits;
  if (depositUnits !== undefined) selected.depositUnits = parseIntegerLike(depositUnits, 'depositUnits');

  const oracleBlob = {
    kind: 'tradelayer-send-state-oracle-v1',
    chain: options.chain || input.chain || input.network || 'litecoin-testnet',
    epochId: String(options.epochId ?? input.epochId ?? input.snapshotHeight ?? selected.blockHeight ?? 0),
    snapshotHeight: Number(options.snapshotHeight ?? input.snapshotHeight ?? input.height ?? selected.blockHeight ?? 0),
    snapshotTxid: options.snapshotTxid || input.snapshotTxid || input.blockHash || input.bestBlockHash || sourceHash,
    oracleAddress: options.oracleAddress || input.oracleAddress || null,
    selectedSendId,
    sends,
    dlcInputs: options.dlcInputs || input.dlcInputs || input.depositInputs || {},
    feeSats: options.feeSats ?? input.feeSats ?? 0,
    dlcFunderRegistry: options.dlcFunderRegistry || input.dlcFunderRegistry || input.dlcRegistry || input.funderRegistry || {},
    source: {
      extractor: 'tradelayer-send-consensus-v1',
      sourceHash,
      sourceRowCount: rows.length,
      validSendCount: sends.length,
      skippedCount: skipped.length,
      skipped,
      stateRoot: options.stateRoot || input.stateRoot || sha256Hex(sends)
    }
  };

  return oracleBlob;
}

module.exports = {
  DEFAULT_UNIT_SCALE,
  decimalToUnits,
  normalizeOneSend,
  buildTradeLayerSendStateOracleFromConsensus
};
