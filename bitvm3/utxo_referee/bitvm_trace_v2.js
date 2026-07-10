const crypto = require('crypto');
const { canonicalStringify } = require('./m1_spec');
const {
  GATES,
  buildRevealScript,
  gateInvalidRows
} = require('./tradelayer_bitvm_circuit');

const VERSION = 2;
const TAG_WIRE = Buffer.from('UTXOREF_BITVM_WIRE_V2\0', 'ascii');
const TAG_NODE = Buffer.from('UTXOREF_BITVM_TRACE_NODE_V2\0', 'ascii');
const TAG_META = Buffer.from('UTXOREF_BITVM_TRACE_META_V2\0', 'ascii');
const TAG_ROOT = Buffer.from('UTXOREF_BITVM_TRACE_ROOT_V2\0', 'ascii');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function sha256Hex(value) {
  return sha256(value).toString('hex');
}

function assertHex(value, bytes, fieldName) {
  const text = String(value || '').toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(text)) {
    throw new Error(`${fieldName} must be ${bytes} bytes of hex`);
  }
  return text;
}

function labelBytes(label) {
  const bytes = Buffer.from(String(label), 'utf8');
  if (!bytes.length || bytes.length > 255) throw new Error('wire label must be 1..255 bytes');
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}

function createWireSecretV2(label, options = {}) {
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const preimage0 = Buffer.from(randomBytes(32));
  const preimage1 = Buffer.from(randomBytes(32));
  if (preimage0.length !== 32 || preimage1.length !== 32) throw new Error('wire RNG must return 32 bytes');
  if (preimage0.equals(preimage1)) throw new Error('wire preimages must differ');
  return {
    label: String(label),
    preimage0: preimage0.toString('hex'),
    preimage1: preimage1.toString('hex'),
    hash0: sha256Hex(preimage0),
    hash1: sha256Hex(preimage1)
  };
}

function buildWireSecretSetV2(labels, options = {}) {
  if (!Array.isArray(labels) || !labels.length) throw new Error('wire labels must be non-empty');
  const unique = [...new Set(labels.map(String))].sort();
  if (unique.length !== labels.length) throw new Error('wire labels must be unique');
  const publicWires = {};
  const secretWires = {};
  for (const label of unique) {
    const secret = createWireSecretV2(label, options);
    publicWires[label] = { label, hash0: secret.hash0, hash1: secret.hash1 };
    secretWires[label] = secret;
  }
  return {
    kind: 'utxoref_bitvm_wire_bundle_v2',
    version: VERSION,
    publicWires,
    secretWires
  };
}

function validateGates(gates, publicWires) {
  if (!Array.isArray(gates)) throw new Error('gates must be an array');
  return gates.map((gate, index) => {
    const type = String(gate.type || '');
    if (!GATES[type]) throw new Error(`gate[${index}] has unsupported type ${type}`);
    const inputs = (gate.inputs || []).map(String);
    if (inputs.length !== GATES[type].arity) throw new Error(`gate[${index}] arity mismatch`);
    const output = String(gate.output || '');
    for (const label of [...inputs, output]) {
      if (!publicWires[label]) throw new Error(`gate[${index}] references unknown wire ${label}`);
    }
    return { index, type, inputs, output };
  });
}

function selectedPreimage(secret, bit) {
  return bit === 1 ? secret.preimage1 : secret.preimage0;
}

function selectedHash(wire, bit) {
  return bit === 1 ? wire.hash1 : wire.hash0;
}

function wireRecordHash(label, wire, reveal) {
  return sha256(Buffer.concat([
    TAG_WIRE,
    labelBytes(label),
    Buffer.from(assertHex(wire.hash0, 32, `${label}.hash0`), 'hex'),
    Buffer.from(assertHex(wire.hash1, 32, `${label}.hash1`), 'hex'),
    Buffer.from([reveal.bit]),
    Buffer.from(assertHex(reveal.preimage, 32, `${label}.preimage`), 'hex')
  ]));
}

function traceMerkleRoot(hashes) {
  if (!hashes.length) throw new Error('trace requires wire hashes');
  let level = hashes.map((hash) => Buffer.from(hash));
  while (level.length > 1) {
    if (level.length % 2) level.push(sha256(Buffer.concat([TAG_NODE, level[level.length - 1], level[level.length - 1]])));
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(Buffer.concat([TAG_NODE, level[i], level[i + 1]])));
    level = next;
  }
  return level[0];
}

