'use strict';

/**
 * Dependency-free reference relation for one atomic PnL settlement batch.
 *
 * An independently pinned snapshot supplies realized obligations, current
 * satoshi claims, payout instructions and eligible UTXOs. This module checks
 * accounting and finds an integral funding flow. It neither authenticates the
 * snapshot nor proves that a Bitcoin script permits the proposed transaction.
 * rBTC-to-satoshi conversion, pricing, liquidation and oracle authentication
 * belong upstream. A caller must atomically consume the snapshot/epoch and
 * outpoints, verify a current chain view, and enforce the exact spend before
 * releasing funds. Hash commitments below are not ZK proofs.
 *
 * Public inputs are copied as frozen plain data before any field is read.
 * The shared canonical boundary also limits inputs to 65,536 value nodes,
 * depth 64 and 16 MiB of string code units. Those limits can bind before the
 * per-list limits below, particularly for large generated batch witnesses.
 * Builders return deeply frozen plain data and apply the same canonical bound
 * to the expanded witness, so every returned batch fits its verifier boundary.
 */

const crypto = require('crypto');
const { snapshotPlainData } = require('./dlc_canonical_json');

const SNAPSHOT_KIND = 'tradelayer_pnl_batch_snapshot_v1';
const BATCH_KIND = 'tradelayer_pnl_settlement_batch_v1';
const STATEMENT_KIND = 'tradelayer_pnl_batch_statement_v1';
const MAX_SATS = (1n << 63n) - 1n;
const LIMITS = Object.freeze({ nettingSets: 128, vaults: 128, accounts: 2048,
  obligations: 10000, routes: 32768, utxos: 4096, consumed: 20000 });
const NETWORK_ASSETS = Object.freeze({
  'bitcoin': 'BTC', 'bitcoin-testnet': 'BTC', 'bitcoin-testnet4': 'BTC',
  'bitcoin-regtest': 'BTC', 'litecoin': 'LTC', 'litecoin-testnet': 'LTC'
});
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function fail(message, code = 'INVALID_SNAPSHOT', detail) {
  const error = new Error(message);
  error.code = code;
  if (detail) error.detail = detail;
  throw error;
}

function record(value, label, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(`${label} must be a plain object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} has unexpected field ${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${label}.${key} is required`);
  }
  return value;
}

function list(value, label, limit) {
  if (!Array.isArray(value) || value.length > limit) fail(`${label} must be an array of at most ${limit} entries`);
  return value;
}

function id(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,96}$/.test(value)) {
    fail(`${label} must be a nonempty ASCII identifier (maximum 96 characters)`);
  }
  return value;
}

function hex(value, bytes, label) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    fail(`${label} must be ${bytes} bytes of hexadecimal`);
  }
  return value.toLowerCase();
}

function script(value, label) {
  if (typeof value !== 'string' || !/^(?:[0-9a-fA-F]{2}){1,10000}$/.test(value)) {
    fail(`${label} must be 1..10000 bytes of hexadecimal script`);
  }
  return value.toLowerCase();
}

function uint(value, label, max = MAX_SATS) {
  let amount;
  if (typeof value === 'bigint') amount = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) amount = BigInt(value);
  else if (typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value)) amount = BigInt(value);
  else fail(`${label} must be an exact non-negative integer`);
  if (amount < 0n || amount > max) fail(`${label} is outside 0..${max}`);
  return amount;
}

function bounded(value, label) {
  if (value < -MAX_SATS || value > MAX_SATS) fail(`${label} exceeds the signed 63-bit amount bound`);
  return value;
}

function sum(values, label) {
  return values.reduce((total, value) => bounded(total + value, label), 0n);
}

function uniqueSorted(rows, key, label) {
  const sorted = rows.sort((a, b) => cmp(key(a), key(b)));
  for (let index = 1; index < sorted.length; index++) {
    if (key(sorted[index - 1]) === key(sorted[index])) fail(`${label} duplicates ${key(sorted[index])}`);
  }
  return sorted;
}

