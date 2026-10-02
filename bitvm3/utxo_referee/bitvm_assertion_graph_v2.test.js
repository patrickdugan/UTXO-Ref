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
// Live circuit shape: both primary inputs are facts the verifier derives
// from the signed state (BVM-1), and the terminal output must be 1.
const IN_STATE = 'state_checkpoint_valid';
const IN_PAYOUT = 'payout_vector_exact';
const OUT = 'settlement_authorized';
const GATES = [{ type: 'and', inputs: [IN_STATE, IN_PAYOUT], output: OUT }];
const bits = (state, payout, out) => ({ [IN_STATE]: state, [IN_PAYOUT]: payout, [OUT]: out });
const DERIVED = { [IN_STATE]: 1, [IN_PAYOUT]: 1 };

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

function buildFixture(values = bits(1, 1, 1), expectedInputs = DERIVED, options = {}) {
  const binding = buildSettlementTraceBindingV2({ stateEnvelope: STATE_ENVELOPE, feeSats: '1000' });
  const gates = options.gates || GATES;
  const labels = [...new Set(gates.flatMap((gate) => [...gate.inputs, gate.output]))];
  const wireBundle = buildWireSecretSetV2(labels);
  const publicTrace = buildPublicTraceV2({
    circuitId: 'utxoref-settlement-and-v2',
    binding,
    gates,
    wireBundle,
    values
  });
  const template = buildBitvmAssertionTemplateV2({
    network: NETWORK,
    publicTrace,
    // null: let the builder derive every expected input.
    ...(expectedInputs === null ? {} : { expectedInputs }),
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
      expectedInputs: DERIVED,
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
      expectedInputs: { [IN_STATE]: 1 },
      operatorXonly: OPERATOR_XONLY,
      challengerXonly: CHALLENGER_XONLY,
      challengeCsvBlocks: 6,
      recoveryCsvBlocks: 144
    });
  } catch (err) { rejected = /verifier derives from the signed state/.test(err.message); }
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
    expectedInputs: DERIVED,
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
  const { graph } = buildFixture(bits(1, 1, 0));
  const graphCheck = verifyBitvmAssertionGraphV2(graph, STATE_VERIFICATION);
  // AND(1,1) revealed as 0 is a gate fraud and also a terminal-output fraud.
  assert(graphCheck.ok && graphCheck.gateFraudCount === 1 && graphCheck.outputBindingFraudCount === 1 &&
    graphCheck.fraudCount === 2, graphCheck.reason);
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
  const { graph } = buildFixture(bits(0, 1, 0), DERIVED);
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

// ---- BVM-1 / BVM-3 (port of readiness-assessment poc4) ----

test('BVM-1: a template cannot name its own input constants', () => {
  // The poc: trace says the state checkpoint is invalid and settlement is not
  // authorized, with expectedInputs chosen to match. The template is refused.
  let error = null;
  try { buildFixture(bits(0, 1, 0), { [IN_STATE]: 0, [IN_PAYOUT]: 1 }); } catch (err) { error = err.message; }
  assert(error && /verifier derives from the signed state/.test(error), error || 'template accepted chosen constants');
  let unknown = null;
  try {
    buildFixture({ a: 1, b: 1, c: 1 }, null, { gates: [{ type: 'and', inputs: ['a', 'b'], output: 'c' }] });
  } catch (err) { unknown = err.message; }
  assert(unknown && /no verifier-derived value/.test(unknown), unknown || 'unbound input accepted');
});

test('BVM-1: the same trace with derived inputs is challengeable on the input and on the terminal output', () => {
  const { graph, template } = buildFixture(bits(0, 1, 0));
  assert(template.predicatePolicy === 'verifier-derived-inputs-terminal-one-v1' && template.terminalOutput === OUT);
  assert(template.leaves.some((leaf) => leaf.id === `output:${OUT}:0`), 'no disprove leaf for a 0 terminal reveal');
  const check = verifyBitvmAssertionGraphV2(graph, STATE_VERIFICATION);
  assert(check.ok && check.predicateBound === true && check.terminalOutputBit === 0, check.reason);
  assert(check.inputBindingFraudCount === 1 && check.outputBindingFraudCount === 1 && check.fraudCount === 2,
    JSON.stringify(check));
  for (const fraudType of ['input', 'output']) {
    const disprove = buildBitvmDisproveV2(graph, {
      stateVerification: STATE_VERIFICATION, fraudType, challengerSecret: CHALLENGER_SECRET,
      feeSats: '400', challengeScriptPubKeyHex: CHALLENGE_SPK
    });
    const result = verifyBitvmDisproveV2(graph, disprove, STATE_VERIFICATION);
    assert(result.ok && result.fraudType === fraudType, result.reason);
  }
});

