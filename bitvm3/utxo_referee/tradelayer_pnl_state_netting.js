/**
 * TradeLayer state-oracle PNL netting for UTXORef.
 *
 * This module sits between a TradeLayer state oracle and the existing
 * UTXORef route adapter. It does not replay all TradeLayer consensus. It
 * assumes the caller has authenticated the complete oracle blob and selected
 * consensus-valid positions, then deterministically recomputes bilateral PNL, folds the directed
 * loser->winner graph, and binds the final payable set into a UTXORef payout
 * commitment. Verification requires that blob separately in
 * options.stateOracleBlob. A hash copied from a proposed settlement is not an
 * independent source. This legacy adapter models one fungible satoshi pool
 * and one funding input; reserve ownership, cross-vault allocation and retained
 * rBTC liabilities belong to the explicit batch settlement gate.
 */

const {
  stableStringify,
  sha256Hex,
  computeTradeLayerPlanHash,
  buildTradeLayerPnlCommitment,
  verifyTradeLayerPnlRoutePlan
} = require('./tradelayer_pnl_route_adapter');
const { types: utilTypes } = require('util');
const { snapshotPlainData, snapshotOwnDataArguments } = require('./dlc_canonical_json');

const CHALLENGE_TYPES = [
  'omitted_pnl_row',
  'invalid_pnl_row',
  'wrong_pnl_arithmetic',
  'wrong_netting_edge',
  'wrong_final_recipient',
  'wrong_state_oracle_hash'
];