function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort(cmp).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  fail('non-canonical value in batch data', 'INVALID_BATCH');
}

function digest(domain, value) {
  return crypto.createHash('sha256').update(`${domain}\0`).update(canonical(value)).digest('hex');
}

function normalizeSnapshot(raw) {
  const topKeys = ['kind', 'network', 'epochId', 'previousStateRoot', 'nettingSets', 'vaults',
    'accounts', 'obligations', 'consumedObligationIds', 'spentOutpoints', 'routes'];
  record(raw, 'snapshot', topKeys);
  if (raw.kind !== SNAPSHOT_KIND) fail('wrong snapshot kind');
  if (typeof raw.network !== 'string' || !Object.prototype.hasOwnProperty.call(NETWORK_ASSETS, raw.network)) fail('unsupported settlement network');
  const network = raw.network;
  const normalizeDomain = (row, label) => {
    const nettingSetId = id(row.nettingSetId, `${label}.nettingSetId`);
    if (row.assetId !== NETWORK_ASSETS[network]) fail(`${label}.assetId must be the native settlement asset ${NETWORK_ASSETS[network]}`);
    if (row.unit !== 'satoshis') fail(`${label}.unit must be satoshis`);
    return { nettingSetId, assetId: row.assetId, unit: 'satoshis' };
  };
  const nettingSets = uniqueSorted(list(raw.nettingSets, 'nettingSets', LIMITS.nettingSets).map((row, index) => {
    const label = `nettingSets[${index}]`;
    record(row, label, ['id', 'assetId', 'unit']);
    const domain = normalizeDomain({ ...row, nettingSetId: row.id }, label);
    return { id: domain.nettingSetId, assetId: domain.assetId, unit: domain.unit };
  }), (row) => row.id, 'nettingSets');
  if (!nettingSets.length) fail('at least one netting set is required');
  const sets = new Map(nettingSets.map((row) => [row.id, row]));
  const assertSet = (row, label) => {
    if (!sets.has(row.nettingSetId)) fail(`${label} references an unknown netting set`);
  };
  const usedOutpoints = new Set();
  let inputCount = 0;
  const vaults = uniqueSorted(list(raw.vaults, 'vaults', LIMITS.vaults).map((row, index) => {
    const label = `vaults[${index}]`;
    record(row, label, ['id', 'nettingSetId', 'assetId', 'unit', 'changeScriptPubKey', 'feeSats', 'protectedSats', 'utxos']);
    const domain = normalizeDomain(row, label);
    assertSet(domain, label);
    const utxos = uniqueSorted(list(row.utxos, `${label}.utxos`, LIMITS.utxos).map((utxo, inputIndex) => {
      const inputLabel = `${label}.utxos[${inputIndex}]`;
      record(utxo, inputLabel, ['txid', 'vout', 'sats', 'scriptPubKey']);
      const txid = hex(utxo.txid, 32, `${inputLabel}.txid`);
      const vout = Number(uint(utxo.vout, `${inputLabel}.vout`, 0xffffffffn));
      const outpoint = `${txid}:${vout}`;
      if (usedOutpoints.has(outpoint)) fail(`duplicate funding outpoint ${outpoint}`);
      usedOutpoints.add(outpoint);
      if (++inputCount > LIMITS.utxos) fail(`batch exceeds ${LIMITS.utxos} funding inputs`);
      const sats = uint(utxo.sats, `${inputLabel}.sats`);
      if (sats === 0n) fail(`${inputLabel}.sats must be positive`);
      return { txid, vout, sats: sats.toString(), scriptPubKey: script(utxo.scriptPubKey, `${inputLabel}.scriptPubKey`) };
    }), (utxo) => `${utxo.txid}:${String(utxo.vout).padStart(10, '0')}`, `${label}.utxos`);
    return { id: id(row.id, `${label}.id`), ...domain,
      changeScriptPubKey: script(row.changeScriptPubKey, `${label}.changeScriptPubKey`),
      feeSats: uint(row.feeSats, `${label}.feeSats`).toString(),
      protectedSats: uint(row.protectedSats, `${label}.protectedSats`).toString(), utxos };
  }), (row) => row.id, 'vaults');
  const vaultMap = new Map(vaults.map((row) => [row.id, row]));
  const accounts = uniqueSorted(list(raw.accounts, 'accounts', LIMITS.accounts).map((row, index) => {
    const label = `accounts[${index}]`;
    const keys = ['id', 'nettingSetId', 'assetId', 'unit', 'vaultId', 'equitySats', 'lockedSats', 'payoutSats', 'payoutScriptPubKey'];
    record(row, label, keys, keys.filter((key) => key !== 'payoutScriptPubKey'));
    const domain = normalizeDomain(row, label);
    assertSet(domain, label);
    const vaultId = id(row.vaultId, `${label}.vaultId`);
    const vault = vaultMap.get(vaultId);
    if (!vault || vault.nettingSetId !== domain.nettingSetId) fail(`${label} has an unknown or cross-set vault`);
    const equity = uint(row.equitySats, `${label}.equitySats`);
    const locked = uint(row.lockedSats, `${label}.lockedSats`);
    const payout = uint(row.payoutSats, `${label}.payoutSats`);
    if (locked > equity) fail(`${label}.lockedSats exceeds initial equity`);
    const rawPayoutScript = Object.prototype.hasOwnProperty.call(row, 'payoutScriptPubKey')
      ? row.payoutScriptPubKey : null;
    const payoutScriptPubKey = rawPayoutScript === null
      ? null : script(rawPayoutScript, `${label}.payoutScriptPubKey`);
    if (payout > 0n && payoutScriptPubKey === null) fail(`${label} requires an explicit payoutScriptPubKey`);
    return { id: id(row.id, `${label}.id`), ...domain, vaultId, equitySats: equity.toString(),
      lockedSats: locked.toString(), payoutSats: payout.toString(), payoutScriptPubKey };
  }), (row) => row.id, 'accounts');
  const accountMap = new Map(accounts.map((row) => [row.id, row]));
  const consumedObligationIds = uniqueSorted(list(raw.consumedObligationIds, 'consumedObligationIds', LIMITS.consumed)
    .map((value) => id(value, 'consumed obligation id')), (value) => value, 'consumedObligationIds');
  const consumed = new Set(consumedObligationIds);
  const spentOutpoints = uniqueSorted(list(raw.spentOutpoints, 'spentOutpoints', LIMITS.consumed).map((value) => {
    if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}:(0|[1-9][0-9]{0,9})$/.test(value)) fail('invalid spent outpoint');
    const [txid, voutString] = value.split(':');
    const vout = uint(voutString, 'spent outpoint vout', 0xffffffffn);
    const normalized = `${txid.toLowerCase()}:${vout}`;
    if (usedOutpoints.has(normalized)) fail(`funding outpoint is already spent: ${normalized}`, 'REPLAY');
    return normalized;
  }), (value) => value, 'spentOutpoints');
  const obligations = uniqueSorted(list(raw.obligations, 'obligations', LIMITS.obligations).map((row, index) => {
    const label = `obligations[${index}]`;
    record(row, label, ['id', 'nettingSetId', 'assetId', 'unit', 'fromAccountId', 'toAccountId', 'sats']);
    const obligationId = id(row.id, `${label}.id`);
    if (consumed.has(obligationId)) fail(`obligation already consumed: ${obligationId}`, 'REPLAY');
    const domain = normalizeDomain(row, label);
    assertSet(domain, label);
    const fromAccountId = id(row.fromAccountId, `${label}.fromAccountId`);
    const toAccountId = id(row.toAccountId, `${label}.toAccountId`);
    if (fromAccountId === toAccountId) fail(`${label} is a self obligation`);
    for (const accountId of [fromAccountId, toAccountId]) {
      if (accountMap.get(accountId)?.nettingSetId !== domain.nettingSetId) fail(`${label} references an unknown or cross-set account`);
    }
    const sats = uint(row.sats, `${label}.sats`);
    if (sats === 0n) fail(`${label}.sats must be positive`);
    return { id: obligationId, ...domain, fromAccountId, toAccountId, sats: sats.toString() };
  }), (row) => row.id, 'obligations');
  const routes = uniqueSorted(list(raw.routes, 'routes', LIMITS.routes).map((row, index) => {
    const label = `routes[${index}]`;
    record(row, label, ['fromVaultId', 'toOutputId', 'capacitySats']);
    const fromVaultId = id(row.fromVaultId, `${label}.fromVaultId`);
    const from = vaultMap.get(fromVaultId);
    if (!from) fail(`${label} references an unknown source vault`);
    if (typeof row.toOutputId !== 'string' || !/^(vault|payout):[A-Za-z0-9_.-]{1,96}$/.test(row.toOutputId)) fail(`${label}.toOutputId is invalid`);
    const [type, destinationId] = row.toOutputId.split(':');
    const destination = type === 'vault' ? vaultMap.get(destinationId) : accountMap.get(destinationId);
    if (!destination || destination.nettingSetId !== from.nettingSetId) fail(`${label} references an unknown or cross-set destination`);
    if (row.toOutputId === `vault:${fromVaultId}`) fail(`${label} duplicates the implicit own-vault residual route`);
    const capacity = uint(row.capacitySats, `${label}.capacitySats`);
    if (capacity === 0n) fail(`${label}.capacitySats must be positive`);
    return { fromVaultId, toOutputId: row.toOutputId, capacitySats: capacity.toString() };
  }), (row) => `${row.fromVaultId}:${row.toOutputId}`, 'routes');
  return { kind: SNAPSHOT_KIND, network, epochId: uint(raw.epochId, 'epochId').toString(),
    previousStateRoot: hex(raw.previousStateRoot, 32, 'previousStateRoot'), nettingSets,
    vaults, accounts, obligations, consumedObligationIds, spentOutpoints, routes };
}

