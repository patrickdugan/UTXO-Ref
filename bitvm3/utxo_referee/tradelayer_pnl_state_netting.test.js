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
const { sha256Hex, addressToScriptPubKey } = require('./tradelayer_pnl_route_adapter');

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
  const result = verifyTradeLayerPnlNettingSettlement(settlement, { stateOracleBlob: STATE_ORACLE });
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
    stateOracleBlob: STATE_ORACLE,
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
    verifyOptions: { stateOracleBlob: STATE_ORACLE },
    challengeType: 'omitted_pnl_row',
    omittedRowHash: 'cc'.repeat(32)
  });
  const wrongRecipient = buildTradeLayerPnlNettingChallenge(settlement, {
    verifyOptions: { stateOracleBlob: STATE_ORACLE },
    challengeType: 'wrong_final_recipient',
    claimedOutput: { address: B, accountAddress: A, sats: '3000' }
  });

  assert(verifyTradeLayerPnlNettingChallenge(omitted, settlement).ok, 'omitted-row challenge should verify');
  assert(verifyTradeLayerPnlNettingChallenge(wrongRecipient, settlement).ok, 'wrong-recipient challenge should verify');
  assertEq(omitted.core.binding.stateOracleHash, settlement.core.stateOracleHash);
  assertEq(wrongRecipient.core.binding.foldedEdgeRoot, settlement.core.foldedEdgeRoot);
});

test('requires an independent source even when the candidate supplies its own source and hash', () => {
  const settlement = buildTradeLayerPnlNettingSettlement(STATE_ORACLE);
  settlement.stateOracleBlob = STATE_ORACLE;
  const result = verifyTradeLayerPnlNettingSettlement(settlement, {
    expectedStateOracleHash: settlement.core.stateOracleHash
  });
  assert(!result.ok && result.reason.includes('independent options.stateOracleBlob'), result.reason);
});

test('rejects a fully rehashed payout redirected from the entitled account to another address', () => {
  const honest = buildTradeLayerPnlNettingSettlement(STATE_ORACLE);
  const outputPlan = clone(honest.routePlan.outputPlan);
  outputPlan[0].address = B;
  const redirected = buildTradeLayerPnlNettingSettlement(STATE_ORACLE, { outputPlan });
  const result = verifyTradeLayerPnlNettingSettlement(redirected, {
    stateOracleBlob: STATE_ORACLE,
    expectedStateOracleHash: honest.core.stateOracleHash
  });
  assert(!result.ok && result.reason.includes('routePlan'), result.reason);
});

test('rejects a script override hidden behind the correct payout address', () => {
  const outputPlan = clone(buildTradeLayerPnlNettingSettlement(STATE_ORACLE).routePlan.outputPlan);
  outputPlan[0].scriptPubKey = addressToScriptPubKey(B, 'litecoin-testnet').toString('hex');
  const settlement = buildTradeLayerPnlNettingSettlement(STATE_ORACLE, { outputPlan });
  const result = verifyTradeLayerPnlNettingSettlement(settlement, { stateOracleBlob: STATE_ORACLE });
  assert(!result.ok && result.reason.includes('routePlan'), result.reason);
});

test('replays the authorized depositor or vault destination map', () => {
  const source = clone(STATE_ORACLE);
  source.settlementAddressMap = { [A]: { payoutAddress: B } };
  const settlement = buildTradeLayerPnlNettingSettlement(source);
  assertEq(settlement.routePlan.outputPlan.find((row) => row.accountAddress === A).address, B);
  const result = verifyTradeLayerPnlNettingSettlement(settlement, { stateOracleBlob: source });
  assert(result.ok, result.reason);
  assertEq(result.reserveFeasibilityVerified, false);
});

test('rejects omitted source rows after the producer recomputes its hashes', () => {
  const settlement = clone(buildTradeLayerPnlNettingSettlement(STATE_ORACLE));
  settlement.rows = [];
  settlement.core.pnlRowRoot = sha256Hex([]);
  settlement.settlementHash = sha256Hex(settlement.core);
  const result = verifyTradeLayerPnlNettingSettlement(settlement, { stateOracleBlob: STATE_ORACLE });
  assert(!result.ok && result.reason.includes('rows'), result.reason);
});

test('rejects gross edges disconnected from the authenticated PNL rows', () => {
  const settlement = clone(buildTradeLayerPnlNettingSettlement(STATE_ORACLE));
  settlement.grossEdges[0].rowId = 'unrelated-position';
  settlement.core.grossEdgeRoot = sha256Hex(settlement.grossEdges);
  settlement.settlementHash = sha256Hex(settlement.core);
  const result = verifyTradeLayerPnlNettingSettlement(settlement, { stateOracleBlob: STATE_ORACLE });
  assert(!result.ok && result.reason.includes('grossEdges'), result.reason);
});

