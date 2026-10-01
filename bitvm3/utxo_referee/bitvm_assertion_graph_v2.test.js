const crypto = require('crypto');
const a = require('./tradelayer_dlc_adaptor_sig');
const {
  buildSignedStateCheckpointV2,
  publicKeyId
} = require('./utxoref_v2');
const {
  buildWireSecretSetV2,
  buildPublicTraceV2,
  traceCommitment
} = require('./bitvm_trace_v2');
const {
  deriveAssertionNumsXonly,
  buildSettlementTraceBindingV2,
  buildBitvmAssertionTemplateV2,
  verifyBitvmAssertionTemplateV2,
  containsPrivateMaterial,
  computeBitvmAssertionGraphHashV2,
  finalizeBitvmAssertionGraphV2,
  verifyBitvmAssertionGraphV2,
  buildBitvmDisproveV2,
  verifyBitvmDisproveV2
} = require('./bitvm_assertion_graph_v2');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const KEY_ID = publicKeyId(publicKey);
const TRUST = { [KEY_ID]: publicKey };
const NETWORK = 'bitcoin-testnet4';
const CONTRACT_ID = '42'.repeat(32);
const GENESIS = '11'.repeat(32);
const ASSERTION_TXID = 'aa'.repeat(32);
const RECOVERY_SPK = '0014' + '09'.repeat(20);
const CHALLENGE_SPK = '0014' + '08'.repeat(20);
const OPERATOR_SECRET = 0x12345n;
const CHALLENGER_SECRET = 0x67890n;
const OPERATOR_XONLY = a.xOnlyPubkey(OPERATOR_SECRET).toString('hex');
const CHALLENGER_XONLY = a.xOnlyPubkey(CHALLENGER_SECRET).toString('hex');
const GATES = [{ type: 'and', inputs: ['a', 'b'], output: 'c' }];

const BODY = {
  network: NETWORK,
  chainGenesisHash: GENESIS,
  contractId: CONTRACT_ID,
  epochId: '91',
  snapshotHeight: 1000,
  snapshotBlockHash: '22'.repeat(32),
  settlementAddressMap: {
    A: { address: 'winner-a', scriptPubKeyHex: '0014' + '01'.repeat(20) },
    C: { address: 'winner-c', scriptPubKeyHex: '0014' + '03'.repeat(20) }
  },
  pnlRows: [
    {
      id: 'a-wins-from-b', contractId: CONTRACT_ID, side: 'long',
      entryPrice: 2100, closePrice: 2200, quantityUnits: 30,
      collateralSats: 50000, traderAddress: 'A', counterpartyAddress: 'B'
    },
    {
      id: 'c-wins-from-b', contractId: CONTRACT_ID, side: 'long',
      entryPrice: 2100, closePrice: 2200, quantityUnits: 20,
      collateralSats: 50000, traderAddress: 'C', counterpartyAddress: 'B'
    }
  ]
};

const STATE_ENVELOPE = buildSignedStateCheckpointV2(BODY, { privateKey, publicKey });
const STATE_VERIFICATION = {
  trustedSigners: TRUST,
  expectedNetwork: NETWORK,
  expectedGenesisHash: GENESIS,
  currentHeight: 1002
};

