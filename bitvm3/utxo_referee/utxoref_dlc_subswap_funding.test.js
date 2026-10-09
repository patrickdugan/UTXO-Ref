#!/usr/bin/env node

const {
  derivePreimageHex,
  derivePaymentHashHex,
  makePrototypeInvoice,
  buildFundingOutputCommitment
} = require('./lightning_integration');
const { buildLightningTradeLayerOracleDlcBundle } = require('./lightning_tradelayer_oracle_dlc');
const {
  buildDlcSubswapFundingRequest,
  verifyDlcSubswapFundingRequest,
  buildDlcSubswapFundingWalletView
} = require('./utxoref_dlc_subswap_funding');

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
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEq(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

function demoDlcBundle() {
  return buildLightningTradeLayerOracleDlcBundle({
    trigger: {
      publishTxid: '22accff5ad661d6bc9fcf8d972ef822305965da866f597dade40ac322124fd63',
      price: 65000
    },
    challengeClaimedOutcomeId: 'price_above_entry'
  });
}

function matchingSubswapProof(dlcBundle) {
  const preimageHex = derivePreimageHex('matching-subswap-proof');
  const paymentHashHex = derivePaymentHashHex(preimageHex);
  const outputAmountSats = '49000';
  const fundingOutput = buildFundingOutputCommitment({
    epochId: 1n,
    dlcId: dlcBundle.contract.contractCore.contractId,
    bitvmCommitmentRoot: dlcBundle.bitvmOrganizer.organizerId,
    collateralSats: BigInt(outputAmountSats),
    refundAddress: 'tb1qutxorefsubswaprefund0000000000000000000000',
    timeoutBlock: 144
  });
  return {
    kind: 'lightning_subswap_into_dlc_funding_demo',
    lightning: {
      bolt11: makePrototypeInvoice({
        amountSats: 50000n,
        paymentHashHex,
        description: 'matching proof'
      }),
      paymentHashHex,
      paymentPreimageHex: preimageHex
    },
    swap: {
      fundingTxid: '11'.repeat(32),
      fundingVout: 0
    },
    dlcFunding: {
      claimTxid: '22'.repeat(32),
      claimWtxid: '33'.repeat(32),
      outputVout: 0,
      outputAmountSats,
      commitmentHash: fundingOutput.commitmentHash,
      fundingOutput
    },
    refundPath: {
      refundTxid: '44'.repeat(32)
    },
    checks: {
      claimPaysDlcFundingOutput: true,
      dlcOutputCommitsFundingHash: true,
      successBroadcasted: true,
      refundBroadcasted: true
    }
  };
}

console.log('\n=== UTXORef DLC Subswap Funding Tests ===\n');

test('builds a DLC submarine-swap funding request from a Lightning DLC bundle', () => {
  const dlcBundle = demoDlcBundle();
  const request = buildDlcSubswapFundingRequest({
    dlcBundle,
    options: {
      walletNodeId: 'zeus-test-node',
      requestedCollateralSats: '50000',
      swapFeeSats: '1000',
      preimageHex: derivePreimageHex('wallet-funded-dlc')
    }
  });
  const result = verifyDlcSubswapFundingRequest(request);
  assert(result.ok, result.reason);
  assertEq(request.requestCore.submarineSwap.invoiceAmountSats, '51000');
  assertEq(request.requestCore.targetDlc.contractCommitmentId, dlcBundle.contract.contractCommitmentId);
  assertEq(request.requestCore.jurassicMotifs.transcriptAliases.length, 2);
  assert(request.requestCore.jurassicMotifs.carrierHints.includes('p2wsh_htlc'));
});

test('binds a matching UTXORef execution proof to the request', () => {
  const dlcBundle = demoDlcBundle();
  const request = buildDlcSubswapFundingRequest({
    dlcBundle,
    subswapProof: matchingSubswapProof(dlcBundle),
    options: {
      walletNodeId: 'zeus-test-node',
      swapFeeSats: '1000'
    }
  });
  const result = verifyDlcSubswapFundingRequest(request);
  assert(result.ok, result.reason);
  assert(request.executionProof.checks.preimageMatchesPaymentHash, 'preimage check failed');
  assert(request.executionProof.checks.claimPaysDlcFundingOutput, 'claim output check failed');
  assertEq(request.requestCore.submarineSwap.requestedCollateralSats, '49000');
});

test('rejects a tampered request id', () => {
  const request = buildDlcSubswapFundingRequest({ dlcBundle: demoDlcBundle() });
  const result = verifyDlcSubswapFundingRequest({ ...request, requestId: '00'.repeat(32) });
  assert(!result.ok, 'tampered request id should fail');
  assertEq(result.reason, 'request id mismatch');
});

test('rejects execution proof with the wrong payment hash', () => {
  const dlcBundle = demoDlcBundle();
  const proof = matchingSubswapProof(dlcBundle);
  const request = buildDlcSubswapFundingRequest({
    dlcBundle,
    subswapProof: proof,
    options: {
      paymentHashHex: 'aa'.repeat(32)
    }
  });
  const result = verifyDlcSubswapFundingRequest(request);
  assert(!result.ok, 'wrong payment hash should fail');
  assertEq(result.reason, 'execution proof failed: paymentHashMatchesRequest');
});

test('builds a wallet view for ZEUS-style integration screens', () => {
  const request = buildDlcSubswapFundingRequest({ dlcBundle: demoDlcBundle() });
  const view = buildDlcSubswapFundingWalletView(request);
  assertEq(view.kind, 'wallet_dlc_subswap_funding_view');
  assertEq(view.status, 'verified');
  assert(view.invoice.startsWith('lnbc'), 'expected prototype invoice');
  assert(view.actions.some(action => action.id === 'pay_invoice'), 'missing pay action');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
