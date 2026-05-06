/**
 * Parallel UTXO index tests
 *
 * Run: node bitvm3/utxo_referee/m1_parallel_utxo_index.test.js
 */

const { buildParallelUtxoIndex } = require('./m1_parallel_utxo_index');

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

console.log('\n=== M1 Parallel UTXO Index Tests ===\n');

test('index collects funding, settlement, roll, and timeout spend references', () => {
  const index = buildParallelUtxoIndex({
    fundingPsbt: {
      kind: 'm1_funding_psbt',
      chain: {
        chainId: 'litecoin-mainnet',
        network: 'main',
        rpcUrl: 'http://127.0.0.1:9332'
      },
      funding: {
        selectedInputs: [
          { txid: '11'.repeat(32), vout: 0 }
        ],
        fundingOutpoint: {
          txid: '22'.repeat(32),
          vout: 1,
          valueSats: '900000'
        },
        fundingAddress: 'ltc1funding'
      }
    },
    fundingFinal: {
      kind: 'm1_funding_finalized',
      txid: '22'.repeat(32),
      wtxid: '33'.repeat(32),
      locktime: 0
    },
    cetSkeletons: {
      kind: 'm1_cet_skeletons',
      fundingOutpoint: {
        txid: '22'.repeat(32),
        vout: 1,
        valueSats: '900000'
      },
      settlement: {
        paths: [
          {
            pathId: 'settle-gain',
            txid: '44'.repeat(32),
            locktime: 100,
            input: { txid: '22'.repeat(32), vout: 1 },
            winnerAddress: 'ltc1winner',
            refundAddress: 'ltc1refund',
            feeAddress: 'ltc1fee',
            dustAddress: 'ltc1dust',
            actualPayoutSats: '500000',
            refundSats: '390000',
            feeSats: '10000',
            dustCarrySats: '0'
          }
        ],
        roll: {
          txid: '55'.repeat(32),
          locktime: 200,
          input: { txid: '22'.repeat(32), vout: 1 },
          payouts: {
            winnerAddress: 'ltc1residual',
            refundAddress: 'ltc1residual',
            dustAddress: 'ltc1dust',
            rolloverCollateralSats: '800000',
            timeoutRemainderSats: '100000',
            dustCarrySats: '0'
          }
        }
      }
    },
    expiryArtifact: {
      kind: 'm1_expiry_redemption',
      deposit: {
        txid: '22'.repeat(32),
        amountSats: '900000'
      },
      redemption: {
        amountSats: '800000',
        settlementKind: 'timeout-refund'
      }
    },
    timeoutProof: {
      kind: 'm1_expiry_timeout_testnet_proof',
      fundingOutpoint: {
        fundingTxid: '22'.repeat(32),
        fundingVout: 1,
        fundingValueSats: '900000'
      },
      committedRouting: {
        winnerAddress: 'ltc1residual',
        refundAddress: 'ltc1refund',
        feeAddress: 'ltc1fee',
        dustAddress: 'ltc1dust'
      },
      timeoutSpend: {
        txid: '66'.repeat(32),
        recipientSats: '800000',
        residualSats: '90000',
        feeSats: '10000',
        dustCarrySats: '0'
      }
    }
  });

  assertEq(index.kind, 'm1_parallel_utxo_index');
  assertEq(index.chain.chainId, 'litecoin-mainnet');
  assertEq(index.anchors.fundingTxid, '22'.repeat(32));
  assertEq(index.anchors.timeoutSpendTxid, '66'.repeat(32));
  assertEq(index.transactions.length, 4);
  assertEq(index.semanticRefs.length, 2);
  assert(index.artifactHash, 'artifactHash should be populated');
});

test('legacy chain metadata can still be mapped into a chain id', () => {
  const index = buildParallelUtxoIndex({
    fundingPsbt: {
      kind: 'm1_funding_psbt',
      chain: {
        network: 'test',
        rpcUrl: 'http://127.0.0.1:19332'
      },
      funding: {
        fundingOutpoint: {
          txid: '77'.repeat(32),
          vout: 0,
          valueSats: '1'
        }
      }
    }
  });

  assertEq(index.chain.chainId, 'litecoin-testnet');
});

console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