function buildFixture(values = { a: 1, b: 1, c: 1 }, expectedInputs = { a: 1, b: 1 }) {
  const binding = buildSettlementTraceBindingV2({ stateEnvelope: STATE_ENVELOPE, feeSats: '1000' });
  const wireBundle = buildWireSecretSetV2(['a', 'b', 'c']);
  const publicTrace = buildPublicTraceV2({
    circuitId: 'utxoref-settlement-and-v2',
    binding,
    gates: GATES,
    wireBundle,
    values
  });
  const template = buildBitvmAssertionTemplateV2({
    network: NETWORK,
    publicTrace,
    expectedInputs,
    operatorXonly: OPERATOR_XONLY,
    challengerXonly: CHALLENGER_XONLY,
    challengeCsvBlocks: 6,
    recoveryCsvBlocks: 144
  });
  const graph = finalizeBitvmAssertionGraphV2({
    template,
    publicTrace,
    stateEnvelope: STATE_ENVELOPE,
    stateVerification: STATE_VERIFICATION,
    assertionOutpoint: {
      txid: ASSERTION_TXID,
      vout: 0,
      amountSats: binding.assertionAmountSats,
      scriptPubKeyHex: template.p2trScriptPubKey
    },
    feeSats: binding.feeSats,
    recoveryFeeSats: '500',
    recoveryScriptPubKeyHex: RECOVERY_SPK,
    operatorSecret: OPERATOR_SECRET,
    challengerSecret: CHALLENGER_SECRET,
    operatorAux: Buffer.alloc(32, 1),
    challengerAux: Buffer.alloc(32, 2),
    recoveryAux: Buffer.alloc(32, 3)
  });
  return { binding, wireBundle, publicTrace, template, graph };
}

console.log('\n=== BitVM Assertion Graph V2 Tests ===\n');

test('assertion output uses only the deterministic NUMS internal key', () => {
  const { publicTrace, template } = buildFixture();
  assert(template.internalKeyPolicy === 'deterministic-nums-no-keypath-v2');
  assert(template.internalXonly === deriveAssertionNumsXonly(NETWORK));
  assert(template.internalXonly !== OPERATOR_XONLY);
  assert(verifyBitvmAssertionTemplateV2(template, publicTrace).ok);
  let rejected = false;
  try {
    buildBitvmAssertionTemplateV2({
      network: NETWORK,
      publicTrace,
      expectedInputs: { a: 1, b: 1 },
      operatorXonly: OPERATOR_XONLY,
      challengerXonly: CHALLENGER_XONLY,
      challengeCsvBlocks: 6,
      recoveryCsvBlocks: 144,
      internalXonly: OPERATOR_XONLY
    });
  } catch (err) {
    rejected = /custom internal key is forbidden/.test(err.message);
  }
  assert(rejected, 'known internal key must be rejected');
});

test('assertion template binds every primary circuit input', () => {
  const { publicTrace } = buildFixture();
  let rejected = false;
  try {
    buildBitvmAssertionTemplateV2({
      network: NETWORK,
      publicTrace,
      expectedInputs: { a: 1 },
      operatorXonly: OPERATOR_XONLY,
      challengerXonly: CHALLENGER_XONLY,
      challengeCsvBlocks: 6,
      recoveryCsvBlocks: 144
    });
  } catch (err) { rejected = /exactly match/.test(err.message); }
  assert(rejected);
});

test('the P2TR tree itself commits the signed-state trace binding', () => {
  const fixture = buildFixture();
  const changedTrace = clone(fixture.publicTrace);
  changedTrace.binding.stateCheckpointHash = 'ff'.repeat(32);
  Object.assign(changedTrace, traceCommitment(changedTrace));
  const changedTemplate = buildBitvmAssertionTemplateV2({
    network: NETWORK,
    publicTrace: changedTrace,
    expectedInputs: { a: 1, b: 1 },
    operatorXonly: OPERATOR_XONLY,
    challengerXonly: CHALLENGER_XONLY,
    challengeCsvBlocks: 6,
    recoveryCsvBlocks: 144
  });
  assert(changedTemplate.assertionTreeRoot !== fixture.template.assertionTreeRoot);
  assert(changedTemplate.p2trScriptPubKey !== fixture.template.p2trScriptPubKey);
  assert(changedTemplate.leaves.some((leaf) => leaf.id === 'trace-commitment'));
});

test('exact settlement is pre-signed by operator and challenger', () => {
  const { graph } = buildFixture();
  const result = verifyBitvmAssertionGraphV2(graph, STATE_VERIFICATION);
  assert(result.ok, result.reason);
  assert(result.fraudCount === 0);
  assert(graph.settlement.outputs.length === 2);
  assert(graph.settlementPath.witness[0] === graph.settlementPath.challengerSignature);
  assert(graph.settlementPath.witness[1] === graph.settlementPath.operatorSignature);
  assert(!containsPrivateMaterial(graph), 'public graph must not contain signer or wire secrets');
});

