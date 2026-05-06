/**
 * Spiral / LDK Value-Add Tests
 *
 * Run: node bitvm3/utxo_referee/spiral_ldk_value_add.test.js
 */

const {
  PUBLIC_COMMIT_EVIDENCE,
  buildLdkExternalFundingReceipt,
  verifyLdkExternalFundingReceipt,
  buildSpiralLdkValueAddBrief
} = require('./index');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `expected ${expected}, got ${actual}`);
  }
}

console.log('\n=== Spiral / LDK Value-Add Tests ===\n');

test('public evidence points at lightningdevkit commits', () => {
  assert(PUBLIC_COMMIT_EVIDENCE.length >= 5, 'expected multiple commit evidence entries');
  for (const item of PUBLIC_COMMIT_EVIDENCE) {
    assert(item.url.startsWith('https://github.com/lightningdevkit/'), `bad evidence URL ${item.url}`);
    assert(item.implication.length > 20, 'missing implication');
  }
});

test('LDK external funding receipt verifies with deterministic prototype data', () => {
  const adapter = buildLdkExternalFundingReceipt({
    positionOpen: {
      collateralSats: 123000n,
      swapFeeSats: 200n,
      fundingFeeSats: 800n
    }
  });
  const result = verifyLdkExternalFundingReceipt(adapter);
  assert(result.ok, result.reason);
  assertEq(adapter.ldkContributionCore.contributionAmountSats, '123000');
  assert(adapter.ldkTouchpoints.includes('rust-lightning::ln::funding::FundingBuilder'), 'missing FundingBuilder touchpoint');
  assert(adapter.traitSketch.length >= 4, 'missing trait sketch');
});

test('LDK external funding receipt binds live CLN payment preimage when supplied', () => {
  const liveClnReceipt = {
    network: 'regtest',
    channel: {
      txid: 'aa'.repeat(32),
      amount: '500000sat'
    },
    payment: {
      invoiceAmount: '25000msat',
      bolt11: 'lnbcrt-demo',
      status: 'complete',
      paymentPreimage: '11'.repeat(32),
      paymentHash: '02d449a31fbb267c8f352e9968a79e3e5fc95c1bbeaa502fd6454ebde5a4bedc'
    }
  };

  const adapter = buildLdkExternalFundingReceipt({ liveClnReceipt });
  const result = verifyLdkExternalFundingReceipt(adapter);
  assert(result.ok, result.reason);
  assertEq(adapter.liveClnReceipt.channelAmountSats, '500000');
  assertEq(adapter.liveClnReceipt.paymentPreimageHex, '11'.repeat(32));
  assert(adapter.checks.preimageMatchesReceiptHash, 'preimage should bind to supplied receipt hash');
});

test('Spiral value-add brief has milestones and a boundary', () => {
  const brief = buildSpiralLdkValueAddBrief({
    createdAt: '2026-04-25T00:00:00.000Z'
  });
  assertEq(brief.kind, 'spiral_ldk_value_add_brief');
  assert(brief.proposedMilestones.length === 3, 'expected three milestones');
  assert(brief.pitchBoundary.some(line => line.includes('BitVM')), 'expected BitVM boundary');
  assert(brief.verification.ok, brief.verification.reason);
});

console.log(`\nTests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
