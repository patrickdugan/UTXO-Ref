'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_SATS, hashPnlSettlementSnapshot, buildPnlSettlementBatch, verifyPnlSettlementBatch
} = require('./tradelayer_pnl_batch_settlement');

const domain = (nettingSetId = 's') => ({ nettingSetId, assetId: 'BTC', unit: 'satoshis' });
const copy = (value) => JSON.parse(JSON.stringify(value));

function vault(id, sats, ordinal, overrides = {}) {
  return { id, ...domain(), changeScriptPubKey: '51', feeSats: '0', protectedSats: '0',
    utxos: sats > 0 ? [{ txid: ordinal.toString(16).padStart(64, '0'), vout: 0,
      sats: String(sats), scriptPubKey: '51' }] : [], ...overrides };
}

function account(id, vaultId, equitySats, payoutSats = 0, overrides = {}) {
  return { id, ...domain(), vaultId, equitySats: String(equitySats), lockedSats: '0',
    payoutSats: String(payoutSats), ...(payoutSats > 0 ? { payoutScriptPubKey: '52' } : {}), ...overrides };
}

function obligation(id, fromAccountId, toAccountId, sats, overrides = {}) {
  return { id, ...domain(), fromAccountId, toAccountId, sats: String(sats), ...overrides };
}

function fixture() {
  return { kind: 'tradelayer_pnl_batch_snapshot_v1', network: 'bitcoin-regtest', epochId: '1',
    previousStateRoot: '00'.repeat(32), nettingSets: [{ id: 's', assetId: 'BTC', unit: 'satoshis' }],
    vaults: [vault('v', 105, 1, { feeSats: '5' })],
    accounts: [account('loser', 'v', 100), account('winner', 'v', 0, 10)],
    obligations: [obligation('o', 'loser', 'winner', 10)], consumedObligationIds: [], spentOutpoints: [],
    routes: [{ fromVaultId: 'v', toOutputId: 'payout:winner', capacitySats: '10' }] };
}

function verify(batch, snapshot) {
  return verifyPnlSettlementBatch(batch, { snapshot, expectedSnapshotHash: hashPnlSettlementSnapshot(snapshot) });
}

function flowFixture() {
  return { ...fixture(), vaults: [vault('A', 10, 1), vault('B', 10, 2)],
    accounts: [account('debtorA', 'A', 10), account('debtorB', 'B', 10),
      account('X', 'A', 0, 10), account('Y', 'B', 0, 10)],
    obligations: [obligation('o1', 'debtorA', 'X', 10), obligation('o2', 'debtorB', 'Y', 10)],
    routes: [{ fromVaultId: 'A', toOutputId: 'payout:X', capacitySats: '10' },
      { fromVaultId: 'A', toOutputId: 'payout:Y', capacitySats: '10' },
      { fromVaultId: 'B', toOutputId: 'payout:X', capacitySats: '10' }] };
}

test('binds exact payout, entire funding inputs, residual and fee to a pinned snapshot', () => {
  const snapshot = fixture();
  const batch = buildPnlSettlementBatch(snapshot);
  assert.equal(verify(batch, snapshot).ok, true);
  assert.equal(batch.statement.totalInputSats, '105');
  assert.equal(batch.statement.totalOutputSats, '100');
  assert.equal(batch.transaction.feeSats, '5');
  assert.deepEqual(batch.transaction.outputs.map(({ id, sats }) => ({ id, sats })),
    [{ id: 'payout:winner', sats: '10' }, { id: 'vault:v', sats: '90' }]);
  assert.equal(batch.executionVerified, false);
  assert.equal(batch.zkProofVerified, false);
  assert.equal(batch.transaction.kind, 'atomic-spend-proposal');
  assert.deepEqual(batch.nextAccountingState.consumedObligationIds, ['o']);
  assert.deepEqual(batch.nextAccountingState.spentOutpoints, [`${'0'.repeat(63)}1:0`]);
});

