/**
 * Procedural sync summary tests
 *
 * Run: node bitvm3/utxo_referee/m1_procedural_sync.test.js
 */

const { buildProceduralSyncSummary } = require('./m1_procedural_sync');

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

console.log('\n=== M1 Procedural Sync Tests ===\n');

test('summary prefers settled withdrawal amount when expiry artifact exists', () => {
  const summary = buildProceduralSyncSummary({
    draft: {
      kind: 'm1_dlc_draft',
      chain: { network: 'testnet', blockHeight: 4665946 },
      template: {
        templateId: 'dlc-receipt-ltc-testnet-v1',
        templateHash: 'aa'.repeat(32)
      },
      roleSet: {
        addresses: {
          alice: 'holder-address',
          operator: 'operator-address',
          oracle: 'oracle-address',
          residual: 'residual-address'
        }
      },
      contract: {
        eventId: 'ltc-testnet-epoch-1-1775408862103',
        collateralSats: '798100'
      }
    },
    fundingPsbt: {
      kind: 'm1_funding_psbt',
      funding: {
        effectiveCollateralSats: '798100',
        fundingOutpoint: {
          txid: 'funding-txid',
          vout: 0,
          valueSats: '798100'
        }
      }
    },
    fundingFinal: {
      kind: 'm1_funding_finalized',
      txid: 'funding-final-txid'
    },
    witnessArtifact: {
      kind: 'm1_challenge_witness',
      route: 'roll'
    },
    parallelUtxoIndex: {
      kind: 'm1_parallel_utxo_index',
      chain: {
        chainId: 'litecoin-testnet'
      },
      anchors: {
        fundingTxid: 'expiry-deposit-txid',
        timeoutSpendTxid: 'timeout-spend-txid'
      },
      transactions: [{}, {}, {}],
      semanticRefs: [{}, {}],
      artifactHash: 'parallel-hash'
    },
    expiryArtifact: {
      kind: 'm1_expiry_redemption',
      chain: { mode: 'rpc', height: 4665952, chain: 'testnet' },
      deposit: {
        txid: 'expiry-deposit-txid',
        amountSats: '798100'
      },
      redemption: {
        amountSats: '758195',
        settlementKind: 'timeout'
      },
      settlementBreakdown: {
        settlementKind: 'timeout',
        winnerSweepSats: '758195',
        refundSats: '39905',
        dustCarrySats: '0'
      }
    },
    sourceArtifacts: {
      draft: { path: 'draft.json', kind: 'm1_dlc_draft', hash: '11' },
      expiryRedemption: { path: 'expiry.json', kind: 'm1_expiry_redemption', hash: '22' },
      parallelUtxoIndex: { path: 'parallel.json', kind: 'm1_parallel_utxo_index', hash: '33' }
    }
  });

  assertEq(summary.state, 'SETTLED');
  assertEq(summary.holderAddress, 'holder-address');
  assertEq(summary.fundingTxid, 'expiry-deposit-txid');
  assertEq(summary.fundedAmountLtc.toFixed(8), '0.00758195');
  assertEq(summary.funding.fundedAmountSats, '758195');
  assertEq(summary.settlement.route, 'roll');
  assertEq(summary.settlement.settlementKind, 'timeout');
  assertEq(summary.settlement.refundSats, '39905');
  assertEq(summary.parallelUtxoIndex.chainId, 'litecoin-testnet');
  assertEq(summary.parallelUtxoIndex.transactionCount, 3);
  assertEq(summary.parallelUtxoIndex.semanticRefCount, 2);
  assertEq(summary.parallelUtxoIndex.timeoutSpendTxid, 'timeout-spend-txid');
  assert(summary.artifactHash, 'artifactHash should be populated');
});

test('summary falls back to funded state before expiry redemption exists', () => {
  const summary = buildProceduralSyncSummary({
    draft: {
      kind: 'm1_dlc_draft',
      chain: { network: 'testnet', blockHeight: 12345 },
      template: {
        templateId: 'dlc-receipt-ltc-testnet-v1',
        templateHash: 'bb'.repeat(32)
      },
      roleSet: {
        addresses: {
          alice: 'alice-holder',
          operator: 'operator-address',
          oracle: 'oracle-address',
          residual: 'residual-address'
        }
      },
      contract: {
        eventId: 'ltc-testnet-epoch-2-1775409999999',
        collateralSats: '800000'
      }
    },
    fundingPsbt: {
      kind: 'm1_funding_psbt',
      funding: {
        effectiveCollateralSats: '798100',
        fundingOutpoint: {
          txid: 'funding-txid-2',
          vout: 1,
          valueSats: '798100'
        }
      }
    }
  }, {
    holderAddress: 'override-holder',
    propertyId: 777
  });

  assertEq(summary.state, 'FUNDED');
  assertEq(summary.propertyId, 777);
  assertEq(summary.holderAddress, 'override-holder');
  assertEq(summary.fundingTxid, 'funding-txid-2');
  assertEq(summary.fundedAmountLtc.toFixed(8), '0.00798100');
  assertEq(summary.funding.collateralSats, '798100');
  assertEq(summary.settlement.route, null);
  assertEq(summary.parallelUtxoIndex, null);
  assertEq(summary.dbRoot, null);
});

console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
