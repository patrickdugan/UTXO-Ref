/**
 * Run: node bitvm3/utxo_referee/tradelayer_pnl_state_netting.test.js
 */

const {
  buildTradeLayerPnlStateOracleCommitment,
  derivePnlRowsFromStateOracle,
  buildGrossPnlEdges,
  computeNetBalances,
  foldPnlNettingGraph,
  buildTradeLayerPnlNettingSettlement,
  verifyTradeLayerPnlNettingSettlement,
  buildTradeLayerPnlNettingChallenge,
  verifyTradeLayerPnlNettingChallenge
} = require('./tradelayer_pnl_state_netting');

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

const A = 'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz';
const B = 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa';
const C = 'tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22';

const STATE_ORACLE = {
  kind: 'tradelayer-pnl-state-oracle-v1',
  chain: 'litecoin-testnet',
  epochId: '91',
  snapshotHeight: 4699001,
  snapshotTxid: 'aa'.repeat(32),
  oracleAddress: A,
  priceScale: 1,
  feeSats: 1000,
  dlcInput: {
    txid: 'bb'.repeat(32),
    vout: 0,
    address: B,
    sats: 6000
  },
  liveAddresses: [A, B, C],
  pnlRows: [
    {
      id: 'a-wins-from-b',
      contractId: 'tl-ltcusd-perp',
      side: 'long',
      entryPrice: 2100,
      closePrice: 2200,
      quantityUnits: 100,
      collateralSats: 50000,
      traderAddress: A,
      counterpartyAddress: B
    },
    {
      id: 'b-wins-from-c',
      contractId: 'tl-ltcusd-perp',
      side: 'long',
      entryPrice: 2150,
      closePrice: 2200,
      quantityUnits: 100,
      collateralSats: 50000,
      traderAddress: B,
      counterpartyAddress: C
    },
    {
      id: 'c-wins-from-a',
      contractId: 'tl-ltcusd-perp',
      side: 'short',
      entryPrice: 2300,
      closePrice: 2200,
      quantityUnits: 70,
      collateralSats: 50000,
      traderAddress: C,
      counterpartyAddress: A
    }
  ]
};

console.log('\n=== TradeLayer PNL State Netting Tests ===\n');

test('commits to the state oracle row source without signature fields', () => {
  const signed = clone(STATE_ORACLE);
  signed.oracleSignature = { signatureHex: '11'.repeat(64), publicKeyPem: 'private-ish test fixture' };
  const unsignedCommitment = buildTradeLayerPnlStateOracleCommitment(STATE_ORACLE);
  const signedCommitment = buildTradeLayerPnlStateOracleCommitment(signed);

  assertEq(unsignedCommitment.oracleBlobHash, signedCommitment.oracleBlobHash);
  assertEq(unsignedCommitment.rowSourceHash.length, 64);
});

test('derives bilateral PNL rows from the oracle update', () => {
  const rows = derivePnlRowsFromStateOracle(STATE_ORACLE);

  assertEq(rows.length, 3);
  assertEq(rows[0].winnerAddress, A);
  assertEq(rows[0].loserAddress, B);
  assertEq(rows[0].transferSats, '10000');
  assertEq(rows[2].winnerAddress, C);
  assertEq(rows[2].loserAddress, A);
  assertEq(rows[2].transferSats, '7000');
});

test('folds gross bilateral transfers into final live counterparties', () => {
  const rows = derivePnlRowsFromStateOracle(STATE_ORACLE);
  const grossEdges = buildGrossPnlEdges(rows);
  const netBalances = computeNetBalances(grossEdges);
  const folded = foldPnlNettingGraph(netBalances);
  const byAddress = new Map(netBalances.map((row) => [row.address, row.netSats]));

  assertEq(grossEdges.length, 3);
  assertEq(byAddress.get(A), '3000');
  assertEq(byAddress.get(B), '-5000');
  assertEq(byAddress.get(C), '2000');
  assertEq(folded.length, 2);
  assert(folded.every((edge) => edge.fromAddress === B), 'B should be the only final payer');
});

test('builds and verifies a UTXORef payout commitment for the netted graph', () => {
  const settlement = buildTradeLayerPnlNettingSettlement(STATE_ORACLE);
  const result = verifyTradeLayerPnlNettingSettlement(settlement);
  const payouts = new Map(settlement.routePlan.outputPlan.map((output) => [output.accountAddress, output.sats]));

  assert(result.ok, result.reason);
  assertEq(result.totalPositiveNetSats, '5000');
  assertEq(settlement.core.totalGrossTransferSats, '22000');
  assertEq(settlement.core.foldedTransferCount, 2);
  assertEq(payouts.get(A), '3000');
  assertEq(payouts.get(C), '2000');
  assertEq(settlement.payout.totalSats, '5000');
});

test('rejects an observed sweep that routes a net payout to the wrong recipient', () => {
  const settlement = buildTradeLayerPnlNettingSettlement(STATE_ORACLE);
  const result = verifyTradeLayerPnlNettingSettlement(settlement, {
    observedOutputs: [
      { address: B, sats: 3000 },
      { address: C, sats: 2000 }
    ]
  });

  assert(!result.ok, 'wrong observed recipient should fail');
  assert(String(result.reason).includes('route plan failed'), 'expected route plan failure');
});

test('rejects claimed PNL arithmetic that does not match the price move', () => {
  const bad = clone(STATE_ORACLE);
  bad.pnlRows[0].rawPnlSats = '9999';
  let threw = false;
  try {
    derivePnlRowsFromStateOracle(bad);
  } catch (err) {
    threw = String(err.message).includes('claimed PNL');
  }
  assert(threw, 'expected claimed PNL mismatch');
});

test('builds challenge records for omitted rows and wrong final recipients', () => {
  const settlement = buildTradeLayerPnlNettingSettlement(STATE_ORACLE);
  const omitted = buildTradeLayerPnlNettingChallenge(settlement, {
    challengeType: 'omitted_pnl_row',
    omittedRowHash: 'cc'.repeat(32)
  });
  const wrongRecipient = buildTradeLayerPnlNettingChallenge(settlement, {
    challengeType: 'wrong_final_recipient',
    claimedOutput: { address: B, accountAddress: A, sats: '3000' }
  });

  assert(verifyTradeLayerPnlNettingChallenge(omitted, settlement).ok, 'omitted-row challenge should verify');
  assert(verifyTradeLayerPnlNettingChallenge(wrongRecipient, settlement).ok, 'wrong-recipient challenge should verify');
  assertEq(omitted.core.binding.stateOracleHash, settlement.core.stateOracleHash);
  assertEq(wrongRecipient.core.binding.foldedEdgeRoot, settlement.core.foldedEdgeRoot);
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
