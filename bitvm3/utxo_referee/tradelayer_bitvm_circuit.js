/**
 * TradeLayer BitVM circuit framework (wires + logic gates)
 *
 * Builds on the bit-commitment / equivocation primitive (tradelayer_bitvm_gadgets)
 * to express a referee predicate as a boolean circuit whose every gate is
 * enforceable on-chain.
 *
 * Model:
 *  - A *wire* is a bit commitment: hash0 = SHA256(pre0), hash1 = SHA256(pre1).
 *    To assert wire = b the prover reveals the matching preimage.
 *  - A *gate* (AND/OR/XOR/NOT) relates input wires to an output wire. For each
 *    INVALID row of the gate's truth table (output != f(inputs)) there is a
 *    "disprove" tapscript leaf: it is spendable only by revealing the prover's
 *    own preimages for exactly that invalid combination, plus a challenger
 *    signature. So if the prover commits an inconsistent gate, a challenger can
 *    punish it on-chain; an honest gate has no satisfiable disprove leaf.
 *  - Wire consistency across gates is enforced by reusing the same wire commitment
 *    everywhere, with the equivocation leaf punishing a double-reveal.
 *
 * This is the per-gate atom of the BitVM disprove game.
 */

const crypto = require('crypto');
const { sha256, buildBitCommitment } = require('./tradelayer_bitvm_gadgets');

const OP_SHA256 = 0xa8;
const OP_EQUALVERIFY = 0x88;
const OP_CHECKSIG = 0xac;
const OP_PUSH32 = 0x20;

const GATES = Object.freeze({
  and: { arity: 2, f: (a, b) => a & b },
  or: { arity: 2, f: (a, b) => a | b },
  xor: { arity: 2, f: (a, b) => a ^ b },
  nand: { arity: 2, f: (a, b) => 1 - (a & b) },
  not: { arity: 1, f: (a) => 1 - a }
});

function buildWire(label) {
  const seed = `${label}:${crypto.randomBytes(16).toString('hex')}`;
  return { label, ...buildBitCommitment(seed) };
}

function wireHash(wire, bit) { return bit ? wire.hash1 : wire.hash0; }
function wirePreimage(wire, bit) { return bit ? wire.preimage1 : wire.preimage0; }

/**
 * Reveal-punishment tapscript: spendable iff each listed wire-value preimage is
 * revealed (in order) plus a challenger signature. Generalizes the equivocation
 * gadget (n=2) to n wires.
 *
 * Script checks hashes in reverse so the witness preimages are in forward order:
 *   witness (bottom->top): [challengerSig, pre_0, pre_1, ..., pre_{n-1}, script, control]
 */
function buildRevealScript(expectedHashesHex, challengerXonly) {
  const pk = Buffer.from(challengerXonly, 'hex');
  if (pk.length !== 32) throw new Error('challengerXonly must be 32 bytes');
  const parts = [];
  for (let k = expectedHashesHex.length - 1; k >= 0; k--) {
    const h = Buffer.from(expectedHashesHex[k], 'hex');
    if (h.length !== 32) throw new Error('each hash must be 32 bytes');
    parts.push(Buffer.from([OP_SHA256, OP_PUSH32]), h, Buffer.from([OP_EQUALVERIFY]));
  }
  parts.push(Buffer.from([OP_PUSH32]), pk, Buffer.from([OP_CHECKSIG]));
  return Buffer.concat(parts).toString('hex');
}

// All invalid truth-table rows for a gate: { inputs:[...], output } with output != f(inputs).
function gateInvalidRows(gateType) {
  const gate = GATES[gateType];
  if (!gate) throw new Error(`unknown gate: ${gateType}`);
  const rows = [];
  const combos = gate.arity === 1 ? [[0], [1]] : [[0, 0], [0, 1], [1, 0], [1, 1]];
  for (const inputs of combos) {
    const correct = gate.f(...inputs);
    rows.push({ inputs, output: 1 - correct }); // the wrong output
  }
  return rows;
}

// Disprove leaves for a gate instance over given wires.
// wires: { inputs: [wireA, wireB?], output: wireOut }
function buildGateDisproveLeaves(gateType, wires, challengerXonly) {
  const gate = GATES[gateType];
  if (!gate) throw new Error(`unknown gate: ${gateType}`);
  if (wires.inputs.length !== gate.arity) throw new Error(`${gateType} needs ${gate.arity} input wires`);
  return gateInvalidRows(gateType).map((row) => {
    const hashes = row.inputs.map((bit, i) => wireHash(wires.inputs[i], bit));
    hashes.push(wireHash(wires.output, row.output));
    return { row, script: buildRevealScript(hashes, challengerXonly) };
  });
}

// Given the prover's asserted wire values, return the fraudulent disprove leaf
// (and the witness preimages that satisfy it) if the gate is violated, else null.
function findGateFraud(gateType, wires, asserted, challengerXonly) {
  const gate = GATES[gateType];
  const correct = gate.f(...asserted.inputs);
  if (asserted.output === correct) return null; // honest gate
  const hashes = asserted.inputs.map((bit, i) => wireHash(wires.inputs[i], bit));
  hashes.push(wireHash(wires.output, asserted.output));
  const preimages = asserted.inputs.map((bit, i) => wirePreimage(wires.inputs[i], bit));
  preimages.push(wirePreimage(wires.output, asserted.output));
  return {
    row: { inputs: asserted.inputs, output: asserted.output },
    script: buildRevealScript(hashes, challengerXonly),
    revealPreimages: preimages
  };
}

module.exports = {
  GATES,
  buildWire,
  wireHash,
  wirePreimage,
  buildRevealScript,
  gateInvalidRows,
  buildGateDisproveLeaves,
  findGateFraud,
  sha256
};
