/**
 * BitVM search manifold tests
 *
 * Run: node bitvm3/utxo_referee/m1_bitvm_search_manifolds.test.js
 */

const {
  CONSTANT_ONE_DIGEST_HEX,
  buildBitvmSearchManifolds
} = require('./m1_bitvm_search_manifolds');

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
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `expected ${expected}, got ${actual}`);
  }
}

function buildFixtureInputs() {
  return {
    challengeBundle: {
      kind: 'm1_challenge_bundle',
      bundleHash: 'aa'.repeat(32),
      selectedPathId: 'settle-gain',
      binding: {
        fundingTxidFinalized: 'bb'.repeat(32),
        fundingOutpoint: {
          txid: 'bb'.repeat(32),
          vout: 1,
          valueSats: '900000'
        },
        dustCarrySats: '1500'
      },
      selectedPath: {
        pathId: 'settle-gain',
        txid: 'cc'.repeat(32),
        payoutSats: '500000',
        actualPayoutSats: '500000',
        refundSats: '398500',
        residualSats: '398500',
        feeSats: '0',
        dustCarrySats: '1500',
        winnerRole: 'winner',
        winnerAddress: 'ltc1winner',
        refundRole: 'refund',
        refundAddress: 'ltc1refund',
        feeRole: 'fee',
        feeAddress: 'ltc1fee',
        dustRole: 'dust',
        dustAddress: 'ltc1dust'
      },
      oracleBinding: {
        eventId: 'contract-1',
        oracleMapId: 'oracle-map-1',
        messageDigestHex: 'dd'.repeat(32)
      },
      deltaPublication: {
        publicationId: 'pub-1',
        publicationHash: 'ee'.repeat(32),
        deltaSats: '398500'
      }
    },
    challengeWitness: {
      kind: 'm1_challenge_witness',
      route: 'settle-gain'
    },
    proceduralSync: {
      kind: 'bitvm_procedural_sync',
      contractId: 'contract-1',
      fundingTxid: 'bb'.repeat(32),
      funding: {
        collateralSats: '900000'
      },
      settlement: {
        route: 'settle-gain'
      }
    },
    parallelUtxoIndex: {
      kind: 'm1_parallel_utxo_index',
      anchors: {
        fundingTxid: 'bb'.repeat(32)
      }
    }
  };
}

console.log('\n=== BitVM Search Manifold Tests ===\n');

test('transcript multiplicity preserves statement hash while aliasing the intended families', () => {
  const report = buildBitvmSearchManifolds(buildFixtureInputs());
  const variants = report.transcriptMultiplicity.variants;
  const aa = variants.find((variant) => variant.variantId === 'fd_repeat_aa');
  const aaaa = variants.find((variant) => variant.variantId === 'fd_repeat_aaaa');
  const aabb = variants.find((variant) => variant.variantId === 'fd_repeat_aabb');
  const hazard = variants.filter((variant) => variant.surface === 'sighash_single' && variant.hazardous);

  assert(aa && aaaa && aabb, 'expected FindAndDelete variants');
  assertEq(aa.statementHash, report.core.statementHash);
  assertEq(aaaa.statementHash, report.core.statementHash);
  assertEq(aabb.statementHash, report.core.statementHash);
  assertEq(aa.transcriptHash, aaaa.transcriptHash, 'retry-equivalent variants should alias');
  assert(aa.transcriptHash !== aabb.transcriptHash, 'branch split variant should diverge');
  assertEq(hazard.length, 2);
  assertEq(hazard[0].transcriptHash, CONSTANT_ONE_DIGEST_HEX);
  assertEq(report.transcriptMultiplicity.summary.recommendedPrimaryVariant, 'fd_repeat_aabb');
});

test('identifier bifurcation yields unique projected anchors from one transcript core', () => {
  const report = buildBitvmSearchManifolds(buildFixtureInputs());
  const variants = report.identifierBifurcation.variants;
  const projectedAnchors = new Set(variants.map((variant) => variant.projectedAnchorId));
  const transcriptCoreHashes = new Set(variants.map((variant) => variant.transcriptCoreHash));

  assertEq(variants.length, 4);
  assertEq(projectedAnchors.size, 4);
  assertEq(transcriptCoreHashes.size, 1);
  assertEq(report.identifierBifurcation.summary.recommendedPrimaryVariant, 'anchor_retry_window');
});

console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