test('BVM-1: a circuit over signed-state bits that honestly computes 0 is disprovable at the terminal output', () => {
  const binding = buildSettlementTraceBindingV2({ stateEnvelope: STATE_ENVELOPE, feeSats: '1000' });
  const hashBits = [...Buffer.from(binding.stateCheckpointHash, 'hex')]
    .flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((shift) => (byte >> shift) & 1));
  const zeroIndex = hashBits.indexOf(0);
  const hashLabel = `state_hash_bit_${zeroIndex}`;
  const gates = [{ type: 'and', inputs: [IN_STATE, hashLabel], output: OUT }];
  const values = { [IN_STATE]: 1, [hashLabel]: 0, [OUT]: 0 };
  const { graph } = buildFixture(values, null, { gates });
  const check = verifyBitvmAssertionGraphV2(graph, STATE_VERIFICATION);
  assert(check.ok && check.gateFraudCount === 0 && check.inputBindingFraudCount === 0 &&
    check.outputBindingFraudCount === 1, JSON.stringify(check));
  const disprove = buildBitvmDisproveV2(graph, {
    stateVerification: STATE_VERIFICATION, challengerSecret: CHALLENGER_SECRET,
    feeSats: '400', challengeScriptPubKeyHex: CHALLENGE_SPK
  });
  assert(disprove.fraudType === 'output' && verifyBitvmDisproveV2(graph, disprove, STATE_VERIFICATION).ok);
  // Lying about the signed-state bit is an input-binding fraud.
  const lie = buildFixture({ [IN_STATE]: 1, [hashLabel]: 1, [OUT]: 1 }, null, { gates });
  const lieCheck = verifyBitvmAssertionGraphV2(lie.graph, STATE_VERIFICATION);
  assert(lieCheck.ok && lieCheck.inputBindingFraudCount === 1 && lieCheck.outputBindingFraudCount === 0,
    JSON.stringify(lieCheck));
});

test('BVM-3: the challenge window has a policy minimum', () => {
  for (const challengeCsvBlocks of [0, 5]) {
    let error = null;
    try {
      const fixture = buildFixture();
      buildBitvmAssertionTemplateV2({
        network: NETWORK, publicTrace: fixture.publicTrace, operatorXonly: OPERATOR_XONLY,
        challengerXonly: CHALLENGER_XONLY, challengeCsvBlocks, recoveryCsvBlocks: 144
      });
    } catch (err) { error = err.message; }
    assert(error && /at least 6/.test(error), `challengeCsvBlocks ${challengeCsvBlocks} accepted`);
  }
  const { graph } = buildFixture();
  const raised = verifyBitvmAssertionGraphV2(graph, { ...STATE_VERIFICATION, minimumChallengeCsvBlocks: 144 });
  assert(!raised.ok && /below the 144-block policy minimum/.test(raised.reason), raised.reason);
});

test('BVM-1: the funded pre-policy testnet4 graph verifies only when pinned as monitor-only', () => {
  // The checked-in testnet4 artifact was funded before the bound-predicate
  // policy: its expected inputs are template constants and it has no
  // terminal-output leaf. It is refused by default and accepted, as
  // predicateBound: false, only for its own pinned hash.
  const fs = require('fs');
  const path = require('path');
  const live = path.join(__dirname, 'artifacts', 'live');
  const artifact = JSON.parse(fs.readFileSync(path.join(live, 'btc_testnet4_utxoref_v2_latest.json'), 'utf8'));
  const policy = JSON.parse(fs.readFileSync(path.join(live, 'utxoref_v2_watchtower_trust_policy.json'), 'utf8'));
  const graphPolicy = policy.allowedGraphs[artifact.graph.graphHash];
  assert(graphPolicy && graphPolicy.predicatePolicy === 'legacy-unbound-v2-monitor-only', 'live graph is not pinned as legacy');
  const options = {
    trustedSigners: { [graphPolicy.signerKeyId]: crypto.createPublicKey(policy.trustedSigners[graphPolicy.signerKeyId]) },
    expectedNetwork: policy.network,
    expectedGenesisHash: policy.genesisHash
  };
  assert(artifact.graph.template.predicatePolicy === undefined, 'live artifact unexpectedly carries a predicate policy');
  const refused = verifyBitvmAssertionGraphV2(artifact.graph, options);
  assert(!refused.ok && /predates the bound-predicate policy/.test(refused.reason), refused.reason);
  const otherHash = verifyBitvmAssertionGraphV2(artifact.graph, {
    ...options, legacyUnboundPredicateGraphHashes: ['00'.repeat(32)]
  });
  assert(!otherHash.ok, 'legacy exception applied to an unlisted graph');
  const monitored = verifyBitvmAssertionGraphV2(artifact.graph, {
    ...options, legacyUnboundPredicateGraphHashes: [artifact.graph.graphHash]
  });
  assert(monitored.ok && monitored.predicateBound === false, monitored.reason);
});

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