function toInt(value, fieldName) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${fieldName} must be a safe integer`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`${fieldName} must be an integer`);
}

function optionalInt(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  return toInt(value, fieldName);
}

function toSats(value, fieldName) {
  const sats = toInt(value, fieldName);
  if (sats < 0n) throw new Error(`${fieldName} must be non-negative`);
  return sats;
}

function abs(value) {
  return value < 0n ? -value : value;
}

function minBigInt(a, b) {
  return a < b ? a : b;
}

function normalizeObjectList(value, fieldName) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => ({
      ...(item && typeof item === 'object' ? item : { value: item }),
      id: item?.id ?? item?.positionId ?? item?.rowId ?? key
    }));
  }
  throw new Error(`${fieldName} must be an array or object map`);
}

function stripSignatureFields(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripSignatureFields);

  const result = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if ([
      'signature',
      'oracleSignature',
      'signatures',
      'publicKeyPem',
      'privateKeyPem',
      'privateKeyHex'
    ].includes(key)) {
      continue;
    }
    result[key] = stripSignatureFields(entry);
  }
  return result;
}

function buildTradeLayerPnlStateOracleCommitment(stateOracleBlob, options = {}) {
  if (!stateOracleBlob || typeof stateOracleBlob !== 'object') {
    throw new Error('stateOracleBlob must be an object');
  }

  const core = {
    kind: stateOracleBlob.kind || 'tradelayer-pnl-state-oracle-v1',
    chain: stateOracleBlob.chain || stateOracleBlob.network || options.network || 'litecoin-testnet',
    network: options.network || stateOracleBlob.network || stateOracleBlob.chain || 'litecoin-testnet',
    epochId: stateOracleBlob.epochId ?? options.epochId ?? null,
    snapshotHeight: stateOracleBlob.snapshotHeight ?? null,
    snapshotTxid: stateOracleBlob.snapshotTxid || stateOracleBlob.revealTxid || null,
    oracleAddress: stateOracleBlob.oracleAddress || options.oracleAddress || null,
    // Include every top-level fallback used by arithmetic and payout routing.
    // Previously changing priceScale alone left oracleBlobHash unchanged.
    contractId: options.contractId ?? stateOracleBlob.contractId ?? 'perp-demo',
    priceScale: stateOracleBlob.priceScale ?? options.priceScale ?? 1,
    fallbackClosePrice: options.closePrice ?? stateOracleBlob.closePrice ?? stateOracleBlob.markPrice ?? null,
    defaultCollateralSats: options.defaultCollateralSats ?? null,
    marks: options.marks || stateOracleBlob.marks || stateOracleBlob.mark || stateOracleBlob.close || null,
    liveAddresses: options.liveAddresses || stateOracleBlob.liveAddresses || null,
    settlementAddressMap: options.settlementAddressMap || stateOracleBlob.settlementAddressMap || null,
    dlcInput: options.dlcInput || stateOracleBlob.dlcInput || stateOracleBlob.settlementInput || null,
    feeSats: String(options.feeSats ?? stateOracleBlob.feeSats ?? 0),
    revealTxid: options.revealTxid || stateOracleBlob.revealTxid || stateOracleBlob.snapshotTxid || null,
    envelope: stateOracleBlob.envelope || {},
    pnlRows: normalizeObjectList(
      options.pnlRows
        || stateOracleBlob.pnlRows
        || stateOracleBlob.perpPnlRows
        || stateOracleBlob.positions
        || stateOracleBlob.openPositions,
      'stateOracleBlob.pnlRows'
    )
  };

  return {
    oracleBlobHash: sha256Hex(stripSignatureFields(core)),
    rowSourceHash: sha256Hex(core.pnlRows),
    core
  };
}

function priceFromMarkSource(row, stateOracleBlob, options, contractId) {
  const direct = row.closePrice ?? row.price ?? row.close?.price ?? row.markPrice;
  if (direct !== undefined && direct !== null) return direct;

  const marks = options.marks || stateOracleBlob.marks || stateOracleBlob.mark || stateOracleBlob.close;
  if (marks && typeof marks === 'object') {
    if (marks[contractId]?.price !== undefined) return marks[contractId].price;
    if (marks[contractId]?.closePrice !== undefined) return marks[contractId].closePrice;
    if (marks.price !== undefined) return marks.price;
    if (marks.closePrice !== undefined) return marks.closePrice;
  }

  const fallback = options.closePrice ?? stateOracleBlob.closePrice ?? stateOracleBlob.markPrice;
  if (fallback !== undefined && fallback !== null) return fallback;
  throw new Error(`missing close price for PNL row ${row.id ?? row.positionId ?? contractId}`);
}

function normalizePartyModel(row) {
  if (row.longAddress && row.shortAddress) {
    return {
      side: 'long',
      traderAddress: String(row.longAddress),
      counterpartyAddress: String(row.shortAddress),
      longAddress: String(row.longAddress),
      shortAddress: String(row.shortAddress)
    };
  }

  const side = String(row.side || 'long').toLowerCase();
  if (side !== 'long' && side !== 'short') throw new Error('PNL row side must be long or short');
  const traderAddress = row.traderAddress || row.address || row.accountAddress;
  const counterpartyAddress = row.counterpartyAddress || row.otherAddress || row.makerAddress;
  if (!traderAddress || !counterpartyAddress) {
    throw new Error('PNL row requires traderAddress/counterpartyAddress or longAddress/shortAddress');
  }

  return {
    side,
    traderAddress: String(traderAddress),
    counterpartyAddress: String(counterpartyAddress),
    longAddress: side === 'long' ? String(traderAddress) : String(counterpartyAddress),
    shortAddress: side === 'short' ? String(traderAddress) : String(counterpartyAddress)
  };
}

function deriveBilateralPnlRow(rawRow, stateOracleBlob = {}, options = {}, index = 0) {
  const row = rawRow || {};
  const contractId = String(row.contractId ?? options.contractId ?? stateOracleBlob.contractId ?? 'perp-demo');
  const rowId = String(row.rowId ?? row.id ?? row.positionId ?? `${contractId}:${index}`);
  const positionId = String(row.positionId ?? row.id ?? rowId);
  const parties = normalizePartyModel(row);
  if (parties.traderAddress === parties.counterpartyAddress) {
    throw new Error(`PNL row ${rowId} must have distinct counterparties`);
  }

  const entryPrice = toInt(row.entryPrice ?? row.openPrice, `pnlRows[${index}].entryPrice`);
  const closePrice = toInt(priceFromMarkSource(row, stateOracleBlob, options, contractId), `pnlRows[${index}].closePrice`);
  const quantityUnits = toInt(row.quantityUnits ?? row.quantity ?? row.size ?? 1, `pnlRows[${index}].quantityUnits`);
  if (quantityUnits <= 0n) throw new Error(`pnlRows[${index}].quantityUnits must be positive`);
  const priceScale = toInt(row.priceScale ?? stateOracleBlob.priceScale ?? options.priceScale ?? 1, `pnlRows[${index}].priceScale`);
  if (priceScale <= 0n) throw new Error(`pnlRows[${index}].priceScale must be positive`);
  const collateralSats = toSats(
    row.collateralSats ?? row.lossCapSats ?? row.maxTransferSats ?? options.defaultCollateralSats,
    `pnlRows[${index}].collateralSats`
  );
  if (collateralSats <= 0n) throw new Error(`pnlRows[${index}].collateralSats must be positive`);

  const direction = parties.side === 'long' ? 1n : -1n;
  const rawPnlSats = ((closePrice - entryPrice) * quantityUnits * direction) / priceScale;
  const claimedRawPnlSats = optionalInt(row.rawPnlSats ?? row.pnlSats, `pnlRows[${index}].rawPnlSats`);
  if (claimedRawPnlSats !== null && claimedRawPnlSats !== rawPnlSats && !options.allowClaimedPnlMismatch) {
    throw new Error(`pnlRows[${index}] claimed PNL ${claimedRawPnlSats} does not match recomputed ${rawPnlSats}`);
  }

  const transferSats = minBigInt(abs(rawPnlSats), collateralSats);
  const winnerAddress = rawPnlSats >= 0n ? parties.traderAddress : parties.counterpartyAddress;
  const loserAddress = rawPnlSats >= 0n ? parties.counterpartyAddress : parties.traderAddress;
  const core = {
    rowId,
    positionId,
    contractId,
    side: parties.side,
    traderAddress: parties.traderAddress,
    counterpartyAddress: parties.counterpartyAddress,
    longAddress: parties.longAddress,
    shortAddress: parties.shortAddress,
    winnerAddress,
    loserAddress,
    entryPrice: entryPrice.toString(),
    closePrice: closePrice.toString(),
    quantityUnits: quantityUnits.toString(),
    priceScale: priceScale.toString(),
    collateralSats: collateralSats.toString(),
    rawPnlSats: rawPnlSats.toString(),
    transferSats: transferSats.toString(),
    markHash: sha256Hex(row.mark || row.close || stateOracleBlob.marks || stateOracleBlob.mark || stateOracleBlob.close || {}),
    positionHash: sha256Hex(row.position || row),
    sourceTxid: row.txid || row.openTxid || null,
    closeTxid: row.closeTxid || stateOracleBlob.closeTxid || null
  };

  return {
    ...core,
    rowHash: sha256Hex(core)
  };
}

function derivePnlRowsFromStateOracle(stateOracleBlob, options = {}) {
  const rawRows = normalizeObjectList(
    options.pnlRows
      || stateOracleBlob.pnlRows
      || stateOracleBlob.perpPnlRows
      || stateOracleBlob.positions
      || stateOracleBlob.openPositions,
    'stateOracleBlob.pnlRows'
  );
  if (!rawRows.length) throw new Error('state oracle PNL netting requires at least one PNL row');
  // Domain metadata must never be silently discarded while folding balances.
  // The batch gate carries explicit netting-set and asset semantics. This
  // legacy path remains limited to its original single, untagged satoshi pool.
  const domainFields = ['nettingSetId', 'nettingSet', 'collateralAssetId', 'collateralAsset',
    'settlementAsset', 'collateralPropertyId', 'assetId', 'propertyId', 'vaultId'];
  for (const value of [stateOracleBlob, ...rawRows]) {
    for (const field of domainFields) {
      if (value?.[field] !== undefined && value[field] !== null) {
        throw new Error(`legacy PNL netting does not support ${field}; use the explicit batch settlement gate`);
      }
    }
  }
  const rows = rawRows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`pnlRows[${index}] must be an object`);
    if (![row.rowId, row.id, row.positionId].some((id) => id !== undefined && id !== null && String(id).trim())) {
      throw new Error(`pnlRows[${index}] requires a stable row or position id`);
    }
    return deriveBilateralPnlRow(row, stateOracleBlob, options, index);
  });
  const rowIds = new Set();
  const positions = new Set();
  for (const row of rows) {
    if (!row.rowId.trim() || !row.positionId.trim()) throw new Error('PNL row and position ids must be non-empty');
    if (rowIds.has(row.rowId)) throw new Error(`duplicate PNL row id: ${row.rowId}`);
    const positionKey = stableStringify([row.contractId, row.positionId]);
    if (positions.has(positionKey)) throw new Error(`duplicate PNL position: ${row.contractId}/${row.positionId}`);
    rowIds.add(row.rowId);
    positions.add(positionKey);
  }
  return rows;
}

function buildGrossPnlEdges(rows) {
  return rows
    .filter((row) => BigInt(row.transferSats) > 0n)
    .map((row, index) => {
      const core = {
        edgeIndex: index,
        rowId: row.rowId,
        contractId: row.contractId,
        fromAddress: row.loserAddress,
        toAddress: row.winnerAddress,
        sats: row.transferSats,
        rowHash: row.rowHash
      };
      return {
        ...core,
        edgeId: sha256Hex(core).slice(0, 24)
      };
    });
}

function computeNetBalances(edges) {
  const map = new Map();
  for (const edge of edges) {
    const sats = toSats(edge.sats, `edge ${edge.edgeId}.sats`);
    map.set(edge.fromAddress, (map.get(edge.fromAddress) || 0n) - sats);
    map.set(edge.toAddress, (map.get(edge.toAddress) || 0n) + sats);
  }

  return [...map.entries()]
    .filter(([, netSats]) => netSats !== 0n)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([address, netSats]) => ({
      address,
      netSats: netSats.toString(),
      direction: netSats > 0n ? 'receive' : 'pay'
    }));
}

function foldPnlNettingGraph(netBalances) {
  const payers = netBalances
    .filter((row) => BigInt(row.netSats) < 0n)
    .map((row) => ({ address: row.address, remaining: -BigInt(row.netSats) }))
    .sort((a, b) => a.address.localeCompare(b.address));
  const receivers = netBalances
    .filter((row) => BigInt(row.netSats) > 0n)
    .map((row) => ({ address: row.address, remaining: BigInt(row.netSats) }))
    .sort((a, b) => a.address.localeCompare(b.address));

  const foldedEdges = [];
  let payerIndex = 0;
  let receiverIndex = 0;
  while (payerIndex < payers.length && receiverIndex < receivers.length) {
    const payer = payers[payerIndex];
    const receiver = receivers[receiverIndex];
    const sats = minBigInt(payer.remaining, receiver.remaining);
    const core = {
      foldIndex: foldedEdges.length,
      fromAddress: payer.address,
      toAddress: receiver.address,
      sats: sats.toString()
    };
    foldedEdges.push({
      ...core,
      foldedEdgeId: sha256Hex(core).slice(0, 24)
    });
    payer.remaining -= sats;
    receiver.remaining -= sats;
    if (payer.remaining === 0n) payerIndex++;
    if (receiver.remaining === 0n) receiverIndex++;
  }

  const payerDust = payers.reduce((sum, row) => sum + row.remaining, 0n);
  const receiverDust = receivers.reduce((sum, row) => sum + row.remaining, 0n);
  if (payerDust !== 0n || receiverDust !== 0n) {
    throw new Error('PNL graph did not net to zero');
  }

  return foldedEdges;
}

function setFromList(value) {
  if (!value) return null;
  if (Array.isArray(value)) return new Set(value.map(String));
  if (typeof value === 'object') {
    return new Set(Object.entries(value).filter(([, live]) => !!live).map(([address]) => String(address)));
  }
  throw new Error('liveAddresses must be an array or object map');
}

function resolveSettlementAddress(accountAddress, settlementAddressMap = {}) {
  const entry = settlementAddressMap && Object.prototype.hasOwnProperty.call(settlementAddressMap, accountAddress)
    ? settlementAddressMap[accountAddress] : undefined;
  if (!entry) return accountAddress;
  if (typeof entry === 'string') return entry;
  return entry.address || entry.payoutAddress || entry.dlcAddress || accountAddress;
}

function buildOutputPlanFromNetBalances(netBalances, options = {}) {
  const liveSet = setFromList(options.liveAddresses);
  const settlementAddressMap = options.settlementAddressMap || {};
  return netBalances
    .filter((row) => BigInt(row.netSats) > 0n)
    .map((row) => {
      const accountAddress = String(row.address);
      const live = liveSet ? liveSet.has(accountAddress) : null;
      if (options.requireLivePayees && live === false) {
        throw new Error(`positive PNL payee is not live: ${accountAddress}`);
      }
      return {
        role: 'pnl-netted-winner',
        address: resolveSettlementAddress(accountAddress, settlementAddressMap),
        accountAddress,
        sats: BigInt(row.netSats).toString(),
        live
      };
    });
}

function totalPositiveNetSats(netBalances) {
  return netBalances.reduce((sum, row) => {
    const netSats = BigInt(row.netSats);
    return netSats > 0n ? sum + netSats : sum;
  }, 0n);
}

function totalGrossTransferSats(edges) {
  return edges.reduce((sum, edge) => sum + BigInt(edge.sats), 0n);
}

function rootHex(value) {
  return sha256Hex(value);
}

function buildTradeLayerPnlNettingRoutePlan(stateOracleBlob, rows, grossEdges, netBalances, foldedEdges, options = {}) {
  const network = options.network || stateOracleBlob.network || stateOracleBlob.chain || 'litecoin-testnet';
  const oracleCommitment = buildTradeLayerPnlStateOracleCommitment(stateOracleBlob, options);
  const outputPlan = options.outputPlan || buildOutputPlanFromNetBalances(netBalances, {
    settlementAddressMap: options.settlementAddressMap || stateOracleBlob.settlementAddressMap,
    liveAddresses: options.liveAddresses || stateOracleBlob.liveAddresses,
    requireLivePayees: options.requireLivePayees
  });
  if (!outputPlan.length && !options.allowEmptyOutputPlan) {
    throw new Error('PNL netting produced no payable outputs');
  }

  const routePlan = {
    route: 'pnl-netting',
    network,
    epochId: String(stateOracleBlob.epochId ?? options.epochId ?? 0),
    revealTxid: options.revealTxid || stateOracleBlob.revealTxid || stateOracleBlob.snapshotTxid || null,
    payloadHash: oracleCommitment.oracleBlobHash,
    dlcInput: options.dlcInput || stateOracleBlob.dlcInput || stateOracleBlob.settlementInput || null,
    feeSats: String(options.feeSats ?? stateOracleBlob.feeSats ?? 0),
    outputPlan,
    envelope: {
      ...(stateOracleBlob.envelope || {}),
      routeType: 'pnl-netting',
      stateOracleHash: oracleCommitment.oracleBlobHash,
      pnlRowRoot: rootHex(rows),
      grossEdgeRoot: rootHex(grossEdges),
      netBalanceRoot: rootHex(netBalances),
      foldedEdgeRoot: rootHex(foldedEdges),
      settlementAddressMapHash: rootHex(options.settlementAddressMap || stateOracleBlob.settlementAddressMap || {}),
      liveAddressRoot: rootHex(options.liveAddresses || stateOracleBlob.liveAddresses || [])
    }
  };

  routePlan.planHash = options.planHash || computeTradeLayerPlanHash(routePlan);
  return routePlan;
}

function buildTradeLayerPnlNettingSettlement(stateOracleBlob, options = {}) {
  const oracleCommitment = buildTradeLayerPnlStateOracleCommitment(stateOracleBlob, options);
  const rows = derivePnlRowsFromStateOracle(stateOracleBlob, options);
  const grossEdges = buildGrossPnlEdges(rows);
  const netBalances = computeNetBalances(grossEdges);
  const foldedEdges = foldPnlNettingGraph(netBalances);
  const routePlan = buildTradeLayerPnlNettingRoutePlan(
    stateOracleBlob,
    rows,
    grossEdges,
    netBalances,
    foldedEdges,
    options
  );
  const bundle = buildTradeLayerPnlCommitment(routePlan, options);
  const core = {
    kind: 'tradelayer_pnl_netting_settlement_v1',
    network: routePlan.network,
    epochId: String(stateOracleBlob.epochId ?? options.epochId ?? bundle.epochId),
    snapshotHeight: stateOracleBlob.snapshotHeight ?? null,
    snapshotTxid: stateOracleBlob.snapshotTxid || null,
    stateOracleHash: oracleCommitment.oracleBlobHash,
    rowSourceHash: oracleCommitment.rowSourceHash,
    pnlRowRoot: rootHex(rows),
    grossEdgeRoot: rootHex(grossEdges),
    netBalanceRoot: rootHex(netBalances),
    foldedEdgeRoot: rootHex(foldedEdges),
    routePlanHash: routePlan.planHash,
    withdrawalRootHex: bundle.withdrawalRootHex,
    commitmentHashHex: bundle.commitmentHashHex,
    rowCount: rows.length,
    grossTransferCount: grossEdges.length,
    foldedTransferCount: foldedEdges.length,
    payoutCount: routePlan.outputPlan.length,
    totalGrossTransferSats: totalGrossTransferSats(grossEdges).toString(),
    totalPositiveNetSats: totalPositiveNetSats(netBalances).toString(),
    challengeTypes: CHALLENGE_TYPES
  };

  return {
    kind: 'tradelayer_pnl_netting_settlement',
    settlementHash: sha256Hex(core),
    core,
    rows,
    grossEdges,
    netBalances,
    foldedEdges,
    routePlan,
    payout: {
      withdrawalRootHex: bundle.withdrawalRootHex,
      commitmentHashHex: bundle.commitmentHashHex,
      totalSats: bundle.payoutTotalSats.toString(),
      proofs: bundle.proofs
    }
  };
}

// The shared descriptor-aware snapshot rejects accessors, Proxies, executable
// hooks and ambiguous containers before values are read. Proof siblings alone
// also accept the Buffer format returned by the builder and its JSON encoding.
// Only already validated frozen data reaches this copier. Null prototypes keep
// optional source fields from consulting ambient Object.prototype properties.
function isolateRecordPrototypes(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(isolateRecordPrototypes));
  if (!value || typeof value !== 'object') return value;
  const result = Object.create(null);
  for (const key of Object.keys(value)) {
    Object.defineProperty(result, key, { value: isolateRecordPrototypes(value[key]), enumerable: true });
  }
  return Object.freeze(result);
}

function requireOwnFields(value, fields, label) {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) throw new Error(`${label}.${field} is required`);
  }
}

function proofArray(value, label, convert) {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)
    || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a plain dense array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 65536
    || Reflect.ownKeys(descriptors).length !== length + 1) {
    throw new Error(`${label} must be a bounded dense array without extra properties`);
  }
  const result = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable data property`);
    }
    result.push(convert(descriptor.value, `${label}[${index}]`));
  }
  return result;
}