test('requires independently supplied snapshot and hash; candidate booleans cannot authorize', () => {
  const snapshot = fixture();
  const batch = buildPnlSettlementBatch(snapshot);
  assert.equal(verifyPnlSettlementBatch(batch).ok, false);
  assert.equal(verifyPnlSettlementBatch(batch, { snapshot }).ok, false);
  assert.equal(verifyPnlSettlementBatch(batch, { snapshot, expectedSnapshotHash: 'ff'.repeat(32) }).ok, false);
  assert.equal(verify({ ...batch, executionVerified: true }, snapshot).ok, false);
  assert.equal(verify({ ...batch, zkProofVerified: true }, snapshot).ok, false);
});

test('reverse residual edges repair the greedy A-to-X allocation', () => {
  const snapshot = flowFixture();
  const batch = buildPnlSettlementBatch(snapshot);
  assert.equal(verify(batch, snapshot).ok, true);
  assert.deepEqual(batch.allocations, [
    { fromVaultId: 'A', toOutputId: 'payout:Y', sats: '10' },
    { fromVaultId: 'B', toOutputId: 'payout:X', sats: '10' }
  ]);
});

test('total reserve sufficiency cannot bypass an unreachable claimant min-cut', () => {
  const snapshot = flowFixture();
  snapshot.routes = snapshot.routes.filter((route) => route.toOutputId !== 'payout:Y');
  assert.throws(() => buildPnlSettlementBatch(snapshot), (error) => {
    assert.equal(error.code, 'FUNDING_CUT');
    assert.equal(error.detail.requiredSats, '20');
    assert.equal(error.detail.shortfallSats, '10');
    assert.equal(error.detail.cutCapacitySats, error.detail.fundedSats);
    assert.equal(error.detail.fundedSats, '10');
    return true;
  });
});

test('retaining a winner claim requires funding its vault residual', () => {
  const snapshot = { ...fixture(), vaults: [vault('debtorVault', 100, 1), vault('winnerVault', 0, 2)],
    accounts: [account('loser', 'debtorVault', 100), account('winner', 'winnerVault', 0)], routes: [] };
  assert.throws(() => buildPnlSettlementBatch(snapshot), (error) => error.code === 'FUNDING_CUT');
  snapshot.routes.push({ fromVaultId: 'debtorVault', toOutputId: 'vault:winnerVault', capacitySats: '10' });
  const batch = buildPnlSettlementBatch(snapshot);
  assert.equal(verify(batch, snapshot).ok, true);
  assert.deepEqual(batch.transaction.outputs.map((output) => output.sats), ['90', '10']);
  assert.equal(batch.accountStates.find((row) => row.accountId === 'winner').afterEquitySats, '10');
});

test('permits partial profit withdrawal while retaining the rest once', () => {
  const snapshot = fixture();
  snapshot.accounts[1].payoutSats = '4';
  const batch = buildPnlSettlementBatch(snapshot);
  const winner = batch.accountStates.find((row) => row.accountId === 'winner');
  assert.equal(winner.afterEquitySats, '6');
  assert.equal(batch.vaultStates[0].residualSats, '96');
  assert.equal(batch.transaction.outputs.find((row) => row.id === 'payout:winner').sats, '4');
});

test('rejects borrowing from depositor principal to pay an overdrawn loser', () => {
  const snapshot = fixture();
  snapshot.accounts[0].equitySats = '9';
  assert.throws(() => buildPnlSettlementBatch(snapshot), (error) => error.code === 'MARGIN_SHORTFALL');
});

test('enforces retained locked margin after applying losses', () => {
  const snapshot = fixture();
  snapshot.accounts[0].lockedSats = '95';
  assert.throws(() => buildPnlSettlementBatch(snapshot), (error) => error.code === 'MARGIN_SHORTFALL');
});

test('permits margin exactly at the post-batch balance', () => {
  const snapshot = fixture();
  snapshot.accounts[0].lockedSats = '90';
  assert.equal(verify(buildPnlSettlementBatch(snapshot), snapshot).ok, true);
});

