/**
 * Run: node bitvm3/utxo_referee/taproot_reserve_vault.test.js
 */

const {
  addressToScriptPubKey
} = require('./tradelayer_pnl_route_adapter');
const {
  buildTradeLayerWithdrawalQueue
} = require('./tradelayer_withdrawal_queue_referee');
const {
  buildTradeLayerReserveReconciliation,
  verifyTradeLayerReserveReconciliation
} = require('./tradelayer_reserve_reconciliation_referee');
const tr = require('./tradelayer_taproot');
const ts = require('./tradelayer_taproot_script');
const a = require('./tradelayer_dlc_adaptor_sig');
const {
  buildTaprootReserveVaultManifest,
  verifyTaprootReserveVaultManifest,
  verifyTaprootReserveVaultOnChain,
  buildTaprootReserveVaultSet,
  reservedSatsFromTaprootReserveVaultSet,
  buildVaultSpendProposal,
  approveTaprootReserveVaultSpend,
  verifyGuardianApproval
} = require('./taproot_reserve_vault');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEq(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const OPERATOR_SECRET = 11n;
const GUARDIAN_SECRET = 22n;
const OPERATOR_XONLY = a.xOnlyPubkey(OPERATOR_SECRET).toString('hex');
const GUARDIAN_XONLY = a.xOnlyPubkey(GUARDIAN_SECRET).toString('hex');
const FUNDING_TXID = 'aa'.repeat(32);
const PAYOUT_ADDRESS = 'tb1qn75cnly6zn4540k7824rmw02eeylaygcpj49rs';
const PAYOUT_SPK = addressToScriptPubKey(PAYOUT_ADDRESS, 'bitcoin-testnet4').toString('hex');

function manifest(overrides = {}) {
  return buildTaprootReserveVaultManifest({
    network: 'bitcoin-testnet4',
    vaultId: 'reserve-vault-1',
    fundingOutpoint: { txid: FUNDING_TXID, vout: 0 },
    amountSats: 100000,
    operatorXonly: OPERATOR_XONLY,
    guardianXonly: GUARDIAN_XONLY,
    observedAtHeight: 1000,
    recoveryCsvDelay: 2016,
    reserveEpochId: 'epoch-77',
    ...overrides
  });
}

function chainTxout(m = manifest(), overrides = {}) {
  return {
    value: 0.001,
    scriptPubKey: { hex: m.core.p2trScriptPubKey },
    confirmations: 12,
    ...overrides
  };
}

function vaultSet(m = manifest(), txout = chainTxout(m), currentHeight = 1200) {
  return buildTaprootReserveVaultSet({
    network: 'bitcoin-testnet4',
    reserveEpochId: 'epoch-77',
    currentHeight,
    manifests: [m],
    chainTxouts: { [`${m.core.fundingOutpoint.txid}:${m.core.fundingOutpoint.vout}`]: txout }
  });
}

function queue(sats = 97000) {
  return buildTradeLayerWithdrawalQueue({
    network: 'bitcoin-testnet4',
    epochId: 77,
    requests: [{
      id: 'wd-1',
      txid: '11'.repeat(32),
      address: PAYOUT_ADDRESS,
      sats,
      propertyId: 0,
      status: 'approved'
    }]
  });
}

function spendTxHex(valueSats = 97000, scriptPubKey = PAYOUT_SPK) {
  return tr.serializeUnsignedTx(2, [
    { outpoint: tr.outpoint(FUNDING_TXID, 0), sequence: 0xfffffffd }
  ], [
    { valueSats, script: scriptPubKey }
  ], 0);
}

function solventReconciliation(set = vaultSet(), sats = 97000) {
  return buildTradeLayerReserveReconciliation({
    network: 'bitcoin-testnet4',
    queue: queue(sats),
    reserve: set,
    observedAtHeight: set.currentHeight,
    currentHeight: set.currentHeight,
    maxReserveAgeBlocks: 6
  });
}

console.log('\n=== Taproot Reserve Vault Tests ===\n');

test('vault manifest hash is deterministic and script tree verifies', () => {
  const a1 = manifest();
  const a2 = manifest();
  assertEq(a1.manifestHash, a2.manifestHash);
  const result = verifyTaprootReserveVaultManifest(a1, { currentHeight: 1200 });
  assert(result.ok, result.reason);
  assert(result.countable, 'vault should be safely before recovery maturity');
  assert(a1.core.p2trScriptPubKey.startsWith('5120'), 'vault output must be P2TR');
});

test('non-vault wallet UTXOs are rejected as reserve evidence', () => {
  const m = manifest();
  const set = vaultSet(m, chainTxout(m, { scriptPubKey: { hex: '0014' + '00'.repeat(20) } }));
  const summary = reservedSatsFromTaprootReserveVaultSet(set);
  assertEq(summary.reservedSats.toString(), '0');
  assertEq(summary.countedVaultCount, 0);
  assertEq(summary.rejectedVaultCount, 1);

  const rec = buildTradeLayerReserveReconciliation({
    network: 'bitcoin-testnet4',
    queue: queue(1),
    reserve: set
  });
  assert(!rec.solvent, 'ordinary wallet UTXO must not back the reserve cap');
  assertEq(rec.core.reserveSourceKind, 'taproot-reserve-vault-set');

  const plainUtxoSet = buildTaprootReserveVaultSet({
    network: 'bitcoin-testnet4',
    reserveEpochId: 'epoch-77',
    currentHeight: 1200,
    manifests: [{ txid: 'bb'.repeat(32), vout: 0, amountSats: 50000 }],
    chainTxouts: [{ valueSats: 50000, scriptPubKey: { hex: '0014' + '22'.repeat(20) } }]
  });
  assertEq(plainUtxoSet.reservedSats, '0');
  assert(/wrong vault manifest kind/.test(plainUtxoSet.core.vaults[0].verification.reason));
});

test('live vault UTXO is counted only when scriptPubKey and amount match', () => {
  const m = manifest();
  const ok = verifyTaprootReserveVaultOnChain(m, {
    txout: chainTxout(m),
    currentHeight: 1200,
    network: 'bitcoin-testnet4'
  });
  assert(ok.ok && ok.counted, ok.reason);

  const badAmount = verifyTaprootReserveVaultOnChain(m, {
    txout: chainTxout(m, { value: 0.00099 }),
    currentHeight: 1200,
    network: 'bitcoin-testnet4'
  });
  assert(!badAmount.ok && /amount mismatch/.test(badAmount.reason), 'amount mismatch should reject');

  const badScript = verifyTaprootReserveVaultOnChain(m, {
    txout: chainTxout(m, { scriptPubKey: { hex: '0014' + '11'.repeat(20) } }),
    currentHeight: 1200,
    network: 'bitcoin-testnet4'
  });
  assert(!badScript.ok && /scriptPubKey mismatch/.test(badScript.reason), 'script mismatch should reject');
});

test('spent or missing vault UTXO contributes zero reserve', () => {
  const set = vaultSet(manifest(), null);
  assertEq(set.reservedSats, '0');
  assertEq(set.rejectedVaultCount, 1);
});

test('vault is rejected once recovery is mature or inside the risk window', () => {
  const m = manifest();
  const nearMaturity = vaultSet(m, chainTxout(m), 1000 + 2016 - 100);
  assertEq(nearMaturity.reservedSats, '0');
  assert(/risk window/.test(nearMaturity.core.vaults[0].verification.reason));

  const mature = vaultSet(m, chainTxout(m), 1000 + 2016);
  assertEq(mature.reservedSats, '0');
  assert(/mature/.test(mature.core.vaults[0].verification.reason));
});

test('taproot reserve vault set drives a solvent reconciliation', () => {
  const set = vaultSet();
  const q = queue(97000);
  const rec = buildTradeLayerReserveReconciliation({
    network: 'bitcoin-testnet4',
    queue: q,
    reserve: set,
    observedAtHeight: set.currentHeight,
    currentHeight: set.currentHeight,
    maxReserveAgeBlocks: 6
  });
  const result = verifyTradeLayerReserveReconciliation(rec, q, { currentHeight: set.currentHeight });
  assert(result.ok, result.reason);
  assert(rec.solvent, 'cap 97000 <= vault reserve 100000');
  assertEq(rec.core.reserveSourceKind, 'taproot-reserve-vault-set');
  assertEq(rec.core.reserveEvidenceSummary.countedVaultCount, 1);
});

test('guardian refuses a proposal with wrong exact outputs', () => {
  const m = manifest();
  const set = vaultSet(m);
  const rec = solventReconciliation(set);
  const proposal = buildVaultSpendProposal({
    manifest: m,
    unsignedTxHex: spendTxHex(96000),
    expectedOutputs: [{ valueSats: 97000, scriptPubKey: PAYOUT_SPK }],
    reserveReconciliation: rec,
    withdrawalQueue: queue(97000)
  });
  const approval = approveTaprootReserveVaultSpend({
    manifest: m,
    proposal,
    guardianSecret: GUARDIAN_SECRET,
    reserveReconciliation: rec,
    withdrawalQueue: queue(97000),
    currentHeight: 1200
  });
  assert(!approval.approved, 'guardian must refuse wrong outputs');
  assert(approval.policyResult.failedChecks.includes('expected_outputs'));
  assert(verifyGuardianApproval(approval, m).ok, 'refusal receipt should verify');
});

test('guardian refuses excessive fees', () => {
  const m = manifest();
  const set = vaultSet(m);
  const q = queue(90000);
  const rec = solventReconciliation(set, 90000);
  const proposal = buildVaultSpendProposal({
    manifest: m,
    unsignedTxHex: spendTxHex(90000),
    expectedOutputs: [{ valueSats: 90000, scriptPubKey: PAYOUT_SPK }],
    reserveReconciliation: rec,
    withdrawalQueue: q
  });
  const approval = approveTaprootReserveVaultSpend({
    manifest: m,
    proposal,
    guardianSecret: GUARDIAN_SECRET,
    reserveReconciliation: rec,
    withdrawalQueue: q,
    currentHeight: 1200
  });
  assert(!approval.approved, 'guardian must refuse fee over cap');
  assert(approval.policyResult.failedChecks.includes('fee_cap'));
});

test('guardian refuses stale or insolvent reserve policy', () => {
  const m = manifest();
  const qInsolvent = queue(120000);
  const insolvent = buildTradeLayerReserveReconciliation({
    network: 'bitcoin-testnet4',
    queue: qInsolvent,
    reserve: vaultSet(m)
  });
  const proposal = buildVaultSpendProposal({
    manifest: m,
    unsignedTxHex: spendTxHex(97000),
    expectedOutputs: [{ valueSats: 97000, scriptPubKey: PAYOUT_SPK }],
    reserveReconciliation: insolvent,
    withdrawalQueue: qInsolvent
  });
  const refusedInsolvent = approveTaprootReserveVaultSpend({
    manifest: m,
    proposal,
    guardianSecret: GUARDIAN_SECRET,
    reserveReconciliation: insolvent,
    withdrawalQueue: qInsolvent,
    currentHeight: 1200
  });
  assert(!refusedInsolvent.approved);
  assert(refusedInsolvent.policyResult.failedChecks.includes('reserve_solvency'));

  const staleSet = vaultSet(m, chainTxout(m), 1000 + 2016 - 100);
  const staleRec = solventReconciliation(staleSet, 1);
  const refusedStale = approveTaprootReserveVaultSpend({
    manifest: m,
    proposal,
    guardianSecret: GUARDIAN_SECRET,
    reserveReconciliation: staleRec,
    withdrawalQueue: queue(1),
    currentHeight: 1000 + 2016 - 100
  });
  assert(!refusedStale.approved);
  assert(refusedStale.policyResult.failedChecks.includes('vault_manifest'));
});

test('guardian approves and signs only the exact policy-matching transaction', () => {
  const m = manifest();
  const q = queue(97000);
  const rec = solventReconciliation(vaultSet(m), 97000);
  const unsignedTxHex = spendTxHex(97000);
  const proposal = buildVaultSpendProposal({
    manifest: m,
    unsignedTxHex,
    expectedOutputs: [{ valueSats: 97000, scriptPubKey: PAYOUT_SPK }],
    reserveReconciliation: rec,
    withdrawalQueue: q
  });
  const approval = approveTaprootReserveVaultSpend({
    manifest: m,
    proposal,
    guardianSecret: GUARDIAN_SECRET,
    reserveReconciliation: rec,
    withdrawalQueue: q,
    currentHeight: 1200
  });
  assert(approval.approved, JSON.stringify(approval.policyResult.failedChecks));
  assert(approval.signature, 'approval must carry guardian signature');
  assertEq(approval.vaultId, m.core.vaultId);
  assert(verifyGuardianApproval(approval, m).ok, 'approval receipt should verify');

  const txParsed = tr.parseTx(unsignedTxHex);
  const leaf = m.core.leaves['immediate-operator-guardian'];
  const sighash = ts.scriptPathSighash(
    txParsed,
    [{ scriptPubKey: m.core.p2trScriptPubKey, amountSats: m.core.amountSats }],
    0,
    Buffer.from(leaf.leafHash, 'hex')
  );
  assert(a.schnorrVerify(Buffer.from(GUARDIAN_XONLY, 'hex'), sighash, Buffer.from(approval.signature, 'hex')), 'guardian signature should verify');

  const tampered = clone(approval);
  tampered.signature = '00'.repeat(64);
  assert(!verifyGuardianApproval(tampered, m).ok, 'approval hash binds the exact signature artifact');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
