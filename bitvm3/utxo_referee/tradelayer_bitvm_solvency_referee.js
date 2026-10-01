/**
 * TradeLayer BitVM solvency referee (Block 8: input binding)
 *
 * Connects the cap<=reserve BitVM circuit to the real on-chain reserve/cap from
 * tradelayer_reserve_reconciliation_referee, closing the last soundness gap: the
 * operator must feed the *real* reserve and cap as circuit inputs, not faked
 * ones.
 *
 *  - Wire commitments are derived deterministically from the reconciliation hash,
 *    so the bonded circuit is tied to one specific reconciliation.
 *  - reserve and cap are public (in the reconciliation), so the correct bit of
 *    every input wire is known. An "input-binding" disprove leaf punishes the
 *    operator for asserting any input bit incorrectly (reveal their preimage for
 *    the wrong bit + challenger signature).
 *
 * Combined with the gate-disprove leaves (Blocks 1-5) and the CSV timeout leaf
 * (Blocks 6-7), a bonded "solvent" assertion is now sound: the operator cannot
 * fake the inputs (input binding) nor the gate execution (gate disprove), so the
 * bond is safe iff reserve >= cap for the real committed values.
 */

const cmp = require('./tradelayer_bitvm_comparator');
const circuitMod = require('./tradelayer_bitvm_circuit');
const dispute = require('./tradelayer_bitvm_dispute');
const { buildBitCommitment } = require('./tradelayer_bitvm_gadgets');

function valueBits(value, nBits) {
  const bits = [];
  let x = BigInt(value);
  for (let i = 0; i < nBits; i++) { bits.push(Number(x & 1n)); x >>= 1n; }
  if (x > 0n) throw new Error(`value exceeds ${nBits} bits`);
  return bits;
}

// Wire commitments bound to a specific reconciliation (deterministic from its hash).
function commitBoundWires(circuit, seedHash) {
  const wireMap = {};
  for (const label of circuit.labels) wireMap[label] = { label, ...buildBitCommitment(`${seedHash}:${label}`) };
  return wireMap;
}

// One input-binding disprove leaf per input bit: spendable iff the operator
// asserted that bit as the WRONG (non-public) value.
function buildInputBindingLeaves(circuit, wireMap, reserve, cap, challengerXonly) {
  const rb = valueBits(reserve, circuit.nBits);
  const cb = valueBits(cap, circuit.nBits);
  const leaves = [];
  circuit.rLabels.forEach((label, i) => {
    const wrong = 1 - rb[i];
    leaves.push({ wire: label, trueBit: rb[i], script: circuitMod.buildRevealScript([circuitMod.wireHash(wireMap[label], wrong)], challengerXonly) });
  });
  circuit.cLabels.forEach((label, i) => {
    const wrong = 1 - cb[i];
    leaves.push({ wire: label, trueBit: cb[i], script: circuitMod.buildRevealScript([circuitMod.wireHash(wireMap[label], wrong)], challengerXonly) });
  });
  return leaves;
}

// If the operator asserted any input bit != the public value, return the binding
// disprove leaf + the operator's reveal preimage for that wrong bit.
function findInputFraud(circuit, wireMap, reserve, cap, asserted, challengerXonly) {
  const rb = valueBits(reserve, circuit.nBits);
  const cb = valueBits(cap, circuit.nBits);
  for (let i = 0; i < circuit.nBits; i++) {
    if (asserted.r[i] !== rb[i]) {
      const label = circuit.rLabels[i];
      return { wire: label, bit: asserted.r[i], script: circuitMod.buildRevealScript([circuitMod.wireHash(wireMap[label], asserted.r[i])], challengerXonly), revealPreimages: [circuitMod.wirePreimage(wireMap[label], asserted.r[i])] };
    }
    if (asserted.c[i] !== cb[i]) {
      const label = circuit.cLabels[i];
      return { wire: label, bit: asserted.c[i], script: circuitMod.buildRevealScript([circuitMod.wireHash(wireMap[label], asserted.c[i])], challengerXonly), revealPreimages: [circuitMod.wirePreimage(wireMap[label], asserted.c[i])] };
    }
  }
  return null;
}

// Full bonded assert tree: gate-disprove + input-binding + CSV timeout.
function buildSolvencyAssertTree({ circuit, wireMap, reserve, cap, challengerXonly, operatorXonly, csvDelay }) {
  const gateScripts = cmp.buildComparatorDisproveLeaves(circuit, wireMap, challengerXonly).map((l) => l.script);
  const inputScripts = buildInputBindingLeaves(circuit, wireMap, reserve, cap, challengerXonly).map((l) => l.script);
  const tree = dispute.buildDisputeTree({ disproveScripts: [...gateScripts, ...inputScripts], operatorXonly, csvDelay });
  return { ...tree, gateLeafCount: gateScripts.length, inputLeafCount: inputScripts.length };
}

module.exports = {
  valueBits,
  commitBoundWires,
  buildInputBindingLeaves,
  findInputFraud,
  buildSolvencyAssertTree
};