function proofSiblingHex(value, label) {
  if (value && typeof value === 'object' && utilTypes.isProxy(value)) {
    throw new Error(`${label} must not be a Proxy`);
  }
  let bytes;
  if (Buffer.isBuffer(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== 32) throw new Error(`${label} must be an unextended 32-byte Buffer`);
    bytes = Array.from({ length: 32 }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new Error(`${label} must contain only byte data properties`);
      }
      return descriptor.value;
    });
  } else {
    const encoded = snapshotPlainData(value, label);
    if (!encoded || typeof encoded !== 'object' || Array.isArray(encoded)
      || Object.keys(encoded).length !== 2
      || !Object.prototype.hasOwnProperty.call(encoded, 'type') || !Object.prototype.hasOwnProperty.call(encoded, 'data')
      || encoded.type !== 'Buffer' || !Array.isArray(encoded.data)) {
      throw new Error(`${label} must be a Buffer or its plain JSON encoding`);
    }
    bytes = encoded.data;
  }
  if (bytes.length !== 32 || bytes.some((byte) => !Number.isSafeInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error(`${label} must contain exactly 32 bytes`);
  }
  return Buffer.from(bytes).toString('hex');
}

function comparableJson(value, field) {
  if (field === 'payout') {
    const payout = snapshotOwnDataArguments(value,
      ['withdrawalRootHex', 'commitmentHashHex', 'totalSats', 'proofs'], '$.payout');
    requireOwnFields(payout, ['withdrawalRootHex', 'commitmentHashHex', 'totalSats', 'proofs'], '$.payout');
    value = {
      withdrawalRootHex: payout.withdrawalRootHex,
      commitmentHashHex: payout.commitmentHashHex,
      totalSats: payout.totalSats,
      proofs: proofArray(payout.proofs, '$.payout.proofs', (rawProof, label) => {
        const proof = snapshotOwnDataArguments(rawProof, ['index', 'siblings'], label);
        requireOwnFields(proof, ['index', 'siblings'], label);
        return { index: proof.index, siblings: proofArray(proof.siblings, `${label}.siblings`, proofSiblingHex) };
      })
    };
  }
  return stableStringify(snapshotPlainData(value, `$.${field}`, true));
}

