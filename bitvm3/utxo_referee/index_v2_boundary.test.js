const api = require('./index');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

console.log('\n=== UTXORef V2 Package Boundary Tests ===\n');

test('V2 settlement, trace, and assertion graph are the named package API', () => {
  assert(typeof api.v2.settlement.verifyUtxoRefSettlementV2 === 'function');
  assert(typeof api.v2.trace.verifyPublicTraceV2 === 'function');
  assert(typeof api.v2.assertionGraph.verifyBitvmAssertionGraphV2 === 'function');
});

test('unsafe V1 sweep and public-wire helpers are absent at top level', () => {
  for (const name of [
    'verifySweep',
    'buildTreeWithProofs',
    'buildBitvmWire',
    'commitBitvmCircuitWires',
    'buildTradeLayerPerpPnlSettlement',
    'buildTradeLayerBitvmStackBundle',
    'tradeLayerUtxoRefLivePath'
  ]) {
    assert(api[name] === undefined, `${name} must not be a top-level export`);
  }
});

test('legacy namespace refuses implicit loading', () => {
  let rejected = false;
  try { api.legacyUnsafe.load(); }
  catch (err) { rejected = /acknowledgeUnsafePrototype/.test(err.message); }
  assert(rejected, 'legacy namespace must require explicit acknowledgement');
});

test('acknowledged legacy namespace preserves historical reproducibility', () => {
  const legacy = api.legacyUnsafe.load({ acknowledgeUnsafePrototype: true });
  assert(typeof legacy.verifySweep === 'function');
  assert(typeof legacy.buildBitvmWire === 'function');
  assert(typeof legacy.buildTradeLayerPerpPnlSettlement === 'function');
  assert(Object.isFrozen(legacy));
  assert(/UNSAFE V1 PROTOTYPES/.test(api.legacyUnsafe.warning));
});

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