test('limits this batch relation to withdrawals from positive realized net profit', () => {
  const snapshot = fixture();
  snapshot.accounts[1].payoutSats = '11';
  assert.throws(() => buildPnlSettlementBatch(snapshot), (error) => error.code === 'PAYOUT_EXCEEDS_PROFIT');
  snapshot.accounts[1].payoutSats = '10';
  snapshot.accounts[0].payoutSats = '1';
  snapshot.accounts[0].payoutScriptPubKey = '51';
  assert.throws(() => buildPnlSettlementBatch(snapshot), (error) => error.code === 'PAYOUT_EXCEEDS_PROFIT');
});

test('protects reserve slack and senior claims while funding authorized fees', () => {
  const snapshot = fixture();
  snapshot.vaults[0].utxos[0].sats = '125';
  snapshot.vaults[0].protectedSats = '10';
  const batch = buildPnlSettlementBatch(snapshot);
  assert.equal(batch.vaultStates[0].residualSats, '110');
  assert.equal(batch.vaultStates[0].freeSurplusSats, '10');
  assert.equal(batch.vaultStates[0].protectedSats, '10');
  snapshot.vaults[0].utxos[0].sats = '110';
  assert.throws(() => buildPnlSettlementBatch(snapshot), (error) => error.code === 'INITIAL_RESERVE_SHORTFALL');
});

test('rejects fee budgets taken from account equity without reserve surplus', () => {
  const snapshot = fixture();
  snapshot.vaults[0].utxos[0].sats = '100';
  assert.throws(() => buildPnlSettlementBatch(snapshot), (error) => error.code === 'INITIAL_RESERVE_SHORTFALL');
});

test('rejects duplicate obligations, accounts, netting sets, routes and funding outpoints', () => {
  for (const field of ['obligations', 'accounts', 'nettingSets', 'routes']) {
    const snapshot = fixture();
    snapshot[field].push(copy(snapshot[field][0]));
    assert.throws(() => buildPnlSettlementBatch(snapshot), /duplicate/);
  }
  const snapshot = fixture();
  snapshot.vaults.push({ ...copy(snapshot.vaults[0]), id: 'other' });
  assert.throws(() => buildPnlSettlementBatch(snapshot), /duplicate funding outpoint/);
});

test('rejects consumed obligations and already-spent outpoints', () => {
  const snapshot = fixture();
  snapshot.consumedObligationIds.push('o');
  assert.throws(() => buildPnlSettlementBatch(snapshot), (error) => error.code === 'REPLAY');
  snapshot.consumedObligationIds = [];
  snapshot.spentOutpoints.push(`${snapshot.vaults[0].utxos[0].txid}:0`);
  assert.throws(() => buildPnlSettlementBatch(snapshot), (error) => error.code === 'REPLAY');
});

test('binds the network, epoch and prior state root', () => {
  const snapshot = fixture();
  const batch = buildPnlSettlementBatch(snapshot);
  for (const [field, replacement] of [['network', 'bitcoin-testnet4'], ['epochId', '2'], ['previousStateRoot', '11'.repeat(32)]]) {
    const different = { ...snapshot, [field]: replacement };
    assert.equal(verify(batch, different).ok, false);
  }
});

test('rejects cross-netting-set obligations, routes and vault ownership', () => {
  const snapshot = flowFixture();
  snapshot.nettingSets.push({ id: 's2', assetId: 'BTC', unit: 'satoshis' });
  snapshot.vaults[1].nettingSetId = 's2';
  snapshot.accounts.filter((row) => row.vaultId === 'B').forEach((row) => { row.nettingSetId = 's2'; });
  snapshot.obligations[1].nettingSetId = 's2';
  assert.throws(() => buildPnlSettlementBatch(snapshot), /cross-set destination/);
  snapshot.routes = [];
  snapshot.obligations[0].toAccountId = 'Y';
  assert.throws(() => buildPnlSettlementBatch(snapshot), /cross-set account/);
  snapshot.obligations[0].toAccountId = 'X';
  snapshot.accounts[0].vaultId = 'B';
  assert.throws(() => buildPnlSettlementBatch(snapshot), /cross-set vault/);
});