function verifyTradeLayerPnlNettingSettlement(settlement, options = {}) {
  try {
    options = isolateRecordPrototypes(snapshotPlainData(snapshotOwnDataArguments(options, [
      'stateOracleBlob', 'expectedStateOracleHash', 'network', 'observedOutputs', 'requireLivePayees',
      // Historical bypass keys are accepted as data for compatibility, then ignored.
      'outputPlan', 'skipPlanHash', 'pnlRows', 'capSats', 'allowClaimedPnlMismatch'
    ], '$.verificationOptions'), '$.verificationOptions', true));
    if (!options.stateOracleBlob || typeof options.stateOracleBlob !== 'object'
      || Array.isArray(options.stateOracleBlob)) {
      return { ok: false, reason: 'independent options.stateOracleBlob is required' };
    }
    settlement = snapshotOwnDataArguments(settlement,
      ['kind', 'settlementHash', 'rows', 'grossEdges', 'netBalances', 'foldedEdges', 'routePlan', 'core', 'payout'],
      '$.settlement');
    requireOwnFields(settlement,
      ['kind', 'settlementHash', 'rows', 'grossEdges', 'netBalances', 'foldedEdges', 'routePlan', 'core', 'payout'],
      '$.settlement');
    if (!settlement || settlement.kind !== 'tradelayer_pnl_netting_settlement') {
      return { ok: false, reason: 'wrong settlement kind' };
    }

    // Rebuild exclusively from the caller's independently obtained source.
    // Producer-controlled rows, outputs, fee/input overrides, bypass switches,
    // and source data embedded in the proposed settlement are never used here.
    const source = options.stateOracleBlob;
    const expected = buildTradeLayerPnlNettingSettlement(source, Object.create(null));
    if (options.expectedStateOracleHash !== undefined
      && options.expectedStateOracleHash !== expected.core.stateOracleHash) {
      return { ok: false, reason: 'independent state oracle hash mismatch' };
    }
    if (options.network !== undefined && options.network !== expected.routePlan.network) {
      return { ok: false, reason: 'independent state oracle network mismatch' };
    }

    const funding = expected.routePlan.dlcInput;
    if (!funding || !/^[0-9a-f]{64}$/i.test(String(funding.txid || ''))
      || !Number.isSafeInteger(funding.vout) || funding.vout < 0 || funding.vout > 0xffffffff
      || funding.sats === undefined || toSats(funding.sats, 'dlcInput.sats') <= 0n) {
      return { ok: false, reason: 'independent source requires a funding outpoint and positive sat amount' };
    }
    toSats(expected.routePlan.feeSats, 'feeSats');
    if (options.requireLivePayees) {
      const live = setFromList(source.liveAddresses);
      if (!live || expected.netBalances.some((row) => BigInt(row.netSats) > 0n && !live.has(row.address))) {
        return { ok: false, reason: 'independent source does not establish every positive PNL payee as live' };
      }
    }

    for (const field of ['rows', 'grossEdges', 'netBalances', 'foldedEdges', 'routePlan', 'core', 'payout']) {
      if (comparableJson(settlement[field], field) !== comparableJson(expected[field], field)) {
        return { ok: false, reason: `${field} differs from independent source recomputation` };
      }
    }
    if (settlement.settlementHash !== expected.settlementHash) {
      return { ok: false, reason: 'settlement hash differs from independent source recomputation' };
    }

    // Only the observed transaction outputs pass through to the route checker.
    // In particular, capSats, epochId and skipPlanHash cannot change verification.
    const routeResult = verifyTradeLayerPnlRoutePlan(expected.routePlan, Object.assign(Object.create(null), {
      observedOutputs: options.observedOutputs,
      skipPlanHash: false
    }));
    if (!routeResult.ok) return { ok: false, reason: `route plan failed: ${routeResult.reason}`, routeResult };
    if (routeResult.withdrawalRootHex !== expected.core.withdrawalRootHex
      || routeResult.commitmentHashHex !== expected.core.commitmentHashHex) {
      return { ok: false, reason: 'independently recomputed payout commitment mismatch' };
    }

    return {
      ok: true,
      settlementHash: expected.settlementHash,
      stateOracleHash: expected.core.stateOracleHash,
      rowCount: expected.core.rowCount,
      totalPositiveNetSats: expected.core.totalPositiveNetSats,
      routePlanHash: expected.core.routePlanHash,
      verificationScope: 'legacy-single-input-source-replay',
      reserveFeasibilityVerified: false
    };
  } catch (err) {
    return { ok: false, reason: `invalid PNL settlement: ${err.message}` };
  }
}

