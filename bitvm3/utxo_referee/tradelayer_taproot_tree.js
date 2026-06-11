/**
 * TradeLayer Taproot script tree (multi-leaf)
 *
 * Commits many tapscript leaves (e.g. every gate-disprove leaf of a BitVM
 * predicate circuit) into one taproot output, and produces the per-leaf merkle
 * path + control block needed to spend any single leaf on the script path.
 *
 * Validated against the multi-leaf BIP341 wallet test vectors
 * (tradelayer_taproot_tree.test.js): root and control blocks match.
 */

const { tapLeafHash, tapBranchHash, LEAF_VERSION_TAPSCRIPT } = require('./tradelayer_taproot_script');

// Arrange a flat leaf list into a balanced binary tree of nodes.
function listToNode(leaves) {
  if (leaves.length === 1) return leaves[0];
  const mid = Math.ceil(leaves.length / 2);
  return [listToNode(leaves.slice(0, mid)), listToNode(leaves.slice(mid))];
}

// Recursively compute the root and each leaf's merkle path (bottom-up siblings).
function buildNode(node) {
  if (!Array.isArray(node)) return { root: node.leafHash, leaves: [{ ...node, path: [] }] };
  const L = buildNode(node[0]);
  const R = buildNode(node[1]);
  const root = tapBranchHash(L.root, R.root);
  const leaves = [
    ...L.leaves.map((l) => ({ ...l, path: [...l.path, R.root] })),
    ...R.leaves.map((l) => ({ ...l, path: [...l.path, L.root] }))
  ];
  return { root, leaves };
}

// leaves: [{ scriptHex, leafVersion?, ...meta }] -> { root, leaves: [{...meta, leafHash, path}] }
function buildTaprootTree(leaves) {
  const withHashes = leaves.map((l) => ({
    ...l,
    leafVersion: l.leafVersion ?? LEAF_VERSION_TAPSCRIPT,
    leafHash: tapLeafHash(l.scriptHex, l.leafVersion ?? LEAF_VERSION_TAPSCRIPT)
  }));
  return buildNode(listToNode(withHashes));
}

function controlBlockWithPath(internalXonly, outputParity, leafVersion, path) {
  return Buffer.concat([Buffer.from([leafVersion | outputParity]), internalXonly, ...path]);
}

module.exports = {
  listToNode,
  buildNode,
  buildTaprootTree,
  controlBlockWithPath
};