test('rejects asset and token-unit substitution', () => {
  const snapshot = fixture();
  snapshot.accounts[0].assetId = 'rBTC';
  assert.throws(() => buildPnlSettlementBatch(snapshot), /native settlement asset/);
  snapshot.accounts[0].assetId = 'BTC';
  snapshot.accounts[0].unit = 'rBTC';
  assert.throws(() => buildPnlSettlementBatch(snapshot), /unit must be satoshis/);
});

test('canonicalizes order and exact input integer representations', () => {
  const snapshot = flowFixture();
  const permuted = copy(snapshot);
  for (const field of ['vaults', 'accounts', 'obligations', 'routes']) permuted[field].reverse();
  permuted.epochId = 1;
  permuted.accounts[0].equitySats = Number(permuted.accounts[0].equitySats);
  assert.equal(hashPnlSettlementSnapshot(snapshot), hashPnlSettlementSnapshot(permuted));
  assert.deepEqual(buildPnlSettlementBatch(snapshot), buildPnlSettlementBatch(permuted));
});

test('keeps fractional, negative, noncanonical and unsafe amounts out of the relation', () => {
  for (const value of ['-1', '1.5', '01', Number.MAX_SAFE_INTEGER + 1, (MAX_SATS + 1n).toString(), true]) {
    const snapshot = fixture();
    snapshot.obligations[0].sats = value;
    assert.throws(() => buildPnlSettlementBatch(snapshot), /integer|outside/);
  }
});

test('checks aggregate overflow even when each input is in range', () => {
  const snapshot = fixture();
  snapshot.vaults[0].utxos[0].sats = MAX_SATS.toString();
  snapshot.vaults[0].utxos.push({ txid: '22'.repeat(32), vout: 0, sats: '1', scriptPubKey: '51' });
  assert.throws(() => buildPnlSettlementBatch(snapshot), /amount bound/);
});

test('rejects uncommitted beneficiary guesses and script mutation', () => {
  const snapshot = fixture();
  delete snapshot.accounts[1].payoutScriptPubKey;
  assert.throws(() => buildPnlSettlementBatch(snapshot), /explicit payoutScriptPubKey/);
  snapshot.accounts[1].payoutScriptPubKey = '52';
  const batch = buildPnlSettlementBatch(snapshot);
  const tampered = copy(batch);
  tampered.transaction.outputs[0].scriptPubKey = '53';
  assert.equal(verify(tampered, snapshot).ok, false);
  const rerouted = copy(snapshot);
  rerouted.accounts[1].payoutScriptPubKey = '53';
  assert.equal(verify(buildPnlSettlementBatch(rerouted), snapshot).ok, false);
});

test('rejects a fully rebuilt self-consistent forged source even with new candidate hashes', () => {
  const snapshot = fixture();
  const forged = copy(snapshot);
  forged.obligations[0].sats = '11';
  forged.accounts[1].payoutSats = '11';
  forged.routes[0].capacitySats = '11';
  const candidate = buildPnlSettlementBatch(forged);
  assert.equal(verify(candidate, snapshot).ok, false);
  assert.equal(verifyPnlSettlementBatch(candidate, { snapshot: forged,
    expectedSnapshotHash: hashPnlSettlementSnapshot(snapshot) }).ok, false);
});

test('rejects all field tampering including extra candidate and snapshot fields', () => {
  const snapshot = fixture();
  const batch = buildPnlSettlementBatch(snapshot);
  for (const altered of [
    { ...batch, ignoredProof: { valid: true } },
    { ...batch, batchHash: '11'.repeat(32) },
    { ...batch, accountStates: [] },
    { ...batch, allocations: [] },
    { ...batch, statement: { ...batch.statement, feeSats: '0' } }
  ]) assert.equal(verify(altered, snapshot).ok, false);
  snapshot.proofVerified = true;
  assert.throws(() => buildPnlSettlementBatch(snapshot), /unexpected field/);
});

