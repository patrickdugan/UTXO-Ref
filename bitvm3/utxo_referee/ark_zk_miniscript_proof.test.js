#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ROLE_CODES,
  ROLE_ORDER,
  buildTaprootPathWitness,
  hex32ToU128Limbs,
  computeArkZkMiniscriptBinding,
  buildArkZkMiniscriptClaimCorpus,
  writeArkZkMiniscriptClaimCorpus,
  buildArkZkMiniscriptProofReceipt,
  verifyArkZkMiniscriptProofReceipt
} = require('./ark_zk_miniscript_proof');

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

function assertEq(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

console.log('\n=== Ark ZK Miniscript Proof Tests ===\n');

test('hex32 splits into two u128 limbs', () => {
  const limbs = hex32ToU128Limbs(`${'11'.repeat(16)}${'22'.repeat(16)}`, 'testHash');
  assertEq(limbs.hiHex, `0x${'11'.repeat(16)}`, 'hi limb mismatch');
  assertEq(limbs.loHex, `0x${'22'.repeat(16)}`, 'lo limb mismatch');
});

test('JS binding matches the Cairo sample claim', () => {
  const binding = computeArkZkMiniscriptBinding({
    manifestId: `${'00'.repeat(30)}0101`,
    taprootRoot: `${'00'.repeat(30)}0202`,
    selectedLeafHash: `${'00'.repeat(30)}0303`,
    taprootPathCommitment: `${'00'.repeat(30)}0505`,
    taprootPathFold: 0x333an,
    selectedLeafRoleCode: ROLE_CODES.dlc_virtual_cet_settlement,
    settlementHash: `${'00'.repeat(30)}0404`,
    amountSats: 100000n,
    exitDelay: 1008
  });
  assertEq(`0x${binding.toString(16)}`, '0x5b8d2b2be', 'sample binding mismatch');
});

test('claim corpus emits one Cairo input per Ark role', () => {
  const corpus = buildArkZkMiniscriptClaimCorpus();
  assertEq(corpus.claims.length, ROLE_ORDER.length, 'claim count mismatch');
  for (const claim of corpus.claims) {
    assertEq(claim.cairoInput.length, 25, 'Cairo input arity mismatch');
    assert(ROLE_ORDER.includes(claim.claimCore.selectedLeafRole), 'unknown role');
    assertEq(
      claim.claimCore.selectedLeafRoleCode,
      ROLE_CODES[claim.claimCore.selectedLeafRole],
      'role code mismatch'
    );
    assert(claim.claimCore.amountSats !== '0', 'amount must be nonzero');
    assert(claim.claimCore.exitDelay > 0, 'exit delay must be nonzero');
    assert(claim.claimCore.taprootPathDepth >= 0, 'path depth must be present');
    assert(claim.claimCore.taprootPathDepth <= 3, 'path depth must fit Cairo fixed witness');
    assertEq(claim.claimCore.taprootPathSiblings.length, 3, 'fixed path sibling count mismatch');
    const witness = buildTaprootPathWitness(claim.sourceManifest);
    assertEq(claim.claimCore.taprootPathFold, witness.pathFoldHex, 'path fold mismatch');
  }
});

test('claim corpus writer records input hashes and paths', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-zk-miniscript-'));
  const { summary, summaryPath } = writeArkZkMiniscriptClaimCorpus({ outDir });
  assert(fs.existsSync(summaryPath), 'summary not written');
  assertEq(summary.claims.length, ROLE_ORDER.length, 'summary claim count mismatch');
  for (const claim of summary.claims) {
    assert(fs.existsSync(claim.claimPath), `missing claim path for ${claim.role}`);
    assert(fs.existsSync(claim.manifestPath), `missing manifest path for ${claim.role}`);
    assert(fs.existsSync(claim.inputPath), `missing input path for ${claim.role}`);
    assertEq(claim.inputSha256.length, 64, 'input hash must be hex32');
  }
});

test('proof receipt verifies hashes and detects tampering', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-zk-receipt-'));
  const corpus = buildArkZkMiniscriptClaimCorpus({ roles: ['dlc_virtual_cet_settlement'] });
  const claim = corpus.claims[0];
  const claimPath = path.join(outDir, 'claim.json');
  const inputPath = path.join(outDir, 'input.json');
  const proofPath = path.join(outDir, 'proof.json');
  const proverLogPath = path.join(outDir, 'prover.log');
  const verifierLogPath = path.join(outDir, 'verifier.log');
  writeJson(claimPath, claim);
  writeJson(inputPath, claim.cairoInput);
  fs.writeFileSync(proofPath, '{"proof":"ok"}\n', 'utf8');
  fs.writeFileSync(proverLogPath, 'prover ok\n', 'utf8');
  fs.writeFileSync(verifierLogPath, 'verifier ok\n', 'utf8');

  const receipt = buildArkZkMiniscriptProofReceipt({
    claim,
    claimPath,
    inputPath,
    proofPath,
    proverLogPath,
    verifierLogPath,
    proverExitCode: 0,
    verifierExitCode: 0
  });
  assert(verifyArkZkMiniscriptProofReceipt(receipt).ok, 'receipt should verify');
  fs.appendFileSync(proofPath, 'tamper\n', 'utf8');
  const tampered = verifyArkZkMiniscriptProofReceipt(receipt);
  assert(!tampered.ok && /proof hash mismatch/.test(tampered.reason), 'tampered proof should fail');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