test('binds top-level arithmetic scale and fallback mark in the source commitment', () => {
  const source = clone(STATE_ORACLE);
  const originalHash = buildTradeLayerPnlStateOracleCommitment(source).oracleBlobHash;
  source.priceScale = 2;
  assert(buildTradeLayerPnlStateOracleCommitment(source).oracleBlobHash !== originalHash, 'scale must be committed');
  source.closePrice = 99;
  const fallbackHash = buildTradeLayerPnlStateOracleCommitment(source).oracleBlobHash;
  source.closePrice = 100;
  assert(buildTradeLayerPnlStateOracleCommitment(source).oracleBlobHash !== fallbackHash, 'fallback mark must be committed');
});

test('binds the source epoch into the payout leaves', () => {
  const settlement = buildTradeLayerPnlNettingSettlement(STATE_ORACLE);
  assertEq(settlement.routePlan.epochId, STATE_ORACLE.epochId);
  const source = clone(STATE_ORACLE);
  source.epochId = '92';
  const next = buildTradeLayerPnlNettingSettlement(source);
  assert(settlement.core.withdrawalRootHex !== next.core.withdrawalRootHex, 'payout root must change across epochs');
  assert(!verifyTradeLayerPnlNettingSettlement(next, { stateOracleBlob: STATE_ORACLE }).ok);
});

test('rejects a self-consistent alternative input amount and fee', () => {
  const source = clone(STATE_ORACLE);
  source.dlcInput.sats += 1000;
  source.feeSats += 1000;
  const settlement = buildTradeLayerPnlNettingSettlement(source);
  const result = verifyTradeLayerPnlNettingSettlement(settlement, { stateOracleBlob: STATE_ORACLE });
  assert(!result.ok, 'alternative funding and fee must not verify');
});

test('requires a concrete input even when payout arithmetic is internally consistent', () => {
  const source = clone(STATE_ORACLE);
  delete source.dlcInput;
  const result = verifyTradeLayerPnlNettingSettlement(buildTradeLayerPnlNettingSettlement(source), { stateOracleBlob: source });
  assert(!result.ok && result.reason.includes('funding outpoint'), result.reason);
});

test('rejects duplicate row identities and duplicate positions under different row ids', () => {
  for (const distinctRowId of [false, true]) {
    const source = clone(STATE_ORACLE);
    const row = clone(source.pnlRows[0]);
    if (distinctRowId) row.rowId = 'different-row-same-position';
    source.pnlRows.push(row);
    let message = '';
    try { derivePnlRowsFromStateOracle(source); } catch (err) { message = err.message; }
    assert(message.includes('duplicate PNL'), message || 'duplicate must reject');
  }
});

test('rejects missing stable identities and same-account counterparties', () => {
  for (const mutation of [
    (row) => { delete row.id; },
    (row) => { row.counterpartyAddress = row.traderAddress; }
  ]) {
    const source = clone(STATE_ORACLE);
    mutation(source.pnlRows[0]);
    let threw = false;
    try { derivePnlRowsFromStateOracle(source); } catch { threw = true; }
    assert(threw, 'ambiguous or self-dealing row must reject');
  }
});

test('refuses explicit netting domains that the legacy fold cannot enforce', () => {
  for (const field of ['nettingSetId', 'collateralAssetId', 'propertyId', 'vaultId']) {
    const source = clone(STATE_ORACLE);
    source.pnlRows[0][field] = 'separate-domain';
    let message = '';
    try { derivePnlRowsFromStateOracle(source); } catch (err) { message = err.message; }
    assert(message.includes('explicit batch settlement gate'), message || 'domain must reject');
  }
});

test('producer override and bypass options cannot alter independent verification', () => {
  const outputPlan = clone(buildTradeLayerPnlNettingSettlement(STATE_ORACLE).routePlan.outputPlan);
  outputPlan[0].address = B;
  const settlement = buildTradeLayerPnlNettingSettlement(STATE_ORACLE, { outputPlan });
  const result = verifyTradeLayerPnlNettingSettlement(settlement, {
    stateOracleBlob: STATE_ORACLE,
    outputPlan,
    skipPlanHash: true,
    pnlRows: [],
    capSats: 0,
    allowClaimedPnlMismatch: true
  });
  assert(!result.ok, 'bypass options must not authorize redirected payout');
});

test('accepts a JSON wire round trip and rejects modified proof metadata', () => {
  const settlement = clone(buildTradeLayerPnlNettingSettlement(STATE_ORACLE));
  assert(verifyTradeLayerPnlNettingSettlement(settlement, { stateOracleBlob: STATE_ORACLE }).ok);
  settlement.payout.proofs[0].index += 1;
  assert(!verifyTradeLayerPnlNettingSettlement(settlement, { stateOracleBlob: STATE_ORACLE }).ok);
});

test('reports malformed candidate data as a rejection without throwing', () => {
  const settlement = buildTradeLayerPnlNettingSettlement(STATE_ORACLE);
  settlement.rows = undefined;
  const result = verifyTradeLayerPnlNettingSettlement(settlement, { stateOracleBlob: STATE_ORACLE });
  assert(!result.ok, 'missing rows must reject');
});

test('challenge construction requires the independent source as well', () => {
  let message = '';
  try { buildTradeLayerPnlNettingChallenge(buildTradeLayerPnlNettingSettlement(STATE_ORACLE)); } catch (err) { message = err.message; }
  assert(message.includes('independent options.stateOracleBlob'), message);
});

