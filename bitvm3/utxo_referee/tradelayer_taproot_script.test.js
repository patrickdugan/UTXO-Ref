/**
 * Run: node bitvm3/utxo_referee/tradelayer_taproot_script.test.js
 *
 * Validates tapleaf hash, merkle root, taproot script-tree tweak, output key,
 * scriptPubKey, and control block against the published BIP341 wallet test
 * vectors (the scriptPubKey section, which exercises script trees).
 */

const fs = require('fs');
const path = require('path');
const {
  tapLeafHash, tapBranchHash, merkleRoot, taprootTweakWithRoot, taprootScriptPubKeyWithRoot, controlBlock
} = require('./tradelayer_taproot_script');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assertEq(a, e, m) { if (a !== e) throw new Error(m || `expected ${e}, got ${a}`); }

const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'bip341-wallet-test-vectors.json'), 'utf8'));

// collect leaves in tree order (depth-first) to line up with vector leafHashes
function collectLeaves(node, out) {
  if (Array.isArray(node)) { collectLeaves(node[0], out); collectLeaves(node[1], out); }
  else out.push(node);
  return out;
}

console.log('\n=== TradeLayer Taproot Script-Path Vector Tests ===\n');

test('single-leaf tree: leaf hash, output key, scriptPubKey, control block', () => {
  const s = v.scriptPubKey.find((x) => x.given.scriptTree && !Array.isArray(x.given.scriptTree));
  const internalXonly = Buffer.from(s.given.internalPubkey, 'hex');
  const leaf = s.given.scriptTree;
  const lh = tapLeafHash(leaf.script, leaf.leafVersion);
  assertEq(lh.toString('hex'), s.intermediary.leafHashes[0], 'leaf hash');
  const root = merkleRoot([lh]);
  assertEq(root.toString('hex'), s.intermediary.merkleRoot, 'merkle root');
  const tw = taprootTweakWithRoot(internalXonly, root);
  assertEq(tw.xonly.toString('hex'), s.intermediary.tweakedPubkey, 'output key');
  assertEq(taprootScriptPubKeyWithRoot(internalXonly, root).toString('hex'), s.expected.scriptPubKey, 'scriptPubKey');
  const cb = controlBlock(internalXonly, tw.parity, leaf.leafVersion, []);
  assertEq(cb.toString('hex'), s.expected.scriptPathControlBlocks[0], 'control block');
});

// Compute the root following the explicit BIP341 tree nesting.
function rootFromTree(node) {
  if (Array.isArray(node)) return tapBranchHash(rootFromTree(node[0]), rootFromTree(node[1]));
  return tapLeafHash(node.script, node.leafVersion);
}

test('multi-leaf trees: leaf hashes and the structured merkle root match', () => {
  for (const s of v.scriptPubKey.filter((x) => x.given.scriptTree && Array.isArray(x.given.scriptTree))) {
    const leafSet = new Set(s.intermediary.leafHashes);
    for (const leaf of collectLeaves(s.given.scriptTree, [])) {
      const lh = tapLeafHash(leaf.script, leaf.leafVersion).toString('hex');
      if (!leafSet.has(lh)) throw new Error(`leaf hash ${lh} not in vector`);
    }
    const root = rootFromTree(s.given.scriptTree);
    assertEq(root.toString('hex'), s.intermediary.merkleRoot, 'merkle root');
    const tw = taprootTweakWithRoot(Buffer.from(s.given.internalPubkey, 'hex'), root);
    assertEq(tw.xonly.toString('hex'), s.intermediary.tweakedPubkey, 'output key');
  }
});

if (failed > 0) { console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`); process.exit(1); }
console.log(`\nPASS: ${passed} tests\n`);
