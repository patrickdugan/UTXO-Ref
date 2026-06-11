/**
 * TradeLayer BitVM comparator circuit (cap <= reserve)
 *
 * Composes the gate primitives (tradelayer_bitvm_circuit) into the real referee
 * predicate: the solvency invariant cap <= reserve over N-bit unsigned integers.
 *
 * Built as a full-subtractor borrow chain for reserve - cap:
 *   x_i      = r_i XOR c_i
 *   borrow_1 = NOT r_0 AND c_0                      (borrow_0 = 0, simplified)
 *   borrow_i+1 = (NOT r_i AND c_i) OR (NOT x_i AND borrow_i)
 *   solvent  = NOT borrow_N      (no final borrow => reserve >= cap => cap <= reserve)
 *
 * Every gate carries on-chain disprove leaves (one per invalid truth-table row),
 * so a prover who commits an inconsistent execution trace can be punished at the
 * first bad gate. The honest trace has no satisfiable disprove leaf.
 */

const { GATES, buildWire, wireHash, wirePreimage, buildRevealScript } = require('./tradelayer_bitvm_circuit');

// Build the comparator gate netlist for nBits. Wires are referenced by label.
function buildComparatorCircuit(nBits) {
  if (!Number.isInteger(nBits) || nBits < 1 || nBits > 64) throw new Error('nBits must be 1..64');
  const gates = [];
  const rLabels = []; const cLabels = [];
  for (let i = 0; i < nBits; i++) { rLabels.push(`r${i}`); cLabels.push(`c${i}`); }

  let borrowLabel = null;
  for (let i = 0; i < nBits; i++) {
    const r = `r${i}`; const c = `c${i}`;
    const nr = `nr${i}`; const x = `x${i}`; const nx = `nx${i}`; const t1 = `t1_${i}`;
    gates.push({ type: 'not', inputs: [r], output: nr });
    gates.push({ type: 'and', inputs: [nr, c], output: t1 });   // NOT r_i AND c_i
    if (i === 0) {
      borrowLabel = t1; // borrow_1 = NOT r_0 AND c_0 (borrow_0 = 0)
    } else {
      gates.push({ type: 'xor', inputs: [r, c], output: x });
      gates.push({ type: 'not', inputs: [x], output: nx });
      const t2 = `t2_${i}`; const b = `borrow${i + 1}`;
      gates.push({ type: 'and', inputs: [nx, borrowLabel], output: t2 }); // NOT x_i AND borrow_i
      gates.push({ type: 'or', inputs: [t1, t2], output: b });            // borrow_{i+1}
      borrowLabel = b;
    }
  }
  gates.push({ type: 'not', inputs: [borrowLabel], output: 'solvent' });

  const labels = new Set();
  for (const g of gates) { g.inputs.forEach((l) => labels.add(l)); labels.add(g.output); }
  return { nBits, gates, rLabels, cLabels, out: 'solvent', borrowOut: borrowLabel, labels: [...labels] };
}

// Compute the honest execution trace (label -> bit) for given reserve/cap.
function evaluateComparator(circuit, reserveSats, capSats) {
  const trace = {};
  const toBits = (v) => { const b = []; let x = BigInt(v); for (let i = 0; i < circuit.nBits; i++) { b.push(Number(x & 1n)); x >>= 1n; } if (x > 0n) throw new Error('value exceeds nBits'); return b; };
  const rb = toBits(reserveSats); const cb = toBits(capSats);
  circuit.rLabels.forEach((l, i) => { trace[l] = rb[i]; });
  circuit.cLabels.forEach((l, i) => { trace[l] = cb[i]; });
  for (const g of circuit.gates) {
    trace[g.output] = GATES[g.type].f(...g.inputs.map((l) => trace[l]));
  }
  return trace;
}

// Commit a wire for every label in the circuit.
function commitCircuitWires(circuit) {
  const wireMap = {};
  for (const label of circuit.labels) wireMap[label] = buildWire(label);
  return wireMap;
}

// All disprove leaves for the whole circuit (every gate, every invalid row).
function buildComparatorDisproveLeaves(circuit, wireMap, challengerXonly) {
  const leaves = [];
  for (const g of circuit.gates) {
    const gate = GATES[g.type];
    const combos = gate.arity === 1 ? [[0], [1]] : [[0, 0], [0, 1], [1, 0], [1, 1]];
    for (const inputs of combos) {
      const wrongOut = 1 - gate.f(...inputs);
      const hashes = inputs.map((bit, i) => wireHash(wireMap[g.inputs[i]], bit));
      hashes.push(wireHash(wireMap[g.output], wrongOut));
      leaves.push({ gate: g, row: { inputs, output: wrongOut }, script: buildRevealScript(hashes, challengerXonly) });
    }
  }
  return leaves;
}

// Find the first gate whose committed trace values violate the gate function,
// and return its disprove leaf + the prover's reveal preimages.
function findComparatorFraud(circuit, wireMap, trace, challengerXonly) {
  for (const g of circuit.gates) {
    const inBits = g.inputs.map((l) => trace[l]);
    const correct = GATES[g.type].f(...inBits);
    if (trace[g.output] !== correct) {
      const hashes = inBits.map((bit, i) => wireHash(wireMap[g.inputs[i]], bit));
      hashes.push(wireHash(wireMap[g.output], trace[g.output]));
      const preimages = inBits.map((bit, i) => wirePreimage(wireMap[g.inputs[i]], bit));
      preimages.push(wirePreimage(wireMap[g.output], trace[g.output]));
      return { gate: g, script: buildRevealScript(hashes, challengerXonly), revealPreimages: preimages };
    }
  }
  return null;
}

module.exports = {
  buildComparatorCircuit,
  evaluateComparator,
  commitCircuitWires,
  buildComparatorDisproveLeaves,
  findComparatorFraud
};