test('rejects a toJSON hook that hides a redirected destination without invoking the hook', () => {
  const honest = buildTradeLayerPnlNettingSettlement(STATE_ORACLE);
  const candidate = buildTradeLayerPnlNettingSettlement(STATE_ORACLE);
  candidate.routePlan.outputPlan[0].address = B;
  let calls = 0;
  candidate.routePlan.toJSON = () => { calls++; return honest.routePlan; };
  const result = verifyTradeLayerPnlNettingSettlement(candidate, { stateOracleBlob: STATE_ORACLE });
  assert(!result.ok, 'executable serialization hook must reject');
  assertEq(calls, 0, 'candidate hook must never execute');
});

test('ignores inherited toJSON hooks while comparing honest plain data', () => {
  const settlement = buildTradeLayerPnlNettingSettlement(STATE_ORACLE);
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  let calls = 0;
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value() { calls++; throw new Error('inherited hook executed'); }
    });
    const result = verifyTradeLayerPnlNettingSettlement(settlement, { stateOracleBlob: STATE_ORACLE });
    assert(result.ok, result.reason);
    assertEq(calls, 0);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'toJSON', previous);
    else delete Object.prototype.toJSON;
  }
});

test('rejects candidate, source and verification-option getters before they execute', () => {
  for (const target of ['candidate', 'route', 'source', 'options', 'proof']) {
    const candidate = buildTradeLayerPnlNettingSettlement(STATE_ORACLE);
    const source = clone(STATE_ORACLE);
    const options = { stateOracleBlob: source };
    const [object, field] = target === 'candidate' ? [candidate, 'kind']
      : target === 'route' ? [candidate.routePlan, 'outputPlan']
        : target === 'source' ? [source, 'pnlRows']
          : target === 'options' ? [options, 'stateOracleBlob']
            : [candidate.payout.proofs[0], 'siblings'];
    let calls = 0;
    Object.defineProperty(object, field, {
      configurable: true, enumerable: true,
      get() { calls++; throw new Error('getter executed'); }
    });
    assert(!verifyTradeLayerPnlNettingSettlement(candidate, options).ok, `${target} getter must reject`);
    assertEq(calls, 0, `${target} getter executed`);
  }
});

test('rejects Proxy candidates, sources, options and proof arrays without invoking traps', () => {
  for (const target of ['candidate', 'source', 'options', 'proofs']) {
    let candidate = buildTradeLayerPnlNettingSettlement(STATE_ORACLE);
    let options = { stateOracleBlob: STATE_ORACLE };
    let calls = 0;
    const traps = {
      get() { calls++; throw new Error('Proxy get trap executed'); },
      ownKeys() { calls++; throw new Error('Proxy ownKeys trap executed'); },
      getPrototypeOf() { calls++; throw new Error('Proxy prototype trap executed'); }
    };
    if (target === 'candidate') candidate = new Proxy(candidate, traps);
    else if (target === 'source') options.stateOracleBlob = new Proxy(STATE_ORACLE, traps);
    else if (target === 'options') options = new Proxy(options, traps);
    else candidate.payout.proofs = new Proxy(candidate.payout.proofs, traps);
    assert(!verifyTradeLayerPnlNettingSettlement(candidate, options).ok, `${target} Proxy must reject`);
    assertEq(calls, 0, `${target} Proxy trap executed`);
  }
});

test('rejects modified Buffer hooks and accessor proof siblings without executing them', () => {
  for (const target of ['buffer', 'sibling-array']) {
    const candidate = buildTradeLayerPnlNettingSettlement(STATE_ORACLE);
    let calls = 0;
    if (target === 'buffer') {
      candidate.payout.proofs[0].siblings[0].toJSON = () => { calls++; return {}; };
    } else {
      Object.defineProperty(candidate.payout.proofs[0].siblings, '0', {
        configurable: true, enumerable: true,
        get() { calls++; throw new Error('proof getter executed'); }
      });
    }
    assert(!verifyTradeLayerPnlNettingSettlement(candidate, { stateOracleBlob: STATE_ORACLE }).ok);
    assertEq(calls, 0);
  }
});

test('ignores inherited optional source fields and inherited payout mappings', () => {
  const candidate = buildTradeLayerPnlNettingSettlement(STATE_ORACLE);
  const inheritedFields = ['settlementAddressMap', 'expectedStateOracleHash', 'requireLivePayees', A];
  const previous = new Map(inheritedFields.map((field) => [field, Object.getOwnPropertyDescriptor(Object.prototype, field)]));
  let calls = 0;
  try {
    for (const field of inheritedFields) {
      Object.defineProperty(Object.prototype, field, {
        configurable: true, get() { calls++; throw new Error('inherited field getter executed'); }
      });
    }
    const result = verifyTradeLayerPnlNettingSettlement(candidate, { stateOracleBlob: STATE_ORACLE });
    assert(result.ok, result.reason);
    assertEq(calls, 0);
  } finally {
    for (const field of inheritedFields) {
      const descriptor = previous.get(field);
      if (descriptor) Object.defineProperty(Object.prototype, field, descriptor);
      else delete Object.prototype[field];
    }
  }
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