function hashPnlSettlementSnapshot(snapshot) {
  const plainSnapshot = snapshotPlainData(snapshot, '$.snapshot', true);
  return digest(SNAPSHOT_KIND, normalizeSnapshot(plainSnapshot));
}

/** Deterministic Edmonds-Karp flow; reverse edges repair greedy assignments. */
function fundOutputs(vaultStates, outputs, routes) {
  const nodes = ['source', ...vaultStates.map((vault) => `source:${vault.id}`),
    ...outputs.map((output) => `output:${output.id}`), 'sink'];
  const indexes = new Map(nodes.map((name, index) => [name, index]));
  const graph = nodes.map(() => []);
  const allocationEdges = [];
  function edge(fromName, toName, capacity, allocation) {
    const from = indexes.get(fromName);
    const to = indexes.get(toName);
    const forward = { to, rev: graph[to].length, remaining: capacity, capacity };
    const reverse = { to: from, rev: graph[from].length, remaining: 0n, capacity: 0n };
    graph[from].push(forward);
    graph[to].push(reverse);
    if (allocation) allocationEdges.push({ ...allocation, edge: forward });
  }
  for (const vault of vaultStates) edge('source', `source:${vault.id}`, BigInt(vault.availableSats));
  const demands = new Map(outputs.map((output) => [output.id, output]));
  const authorization = [...routes, ...vaultStates.map((vault) => ({
    fromVaultId: vault.id, toOutputId: `vault:${vault.id}`, capacitySats: vault.availableSats
  }))].sort((a, b) => cmp(`${a.fromVaultId}:${a.toOutputId}`, `${b.fromVaultId}:${b.toOutputId}`));
  for (const route of authorization) {
    if (!demands.has(route.toOutputId)) continue;
    edge(`source:${route.fromVaultId}`, `output:${route.toOutputId}`, BigInt(route.capacitySats),
      { fromVaultId: route.fromVaultId, toOutputId: route.toOutputId });
  }
  for (const output of outputs) edge(`output:${output.id}`, 'sink', BigInt(output.sats));
  const source = 0;
  const sink = nodes.length - 1;
  const required = sum(outputs.map((output) => BigInt(output.sats)), 'output total');
  let funded = 0n;
  while (funded < required) {
    const parents = Array(nodes.length).fill(null);
    parents[source] = { node: source, edgeIndex: -1 };
    const queue = [source];
    for (let cursor = 0; cursor < queue.length && !parents[sink]; cursor++) {
      const current = queue[cursor];
      for (let edgeIndex = 0; edgeIndex < graph[current].length; edgeIndex++) {
        const currentEdge = graph[current][edgeIndex];
        if (currentEdge.remaining > 0n && !parents[currentEdge.to]) {
          parents[currentEdge.to] = { node: current, edgeIndex };
          queue.push(currentEdge.to);
          if (currentEdge.to === sink) break;
        }
      }
    }
    if (!parents[sink]) {
      const reachable = parents.map((parent) => parent !== null);
      let cutCapacity = 0n;
      for (let from = 0; from < graph.length; from++) {
        if (!reachable[from]) continue;
        for (const currentEdge of graph[from]) {
          if (!reachable[currentEdge.to]) cutCapacity += currentEdge.capacity;
        }
      }
      fail('authorized funding graph cannot satisfy every payout and vault residual', 'FUNDING_CUT', {
        requiredSats: required.toString(), fundedSats: funded.toString(),
        shortfallSats: (required - funded).toString(), cutCapacitySats: cutCapacity.toString(),
        reachableVaultIds: vaultStates.filter((vault) => reachable[indexes.get(`source:${vault.id}`)]).map((vault) => vault.id),
        reachableOutputIds: outputs.filter((output) => reachable[indexes.get(`output:${output.id}`)]).map((output) => output.id)
      });
    }
    let increment = required - funded;
    for (let current = sink; current !== source;) {
      const parent = parents[current];
      const currentEdge = graph[parent.node][parent.edgeIndex];
      if (currentEdge.remaining < increment) increment = currentEdge.remaining;
      current = parent.node;
    }
    for (let current = sink; current !== source;) {
      const parent = parents[current];
      const currentEdge = graph[parent.node][parent.edgeIndex];
      currentEdge.remaining -= increment;
      graph[current][currentEdge.rev].remaining += increment;
      current = parent.node;
    }
    funded += increment;
  }
  return allocationEdges.filter((entry) => entry.edge.capacity > entry.edge.remaining).map((entry) => ({
    fromVaultId: entry.fromVaultId, toOutputId: entry.toOutputId,
    sats: (entry.edge.capacity - entry.edge.remaining).toString()
  }));
}

