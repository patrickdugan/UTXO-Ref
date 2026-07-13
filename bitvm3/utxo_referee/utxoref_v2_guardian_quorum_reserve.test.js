const a = require('./tradelayer_dlc_adaptor_sig');
const {
  buildGuardianQuorumVaultTemplate,
  buildGuardianQuorumVaultManifest,
  verifyGuardianQuorumVaultManifest,
  buildGuardianQuorumFeeReserve,
  verifyGuardianQuorumFeeReserve
} = require('./utxoref_v2_guardian_quorum_reserve');
const { verifyUtxorefV2FeeReserve } = require('./utxoref_v2_fee_reserve');
const { sha256Hex } = require('./tradelayer_pnl_route_adapter');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
function key(secret) { return a.xOnlyPubkey(BigInt(secret)).toString('hex'); }

const GRAPH = '11'.repeat(32);
const GUARDIANS = [key(2), key(3), key(4)];

function template(overrides = {}) {
  return buildGuardianQuorumVaultTemplate({
    network: 'bitcoin-regtest',
    bindingHash: GRAPH,
    operatorXonly: key(1),
    guardianXonlys: GUARDIANS,
    guardianThreshold: 2,
    recoveryXonly: key(5),
    recoveryCsvDelay: 144,
    ...overrides
  });
}

function reserve(overrides = {}) {
  return buildGuardianQuorumFeeReserve({
    network: 'bitcoin-regtest',
    graphHash: GRAPH,
    disputeId: 'quorum-reserve-test',
    fundingOutpoint: { txid: '22'.repeat(32), vout: 1 },
    fundingHeight: 100,
    amountSats: 12000,
    maxFeeSats: 10000,
    challengeWindowBlocks: 18,
    confirmationTarget: 2,
    recoverySafetyBlocks: 6,
    recoveryCsvDelay: 144,
    challengerXonly: key(1),
    guardianXonlys: GUARDIANS,
    guardianThreshold: 2,
    refundXonly: key(5),
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

test('2-of-3 template is deterministic and commits graph, challenger, and CHECKSIGADD quorum', () => {
  const first = template();
  const second = template();
  assert(first.p2trScriptPubKey === second.p2trScriptPubKey);
  assert(first.merkleRoot === second.merkleRoot);
  assert(first.immediateLeaf.scriptHex.includes(GRAPH));
  assert(first.immediateLeaf.scriptHex.includes(key(1)));
  assert(first.immediateLeaf.scriptHex.includes('ba'));
  assert(first.guardianThreshold === 2 && first.guardianXonlys.length === 3);
});

test('guardian policy rejects duplicate, undersized, and overlapping role sets', () => {
  const invalid = [
    { guardianXonlys: [GUARDIANS[0], GUARDIANS[0]], guardianThreshold: 2 },
    { guardianXonlys: [GUARDIANS[0]], guardianThreshold: 1 },
    { guardianThreshold: 1 },
    { operatorXonly: GUARDIANS[0] },
    { recoveryXonly: GUARDIANS[0] }
  ];
  for (const overrides of invalid) {
    let rejected = false;
    try { template(overrides); } catch (_err) { rejected = true; }
    assert(rejected, `expected policy rejection for ${JSON.stringify(overrides)}`);
  }
});

test('manifest verification reconstructs every taproot commitment and fails on mutation', () => {
  const manifest = buildGuardianQuorumVaultManifest({
    network: 'bitcoin-regtest',
    fundingOutpoint: { txid: '22'.repeat(32), vout: 1 },
    amountSats: 12000,
    observedAtHeight: 100,
    reserveEpochId: 'quorum-reserve-test',
    bindingHash: GRAPH,
    operatorXonly: key(1),
    guardianXonlys: GUARDIANS,
    guardianThreshold: 2,
    recoveryXonly: key(5),
    recoveryCsvDelay: 144
  });
  const valid = verifyGuardianQuorumVaultManifest(manifest, { currentHeight: 110, recoveryRiskMarginBlocks: 26 });
  assert(valid.ok && valid.countable);
  assert(/^[0-9a-f]{64}$/.test(manifest.core.guardianSetHash));
  const changed = JSON.parse(JSON.stringify(manifest));
  changed.core.guardianThreshold = 3;
  const invalid = verifyGuardianQuorumVaultManifest(changed, { currentHeight: 110 });
  assert(!invalid.ok && /hash mismatch/.test(invalid.reason));
  const changedSet = JSON.parse(JSON.stringify(manifest));
  changedSet.core.guardianSetHash = 'ff'.repeat(32);
  changedSet.manifestHash = sha256Hex(changedSet.core);
  const invalidSet = verifyGuardianQuorumVaultManifest(changedSet, { currentHeight: 110 });
  assert(!invalidSet.ok && /set hash mismatch/.test(invalidSet.reason));
});

test('confirmed quorum reserve passes both specialized and generic live verification', () => {
  const r = reserve();
  for (const verify of [verifyGuardianQuorumFeeReserve, verifyUtxorefV2FeeReserve]) {
    const result = verify(r, { graphHash: GRAPH, currentHeight: 110, txout: txout(r) });
    assert(result.ok && result.counted, result.reason);
    assert(result.guardianThreshold === 2 && result.guardianCount === 3);
  }
});

test('quorum reserve fails closed for a spent, wrong-script, or near-recovery UTXO', () => {
  const r = reserve();
  const cases = [
    [null, /confirmed/],
    [txout(r, { scriptPubKey: { hex: `5120${'00'.repeat(32)}` } }), /scriptPubKey mismatch/],
    [txout(r, { confirmations: 121 }), /risk window|challenge horizon/]
  ];
  const heights = [110, 110, 220];
  cases.forEach(([chainTxout, pattern], index) => {
    const result = verifyGuardianQuorumFeeReserve(r, {
      graphHash: GRAPH,
      currentHeight: heights[index],
      txout: chainTxout
    });
    assert(!result.ok && pattern.test(result.reason), `expected ${pattern}, got ${result.reason}`);
  });
});

let passed = 0;
let failed = 0;
for (const item of tests) {
  try { item.fn(); console.log(`  OK  ${item.name}`); passed += 1; }
  catch (err) { console.log(`  FAIL ${item.name}\n       ${err.message}`); failed += 1; }
}
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