function traceCommitment(publicTrace) {
  const labels = Object.keys(publicTrace.publicWires || {}).sort();
  const hashes = labels.map((label) => wireRecordHash(
    label,
    publicTrace.publicWires[label],
    publicTrace.reveals[label]
  ));
  const wireRoot = traceMerkleRoot(hashes);
  const gatesHash = sha256(Buffer.from(canonicalStringify(publicTrace.gates), 'utf8'));
  const bindingHash = sha256(Buffer.from(canonicalStringify(publicTrace.binding), 'utf8'));
  const metaHash = sha256(Buffer.concat([
    TAG_META,
    labelBytes(publicTrace.circuitId),
    gatesHash,
    bindingHash
  ]));
  return {
    wireRoot: wireRoot.toString('hex'),
    gatesHash: gatesHash.toString('hex'),
    bindingHash: bindingHash.toString('hex'),
    traceRoot: sha256(Buffer.concat([TAG_ROOT, metaHash, wireRoot])).toString('hex')
  };
}

function buildPublicTraceV2(input = {}) {
  const bundle = input.wireBundle;
  if (!bundle || bundle.kind !== 'utxoref_bitvm_wire_bundle_v2') throw new Error('wireBundle is required');
  const publicWires = bundle.publicWires;
  const gates = validateGates(input.gates || [], publicWires);
  const labels = Object.keys(publicWires).sort();
  const values = input.values || {};
  const reveals = {};
  for (const label of labels) {
    const bit = Number(values[label]);
    if (bit !== 0 && bit !== 1) throw new Error(`trace value for ${label} must be 0 or 1`);
    const secret = bundle.secretWires[label];
    if (!secret) throw new Error(`missing secret wire ${label}`);
    reveals[label] = { bit, preimage: selectedPreimage(secret, bit) };
  }
  const trace = {
    kind: 'utxoref_bitvm_public_trace_v2',
    version: VERSION,
    circuitId: String(input.circuitId || ''),
    binding: input.binding || {},
    gates,
    publicWires,
    reveals
  };
  if (!trace.circuitId) throw new Error('circuitId is required');
  return { ...trace, ...traceCommitment(trace) };
}

function containsSecretPair(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsSecretPair);
  const keys = Object.keys(value);
  if (keys.includes('preimage0') || keys.includes('preimage1') || keys.includes('secretWires')) return true;
  return Object.values(value).some(containsSecretPair);
}

