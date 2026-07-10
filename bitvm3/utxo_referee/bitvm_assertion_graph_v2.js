const crypto = require('crypto');
const { canonicalStringify } = require('./m1_spec');
const a = require('./tradelayer_dlc_adaptor_sig');
const tr = require('./tradelayer_taproot');
const ts = require('./tradelayer_taproot_script');
const { buildTaprootTree, controlBlockWithPath } = require('./tradelayer_taproot_tree');
const { pushScriptNum, csvSequence } = require('./tradelayer_bitvm_dispute');
const {
  buildGateDisproveLeavesV2,
  buildInputBindingLeavesV2,
  findGateDisproveV2,
  findInputBindingDisproveV2,
  verifyPublicTraceV2
} = require('./bitvm_trace_v2');
const {
  DEFAULT_CHALLENGE_CSV_BLOCKS,
  DEFAULT_RECOVERY_CSV_BLOCKS,
  MIN_PAYOUT_SATS,
  derivePnlPayoutsV2,
  outputVectorHashV2,
  buildUtxoRefPnlSettlementV2,
  verifyUtxoRefSettlementV2,
  strictUnsignedTx
} = require('./utxoref_v2');

const VERSION = 2;
const OP_CHECKSEQUENCEVERIFY = 0xb2;
const OP_DROP = 0x75;
const OP_PUSH32 = 0x20;
const OP_CHECKSIG = 0xac;
const OP_CHECKSIGVERIFY = 0xad;
const OP_RETURN = 0x6a;
const TAG_TEMPLATE = Buffer.from('UTXOREF_BITVM_ASSERTION_TEMPLATE_V2\0', 'ascii');
const TAG_GRAPH = Buffer.from('UTXOREF_BITVM_ASSERTION_GRAPH_V2\0', 'ascii');
const NUMS_DOMAIN = 'UTXORef BitVM assertion NUMS internal key v2';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function taggedObjectHash(tag, value) {
  return sha256(Buffer.concat([tag, Buffer.from(canonicalStringify(value), 'utf8')])).toString('hex');
}

function assertHex(value, bytes, fieldName) {
  const text = String(value || '').toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(text)) {
    throw new Error(`${fieldName} must be ${bytes} bytes of hex`);
  }
  return text;
}

function assertHexAny(value, fieldName) {
  const text = String(value || '').toLowerCase();
  if (!text.length || !/^[0-9a-f]+$/.test(text) || text.length % 2) {
    throw new Error(`${fieldName} must be non-empty even-length hex`);
  }
  return text;
}

function toU64(value, fieldName) {
  let result;
  try {
    result = BigInt(value);
  } catch (_err) {
    throw new Error(`${fieldName} must be an unsigned integer`);
  }
  if (result < 0n || result > 0xffffffffffffffffn) throw new Error(`${fieldName} must fit u64`);
  return result;
}

function normalizeNetwork(value) {
  const network = String(value || '').toLowerCase();
  if (!network) throw new Error('network is required');
  return network;
}

function assertXonly(value, fieldName) {
  const text = assertHex(value, 32, fieldName);
  try {
    a.liftX(a.bufToBig(Buffer.from(text, 'hex')));
  } catch (err) {
    throw new Error(`${fieldName} is not a valid x-only secp256k1 key: ${err.message}`);
  }
  return text;
}

function secretScalar(value, fieldName) {
  let scalar;
  if (typeof value === 'bigint') scalar = value;
  else scalar = BigInt(`0x${assertHex(value, 32, fieldName)}`);
  scalar = a.mod(scalar, a.N);
  if (scalar === 0n) throw new Error(`${fieldName} is invalid`);
  return scalar;
}

function deriveAssertionNumsXonly(network) {
  const normalized = normalizeNetwork(network);
  for (let counter = 0; counter < 1024; counter++) {
    const candidate = sha256(Buffer.from(`${NUMS_DOMAIN}:${normalized}:${counter}`, 'utf8'));
    try {
      a.liftX(a.bufToBig(candidate));
      return candidate.toString('hex');
    } catch (_err) {
      // Roughly half of candidate x-coordinates are valid curve points.
    }
  }
  throw new Error('failed to derive assertion NUMS internal key');
}

function buildCooperativeSettlementLeafScript(operatorXonly, challengerXonly, challengeCsvBlocks) {
  const operator = Buffer.from(assertXonly(operatorXonly, 'operatorXonly'), 'hex');
  const challenger = Buffer.from(assertXonly(challengerXonly, 'challengerXonly'), 'hex');
  return Buffer.concat([
    pushScriptNum(csvSequence(challengeCsvBlocks)),
    Buffer.from([OP_CHECKSEQUENCEVERIFY, OP_DROP, OP_PUSH32]), operator,
    Buffer.from([OP_CHECKSIGVERIFY, OP_PUSH32]), challenger,
    Buffer.from([OP_CHECKSIG])
  ]).toString('hex');
}

