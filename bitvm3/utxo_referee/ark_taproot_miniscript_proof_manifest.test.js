#!/usr/bin/env node

const {
  buildArkTaprootLeafSet,
  buildArkTaprootMiniscriptProofManifest,
  deriveTaprootPathProof,
  verifyArkTaprootMiniscriptProofManifest
} = require('./ark_taproot_miniscript_proof_manifest');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  OK  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log('\n=== Ark Taproot Miniscript Proof Manifest Tests ===\n');

test('leaf set contains Ark cooperative, exit, forfeit, DLC, and challenge roles', () => {
  const leaves = buildArkTaprootLeafSet({
    aspPubkeyHex: '11'.repeat(32),
    ownerPubkeyHex: '22'.repeat(32),
    oraclePubkeyHex: '33'.repeat(32),
    challengePubkeyHex: '44'.repeat(32),
    selectedVirtualCetId: '55'.repeat(32),
    settlementRoot: '66'.repeat(32)
  });
  const roles = leaves.map(leaf => leaf.role);
  assert(roles.includes('cooperative_round'), 'missing cooperative round leaf');
  assert(roles.includes('owner_csv_exit'), 'missing owner exit leaf');
  assert(roles.includes('asp_forfeit_guard'), 'missing ASP forfeit leaf');
  assert(roles.includes('dlc_virtual_cet_settlement'), 'missing virtual CET leaf');
  assert(roles.includes('utxoref_challenge_publication'), 'missing UTXORef challenge leaf');
});

test('manifest deterministically binds selected leaf and public inputs', () => {
  const a = buildArkTaprootMiniscriptProofManifest({
    aspId: 'asp-a',
    templateId: 'tpl-a',
    arkRoundId: 'round-a',
    connectorOutpoint: `${'77'.repeat(32)}:1`,
    vtxoCommitmentId: '88'.repeat(32),
    taprootOutputKey: '99'.repeat(32),
    selectedLeafRole: 'cooperative_round',
    amountSats: 50000n
  });
  const b = buildArkTaprootMiniscriptProofManifest({
    aspId: 'asp-a',
    templateId: 'tpl-a',
    arkRoundId: 'round-a',
    connectorOutpoint: `${'77'.repeat(32)}:1`,
    vtxoCommitmentId: '88'.repeat(32),
    taprootOutputKey: '99'.repeat(32),
    selectedLeafRole: 'cooperative_round',
    amountSats: 50000n
  });
  assert(a.manifestId === b.manifestId, 'manifest id should be deterministic');
  assert(a.manifestCore.selectedLeafRole === 'cooperative_round', 'selected role mismatch');
  assert(a.publicInputs.vtxoCommitmentId === '88'.repeat(32), 'vtxo public input mismatch');
  assert(a.selectedTaprootPath.pathCommitment === a.manifestCore.selectedTaprootPathCommitment, 'path commitment mismatch');
  assert(a.selectedTaprootPath.pathDepth === a.manifestCore.selectedTaprootPathDepth, 'path depth mismatch');
  assert(verifyArkTaprootMiniscriptProofManifest(a).ok, 'manifest should verify');
});

test('selected Taproot path recomputes root and detects tampering', () => {
  const manifest = buildArkTaprootMiniscriptProofManifest({
    aspId: 'asp-path',
    templateId: 'tpl-path',
    arkRoundId: 'round-path',
    connectorOutpoint: `${'12'.repeat(32)}:0`,
    vtxoCommitmentId: '34'.repeat(32),
    taprootOutputKey: '56'.repeat(32),
    selectedLeafRole: 'owner_csv_exit',
    amountSats: 70000n
  });
  const proof = deriveTaprootPathProof(manifest.taprootLeaves, 'owner_csv_exit');
  assert(proof.taprootLeafRoot === manifest.manifestCore.taprootLeafRoot, 'path root mismatch');
  assert(proof.pathCommitment === manifest.manifestCore.selectedTaprootPathCommitment, 'path commitment mismatch');

  const tampered = JSON.parse(JSON.stringify(manifest));
  tampered.selectedTaprootPath.path[0].siblingHash = 'ff'.repeat(32);
  const result = verifyArkTaprootMiniscriptProofManifest(tampered);
  assert(!result.ok && /path object/i.test(result.reason), 'tampered path should fail');
});

test('DLC settlement leaf requires virtual CET ids', () => {
  let failedAsExpected = false;
  try {
    const manifest = buildArkTaprootMiniscriptProofManifest({
      selectedLeafRole: 'dlc_virtual_cet_settlement'
    });
    const result = verifyArkTaprootMiniscriptProofManifest(manifest);
    failedAsExpected = !result.ok && /virtual CET/i.test(result.reason);
  } catch (err) {
    failedAsExpected = /virtual CET/i.test(err.message);
  }
  assert(failedAsExpected, 'DLC leaf should require virtual CET ids');
});

test('DLC settlement leaf verifies when virtual CET ids are bound', () => {
  const manifest = buildArkTaprootMiniscriptProofManifest({
    selectedLeafRole: 'dlc_virtual_cet_settlement',
    virtualCetSetId: 'aa'.repeat(32),
    selectedVirtualCetId: 'bb'.repeat(32),
    oracleOutcomeHash: 'cc'.repeat(32),
    settlementRoot: 'dd'.repeat(32),
    amountSats: 100000n
  });
  const result = verifyArkTaprootMiniscriptProofManifest(manifest);
  assert(result.ok, result.reason || 'DLC manifest should verify');
  assert(manifest.manifestCore.virtualCetSetId === 'aa'.repeat(32), 'virtual CET set not bound');
  assert(
    manifest.proofPackage.proofPackageCore.proverStatus === 'manifest_only',
    'default proof package should remain manifest-only'
  );
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