test('trace binding rejects a different signed state or payout vector', () => {
  const fixture = buildFixture();
  const publicTrace = clone(fixture.publicTrace);
  publicTrace.binding.feeSats = '999';
  let rejected = false;
  try {
    finalizeBitvmAssertionGraphV2({
      template: fixture.template,
      publicTrace,
      stateEnvelope: STATE_ENVELOPE,
      stateVerification: STATE_VERIFICATION,
      assertionOutpoint: fixture.graph.assertionOutpoint,
      feeSats: '1000',
      recoveryScriptPubKeyHex: RECOVERY_SPK,
      operatorSecret: OPERATOR_SECRET,
      challengerSecret: CHALLENGER_SECRET
    });
  } catch (err) {
    rejected = /invalid assertion template|not bound/.test(err.message);
  }
  assert(rejected, 'mutated trace binding must fail');
});

test('recomputed graph hash cannot authorize a missing co-signature or redirected payout', () => {
  const missingSignature = clone(buildFixture().graph);
  missingSignature.settlementPath.challengerSignature = '00'.repeat(64);
  missingSignature.settlementPath.witness[0] = missingSignature.settlementPath.challengerSignature;
  missingSignature.graphHash = computeBitvmAssertionGraphHashV2(missingSignature);
  const signatureCheck = verifyBitvmAssertionGraphV2(missingSignature, STATE_VERIFICATION);
  assert(!signatureCheck.ok && /challenger settlement signature/.test(signatureCheck.reason), signatureCheck.reason);

  const redirected = clone(buildFixture().graph);
  redirected.settlement.unsignedTxHex = redirected.recoveryPath.unsignedTxHex;
  redirected.graphHash = computeBitvmAssertionGraphHashV2(redirected);
  const outputCheck = verifyBitvmAssertionGraphV2(redirected, STATE_VERIFICATION);
  assert(!outputCheck.ok && /settlement verification failed/.test(outputCheck.reason), outputCheck.reason);
});

test('fraudulent gate trace creates an immediate committed disprove spend', () => {
  const { graph } = buildFixture({ a: 1, b: 1, c: 0 });
  const graphCheck = verifyBitvmAssertionGraphV2(graph, STATE_VERIFICATION);
  assert(graphCheck.ok && graphCheck.fraudCount === 1, graphCheck.reason);
  const disprove = buildBitvmDisproveV2(graph, {
    stateVerification: STATE_VERIFICATION,
    challengerSecret: CHALLENGER_SECRET,
    challengerAux: Buffer.alloc(32, 4),
    feeSats: '400',
    challengeScriptPubKeyHex: CHALLENGE_SPK
  });
  const result = verifyBitvmDisproveV2(graph, disprove, STATE_VERIFICATION);
  assert(result.ok, result.reason);
  assert(result.fraudType === 'gate');
});

test('wrong public input creates an input-binding disprove spend', () => {
  const { graph } = buildFixture({ a: 0, b: 1, c: 0 }, { a: 1, b: 1 });
  const disprove = buildBitvmDisproveV2(graph, {
    stateVerification: STATE_VERIFICATION,
    fraudType: 'input',
    challengerSecret: CHALLENGER_SECRET,
    feeSats: '400',
    challengeScriptPubKeyHex: CHALLENGE_SPK
  });
  const result = verifyBitvmDisproveV2(graph, disprove, STATE_VERIFICATION);
  assert(result.ok, result.reason);
  assert(result.fraudType === 'input');
});

test('an honest trace exposes no spendable disprove witness', () => {
  const { graph } = buildFixture();
  let rejected = false;
  try {
    buildBitvmDisproveV2(graph, {
      stateVerification: STATE_VERIFICATION,
      challengerSecret: CHALLENGER_SECRET,
      feeSats: '400',
      challengeScriptPubKeyHex: CHALLENGE_SPK
    });
  } catch (err) {
    rejected = /no constructible fraud proof/.test(err.message);
  }
  assert(rejected, 'honest trace must not produce a disprove spend');
});

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