function buildTradeLayerPnlNettingChallenge(settlement, options = {}) {
  const result = verifyTradeLayerPnlNettingSettlement(settlement, options.verifyOptions || {});
  if (!result.ok) throw new Error(`invalid PNL netting settlement: ${result.reason}`);
  const challengeType = options.challengeType || 'wrong_netting_edge';
  if (!CHALLENGE_TYPES.includes(challengeType)) {
    throw new Error(`unknown PNL netting challenge type: ${challengeType}`);
  }

  const core = {
    kind: 'tradelayer_pnl_netting_challenge_v1',
    challengeType,
    settlementHash: settlement.settlementHash,
    binding: {
      stateOracleHash: settlement.core.stateOracleHash,
      pnlRowRoot: settlement.core.pnlRowRoot,
      grossEdgeRoot: settlement.core.grossEdgeRoot,
      netBalanceRoot: settlement.core.netBalanceRoot,
      foldedEdgeRoot: settlement.core.foldedEdgeRoot,
      routePlanHash: settlement.core.routePlanHash,
      withdrawalRootHex: settlement.core.withdrawalRootHex
    },
    expected: options.expected || {},
    claimed: options.claimed || defaultClaimForChallenge(challengeType, settlement, options)
  };

  return {
    kind: 'tradelayer_pnl_netting_challenge',
    challengeType,
    challengeable: true,
    challengeHash: sha256Hex(core),
    core
  };
}

