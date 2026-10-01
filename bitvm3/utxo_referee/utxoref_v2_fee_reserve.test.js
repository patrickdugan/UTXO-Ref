const a = require('./tradelayer_dlc_adaptor_sig');
const {
  buildUtxorefV2FeeReserve,
  verifyUtxorefV2FeeReserve,
  buildUtxorefV2FeeReserveRegistry
} = require('./utxoref_v2_fee_reserve');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
function key(value) { return a.xOnlyPubkey(BigInt(value)).toString('hex'); }

const GRAPH = '11'.repeat(32);
const FUNDING = { txid: '22'.repeat(32), vout: 1 };

function reserve(overrides = {}) {
  return buildUtxorefV2FeeReserve({
    network: 'bitcoin-regtest',
    graphHash: GRAPH,
    disputeId: 'dispute-1',
    fundingOutpoint: FUNDING,
    fundingHeight: 100,
    amountSats: 12000,
    maxFeeSats: 10000,
    challengeWindowBlocks: 18,
    confirmationTarget: 2,
    recoverySafetyBlocks: 6,
    recoveryCsvDelay: 144,
    challengerXonly: key(1),
    guardianXonly: key(2),
    refundXonly: key(3),
    ...overrides
  });
}

function txout(r = reserve(), overrides = {}) {
  return {
    valueSats: r.core.amountSats,
    scriptPubKey: { hex: r.core.vaultManifest.core.p2trScriptPubKey },
    confirmations: 11,
    bestblock: '44'.repeat(32),
    ...overrides
  };
}

test('graph hash and distinct refund key are committed into both Taproot leaves', () => {
  const first = reserve();
  const second = reserve({ graphHash: '33'.repeat(32), disputeId: 'dispute-2', fundingOutpoint: { txid: '55'.repeat(32), vout: 0 } });
  const vault = first.core.vaultManifest.core;
  assert(vault.bindingHash === GRAPH);
  assert(vault.recoveryXonly === key(3));
  assert(vault.leaves['immediate-operator-guardian'].scriptHex.includes(GRAPH));
  assert(vault.leaves['recovery-operator-csv'].scriptHex.includes(GRAPH));
  assert(vault.p2trScriptPubKey !== second.core.vaultManifest.core.p2trScriptPubKey);
});

test('confirmed live UTXO is counted only while recovery exceeds the challenge horizon', () => {
  const r = reserve();
  const verification = verifyUtxorefV2FeeReserve(r, { graphHash: GRAPH, currentHeight: 110, txout: txout(r) });
  assert(verification.ok && verification.counted);
  assert(verification.remainingBlocks === 134);
  const nearRecovery = verifyUtxorefV2FeeReserve(r, {
    graphHash: GRAPH,
    currentHeight: 220,
    txout: txout(r, { confirmations: 121 })
  });
  assert(!nearRecovery.ok && /challenge horizon/.test(nearRecovery.reason));
});

test('spent, unconfirmed, wrong amount, and wrong script reserves fail closed', () => {
  const r = reserve();
  const cases = [
    [null, /confirmed/],
    [txout(r, { confirmations: 0 }), /confirmed/],
    [txout(r, { valueSats: '11999' }), /amount mismatch/],
    [txout(r, { scriptPubKey: { hex: `5120${'00'.repeat(32)}` } }), /scriptPubKey mismatch/]
  ];
  for (const [chainTxout, pattern] of cases) {
    const result = verifyUtxorefV2FeeReserve(r, { graphHash: GRAPH, currentHeight: 110, txout: chainTxout });
    assert(!result.ok && pattern.test(result.reason), `expected ${pattern}, got ${result.reason}`);
  }
});

test('manifest, graph, funding-height, and minimum-amount mutations fail closed', () => {
  const r = reserve();
  const tampered = JSON.parse(JSON.stringify(r));
  tampered.core.maxFeeSats = '1';
  assert(/hash mismatch/.test(verifyUtxorefV2FeeReserve(tampered, { currentHeight: 110, txout: txout(r) }).reason));
  assert(/graph hash mismatch/.test(verifyUtxorefV2FeeReserve(r, {
    graphHash: '99'.repeat(32), currentHeight: 110, txout: txout(r)
  }).reason));
  assert(/funding height/.test(verifyUtxorefV2FeeReserve(r, {
    currentHeight: 110, txout: txout(r, { confirmations: 10 })
  }).reason));
  assert(/policy minimum/.test(verifyUtxorefV2FeeReserve(r, {
    currentHeight: 110, txout: txout(r), minimumFeeReserveSats: 13000
  }).reason));
});

test('registry prevents one outpoint or dispute from backing multiple obligations', () => {
  const first = reserve();
  const sameOutpoint = reserve({ graphHash: '33'.repeat(32), disputeId: 'dispute-2' });
  let duplicateOutpoint = false;
  try { buildUtxorefV2FeeReserveRegistry({ reserves: [first, sameOutpoint], currentHeight: 110 }); }
  catch (err) { duplicateOutpoint = /assigned more than once/.test(err.message); }
  assert(duplicateOutpoint);

  const sameDispute = reserve({ fundingOutpoint: { txid: '66'.repeat(32), vout: 0 } });
  let duplicateDispute = false;
  try { buildUtxorefV2FeeReserveRegistry({ reserves: [first, sameDispute], currentHeight: 110 }); }
  catch (err) { duplicateDispute = /more than one fee reserve/.test(err.message); }
  assert(duplicateDispute);
});

test('registry records only independently verified live reserves', () => {
  const r = reserve();
  const outpoint = `${FUNDING.txid}:${FUNDING.vout}`;
  const registry = buildUtxorefV2FeeReserveRegistry({
    reserves: [r],
    currentHeight: 110,
    chainTxouts: { [outpoint]: txout(r) }
  });
  assert(registry.core.countedReserveCount === 1);
  assert(registry.core.entries[0].verification.graphHash === GRAPH);
});

let passed = 0;
let failed = 0;
for (const item of tests) {
  try { item.fn(); console.log(`  OK  ${item.name}`); passed += 1; }
  catch (err) { console.log(`  FAIL ${item.name}\n       ${err.message}`); failed += 1; }
}
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
