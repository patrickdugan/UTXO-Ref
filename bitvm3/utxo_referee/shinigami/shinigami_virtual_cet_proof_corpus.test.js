const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildShinigamiVirtualCetCairoClaim,
  buildShinigamiVirtualCetProofCorpus,
  writeShinigamiVirtualCetProofCorpus,
  buildShinigamiVirtualCetProofReceipt,
  verifyShinigamiVirtualCetProofReceipt
} = require('./shinigami_virtual_cet_proof_corpus');

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
    console.error(`       ${err.stack || err.message}`);
  }
}

console.log('\n=== Shinigami Virtual CET Proof Corpus Tests ===\n');

test('builds a Cairo claim with zero materialized CETs', () => {
  const claim = buildShinigamiVirtualCetCairoClaim({ outcomeCount: 17 });
  assert.strictEqual(claim.kind, 'shinigami_virtual_cet_cairo_claim');
  assert.strictEqual(claim.claimCore.materializedCetCount, 0);
  assert.strictEqual(claim.cairoInput.length, 19);
  assert.strictEqual(
    BigInt(claim.claimCore.offerPayoutSats) + BigInt(claim.claimCore.acceptPayoutSats),
    BigInt(claim.claimCore.totalCollateralSats)
  );
});

test('writes a multi-size proof corpus', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shinigami-virtual-cet-'));
  const { summary, summaryPath } = writeShinigamiVirtualCetProofCorpus({
    outDir,
    outcomeCounts: [17, 101, 1001]
  });
  assert(fs.existsSync(summaryPath), 'summary missing');
  assert.strictEqual(summary.claims.length, 3);
  for (const entry of summary.claims) {
    assert(fs.existsSync(entry.claimPath), `claim missing: ${entry.claimPath}`);
    assert(fs.existsSync(entry.inputPath), `input missing: ${entry.inputPath}`);
    const input = JSON.parse(fs.readFileSync(entry.inputPath, 'utf8'));
    assert.strictEqual(input.length, 19);
  }
});

test('receipt verification accepts a verified proof receipt', () => {
  const claim = buildShinigamiVirtualCetCairoClaim({ outcomeCount: 17 });
  const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shinigami-virtual-cet-proof-'));
  const proofPath = path.join(proofDir, 'proof.json');
  const inputPath = path.join(proofDir, 'input.json');
  const logPath = path.join(proofDir, 'proof.log');
  fs.writeFileSync(proofPath, '{"proof":"ok"}\n', 'utf8');
  fs.writeFileSync(inputPath, JSON.stringify(claim.cairoInput), 'utf8');
  fs.writeFileSync(
    logPath,
    'Elapsed (wall clock) time (h:mm:ss or m:ss): 0:29.86\nMaximum resident set size (kbytes): 12380984\n',
    'utf8'
  );
  const receipt = buildShinigamiVirtualCetProofReceipt({
    claim,
    inputPath,
    proofPath,
    proverLogPath: logPath,
    proverExitCode: 0,
    verifierExitCode: 0
  });
  const result = verifyShinigamiVirtualCetProofReceipt(receipt, claim);
  assert(result.ok, result.reason);
  assert.strictEqual(receipt.receiptCore.metrics.maxResidentSetKb, 12380984);
});

test('receipt verification rejects materialized CETs', () => {
  const claim = buildShinigamiVirtualCetCairoClaim({ outcomeCount: 17 });
  const receipt = buildShinigamiVirtualCetProofReceipt({
    claim,
    proofPath: null,
    proverExitCode: 0,
    verifierExitCode: 0
  });
  receipt.receiptCore.materializedCetCount = 1;
  receipt.receiptId = require('crypto').createHash('sha256').update('tampered').digest('hex');
  const result = verifyShinigamiVirtualCetProofReceipt(receipt, claim);
  assert(!result.ok, 'tampered receipt should fail');
});

console.log(`\nTests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