function defaultClaimForChallenge(challengeType, settlement, options) {
  switch (challengeType) {
    case 'omitted_pnl_row':
      return {
        omittedRowHash: options.omittedRowHash || options.rowHash || 'unknown',
        committedPnlRowRoot: settlement.core.pnlRowRoot
      };
    case 'invalid_pnl_row':
      return {
        invalidRowHash: options.invalidRowHash || settlement.rows?.[0]?.rowHash || 'unknown'
      };
    case 'wrong_pnl_arithmetic':
      return {
        rowId: options.rowId || settlement.rows?.[0]?.rowId || null,
        claimedTransferSats: options.claimedTransferSats || '0'
      };
    case 'wrong_final_recipient':
      return {
        claimedOutput: options.claimedOutput || settlement.routePlan?.outputPlan?.[0] || null
      };
    case 'wrong_state_oracle_hash':
      return {
        claimedStateOracleHash: options.claimedStateOracleHash || '00'.repeat(32)
      };
    case 'wrong_netting_edge':
    default:
      return {
        claimedFoldedEdge: options.claimedFoldedEdge || settlement.foldedEdges?.[0] || null
      };
  }
}

function verifyTradeLayerPnlNettingChallenge(challenge, settlement) {
  if (!challenge || challenge.kind !== 'tradelayer_pnl_netting_challenge') {
    return { ok: false, reason: 'wrong challenge kind' };
  }
  if (!CHALLENGE_TYPES.includes(challenge.challengeType)) {
    return { ok: false, reason: `unknown challenge type: ${challenge.challengeType}` };
  }
  const challengeHash = sha256Hex(challenge.core);
  if (challengeHash !== challenge.challengeHash) {
    return { ok: false, reason: 'challenge hash mismatch', challengeHash };
  }
  if (settlement && challenge.core?.settlementHash !== settlement.settlementHash) {
    return { ok: false, reason: 'settlement hash mismatch' };
  }
  return {
    ok: true,
    challengeHash,
    challengeable: challenge.challengeable,
    challengeType: challenge.challengeType
  };
}

