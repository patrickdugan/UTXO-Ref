/**
 * TradeLayer BitVM dispute tx-graph (assert -> challenge -> disprove / timeout)
 *
 * The operator bonds funds into an "assert" taproot output whose tapscript tree
 * holds:
 *   - every gate-disprove leaf of the predicate circuit (a challenger takes the
 *     bond by disproving any inconsistent gate on the script path), and
 *   - a timeout leaf `<csvDelay> OP_CSV OP_DROP <operatorXonly> OP_CHECKSIG`
 *     (the operator reclaims the bond after the challenge window if nobody
 *     disproved).
 *
 * This turns the disprove *capability* (Blocks 4-5) into the full dispute game:
 * the bond is safe iff the operator's committed circuit execution is honest.
 */

const { tapLeafHash, LEAF_VERSION_TAPSCRIPT } = require('./tradelayer_taproot_script');
const { buildTaprootTree, controlBlockWithPath } = require('./tradelayer_taproot_tree');

const OP_CHECKSEQUENCEVERIFY = 0xb2;
const OP_DROP = 0x75;
const OP_CHECKSIG = 0xac;
const OP_PUSH32 = 0x20;

// Minimal script-number push for small positive n (OP_1..OP_16 then generic LE).
function pushScriptNum(n) {
  if (n < 0) throw new Error('csv delay must be >= 0');
  if (n === 0) return Buffer.from([0x00]);
  if (n <= 16) return Buffer.from([0x50 + n]); // OP_1..OP_16
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.push(v & 0xff); v >>= 8; }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00); // keep positive
  return Buffer.concat([Buffer.from([bytes.length]), Buffer.from(bytes)]);
}

// BIP68 relative-block nSequence for the given block delay.
function csvSequence(csvDelay) {
  if (csvDelay < 0 || csvDelay > 0xffff) throw new Error('csv delay out of block range');
  return csvDelay; // type bit (22)=0 -> blocks, disable bit (31)=0 -> enabled
}

function buildTimeoutLeafScript(operatorXonly, csvDelay) {
  const pk = Buffer.from(operatorXonly, 'hex');
  if (pk.length !== 32) throw new Error('operatorXonly must be 32 bytes');
  return Buffer.concat([
    pushScriptNum(csvDelay),
    Buffer.from([OP_CHECKSEQUENCEVERIFY, OP_DROP, OP_PUSH32]), pk,
    Buffer.from([OP_CHECKSIG])
  ]).toString('hex');
}

/**
 * Build the assert-output taproot tree from the circuit's disprove leaves plus
 * the operator timeout leaf.
 * disproveScripts: array of script hex (one per disprove leaf)
 * returns { root, leaves (with leafHash+path), timeoutLeaf, timeoutScript }
 */
function buildDisputeTree({ disproveScripts, operatorXonly, csvDelay }) {
  const timeoutScript = buildTimeoutLeafScript(operatorXonly, csvDelay);
  const leaves = [
    ...disproveScripts.map((scriptHex) => ({ scriptHex, kind: 'disprove' })),
    { scriptHex: timeoutScript, kind: 'timeout' }
  ];
  const built = buildTaprootTree(leaves);
  const timeoutLeaf = built.leaves.find((l) => l.kind === 'timeout');
  return { root: built.root, leaves: built.leaves, timeoutLeaf, timeoutScript };
}

module.exports = {
  pushScriptNum,
  csvSequence,
  buildTimeoutLeafScript,
  buildDisputeTree,
  controlBlockWithPath,
  tapLeafHash,
  LEAF_VERSION_TAPSCRIPT
};