function buildEmergencyRecoveryLeafScript(operatorXonly, recoveryCsvBlocks) {
  const operator = Buffer.from(assertXonly(operatorXonly, 'operatorXonly'), 'hex');
  return Buffer.concat([
    pushScriptNum(csvSequence(recoveryCsvBlocks)),
    Buffer.from([OP_CHECKSEQUENCEVERIFY, OP_DROP, OP_PUSH32]), operator,
    Buffer.from([OP_CHECKSIG])
  ]).toString('hex');
}

function buildTraceCommitmentLeafScript(traceRoot) {
  const root = Buffer.from(assertHex(traceRoot, 32, 'traceRoot'), 'hex');
  return Buffer.concat([Buffer.from([OP_RETURN, OP_PUSH32]), root]).toString('hex');
}

function normalizeExpectedInputs(value) {
  const normalized = {};
  for (const [label, rawBit] of Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right))) {
    const bit = Number(rawBit);
    if (bit !== 0 && bit !== 1) throw new Error(`expected input ${label} must be 0 or 1`);
    normalized[String(label)] = bit;
  }
  return normalized;
}

function leafId(leaf, index) {
  if (leaf.kind === 'gate-disprove-v2') {
    return `gate:${leaf.gateIndex}:${leaf.row.inputs.join('')}:${leaf.row.output}`;
  }
  if (leaf.kind === 'input-binding-disprove-v2') return `input:${leaf.label}:${leaf.wrongBit}`;
  if (leaf.kind === 'trace-root-commitment-v2') return 'trace-commitment';
  if (leaf.kind === 'cooperative-settlement-csv-v2') return 'settlement';
  if (leaf.kind === 'emergency-recovery-csv-v2') return 'recovery';
  return `leaf:${index}`;
}

function publicLeaf(leaf, internalXonly, outputParity, index) {
  const result = {
    id: leafId(leaf, index),
    kind: leaf.kind,
    scriptHex: leaf.scriptHex,
    leafVersion: leaf.leafVersion,
    leafHash: leaf.leafHash.toString('hex'),
    merklePath: leaf.path.map((item) => item.toString('hex')),
    controlBlock: controlBlockWithPath(
      Buffer.from(internalXonly, 'hex'),
      outputParity,
      leaf.leafVersion,
      leaf.path
    ).toString('hex')
  };
  if (leaf.gateIndex !== undefined) result.gateIndex = leaf.gateIndex;
  if (leaf.gate) result.gate = leaf.gate;
  if (leaf.row) result.row = leaf.row;
  if (leaf.label !== undefined) result.label = leaf.label;
  if (leaf.expectedBit !== undefined) result.expectedBit = leaf.expectedBit;
  if (leaf.wrongBit !== undefined) result.wrongBit = leaf.wrongBit;
  return result;
}