function describeTradeLayerPnlNettingFlow(settlement) {
  return {
    flow: [
      'state_oracle_update',
      'bilateral_pnl_rows',
      'gross_loser_to_winner_edges',
      'netted_counterparty_graph',
      'utxoref_payout_root',
      'bitvm_referee_challenge'
    ],
    rows: settlement.core.rowCount,
    grossTransfers: settlement.core.grossTransferCount,
    foldedTransfers: settlement.core.foldedTransferCount,
    payouts: settlement.core.payoutCount,
    totalGrossTransferSats: settlement.core.totalGrossTransferSats,
    totalPositiveNetSats: settlement.core.totalPositiveNetSats,
    stateOracleHash: settlement.core.stateOracleHash,
    withdrawalRootHex: settlement.core.withdrawalRootHex
  };
}

module.exports = {
  CHALLENGE_TYPES,
  buildTradeLayerPnlStateOracleCommitment,
  deriveBilateralPnlRow,
  derivePnlRowsFromStateOracle,
  buildGrossPnlEdges,
  computeNetBalances,
  foldPnlNettingGraph,
  buildOutputPlanFromNetBalances,
  buildTradeLayerPnlNettingRoutePlan,
  buildTradeLayerPnlNettingSettlement,
  verifyTradeLayerPnlNettingSettlement,
  buildTradeLayerPnlNettingChallenge,
  verifyTradeLayerPnlNettingChallenge,
  describeTradeLayerPnlNettingFlow,
  stableStringify
};