function buildFromNormalized(snapshot) {
  const snapshotHash = digest(SNAPSHOT_KIND, snapshot);
  const net = new Map(snapshot.accounts.map((account) => [account.id, 0n]));
  for (const obligation of snapshot.obligations) {
    const sats = BigInt(obligation.sats);
    net.set(obligation.fromAccountId, bounded(net.get(obligation.fromAccountId) - sats, 'account net debit'));
    net.set(obligation.toAccountId, bounded(net.get(obligation.toAccountId) + sats, 'account net credit'));
  }
  const accountStates = snapshot.accounts.map((account) => {
    const delta = net.get(account.id);
    const payout = BigInt(account.payoutSats);
    if (payout > (delta > 0n ? delta : 0n)) fail(`account ${account.id} payout exceeds its positive realized net PnL`, 'PAYOUT_EXCEEDS_PROFIT');
    const beforePayout = bounded(BigInt(account.equitySats) + delta, 'post-PnL equity');
    const after = bounded(beforePayout - payout, 'post-payout equity');
    if (after < BigInt(account.lockedSats)) fail(`account ${account.id} has insufficient equity after PnL and payout`, 'MARGIN_SHORTFALL');
    return { accountId: account.id, nettingSetId: account.nettingSetId, assetId: account.assetId,
      unit: account.unit, vaultId: account.vaultId, beforeEquitySats: account.equitySats,
      netPnlSats: delta.toString(), payoutSats: account.payoutSats,
      afterEquitySats: after.toString(), lockedSats: account.lockedSats,
      payoutScriptPubKey: account.payoutScriptPubKey };
  });
  const vaultStates = snapshot.vaults.map((vault) => {
    const claims = accountStates.filter((account) => account.vaultId === vault.id);
    const inputSats = sum(vault.utxos.map((utxo) => BigInt(utxo.sats)), `vault ${vault.id} input total`);
    const beforeClaims = sum(claims.map((account) => BigInt(account.beforeEquitySats)), 'pre-batch claims');
    const afterClaims = sum(claims.map((account) => BigInt(account.afterEquitySats)), 'post-batch claims');
    const protectedSats = BigInt(vault.protectedSats);
    const feeSats = BigInt(vault.feeSats);
    const requiredBefore = bounded(beforeClaims + protectedSats + feeSats, 'required initial backing');
    if (inputSats < requiredBefore) fail(`vault ${vault.id} cannot fund initial claims, protected reserve and fees`, 'INITIAL_RESERVE_SHORTFALL');
    const freeSurplus = inputSats - requiredBefore;
    const residual = bounded(afterClaims + protectedSats + freeSurplus, 'post-batch vault residual');
    return { id: vault.id, nettingSetId: vault.nettingSetId, assetId: vault.assetId, unit: vault.unit,
      inputSats: inputSats.toString(), feeSats: vault.feeSats,
      availableSats: (inputSats - feeSats).toString(), beforeClaimsSats: beforeClaims.toString(),
      afterClaimsSats: afterClaims.toString(), protectedSats: vault.protectedSats,
      freeSurplusSats: freeSurplus.toString(), residualSats: residual.toString(),
      changeScriptPubKey: vault.changeScriptPubKey };
  });
  const outputs = [...vaultStates.filter((vault) => BigInt(vault.residualSats) > 0n).map((vault) => ({
    id: `vault:${vault.id}`, kind: 'vault-residual', nettingSetId: vault.nettingSetId,
    assetId: vault.assetId, unit: vault.unit, scriptPubKey: vault.changeScriptPubKey, sats: vault.residualSats
  })), ...accountStates.filter((account) => BigInt(account.payoutSats) > 0n).map((account) => ({
    id: `payout:${account.accountId}`, kind: 'depositor-payout', nettingSetId: account.nettingSetId,
    assetId: account.assetId, unit: account.unit, scriptPubKey: account.payoutScriptPubKey, sats: account.payoutSats
  }))].sort((a, b) => cmp(a.id, b.id));
  const totalInputs = sum(vaultStates.map((vault) => BigInt(vault.inputSats)), 'batch input total');
  const totalFees = sum(vaultStates.map((vault) => BigInt(vault.feeSats)), 'batch fee total');
  const totalOutputs = sum(outputs.map((output) => BigInt(output.sats)), 'batch output total');
  if (totalInputs !== totalFees + totalOutputs) fail('input/output/fee conservation failed', 'CONSERVATION');
  const allocations = fundOutputs(vaultStates, outputs, snapshot.routes);
  const inputs = snapshot.vaults.flatMap((vault) => vault.utxos.map((utxo) => ({ vaultId: vault.id, ...utxo })))
    .sort((a, b) => cmp(`${a.txid}:${String(a.vout).padStart(10, '0')}`, `${b.txid}:${String(b.vout).padStart(10, '0')}`));
  if (inputs.length > 0 && outputs.length === 0) fail('an atomic spend proposal must have at least one output');
  const nextAccountingState = {
    network: snapshot.network, epochId: snapshot.epochId, previousStateRoot: snapshot.previousStateRoot,
    accounts: accountStates.map((account) => ({ accountId: account.accountId, nettingSetId: account.nettingSetId,
      assetId: account.assetId, unit: account.unit, vaultId: account.vaultId,
      equitySats: account.afterEquitySats, lockedSats: account.lockedSats })),
    vaults: vaultStates.map((vault) => ({ id: vault.id, residualSats: vault.residualSats,
      protectedSats: vault.protectedSats, freeSurplusSats: vault.freeSurplusSats,
      changeScriptPubKey: vault.changeScriptPubKey })),
    consumedObligationIds: [...snapshot.consumedObligationIds, ...snapshot.obligations.map((obligation) => obligation.id)].sort(cmp),
    spentOutpoints: [...snapshot.spentOutpoints, ...inputs.map((input) => `${input.txid}:${input.vout}`)].sort(cmp)
  };
  const transaction = { kind: inputs.length ? 'atomic-spend-proposal' : 'accounting-only',
    network: snapshot.network, inputs, outputs, feeSats: totalFees.toString() };
  const statement = { kind: STATEMENT_KIND, network: snapshot.network, epochId: snapshot.epochId,
    snapshotHash, previousStateRoot: snapshot.previousStateRoot,
    nextAccountingStateRoot: digest('utxoref-pnl-accounting-state-v1', nextAccountingState),
    obligationRoot: digest('utxoref-pnl-obligations-v1', snapshot.obligations),
    routePolicyRoot: digest('utxoref-pnl-route-policy-v1', snapshot.routes),
    inputRoot: digest('utxoref-pnl-inputs-v1', inputs),
    outputRoot: digest('utxoref-pnl-outputs-v1', outputs),
    transactionTemplateHash: digest('utxoref-pnl-atomic-transaction-v1', transaction),
    totalInputSats: totalInputs.toString(), totalOutputSats: totalOutputs.toString(), feeSats: totalFees.toString(),
    accountCount: accountStates.length, obligationCount: snapshot.obligations.length,
    inputCount: inputs.length, outputCount: outputs.length };
  const core = { kind: BATCH_KIND, snapshotHash, statement,
    statementHash: digest(STATEMENT_KIND, statement), accountStates, vaultStates,
    allocations, nextAccountingState, transaction,
    executionVerified: false, zkProofVerified: false };
  return snapshotPlainData({ ...core, batchHash: digest(BATCH_KIND, core) }, '$.batch', false);
}