function buildBitvmAssertionTemplateV2(input = {}) {
  const traceCheck = verifyPublicTraceV2(input.publicTrace);
  if (!traceCheck.ok) throw new Error(`invalid public trace: ${traceCheck.reason}`);
  const network = normalizeNetwork(input.network);
  const operatorXonly = assertXonly(input.operatorXonly, 'operatorXonly');
  const challengerXonly = assertXonly(input.challengerXonly, 'challengerXonly');
  if (operatorXonly === challengerXonly) throw new Error('operator and challenger keys must differ');
  const challengeCsvBlocks = csvSequence(input.challengeCsvBlocks ?? DEFAULT_CHALLENGE_CSV_BLOCKS);
  const recoveryCsvBlocks = csvSequence(input.recoveryCsvBlocks ?? DEFAULT_RECOVERY_CSV_BLOCKS);
  if (recoveryCsvBlocks <= challengeCsvBlocks) {
    throw new Error('recoveryCsvBlocks must exceed challengeCsvBlocks');
  }
  const expectedInputs = normalizeExpectedInputs(input.expectedInputs);
  const derivedInternalXonly = deriveAssertionNumsXonly(network);
  if (input.internalXonly && assertHex(input.internalXonly, 32, 'internalXonly') !== derivedInternalXonly) {
    throw new Error('custom internal key is forbidden; the V2 assertion output requires the deterministic NUMS key');
  }
  const internalXonly = derivedInternalXonly;

  const gateLeaves = buildGateDisproveLeavesV2(
    input.publicTrace.gates,
    input.publicTrace.publicWires,
    challengerXonly
  );
  const inputLeaves = buildInputBindingLeavesV2(
    expectedInputs,
    input.publicTrace.publicWires,
    challengerXonly
  );
  const settlementScript = buildCooperativeSettlementLeafScript(
    operatorXonly,
    challengerXonly,
    challengeCsvBlocks
  );
  const recoveryScript = buildEmergencyRecoveryLeafScript(operatorXonly, recoveryCsvBlocks);
  const traceCommitmentScript = buildTraceCommitmentLeafScript(input.publicTrace.traceRoot);
  const drafts = [
    ...gateLeaves,
    ...inputLeaves,
    { kind: 'trace-root-commitment-v2', scriptHex: traceCommitmentScript },
    { kind: 'cooperative-settlement-csv-v2', scriptHex: settlementScript },
    { kind: 'emergency-recovery-csv-v2', scriptHex: recoveryScript }
  ];
  const tree = buildTaprootTree(drafts);
  const tweak = ts.taprootTweakWithRoot(Buffer.from(internalXonly, 'hex'), tree.root);
  const leaves = tree.leaves.map((leaf, index) => publicLeaf(leaf, internalXonly, tweak.parity, index));
  const ids = leaves.map((leaf) => leaf.id);
  if (new Set(ids).size !== ids.length) throw new Error('assertion leaf identifiers must be unique');

  const core = {
    kind: 'utxoref_bitvm_assertion_template_v2',
    version: VERSION,
    network,
    traceRoot: input.publicTrace.traceRoot,
    traceBindingHash: input.publicTrace.bindingHash,
    expectedInputs,
    operatorXonly,
    challengerXonly,
    challengeCsvBlocks,
    recoveryCsvBlocks,
    internalKeyPolicy: 'deterministic-nums-no-keypath-v2',
    internalXonly,
    assertionTreeRoot: tree.root.toString('hex'),
    outputKeyXonly: tweak.xonly.toString('hex'),
    outputParity: tweak.parity,
    p2trScriptPubKey: ts
      .taprootScriptPubKeyWithRoot(Buffer.from(internalXonly, 'hex'), tree.root)
      .toString('hex'),
    gateDisproveLeafCount: gateLeaves.length,
    inputDisproveLeafCount: inputLeaves.length,
    traceCommitmentLeafCount: 1,
    leaves
  };
  return { ...core, templateHash: taggedObjectHash(TAG_TEMPLATE, core) };
}

