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

test('unsafe V1 circuit, public-wire and settlement helpers are absent at top level', () => {
  for (const name of [
    'RefereeCircuit',
    'generateRefereeCircuit',
    'buildBitCommitment',
    'buildBitvmWire',
    'commitBitvmCircuitWires',
    'buildTradeLayerPerpPnlSettlement',
    'buildTradeLayerBitvmStackBundle',
    'tradeLayerUtxoRefLivePath',
    'circuit'
  ]) {
    assert(api[name] === undefined, `${name} must not be a top-level export`);
  }
});

// pilot-merge: the sweep verifier was hardened on main and is scored through
// this entry point by the locked eval/utxo_referee_eval.js, so it is exported
// at top level again. This test replaces the old name check with a behaviour
// check: it may only be top-level while it rejects the red-team proof shapes.
test('top-level sweep verifier rejects replayed positions and non-canonical indices', () => {
  const script = (id) => Buffer.concat([Buffer.from([0x00, 0x14]), Buffer.alloc(20, id)]);
  const leaves = [1, 2].map((id) => new api.PayoutLeaf({ epochId: 9n, recipientScriptPubKey: script(id), amountSats: 1000n }));
  const { root, proofs } = api.buildTreeWithProofs(leaves);
  const commitment = new api.CommitmentPackage({ epochId: 9n, withdrawalRoot: root, capSats: 5000n, residualDest: script(9) });
  const sweep = (payouts) => ({
    epochIdCommitted: 9n,
    payoutOutputs: payouts,
    residualOutput: {
      recipientScriptPubKey: script(9),
      amountSats: 5000n - payouts.reduce((sum, output) => sum + output.amountSats, 0n)
    }
  });
  const payout = (index, proof = proofs[index]) => ({
    recipientScriptPubKey: leaves[index].recipientScriptPubKey,
    amountSats: leaves[index].amountSats,
    merkleProof: proof
  });
  assert(api.verifySweep(commitment, sweep([payout(0), payout(1)])).ok === true, 'valid sweep must verify');
  assert(api.verifySweep(commitment, sweep([payout(0), payout(0)])).ok === false, 'a Merkle position must not be paid twice');
  assert(api.verifySweep(commitment, sweep([payout(0, { ...proofs[0], index: '0' })])).ok === false, 'string index must be rejected');
  assert(api.verifySweep(commitment, sweep([payout(0, { ...proofs[0], index: 0.5 })])).ok === false, 'fractional index must be rejected');
  assert(api.verifySweep(commitment, sweep([payout(0, { ...proofs[0], siblings: 'x' })])).ok === false, 'malformed siblings must not throw');
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
