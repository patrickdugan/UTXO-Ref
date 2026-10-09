const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildDlcTokenizerSecurityComparison,
  verifyDlcTokenizerSecurityComparison,
  writeDlcTokenizerSecurityComparison
} = require('./dlc_tokenizer_security_comparison');

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

console.log('\n=== DLC Tokenizer Security Comparison Tests ===\n');

test('compares ASP-backed and direct DLC/BitVM models', () => {
  const comparison = buildDlcTokenizerSecurityComparison({ outcomeCounts: [17, 101] });
  const result = verifyDlcTokenizerSecurityComparison(comparison);
  assert(result.ok, result.reason);
  assert(comparison.comparisonCore.models.aspBacked.reserveId, 'ASP model should bind reserve');
  assert.strictEqual(comparison.comparisonCore.models.directDlcBitvm.aspId, null);
  assert(comparison.comparisonCore.threats.some(row => row.threat === 'asp_route_mismatch'));
});

test('CET compression rows keep materialized count at zero', () => {
  const comparison = buildDlcTokenizerSecurityComparison({ outcomeCounts: [17, 1001, 5000] });
  for (const row of comparison.comparisonCore.feeRows) {
    assert.strictEqual(row.materializedCetCount, 0);
    assert.strictEqual(row.avoidsCetFanoutOnchainExposure, true);
    assert(BigInt(row.estimatedSavingsSats) > 0n, 'expected positive savings');
  }
});

test('writes JSON and markdown report', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlc-tokenizer-security-'));
  const { comparison, jsonPath, mdPath } = writeDlcTokenizerSecurityComparison({
    outcomeCounts: [17],
    jsonPath: path.join(outDir, 'comparison.json'),
    mdPath: path.join(outDir, 'comparison.md')
  });
  assert(fs.existsSync(jsonPath), 'json missing');
  assert(fs.existsSync(mdPath), 'markdown missing');
  const text = fs.readFileSync(mdPath, 'utf8');
  assert(text.includes('ASP-backed Ark model'), 'missing ASP section');
  assert(text.includes('Direct DLC/BitVM model'), 'missing direct model section');
  assert(verifyDlcTokenizerSecurityComparison(comparison).ok);
});

test('verification rejects a direct model that binds an ASP', () => {
  const comparison = buildDlcTokenizerSecurityComparison({ outcomeCounts: [17] });
  comparison.comparisonCore.models.directDlcBitvm.aspId = 'bad-asp';
  comparison.comparisonId = require('crypto')
    .createHash('sha256')
    .update(JSON.stringify(comparison.comparisonCore))
    .digest('hex');
  const result = verifyDlcTokenizerSecurityComparison(comparison);
  assert(!result.ok, 'bad direct model should fail');
});

console.log(`\nTests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