test('rejects undefined, null, malformed and oversized structures without throwing from verifier', () => {
  const snapshot = fixture();
  for (const batch of [undefined, null, {}, [], { kind: 'wrong' }]) assert.equal(verify(batch, snapshot).ok, false);
  snapshot.vaults[0].utxos[0].vout = -1;
  assert.equal(verifyPnlSettlementBatch({}, { snapshot, expectedSnapshotHash: '00'.repeat(32) }).ok, false);
  const tooMany = fixture();
  tooMany.accounts = Array(2049).fill(tooMany.accounts[0]);
  assert.throws(() => buildPnlSettlementBatch(tooMany), /at most 2048/);
  const wrongNetwork = fixture();
  wrongNetwork.network = ['bitcoin-regtest'];
  assert.throws(() => buildPnlSettlementBatch(wrongNetwork), /unsupported/);
});

test('clears a pure zero-capital cycle as an accounting-only transition', () => {
  const snapshot = { ...fixture(), vaults: [vault('v', 0, 1)],
    accounts: [account('A', 'v', 0), account('B', 'v', 0), account('C', 'v', 0)],
    obligations: [obligation('ab', 'A', 'B', 10), obligation('bc', 'B', 'C', 10), obligation('ca', 'C', 'A', 10)], routes: [] };
  const batch = buildPnlSettlementBatch(snapshot);
  assert.equal(batch.transaction.kind, 'accounting-only');
  assert.deepEqual(batch.transaction.inputs, []);
  assert.deepEqual(batch.transaction.outputs, []);
  assert.equal(verify(batch, snapshot).ok, true);
  assert(batch.accountStates.every((row) => row.netPnlSats === '0'));
  assert.equal(batch.zkProofVerified, false);
});

test('a zero-input accounting cycle cannot mint a retained vault claim', () => {
  const snapshot = { ...fixture(), vaults: [vault('v', 0, 1)],
    accounts: [account('A', 'v', 0), account('B', 'v', 0)],
    obligations: [obligation('ab', 'A', 'B', 10)], routes: [] };
  assert.throws(() => buildPnlSettlementBatch(snapshot), (error) => error.code === 'MARGIN_SHORTFALL');
});

test('requires at least one output for an input-consuming transaction proposal', () => {
  const snapshot = { ...fixture(), vaults: [vault('v', 5, 1, { feeSats: '5' })],
    accounts: [], obligations: [], routes: [] };
  assert.throws(() => buildPnlSettlementBatch(snapshot), /at least one output/);
});

test('matches exhaustive integer allocation feasibility across all tiny 2-by-2 capacity graphs', () => {
  let cases = 0;
  for (let aa = 0; aa <= 2; aa++) for (let ab = 0; ab <= 2; ab++) {
    for (let ba = 0; ba <= 2; ba++) for (let bb = 0; bb <= 2; bb++) {
      // Supply A=2,B=2; demand X=2,Y=2. Exhaustively try A->X;
      // conservation determines every other edge without using the solver.
      const feasible = [0, 1, 2].some((ax) => ax <= aa && 2 - ax <= ab && 2 - ax <= ba && ax <= bb);
      const snapshot = flowFixture();
      snapshot.vaults.forEach((row) => { row.utxos[0].sats = '2'; });
      snapshot.accounts.forEach((row) => { row.equitySats = row.equitySats === '10' ? '2' : '0'; row.payoutSats = row.payoutSats === '10' ? '2' : '0'; });
      snapshot.obligations.forEach((row) => { row.sats = '2'; });
      snapshot.routes = [['A', 'X', aa], ['A', 'Y', ab], ['B', 'X', ba], ['B', 'Y', bb]]
        .filter(([, , capacity]) => capacity > 0)
        .map(([fromVaultId, target, capacity]) => ({ fromVaultId, toOutputId: `payout:${target}`, capacitySats: String(capacity) }));
      let accepted = true;
      try {
        const batch = buildPnlSettlementBatch(snapshot);
        assert.equal(verify(batch, snapshot).ok, true);
        assert.equal(batch.allocations.reduce((total, row) => total + BigInt(row.sats), 0n), 4n);
      } catch (error) {
        accepted = false;
        assert.equal(error.code, 'FUNDING_CUT');
        assert.equal(error.detail.cutCapacitySats, error.detail.fundedSats);
      }
      assert.equal(accepted, feasible, `capacities ${aa},${ab},${ba},${bb}`);
      cases++;
    }
  }
  assert.equal(cases, 81);
});