function verifyBitvmAssertionTemplateV2(template, publicTrace) {
  try {
    if (!template || template.kind !== 'utxoref_bitvm_assertion_template_v2' || template.version !== VERSION) {
      return { ok: false, reason: 'wrong assertion template kind or version' };
    }
    const expected = buildBitvmAssertionTemplateV2({
      network: template.network,
      publicTrace,
      expectedInputs: template.expectedInputs,
      operatorXonly: template.operatorXonly,
      challengerXonly: template.challengerXonly,
      challengeCsvBlocks: template.challengeCsvBlocks,
      recoveryCsvBlocks: template.recoveryCsvBlocks,
      internalXonly: template.internalXonly
    });
    if (canonicalStringify(expected) !== canonicalStringify(template)) {
      return { ok: false, reason: 'assertion template does not reconstruct from the public trace' };
    }
    return {
      ok: true,
      templateHash: expected.templateHash,
      assertionTreeRoot: expected.assertionTreeRoot,
      p2trScriptPubKey: expected.p2trScriptPubKey
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function buildSettlementTraceBindingV2(input = {}) {
  const envelope = input.stateEnvelope;
  if (!envelope || envelope.kind !== 'utxoref_signed_state_checkpoint_v2' || envelope.version !== VERSION) {
    throw new Error('a V2 signed state checkpoint is required for the trace binding');
  }
  const derived = derivePnlPayoutsV2(envelope.body);
  const outputs = derived.payouts.map((payout) => ({
    valueSats: payout.amountSats,
    scriptPubKeyHex: payout.scriptPubKeyHex
  }));
  const feeSats = toU64(input.feeSats, 'feeSats');
  const payoutTotalSats = derived.payouts.reduce((sum, payout) => sum + BigInt(payout.amountSats), 0n);
  return {
    kind: 'utxoref_settlement_trace_binding_v2',
    version: VERSION,
    network: normalizeNetwork(envelope.body.network),
    chainGenesisHash: assertHex(envelope.body.chainGenesisHash, 32, 'chainGenesisHash'),
    contractId: assertHex(envelope.body.contractId, 32, 'contractId'),
    epochId: String(envelope.body.epochId),
    stateCheckpointHash: assertHex(envelope.bodyHash, 32, 'stateCheckpointHash'),
    outputsHash: outputVectorHashV2(outputs),
    payoutTotalSats: payoutTotalSats.toString(),
    feeSats: feeSats.toString(),
    assertionAmountSats: (payoutTotalSats + feeSats).toString()
  };
}

function normalizeAssertionOutpoint(value, template) {
  if (!value || typeof value !== 'object') throw new Error('assertionOutpoint is required');
  const scriptPubKeyHex = value.scriptPubKeyHex
    ? assertHexAny(value.scriptPubKeyHex, 'assertionOutpoint.scriptPubKeyHex')
    : template.p2trScriptPubKey;
  if (scriptPubKeyHex !== template.p2trScriptPubKey) {
    throw new Error('assertion outpoint does not pay the reconstructed V2 assertion script');
  }
  const vout = Number(value.vout);
  if (!Number.isSafeInteger(vout) || vout < 0 || vout > 0xffffffff) {
    throw new Error('assertionOutpoint.vout must fit u32');
  }
  const amountSats = toU64(value.amountSats, 'assertionOutpoint.amountSats');
  return {
    txid: assertHex(value.txid, 32, 'assertionOutpoint.txid'),
    vout,
    amountSats: amountSats.toString(),
    scriptPubKeyHex
  };
}

function leafById(template, id) {
  const leaf = template.leaves.find((candidate) => candidate.id === id);
  if (!leaf) throw new Error(`assertion leaf ${id} is absent`);
  return leaf;
}

function outputsForTx(outputs) {
  return outputs.map((output) => ({
    valueSats: output.valueSats,
    script: output.scriptPubKeyHex
  }));
}

function signForXonly(secretValue, expectedXonly, fieldName, sighash, aux) {
  const secret = secretScalar(secretValue, fieldName);
  const actualXonly = a.xOnlyPubkey(secret).toString('hex');
  if (actualXonly !== expectedXonly) throw new Error(`${fieldName} does not match its public key`);
  return a.schnorrSign(secret, sighash, aux || crypto.randomBytes(32)).toString('hex');
}

function witnessTxFromUnsigned(unsignedTxHex, witnessItems) {
  const parsed = strictUnsignedTx(unsignedTxHex);
  return tr.serializeWitnessTx(
    parsed.version,
    parsed.vin.map((vin, index) => ({
      outpoint: vin.outpoint.toString('hex'),
      sequence: vin.sequence,
      witness: index === 0 ? witnessItems : []
    })),
    parsed.vout.map((output) => ({ valueSats: output.value, script: output.script.toString('hex') })),
    parsed.locktime
  );
}

function graphHash(graph) {
  const { graphHash: _ignored, ...body } = graph;
  return taggedObjectHash(TAG_GRAPH, body);
}

function containsPrivateMaterial(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsPrivateMaterial);
  for (const [key, nested] of Object.entries(value)) {
    if (/^(operatorSecret|challengerSecret|privateKey|preimage0|preimage1|secretWires)$/i.test(key)) return true;
    if (containsPrivateMaterial(nested)) return true;
  }
  return false;
}

function finalizeBitvmAssertionGraphV2(input = {}) {
  const templateCheck = verifyBitvmAssertionTemplateV2(input.template, input.publicTrace);
  if (!templateCheck.ok) throw new Error(`invalid assertion template: ${templateCheck.reason}`);
  const template = input.template;
  const binding = buildSettlementTraceBindingV2({ stateEnvelope: input.stateEnvelope, feeSats: input.feeSats });
  if (canonicalStringify(input.publicTrace.binding) !== canonicalStringify(binding)) {
    throw new Error('public trace is not bound to the signed state and exact payout vector');
  }
  const assertionOutpoint = normalizeAssertionOutpoint(input.assertionOutpoint, template);
  if (assertionOutpoint.amountSats !== binding.assertionAmountSats) {
    throw new Error('assertion outpoint amount does not equal payout total plus settlement fee');
  }

  const settlement = buildUtxoRefPnlSettlementV2({
    stateEnvelope: input.stateEnvelope,
    stateVerification: input.stateVerification,
    fundingOutpoints: [assertionOutpoint],
    feeSats: binding.feeSats,
    traceRoot: input.publicTrace.traceRoot,
    assertionTreeRoot: template.assertionTreeRoot,
    challengeCsvBlocks: template.challengeCsvBlocks,
    recoveryCsvBlocks: template.recoveryCsvBlocks,
    operatorXonly: template.operatorXonly,
    challengerXonly: template.challengerXonly
  });
  settlement.unsignedTxHex = tr.serializeUnsignedTx(2, [{
    outpoint: tr.outpoint(assertionOutpoint.txid, assertionOutpoint.vout),
    sequence: template.challengeCsvBlocks
  }], outputsForTx(settlement.outputs), 0);
  const settlementCheck = verifyUtxoRefSettlementV2(settlement, input.stateVerification);
  if (!settlementCheck.ok) throw new Error(`invalid V2 settlement: ${settlementCheck.reason}`);

  const settlementLeaf = leafById(template, 'settlement');
  const settlementParsed = strictUnsignedTx(settlement.unsignedTxHex);
  const settlementSighash = ts.scriptPathSighash(
    settlementParsed,
    [{ amountSats: assertionOutpoint.amountSats, scriptPubKey: assertionOutpoint.scriptPubKeyHex }],
    0,
    Buffer.from(settlementLeaf.leafHash, 'hex')
  );
  const operatorSignature = signForXonly(
    input.operatorSecret,
    template.operatorXonly,
    'operatorSecret',
    settlementSighash,
    input.operatorAux
  );
  const challengerSignature = signForXonly(
    input.challengerSecret,
    template.challengerXonly,
    'challengerSecret',
    settlementSighash,
    input.challengerAux
  );
  const settlementWitness = [
    challengerSignature,
    operatorSignature,
    settlementLeaf.scriptHex,
    settlementLeaf.controlBlock
  ];

  const recoveryFeeSats = toU64(input.recoveryFeeSats ?? binding.feeSats, 'recoveryFeeSats');
  const recoveryValueSats = BigInt(assertionOutpoint.amountSats) - recoveryFeeSats;
  if (recoveryValueSats < MIN_PAYOUT_SATS) throw new Error('emergency recovery output is below the V2 dust floor');
  const recoveryScriptPubKeyHex = assertHexAny(input.recoveryScriptPubKeyHex, 'recoveryScriptPubKeyHex');
  const recoveryUnsignedTxHex = tr.serializeUnsignedTx(2, [{
    outpoint: tr.outpoint(assertionOutpoint.txid, assertionOutpoint.vout),
    sequence: template.recoveryCsvBlocks
  }], [{ valueSats: recoveryValueSats, script: recoveryScriptPubKeyHex }], 0);
  const recoveryLeaf = leafById(template, 'recovery');
  const recoveryParsed = strictUnsignedTx(recoveryUnsignedTxHex);
  const recoverySighash = ts.scriptPathSighash(
    recoveryParsed,
    [{ amountSats: assertionOutpoint.amountSats, scriptPubKey: assertionOutpoint.scriptPubKeyHex }],
    0,
    Buffer.from(recoveryLeaf.leafHash, 'hex')
  );
  const recoverySignature = signForXonly(
    input.operatorSecret,
    template.operatorXonly,
    'operatorSecret',
    recoverySighash,
    input.recoveryAux
  );
  const recoveryWitness = [recoverySignature, recoveryLeaf.scriptHex, recoveryLeaf.controlBlock];

  const unsignedGraph = {
    kind: 'utxoref_bitvm_assertion_graph_v2',
    version: VERSION,
    publicTrace: input.publicTrace,
    template,
    assertionOutpoint,
    settlement,
    settlementPath: {
      kind: 'cooperative-settlement-csv-v2',
      leafId: settlementLeaf.id,
      sighash: settlementSighash.toString('hex'),
      operatorSignature,
      challengerSignature,
      witness: settlementWitness,
      witnessTxHex: witnessTxFromUnsigned(settlement.unsignedTxHex, settlementWitness)
    },
    recoveryPath: {
      kind: 'emergency-recovery-csv-v2',
      leafId: recoveryLeaf.id,
      recoveryFeeSats: recoveryFeeSats.toString(),
      recoveryScriptPubKeyHex,
      unsignedTxHex: recoveryUnsignedTxHex,
      sighash: recoverySighash.toString('hex'),
      operatorSignature: recoverySignature,
      witness: recoveryWitness,
      witnessTxHex: witnessTxFromUnsigned(recoveryUnsignedTxHex, recoveryWitness)
    }
  };
  if (containsPrivateMaterial(unsignedGraph)) throw new Error('graph package contains private material');
  return { ...unsignedGraph, graphHash: graphHash(unsignedGraph) };
}

function compareExact(actual, expected, reason) {
  if (canonicalStringify(actual) !== canonicalStringify(expected)) throw new Error(reason);
}

function verifyBitvmAssertionGraphV2(graph, options = {}) {
  try {
    if (!graph || graph.kind !== 'utxoref_bitvm_assertion_graph_v2' || graph.version !== VERSION) {
      return { ok: false, reason: 'wrong assertion graph kind or version' };
    }
    if (containsPrivateMaterial(graph)) return { ok: false, reason: 'graph package leaks private material' };
    if (graph.graphHash !== graphHash(graph)) return { ok: false, reason: 'assertion graph hash mismatch' };
    const templateCheck = verifyBitvmAssertionTemplateV2(graph.template, graph.publicTrace);
    if (!templateCheck.ok) return { ok: false, reason: `template verification failed: ${templateCheck.reason}` };
    const traceCheck = verifyPublicTraceV2(graph.publicTrace);
    if (!traceCheck.ok) return { ok: false, reason: `trace verification failed: ${traceCheck.reason}` };
    const assertionOutpoint = normalizeAssertionOutpoint(graph.assertionOutpoint, graph.template);
    const binding = buildSettlementTraceBindingV2({
      stateEnvelope: graph.settlement.stateEnvelope,
      feeSats: graph.settlement.commitment?.core?.feeSats
    });
    compareExact(graph.publicTrace.binding, binding, 'public trace binding mismatch');
    if (assertionOutpoint.amountSats !== binding.assertionAmountSats) {
      throw new Error('assertion amount does not match trace binding');
    }
    if (graph.settlement.commitment?.core?.traceRoot !== graph.publicTrace.traceRoot) {
      throw new Error('settlement does not commit the public trace root');
    }
    if (graph.settlement.commitment?.core?.assertionTreeRoot !== graph.template.assertionTreeRoot) {
      throw new Error('settlement does not commit the assertion tree root');
    }
    if (graph.settlement.commitment?.core?.operatorXonly !== graph.template.operatorXonly ||
        graph.settlement.commitment?.core?.challengerXonly !== graph.template.challengerXonly) {
      throw new Error('settlement signer keys do not match the assertion tree');
    }
    compareExact(graph.settlement.fundingOutpoints, [{ ...assertionOutpoint, index: 0 }], 'settlement funding outpoint mismatch');
    const settlementCheck = verifyUtxoRefSettlementV2(graph.settlement, options.stateVerification || options);
    if (!settlementCheck.ok) throw new Error(`settlement verification failed: ${settlementCheck.reason}`);

    const settlementLeaf = leafById(graph.template, 'settlement');
    const settlementParsed = strictUnsignedTx(graph.settlement.unsignedTxHex);
    const settlementSighash = ts.scriptPathSighash(
      settlementParsed,
      [{ amountSats: assertionOutpoint.amountSats, scriptPubKey: assertionOutpoint.scriptPubKeyHex }],
      0,
      Buffer.from(settlementLeaf.leafHash, 'hex')
    );
    if (graph.settlementPath.sighash !== settlementSighash.toString('hex')) throw new Error('settlement sighash mismatch');
    if (!a.schnorrVerify(
      Buffer.from(graph.template.operatorXonly, 'hex'),
      settlementSighash,
      Buffer.from(assertHex(graph.settlementPath.operatorSignature, 64, 'operatorSignature'), 'hex')
    )) throw new Error('invalid operator settlement signature');
    if (!a.schnorrVerify(
      Buffer.from(graph.template.challengerXonly, 'hex'),
      settlementSighash,
      Buffer.from(assertHex(graph.settlementPath.challengerSignature, 64, 'challengerSignature'), 'hex')
    )) throw new Error('invalid challenger settlement signature');
    const expectedSettlementWitness = [
      graph.settlementPath.challengerSignature,
      graph.settlementPath.operatorSignature,
      settlementLeaf.scriptHex,
      settlementLeaf.controlBlock
    ];
    compareExact(graph.settlementPath.witness, expectedSettlementWitness, 'settlement witness mismatch');
    if (graph.settlementPath.witnessTxHex !== witnessTxFromUnsigned(graph.settlement.unsignedTxHex, expectedSettlementWitness)) {
      throw new Error('settlement witness transaction mismatch');
    }

    const recoveryLeaf = leafById(graph.template, 'recovery');
    const recoveryParsed = strictUnsignedTx(graph.recoveryPath.unsignedTxHex);
    if (recoveryParsed.vin.length !== 1 || recoveryParsed.vin[0].outpoint.toString('hex') !== tr.outpoint(assertionOutpoint.txid, assertionOutpoint.vout)) {
      throw new Error('recovery transaction outpoint mismatch');
    }
    if (recoveryParsed.vin[0].sequence !== graph.template.recoveryCsvBlocks) throw new Error('recovery sequence mismatch');
    if (recoveryParsed.vout.length !== 1 || recoveryParsed.vout[0].script.toString('hex') !== graph.recoveryPath.recoveryScriptPubKeyHex) {
      throw new Error('recovery output mismatch');
    }
    const recoveryFeeSats = BigInt(graph.recoveryPath.recoveryFeeSats);
    if (recoveryParsed.vout[0].value + recoveryFeeSats !== BigInt(assertionOutpoint.amountSats)) {
      throw new Error('recovery fee arithmetic mismatch');
    }
    const recoverySighash = ts.scriptPathSighash(
      recoveryParsed,
      [{ amountSats: assertionOutpoint.amountSats, scriptPubKey: assertionOutpoint.scriptPubKeyHex }],
      0,
      Buffer.from(recoveryLeaf.leafHash, 'hex')
    );
    if (graph.recoveryPath.sighash !== recoverySighash.toString('hex')) throw new Error('recovery sighash mismatch');
    if (!a.schnorrVerify(
      Buffer.from(graph.template.operatorXonly, 'hex'),
      recoverySighash,
      Buffer.from(assertHex(graph.recoveryPath.operatorSignature, 64, 'recoverySignature'), 'hex')
    )) throw new Error('invalid recovery signature');
    const expectedRecoveryWitness = [
      graph.recoveryPath.operatorSignature,
      recoveryLeaf.scriptHex,
      recoveryLeaf.controlBlock
    ];
    compareExact(graph.recoveryPath.witness, expectedRecoveryWitness, 'recovery witness mismatch');
    if (graph.recoveryPath.witnessTxHex !== witnessTxFromUnsigned(graph.recoveryPath.unsignedTxHex, expectedRecoveryWitness)) {
      throw new Error('recovery witness transaction mismatch');
    }

    return {
      ok: true,
      graphHash: graph.graphHash,
      commitmentHash: settlementCheck.commitmentHash,
      assertionTreeRoot: graph.template.assertionTreeRoot,
      p2trScriptPubKey: graph.template.p2trScriptPubKey,
      fraudCount: traceCheck.frauds.length,
      challengeCsvBlocks: graph.template.challengeCsvBlocks,
      recoveryCsvBlocks: graph.template.recoveryCsvBlocks
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function selectFraudEvidence(graph, fraudType) {
  const gate = findGateDisproveV2(graph.publicTrace, graph.template.challengerXonly);
  const input = findInputBindingDisproveV2(
    graph.publicTrace,
    graph.template.expectedInputs,
    graph.template.challengerXonly
  );
  if (fraudType === 'gate') return gate;
  if (fraudType === 'input') return input;
  return gate || input;
}

function buildBitvmDisproveV2(graph, input = {}) {
  const graphCheck = verifyBitvmAssertionGraphV2(graph, input.stateVerification || {});
  if (!graphCheck.ok) throw new Error(`invalid assertion graph: ${graphCheck.reason}`);
  const evidence = selectFraudEvidence(graph, input.fraudType);
  if (!evidence) throw new Error('the public trace contains no constructible fraud proof');
  const leaf = graph.template.leaves.find((candidate) => candidate.scriptHex === evidence.scriptHex);
  if (!leaf || !leaf.kind.includes('disprove')) throw new Error('fraud proof is not committed in the assertion tree');
  const assertionOutpoint = graph.assertionOutpoint;
  const feeSats = toU64(input.feeSats, 'feeSats');
  const outputValueSats = BigInt(assertionOutpoint.amountSats) - feeSats;
  if (outputValueSats < MIN_PAYOUT_SATS) throw new Error('disprove output is below the V2 dust floor');
  const challengeScriptPubKeyHex = assertHexAny(input.challengeScriptPubKeyHex, 'challengeScriptPubKeyHex');
  const unsignedTxHex = tr.serializeUnsignedTx(2, [{
    outpoint: tr.outpoint(assertionOutpoint.txid, assertionOutpoint.vout),
    sequence: 0xfffffffd
  }], [{ valueSats: outputValueSats, script: challengeScriptPubKeyHex }], 0);
  const parsed = strictUnsignedTx(unsignedTxHex);
  const sighash = ts.scriptPathSighash(
    parsed,
    [{ amountSats: assertionOutpoint.amountSats, scriptPubKey: assertionOutpoint.scriptPubKeyHex }],
    0,
    Buffer.from(leaf.leafHash, 'hex')
  );
  const challengerSignature = signForXonly(
    input.challengerSecret,
    graph.template.challengerXonly,
    'challengerSecret',
    sighash,
    input.challengerAux
  );
  const witness = [challengerSignature, ...evidence.revealPreimages, leaf.scriptHex, leaf.controlBlock];
  return {
    kind: 'utxoref_bitvm_disprove_v2',
    version: VERSION,
    graphHash: graph.graphHash,
    fraudType: evidence.kind.includes('gate') ? 'gate' : 'input',
    leafId: leaf.id,
    evidence,
    feeSats: feeSats.toString(),
    challengeScriptPubKeyHex,
    unsignedTxHex,
    sighash: sighash.toString('hex'),
    challengerSignature,
    witness,
    witnessTxHex: witnessTxFromUnsigned(unsignedTxHex, witness)
  };
}

function verifyBitvmDisproveV2(graph, disprove, options = {}) {
  try {
    const graphCheck = verifyBitvmAssertionGraphV2(graph, options.stateVerification || options);
    if (!graphCheck.ok) throw new Error(`invalid assertion graph: ${graphCheck.reason}`);
    if (!disprove || disprove.kind !== 'utxoref_bitvm_disprove_v2' || disprove.version !== VERSION) {
      throw new Error('wrong disprove kind or version');
    }
    if (disprove.graphHash !== graph.graphHash) throw new Error('disprove graph hash mismatch');
    const evidence = selectFraudEvidence(graph, disprove.fraudType);
    if (!evidence) throw new Error('the public trace does not support this fraud proof');
    compareExact(disprove.evidence, evidence, 'disprove evidence mismatch');
    const leaf = leafById(graph.template, disprove.leafId);
    if (leaf.scriptHex !== evidence.scriptHex || !leaf.kind.includes('disprove')) {
      throw new Error('disprove leaf mismatch');
    }
    const parsed = strictUnsignedTx(disprove.unsignedTxHex);
    if (parsed.vin.length !== 1 || parsed.vin[0].outpoint.toString('hex') !== tr.outpoint(graph.assertionOutpoint.txid, graph.assertionOutpoint.vout)) {
      throw new Error('disprove outpoint mismatch');
    }
    if (parsed.vin[0].sequence !== 0xfffffffd) throw new Error('disprove sequence mismatch');
    if (parsed.vout.length !== 1 || parsed.vout[0].script.toString('hex') !== disprove.challengeScriptPubKeyHex) {
      throw new Error('disprove output mismatch');
    }
    if (parsed.vout[0].value + BigInt(disprove.feeSats) !== BigInt(graph.assertionOutpoint.amountSats)) {
      throw new Error('disprove fee arithmetic mismatch');
    }
    for (let index = 0; index < evidence.revealPreimages.length; index++) {
      if (disprove.witness[index + 1] !== evidence.revealPreimages[index]) {
        throw new Error('disprove reveal witness mismatch');
      }
    }
    const sighash = ts.scriptPathSighash(
      parsed,
      [{ amountSats: graph.assertionOutpoint.amountSats, scriptPubKey: graph.assertionOutpoint.scriptPubKeyHex }],
      0,
      Buffer.from(leaf.leafHash, 'hex')
    );
    if (disprove.sighash !== sighash.toString('hex')) throw new Error('disprove sighash mismatch');
    if (!a.schnorrVerify(
      Buffer.from(graph.template.challengerXonly, 'hex'),
      sighash,
      Buffer.from(assertHex(disprove.challengerSignature, 64, 'challengerSignature'), 'hex')
    )) throw new Error('invalid challenger disprove signature');
    const expectedWitness = [
      disprove.challengerSignature,
      ...evidence.revealPreimages,
      leaf.scriptHex,
      leaf.controlBlock
    ];
    compareExact(disprove.witness, expectedWitness, 'disprove witness mismatch');
    if (disprove.witnessTxHex !== witnessTxFromUnsigned(disprove.unsignedTxHex, expectedWitness)) {
      throw new Error('disprove witness transaction mismatch');
    }
    return { ok: true, graphHash: graph.graphHash, leafId: leaf.id, fraudType: disprove.fraudType };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  VERSION,
  NUMS_DOMAIN,
  deriveAssertionNumsXonly,
  buildCooperativeSettlementLeafScript,
  buildEmergencyRecoveryLeafScript,
  buildTraceCommitmentLeafScript,
  buildSettlementTraceBindingV2,
  buildBitvmAssertionTemplateV2,
  verifyBitvmAssertionTemplateV2,
  containsPrivateMaterial,
  computeBitvmAssertionGraphHashV2: graphHash,
  finalizeBitvmAssertionGraphV2,
  verifyBitvmAssertionGraphV2,
  buildBitvmDisproveV2,
  verifyBitvmDisproveV2
};