function buildPnlSettlementBatch(snapshot) {
  const plainSnapshot = snapshotPlainData(snapshot, '$.snapshot', true);
  return buildFromNormalized(normalizeSnapshot(plainSnapshot));
}

function verifyPnlSettlementBatch(batch, context = {}) {
  try {
    const plainBatch = snapshotPlainData(batch, '$.batch', false);
    const plainContext = snapshotPlainData(context, '$.context', true);
    record(plainContext, 'verification context', ['snapshot', 'expectedSnapshotHash']);
    const expectedSnapshotHash = hex(plainContext.expectedSnapshotHash, 32, 'expectedSnapshotHash');
    const snapshot = normalizeSnapshot(plainContext.snapshot);
    const snapshotHash = digest(SNAPSHOT_KIND, snapshot);
    if (snapshotHash !== expectedSnapshotHash) fail('independent snapshot hash mismatch', 'SNAPSHOT_MISMATCH');
    const rebuilt = buildFromNormalized(snapshot);
    if (canonical(plainBatch) !== canonical(rebuilt)) fail('batch differs from independently rebuilt settlement', 'BATCH_MISMATCH');
    return { ok: true, snapshotHash, batchHash: rebuilt.batchHash, statement: rebuilt.statement,
      statementHash: rebuilt.statementHash, executionVerified: false, zkProofVerified: false };
  } catch (error) {
    return { ok: false, reason: error.message, code: error.code || 'INVALID_BATCH',
      ...(error.detail ? { detail: error.detail } : {}) };
  }
}

module.exports = { SNAPSHOT_KIND, BATCH_KIND, STATEMENT_KIND, MAX_SATS, LIMITS,
  hashPnlSettlementSnapshot, buildPnlSettlementBatch, verifyPnlSettlementBatch };