test('preserves the committed fixture digest and accepts exact BigInt snapshot amounts', () => {
  const committed = require('./artifacts/fixtures/pnl_batch_settlement_v1.snapshot.json');
  assert.equal(hashPnlSettlementSnapshot(committed), 'bc71ce13544ae91521c3cc1b4672bac699f025f73eaf219a34ad6220a19d73f2');
  const snapshot = fixture();
  const originalHash = hashPnlSettlementSnapshot(snapshot);
  snapshot.epochId = 1n;
  snapshot.vaults[0].utxos[0].sats = 105n;
  snapshot.vaults[0].feeSats = 5n;
  snapshot.accounts[0].equitySats = 100n;
  snapshot.obligations[0].sats = 10n;
  assert.equal(hashPnlSettlementSnapshot(snapshot), originalHash);
  const batch = buildPnlSettlementBatch(snapshot);
  assert.equal(verifyPnlSettlementBatch(batch, { snapshot, expectedSnapshotHash: originalHash }).ok, true);
  const candidate = copy(batch);
  candidate.statement.feeSats = 5n;
  assert.equal(verifyPnlSettlementBatch(candidate, { snapshot, expectedSnapshotHash: originalHash }).ok, false);
});

test('builder returns a deeply frozen plain-data batch', () => {
  const batch = buildPnlSettlementBatch(fixture());
  assert(Object.isFrozen(batch));
  assert(Object.isFrozen(batch.statement));
  assert(Object.isFrozen(batch.transaction.outputs));
  assert(Object.isFrozen(batch.transaction.outputs[0]));
  assert.throws(() => { batch.transaction.outputs[0].sats = '0'; }, TypeError);
});

test('rejects snapshot and context accessors without invoking their getters', () => {
  let sideEffects = 0;
  const snapshot = fixture();
  Object.defineProperty(snapshot.obligations[0], 'sats', {
    enumerable: true, configurable: true, get() { sideEffects++; return '10'; }
  });
  assert.throws(() => hashPnlSettlementSnapshot(snapshot), /data property/);
  assert.throws(() => buildPnlSettlementBatch(snapshot), /data property/);
  const trusted = fixture();
  const batch = buildPnlSettlementBatch(trusted);
  assert.equal(verifyPnlSettlementBatch(batch, { snapshot, expectedSnapshotHash: hashPnlSettlementSnapshot(trusted) }).ok, false);
  const context = { snapshot: trusted };
  Object.defineProperty(context, 'expectedSnapshotHash', {
    enumerable: true, get() { sideEffects++; return hashPnlSettlementSnapshot(trusted); }
  });
  assert.equal(verifyPnlSettlementBatch(batch, context).ok, false);
  assert.equal(sideEffects, 0);
});

test('rejects a getter on a candidate economic field without invoking it', () => {
  let sideEffects = 0;
  const snapshot = fixture();
  const candidate = copy(buildPnlSettlementBatch(snapshot));
  Object.defineProperty(candidate.transaction.outputs[0], 'sats', {
    enumerable: true, configurable: true, get() { sideEffects++; return '10'; }
  });
  const result = verify(candidate, snapshot);
  assert.equal(result.ok, false);
  assert.match(result.reason, /data property/);
  assert.equal(sideEffects, 0);
});