function verifyPublicTraceV2(trace, options = {}) {
  try {
    if (!trace || trace.kind !== 'utxoref_bitvm_public_trace_v2' || trace.version !== VERSION) {
      return { ok: false, reason: 'wrong public trace kind or version' };
    }
    if (containsSecretPair(trace)) return { ok: false, reason: 'public trace leaks opposite wire preimages' };
    const labels = Object.keys(trace.publicWires || {}).sort();
    if (!labels.length) return { ok: false, reason: 'public trace has no wires' };
    if (Object.keys(trace.reveals || {}).sort().join('|') !== labels.join('|')) {
      return { ok: false, reason: 'public trace reveal set does not match wire set' };
    }
    const gates = validateGates(trace.gates || [], trace.publicWires);
    if (canonicalStringify(gates) !== canonicalStringify(trace.gates)) {
      return { ok: false, reason: 'public trace gates are not canonical' };
    }
    const values = {};
    for (const label of labels) {
      const wire = trace.publicWires[label];
      const reveal = trace.reveals[label];
      if (reveal.bit !== 0 && reveal.bit !== 1) return { ok: false, reason: `invalid reveal bit for ${label}` };
      const preimage = Buffer.from(assertHex(reveal.preimage, 32, `${label}.preimage`), 'hex');
      if (sha256Hex(preimage) !== selectedHash(wire, reveal.bit)) {
        return { ok: false, reason: `selected preimage mismatch for ${label}` };
      }
      values[label] = reveal.bit;
    }
    const commitment = traceCommitment(trace);
    for (const field of ['wireRoot', 'gatesHash', 'bindingHash', 'traceRoot']) {
      if (trace[field] !== commitment[field]) return { ok: false, reason: `${field} mismatch`, [field]: commitment[field] };
    }
    if (options.expectedBindingHash && options.expectedBindingHash !== trace.bindingHash) {
      return { ok: false, reason: 'trace binding mismatch' };
    }
    const frauds = [];
    for (const gate of gates) {
      const inputs = gate.inputs.map((label) => values[label]);
      const expected = GATES[gate.type].f(...inputs);
      const actual = values[gate.output];
      if (actual !== expected) frauds.push({ gate, inputs, expected, actual });
    }
    return { ok: true, traceRoot: trace.traceRoot, values, frauds };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function publicWireForScript(wire) {
  return { hash0: wire.hash0, hash1: wire.hash1 };
}

function buildGateDisproveLeavesV2(gates, publicWires, challengerXonly) {
  const canonicalGates = validateGates(gates, publicWires);
  const leaves = [];
  for (const gate of canonicalGates) {
    for (const row of gateInvalidRows(gate.type)) {
      const hashes = row.inputs.map((bit, index) => selectedHash(publicWires[gate.inputs[index]], bit));
      hashes.push(selectedHash(publicWires[gate.output], row.output));
      leaves.push({
        kind: 'gate-disprove-v2',
        gateIndex: gate.index,
        gate,
        row,
        scriptHex: buildRevealScript(hashes, challengerXonly)
      });
    }
  }
  return leaves;
}

function buildInputBindingLeavesV2(expectedInputs, publicWires, challengerXonly) {
  return Object.entries(expectedInputs || {}).sort(([a], [b]) => a.localeCompare(b)).map(([label, expectedBit]) => {
    if (!publicWires[label]) throw new Error(`input binding references unknown wire ${label}`);
    const bit = Number(expectedBit);
    if (bit !== 0 && bit !== 1) throw new Error(`expected input ${label} must be 0 or 1`);
    const wrongBit = 1 - bit;
    return {
      kind: 'input-binding-disprove-v2',
      label,
      expectedBit: bit,
      wrongBit,
      scriptHex: buildRevealScript([selectedHash(publicWires[label], wrongBit)], challengerXonly)
    };
  });
}

function findGateDisproveV2(trace, challengerXonly) {
  const verification = verifyPublicTraceV2(trace);
  if (!verification.ok) throw new Error(`invalid public trace: ${verification.reason}`);
  const fraud = verification.frauds[0];
  if (!fraud) return null;
  const hashes = fraud.gate.inputs.map((label) => selectedHash(trace.publicWires[label], trace.reveals[label].bit));
  hashes.push(selectedHash(trace.publicWires[fraud.gate.output], trace.reveals[fraud.gate.output].bit));
  return {
    kind: 'utxoref_bitvm_gate_disprove_v2',
    traceRoot: trace.traceRoot,
    gate: fraud.gate,
    row: { inputs: fraud.inputs, output: fraud.actual },
    scriptHex: buildRevealScript(hashes, challengerXonly),
    revealPreimages: [
      ...fraud.gate.inputs.map((label) => trace.reveals[label].preimage),
      trace.reveals[fraud.gate.output].preimage
    ]
  };
}

function findInputBindingDisproveV2(trace, expectedInputs, challengerXonly) {
  const verification = verifyPublicTraceV2(trace);
  if (!verification.ok) throw new Error(`invalid public trace: ${verification.reason}`);
  for (const [label, expectedValue] of Object.entries(expectedInputs || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const expectedBit = Number(expectedValue);
    const reveal = trace.reveals[label];
    if (!reveal) throw new Error(`expected input ${label} is absent from trace`);
    if (reveal.bit !== expectedBit) {
      return {
        kind: 'utxoref_bitvm_input_disprove_v2',
        traceRoot: trace.traceRoot,
        label,
        expectedBit,
        actualBit: reveal.bit,
        scriptHex: buildRevealScript([selectedHash(trace.publicWires[label], reveal.bit)], challengerXonly),
        revealPreimages: [reveal.preimage]
      };
    }
  }
  return null;
}

module.exports = {
  VERSION,
  createWireSecretV2,
  buildWireSecretSetV2,
  buildPublicTraceV2,
  verifyPublicTraceV2,
  containsSecretPair,
  traceCommitment,
  buildGateDisproveLeavesV2,
  buildInputBindingLeavesV2,
  findGateDisproveV2,
  findInputBindingDisproveV2
};
