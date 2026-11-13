#!/usr/bin/env node

const {
  REQUIRED_ROLES,
  REQUIRED_DRILLS,
  buildKeySeparationCeremony,
  buildOperationalDrillChecklist,
  buildBetaGatePackage
} = require('./tradelayer_beta_gate_package');
const {
  buildPnlSettlementBatch,
  hashPnlSettlementSnapshot
} = require('./tradelayer_pnl_batch_settlement');
const crypto = require('crypto');
const { buildSignedPnlBatchCheckpointV2, TRUST_POLICY_KIND } = require('./utxoref_v2_pnl_batch_checkpoint');
const { hashPnlBatchTransactionPolicy, POLICY_KIND } = require('./tradelayer_pnl_batch_transaction');
const { buildUtxoRefPnlBatchSettlementV2 } = require('./utxoref_v2_pnl_batch');

function authenticatedPnlFixture() {
  const snapshot = JSON.parse(JSON.stringify(require('./artifacts/fixtures/pnl_batch_settlement_v1.snapshot.json')));
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicDer = keys.publicKey.export({ format: 'der', type: 'spki' });
  const keyId = crypto.createHash('sha256').update(publicDer).digest('hex');
  const transactionPolicy = { kind: POLICY_KIND, network: snapshot.network, version: 2, locktime: 0,
    inputSequences: snapshot.vaults.flatMap((v) => v.utxos.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd }))) };
  const expectedTransactionPolicyHash = hashPnlBatchTransactionPolicy(transactionPolicy);
  const trustPolicy = { kind: TRUST_POLICY_KIND, version: 1, policyId: 'pnl-test', network: snapshot.network,
    chainGenesisHash: '11'.repeat(32), contractId: '22'.repeat(32), threshold: 1, maxAgeBlocks: 6,
    trustedSigners: [{ keyId, publicKeySpki: publicDer.toString('base64') }] };
  const stateVerification = { trustPolicy, expectedPreviousStateRoot: snapshot.previousStateRoot,
    expectedEpochId: snapshot.epochId, currentHeight: 100, expectedSnapshotBlockHash: '33'.repeat(32) };
  const stateEnvelope = buildSignedPnlBatchCheckpointV2({ policyId: trustPolicy.policyId,
    chainGenesisHash: trustPolicy.chainGenesisHash, contractId: trustPolicy.contractId,
    snapshotHeight: 100, snapshotBlockHash: stateVerification.expectedSnapshotBlockHash,
    transactionPolicyHash: expectedTransactionPolicyHash, snapshot },
  { privateKeys: [keys.privateKey.export({ format: 'pem', type: 'pkcs8' })] });
  const context = { stateVerification, transactionPolicy, expectedTransactionPolicyHash };
  const settlement = buildUtxoRefPnlBatchSettlementV2({ stateEnvelope, ...context });
  return { settlement, context, accountingContext: { snapshot, expectedSnapshotHash: hashPnlSettlementSnapshot(snapshot) } };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    failed += 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEq(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

function roleKeys() {
  const roles = {};
  REQUIRED_ROLES.forEach((role, index) => {
    roles[role] = {
      owner: `${role}-owner`,
      custody: `${role}-hsm-slot`,
      publicKey: `${(index + 2).toString(16).padStart(2, '0')}${String(index + 1).repeat(64)}`,
      rotation: 'quarterly',
      emergencyContact: `${role}@example.invalid`
    };
  });
  return roles;
}

function passedDrills() {
  return Object.fromEntries(REQUIRED_DRILLS.map((id) => [id, {
    status: 'passed',
    artifact: `artifacts/live/${id}.json`,
    notes: 'simulated beta gate rehearsal'
  }]));
}

function coreEvidence() {
  return {
    reserve: {
      confirmed: true,
      unspent: true,
      txid: '93f953df2c89faf386d14217fb4d3de62d91d3789fee83cc53acfd653882f6a6',
      confirmations: 22
    },
    relayRetrieval: {
      ok: true,
      relayBlobHash: 'dca8e7c5964dbf2ae902cc20b757d0400434a19a25c72da5dba5100a09491821',
      replicaCount: 2
    },
    tests: {
      fullSuitePassed: true,
      command: 'node bitvm3/utxo_referee/run_utxoref_all.js',
      suites: '73/73'
    }
  };
}

function fundedPnlFixture() {
  const domain = { nettingSetId: 's', assetId: 'BTC', unit: 'satoshis' };
  const snapshot = {
    kind: 'tradelayer_pnl_batch_snapshot_v1',
    network: 'bitcoin-regtest', epochId: '1', previousStateRoot: '00'.repeat(32),
    nettingSets: [{ id: 's', assetId: 'BTC', unit: 'satoshis' }],
    vaults: [{
      ...domain, id: 'v', changeScriptPubKey: '51', feeSats: '5', protectedSats: '0',
      utxos: [{ txid: '11'.repeat(32), vout: 0, sats: '105', scriptPubKey: '51' }]
    }],
    accounts: [
      { ...domain, id: 'loser', vaultId: 'v', equitySats: '100', lockedSats: '0', payoutSats: '0' },
      { ...domain, id: 'winner', vaultId: 'v', equitySats: '0', lockedSats: '0', payoutSats: '10', payoutScriptPubKey: '52' }
    ],
    obligations: [{ ...domain, id: 'o', fromAccountId: 'loser', toAccountId: 'winner', sats: '10' }],
    consumedObligationIds: [], spentOutpoints: [],
    routes: [{ fromVaultId: 'v', toOutputId: 'payout:winner', capacitySats: '10' }]
  };
  return {
    batch: buildPnlSettlementBatch(snapshot),
    context: { snapshot, expectedSnapshotHash: hashPnlSettlementSnapshot(snapshot) }
  };
}

console.log('\n=== TradeLayer Beta Gate Package Tests ===\n');

test('key separation ceremony passes only with distinct public keys', () => {
  const ceremony = buildKeySeparationCeremony({ roles: roleKeys(), createdAt: '2026-07-06T00:00:00.000Z' });
  assertEq(ceremony.ok, true, ceremony.errors.join('; '));
  assertEq(Object.keys(ceremony.roles).length, REQUIRED_ROLES.length);
});

test('key separation ceremony rejects duplicate role keys', () => {
  const roles = roleKeys();
  roles.challenger.publicKey = roles.stateOracle.publicKey;
  const ceremony = buildKeySeparationCeremony({ roles, createdAt: '2026-07-06T00:00:00.000Z' });
  assertEq(ceremony.ok, false);
  assert(ceremony.errors.some((e) => /duplicates/.test(e)), 'duplicate key error missing');
});

test('key separation ceremony rejects private key material', () => {
  const roles = roleKeys();
  roles.stateOracle.privateKeyHex = '11'.repeat(32);
  const ceremony = buildKeySeparationCeremony({ roles, createdAt: '2026-07-06T00:00:00.000Z' });
  assertEq(ceremony.ok, false);
  assert(ceremony.errors.some((e) => /private-key-like/.test(e)), 'private key error missing');
});

test('beta package remains limited testnet when non-core gates are missing', () => {
  const pkg = buildBetaGatePackage({
    createdAt: '2026-07-06T00:00:00.000Z',
    evidence: coreEvidence(),
    roles: {},
    drills: {},
    caps: {},
    externalReview: {}
  });

  assertEq(pkg.status, 'LIMITED_TESTNET_CONTINUE');
  assertEq(pkg.realMoneyAllowed, false);
  assert(pkg.nextRequiredActions.includes('separated_keys'));
  assert(pkg.nextRequiredActions.includes('operational_drills'));
  assert(pkg.nextRequiredActions.includes('loss_caps_defined'));
  assert(pkg.nextRequiredActions.includes('external_review_scope'));
  assert(pkg.nextRequiredActions.includes('pnl_batch_accounting'));
  assert(pkg.nextRequiredActions.includes('pnl_batch_spend_enforcement'));
});

test('legacy readiness evidence cannot bypass the new PNL gates', () => {
  const pkg = buildBetaGatePackage({
    createdAt: '2026-07-06T00:00:00.000Z',
    evidence: coreEvidence(),
    roles: roleKeys(),
    drills: passedDrills(),
    caps: {
      maxTotalLossSats: '100000',
      maxPerContractSats: '20000',
      pausePolicy: 'pause on any watchtower block-severity alert'
    },
    externalReview: {
      scopeDefined: true,
      reviewer: 'independent-reviewer-placeholder'
    }
  });

  assertEq(pkg.status, 'LIMITED_TESTNET_CONTINUE');
  assertEq(pkg.realMoneyAllowed, false);
  assertEq(pkg.nextRequiredActions.join(','), 'pnl_batch_accounting,pnl_batch_v2_binding,pnl_batch_spend_enforcement');
});

test('a verified funded batch passes accounting while spend enforcement stays pending', () => {
  const fixture = fundedPnlFixture();
  const pkg = buildBetaGatePackage({
    evidence: { ...coreEvidence(), pnlSettlement: { batch: fixture.batch } },
    pnlSettlementContext: fixture.context
  });
  const accounting = pkg.gates.find((g) => g.name === 'pnl_batch_accounting');
  assertEq(accounting.ok, true, accounting.reason);
  assertEq(accounting.zkProofVerified, false);
  assertEq(pkg.gates.find((g) => g.name === 'pnl_batch_spend_enforcement').ok, false);
  assertEq(pkg.realMoneyAllowed, false);
});

test('a receipt success flag cannot substitute for independently verified batch economics', () => {
  const pkg = buildBetaGatePackage({
    evidence: {
      ...coreEvidence(),
      pnlSettlement: { ok: true, executionVerified: true, zkProofVerified: true }
    }
  });
  assertEq(pkg.gates.find((g) => g.name === 'pnl_batch_accounting').ok, false);
  assertEq(pkg.gates.find((g) => g.name === 'pnl_batch_spend_enforcement').ok, false);
  assertEq(pkg.realMoneyAllowed, false);
});

test('a valid candidate still requires a separately supplied pinned snapshot', () => {
  const fixture = fundedPnlFixture();
  const pkg = buildBetaGatePackage({
    evidence: {
      ...coreEvidence(),
      pnlSettlement: { batch: fixture.batch, ...fixture.context, ok: true }
    }
  });
  assertEq(pkg.gates.find((g) => g.name === 'pnl_batch_accounting').ok, false);
  assertEq(pkg.realMoneyAllowed, false);
});

test('a changed destination fails the integrated gate', () => {
  const fixture = fundedPnlFixture();
  const changed = JSON.parse(JSON.stringify(fixture.context.snapshot));
  changed.accounts.find((a) => a.id === 'winner').payoutScriptPubKey = '53';
  const pkg = buildBetaGatePackage({
    evidence: { ...coreEvidence(), pnlSettlement: { batch: buildPnlSettlementBatch(changed) } },
    pnlSettlementContext: fixture.context
  });
  assertEq(pkg.gates.find((g) => g.name === 'pnl_batch_accounting').ok, false);
  assertEq(pkg.realMoneyAllowed, false);
});

test('authenticated V2 bytes must bind the same independently verified economic batch', () => {
  const fixture = authenticatedPnlFixture();
  const pkg = buildBetaGatePackage({ evidence: { ...coreEvidence(), pnlSettlement: {
    batch: fixture.settlement.batch, v2Settlement: fixture.settlement } },
  pnlSettlementContext: fixture.accountingContext, pnlBatchV2Context: fixture.context });
  assertEq(pkg.gates.find((g) => g.name === 'pnl_batch_v2_binding').ok, true);
  assertEq(pkg.gates.find((g) => g.name === 'pnl_batch_spend_enforcement').ok, false);
  assertEq(pkg.realMoneyAllowed, false);
});

test('V2 candidate cannot supply its own trust context inside evidence', () => {
  const fixture = authenticatedPnlFixture();
  const pkg = buildBetaGatePackage({ evidence: { ...coreEvidence(), pnlSettlement: {
    batch: fixture.settlement.batch, v2Settlement: fixture.settlement, ...fixture.context } },
  pnlSettlementContext: fixture.accountingContext });
  assertEq(pkg.gates.find((g) => g.name === 'pnl_batch_v2_binding').ok, false);
});

test('valid signed evidence for another batch cannot satisfy the V2 binding gate', () => {
  const fixture = authenticatedPnlFixture();
  const other = fundedPnlFixture();
  const pkg = buildBetaGatePackage({ evidence: { ...coreEvidence(), pnlSettlement: {
    batch: other.batch, v2Settlement: fixture.settlement } },
  pnlSettlementContext: other.context, pnlBatchV2Context: fixture.context });
  assertEq(pkg.gates.find((g) => g.name === 'pnl_batch_accounting').ok, true);
  assertEq(pkg.gates.find((g) => g.name === 'pnl_batch_v2_binding').ok, false);
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
