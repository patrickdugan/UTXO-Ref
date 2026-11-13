#!/usr/bin/env node
'use strict';

/**
 * Run: node bitvm3/utxo_referee/tradelayer_pnl_batch_demo.js
 *
 * Synthetic, offline accounting example. The transaction IDs and scripts in
 * this fixture identify invented inputs. The pinned hash below authenticates
 * this committed test vector only. It supplies no chain or oracle evidence.
 * This script reads one fixture and prints results; it makes no RPC or signer
 * calls and writes no files.
 */

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const {
  hashPnlSettlementSnapshot, buildPnlSettlementBatch, verifyPnlSettlementBatch
} = require('./tradelayer_pnl_batch_settlement');

const FIXTURE_PATH = path.join(__dirname, 'artifacts', 'fixtures', 'pnl_batch_settlement_v1.snapshot.json');
// Derived with hashPnlSettlementSnapshot from the exact synthetic fixture.
// Changes to the economic inputs require an explicit update of this test pin.
const EXPECTED_FIXTURE_SNAPSHOT_HASH = 'bc71ce13544ae91521c3cc1b4672bac699f025f73eaf219a34ad6220a19d73f2';

function runDemo() {
  const snapshot = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const computedSnapshotHash = hashPnlSettlementSnapshot(snapshot);
  assert.equal(computedSnapshotHash, EXPECTED_FIXTURE_SNAPSHOT_HASH, 'synthetic fixture hash changed');
  const batch = buildPnlSettlementBatch(snapshot);
  const verification = verifyPnlSettlementBatch(batch, {
    snapshot, expectedSnapshotHash: EXPECTED_FIXTURE_SNAPSHOT_HASH
  });
  assert.equal(verification.ok, true, verification.reason);
  const vaultA = batch.vaultStates.find((vault) => vault.id === 'A');
  const vaultB = batch.vaultStates.find((vault) => vault.id === 'B');
  const traderB = batch.accountStates.find((account) => account.accountId === 'trader-B');
  assert.equal(vaultA.residualSats, '99500');
  assert.equal(vaultB.residualSats, '110500');
  assert.equal(traderB.payoutSats, '4000');
  assert.equal(traderB.afterEquitySats, '106000');
  assert.equal(batch.statement.totalInputSats, '215000');
  assert.equal(batch.statement.totalOutputSats, '214000');
  assert.equal(batch.statement.feeSats, '1000');

  const deficient = JSON.parse(JSON.stringify(snapshot));
  deficient.routes = deficient.routes.filter((route) => !(route.fromVaultId === 'A' && route.toOutputId === 'vault:B'));
  let rejectedRoute;
  try {
    buildPnlSettlementBatch(deficient);
    throw new Error('missing retained-profit funding route was accepted');
  } catch (error) {
    assert.equal(error.code, 'FUNDING_CUT');
    assert.equal(error.detail.shortfallSats, '6000');
    assert.equal(error.detail.cutCapacitySats, error.detail.fundedSats);
    rejectedRoute = { removedRoute: 'A -> vault:B',
      mutationSnapshotHash: hashPnlSettlementSnapshot(deficient),
      rejected: true, code: error.code, reason: error.message, cut: error.detail };
  }

  const result = {
    kind: 'synthetic_pnl_batch_demo_v1',
    scope: 'Offline test vector with invented funding inputs; arithmetic and flow verification only',
    syntheticInputs: true,
    expectedFixtureSnapshotHash: EXPECTED_FIXTURE_SNAPSHOT_HASH,
    computedSnapshotHash,
    verification,
    economics: {
      totalInputSats: batch.statement.totalInputSats,
      totalOutputSats: batch.statement.totalOutputSats,
      feeSats: batch.statement.feeSats,
      winnerPayoutSats: traderB.payoutSats,
      winnerRetainedProfitSats: (BigInt(traderB.afterEquitySats) - BigInt(traderB.beforeEquitySats)).toString(),
      vaultResiduals: batch.vaultStates.map((vault) => ({ vaultId: vault.id, sats: vault.residualSats }))
    },
    accountStates: batch.accountStates,
    fundingAllocations: batch.allocations,
    statement: batch.statement,
    transaction: batch.transaction,
    deficientRouteExample: rejectedRoute,
    executionVerified: false,
    zkProofVerified: false
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  try { runDemo(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { runDemo, EXPECTED_FIXTURE_SNAPSHOT_HASH };