test('rejects top-level and nested Proxies before invoking any trap', () => {
  let sideEffects = 0;
  const traps = Object.fromEntries(['get', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'].map((name) => [name, () => {
    sideEffects++;
    throw new Error(`unexpected ${name} trap`);
  }]));
  const snapshot = fixture();
  const expectedSnapshotHash = hashPnlSettlementSnapshot(snapshot);
  const batch = buildPnlSettlementBatch(snapshot);
  const proxySnapshot = new Proxy(snapshot, traps);
  assert.throws(() => hashPnlSettlementSnapshot(proxySnapshot), /Proxy/);
  assert.throws(() => buildPnlSettlementBatch(proxySnapshot), /Proxy/);
  assert.equal(verifyPnlSettlementBatch(new Proxy(batch, traps), { snapshot, expectedSnapshotHash }).ok, false);
  assert.equal(verifyPnlSettlementBatch(batch, new Proxy({ snapshot, expectedSnapshotHash }, traps)).ok, false);
  const nested = fixture();
  nested.obligations[0] = new Proxy(nested.obligations[0], traps);
  assert.equal(verifyPnlSettlementBatch(batch, { snapshot: nested, expectedSnapshotHash }).ok, false);
  assert.equal(sideEffects, 0);
});

test('rejects own toJSON hooks and custom inherited hooks without executing them', () => {
  let sideEffects = 0;
  const hook = () => { sideEffects++; return fixture(); };
  const snapshot = fixture();
  snapshot.toJSON = hook;
  assert.throws(() => hashPnlSettlementSnapshot(snapshot), /unsupported data/);
  assert.throws(() => buildPnlSettlementBatch(snapshot), /unsupported data/);
  const trusted = fixture();
  const batch = buildPnlSettlementBatch(trusted);
  const candidate = copy(batch);
  candidate.toJSON = hook;
  assert.equal(verify(candidate, trusted).ok, false);
  const customPrototype = Object.create({ toJSON: hook });
  Object.assign(customPrototype, trusted);
  assert.throws(() => buildPnlSettlementBatch(customPrototype), /plain objects/);
  assert.equal(sideEffects, 0);
});

test('ignores ambient inherited toJSON and optional-field getters without invoking them', () => {
  let sideEffects = 0;
  const snapshot = fixture();
  const expectedSnapshotHash = hashPnlSettlementSnapshot(snapshot);
  const originalToJson = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const originalPayout = Object.getOwnPropertyDescriptor(Object.prototype, 'payoutScriptPubKey');
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true, value() { sideEffects++; return { rewritten: true }; }
    });
    Object.defineProperty(Object.prototype, 'payoutScriptPubKey', {
      configurable: true, get() { sideEffects++; return '53'; }
    });
    assert.equal(hashPnlSettlementSnapshot(snapshot), expectedSnapshotHash);
    const batch = buildPnlSettlementBatch(snapshot);
    assert.equal(verifyPnlSettlementBatch(batch, { snapshot, expectedSnapshotHash }).ok, true);
    assert.equal(sideEffects, 0);
  } finally {
    if (originalToJson) Object.defineProperty(Object.prototype, 'toJSON', originalToJson);
    else delete Object.prototype.toJSON;
    if (originalPayout) Object.defineProperty(Object.prototype, 'payoutScriptPubKey', originalPayout);
    else delete Object.prototype.payoutScriptPubKey;
  }
});

test('rejects a snapshot whose expanded witness exceeds the shared canonical boundary', () => {
  const snapshot = fixture();
  snapshot.accounts = Array.from({ length: 2048 }, (_, index) => account(`a${index}`, 'v', 0));
  snapshot.obligations = [];
  snapshot.routes = [];
  snapshot.consumedObligationIds = Array.from({ length: 20000 }, (_, index) => `prior-${index}`);
  snapshot.spentOutpoints = Array.from({ length: 10000 }, (_, index) => `${'ff'.repeat(32)}:${index}`);
  // The source fits its own per-list and plain-data limits; expansion repeats
  // account rows in accountStates and nextAccountingState and must also fit.
  assert.equal(hashPnlSettlementSnapshot(snapshot).length, 64);
  assert.throws(() => buildPnlSettlementBatch(snapshot), /canonical data exceeds 65536 nodes/);
});
