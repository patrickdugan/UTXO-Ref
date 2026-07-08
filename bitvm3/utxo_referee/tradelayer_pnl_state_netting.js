/**
 * TradeLayer state-oracle PNL netting for UTXORef.
 *
 * This module sits between a TradeLayer state oracle and the existing
 * UTXORef route adapter. It does not replay all TradeLayer consensus. It
 * assumes the oracle blob has already selected consensus-valid positions,
 * then deterministically recomputes bilateral PNL, folds the directed
 * loser->winner graph, and binds the final payable set into a UTXORef payout
 * commitment.
 */

const {
  stableStringify,
  sha256Hex,
  computeTradeLayerPlanHash,
  buildTradeLayerPnlCommitment,
  verifyTradeLayerPnlRoutePlan
} = require('./tradelayer_pnl_route_adapter');

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

  const result = {};
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
    epochId: stateOracleBlob.epochId ?? options.epochId ?? null,
    snapshotHeight: stateOracleBlob.snapshotHeight ?? null,
    snapshotTxid: stateOracleBlob.snapshotTxid || stateOracleBlob.revealTxid || null,
    oracleAddress: stateOracleBlob.oracleAddress || options.oracleAddress || null,
    marks: stateOracleBlob.marks || stateOracleBlob.mark || stateOracleBlob.close || null,
    liveAddresses: stateOracleBlob.liveAddresses || options.liveAddresses || null,
    settlementAddressMap: stateOracleBlob.settlementAddressMap || options.settlementAddressMap || null,
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
  return rawRows.map((row, index) => deriveBilateralPnlRow(row, stateOracleBlob, options, index));
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
  const entry = settlementAddressMap?.[accountAddress];
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

function verifyPositiveNetOutputs(netBalances, outputPlan) {
  const positives = netBalances
    .filter((row) => BigInt(row.netSats) > 0n)
    .map((row) => ({ address: row.address, sats: BigInt(row.netSats).toString() }))
    .sort((a, b) => a.address.localeCompare(b.address));
  const outputs = outputPlan
    .map((output) => ({
      accountAddress: output.accountAddress || output.address,
      sats: String(output.sats)
    }))
    .sort((a, b) => a.accountAddress.localeCompare(b.accountAddress));

  if (positives.length !== outputs.length) {
    return { ok: false, reason: `positive PNL output count mismatch: expected ${positives.length}, got ${outputs.length}` };
  }
  for (let i = 0; i < positives.length; i++) {
    if (positives[i].address !== outputs[i].accountAddress || positives[i].sats !== outputs[i].sats) {
      return {
        ok: false,
        reason: 'positive PNL output mismatch',
        expected: positives[i],
        actual: outputs[i]
      };
    }
  }
  return { ok: true };
}

function verifyTradeLayerPnlNettingSettlement(settlement, options = {}) {
  if (!settlement || settlement.kind !== 'tradelayer_pnl_netting_settlement') {
    return { ok: false, reason: 'wrong settlement kind' };
  }
  if (!settlement.core || typeof settlement.core !== 'object') {
    return { ok: false, reason: 'settlement core missing' };
  }

  const settlementHash = sha256Hex(settlement.core);
  if (settlementHash !== settlement.settlementHash) {
    return { ok: false, reason: 'settlement hash mismatch', settlementHash };
  }
  if (options.expectedStateOracleHash && options.expectedStateOracleHash !== settlement.core.stateOracleHash) {
    return { ok: false, reason: 'state oracle hash mismatch', expectedStateOracleHash: options.expectedStateOracleHash };
  }

  const checks = [
    ['pnlRowRoot', rootHex(settlement.rows || [])],
    ['grossEdgeRoot', rootHex(settlement.grossEdges || [])],
    ['netBalanceRoot', rootHex(settlement.netBalances || [])],
    ['foldedEdgeRoot', rootHex(settlement.foldedEdges || [])]
  ];
  for (const [field, recomputed] of checks) {
    if (settlement.core[field] !== recomputed) {
      return { ok: false, reason: `${field} mismatch`, recomputed };
    }
  }

  const recomputedNet = computeNetBalances(settlement.grossEdges || []);
  if (rootHex(recomputedNet) !== settlement.core.netBalanceRoot) {
    return { ok: false, reason: 'gross edge graph does not recompute the committed net balance root' };
  }
  const recomputedFolded = foldPnlNettingGraph(settlement.netBalances || []);
  if (rootHex(recomputedFolded) !== settlement.core.foldedEdgeRoot) {
    return { ok: false, reason: 'folded graph does not recompute from net balances' };
  }

  const outputCheck = verifyPositiveNetOutputs(settlement.netBalances || [], settlement.routePlan?.outputPlan || []);
  if (!outputCheck.ok) return outputCheck;

  const routePlanHash = computeTradeLayerPlanHash(settlement.routePlan);
  if (settlement.core.routePlanHash !== routePlanHash || settlement.routePlan.planHash !== routePlanHash) {
    return { ok: false, reason: 'route plan hash mismatch', routePlanHash };
  }

  const routeResult = verifyTradeLayerPnlRoutePlan(settlement.routePlan, {
    ...options,
    skipPlanHash: false
  });
  if (!routeResult.ok) return { ok: false, reason: `route plan failed: ${routeResult.reason}`, routeResult };

  if (settlement.core.withdrawalRootHex !== routeResult.withdrawalRootHex) {
    return { ok: false, reason: 'withdrawal root mismatch', withdrawalRootHex: routeResult.withdrawalRootHex };
  }
  if (settlement.core.commitmentHashHex !== routeResult.commitmentHashHex) {
    return { ok: false, reason: 'commitment hash mismatch', commitmentHashHex: routeResult.commitmentHashHex };
  }

  return {
    ok: true,
    settlementHash,
    stateOracleHash: settlement.core.stateOracleHash,
    rowCount: settlement.core.rowCount,
    totalPositiveNetSats: settlement.core.totalPositiveNetSats,
    routePlanHash
  };
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
