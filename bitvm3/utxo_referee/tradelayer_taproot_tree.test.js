/**
 * Run: node bitvm3/utxo_referee/tradelayer_taproot_tree.test.js
 *
 * Validates multi-leaf taproot tree root + per-leaf control blocks against the
 * BIP341 wallet test vectors.
 */

const fs = require('fs');
const path = require('path');
const { buildNode, controlBlockWithPath } = require('./tradelayer_taproot_tree');
const { tapLeafHash, taprootTweakWithRoot } = require('./tradelayer_taproot_script');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assertEq(a, e, m) { if (a !== e) throw new Error(m || `expected ${e}, got ${a}`); }

const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'bip341-wallet-test-vectors.json'), 'utf8'));

// Convert a vector scriptTree node into our node form (leaf carries hash + version).
function fromScriptTree(node) {
  if (Array.isArray(node)) return [fromScriptTree(node[0]), fromScriptTree(node[1])];
  return { leafHash: tapLeafHash(node.script, node.leafVersion), leafVersion: node.leafVersion };
}

console.log('\n=== TradeLayer Taproot Tree Vector Tests ===\n');

test('multi-leaf root + control blocks match BIP341 vectors', () => {
  const cases = v.scriptPubKey.filter((x) => x.given.scriptTree && Array.isArray(x.given.scriptTree));
  let checked = 0;
  for (const s of cases) {
    const built = buildNode(fromScriptTree(s.given.scriptTree));
    assertEq(built.root.toString('hex'), s.intermediary.merkleRoot, 'merkle root');
    const internalXonly = Buffer.from(s.given.internalPubkey, 'hex');
    const tw = taprootTweakWithRoot(internalXonly, built.root);
    // control blocks are listed in leaf id order; our traversal yields the same order
    built.leaves.forEach((leaf, i) => {
      const cb = controlBlockWithPath(internalXonly, tw.parity, leaf.leafVersion, leaf.path).toString('hex');
      assertEq(cb, s.expected.scriptPathControlBlocks[i], `control block ${i}`);
      checked++;
    });
  }
  if (checked === 0) throw new Error('no multi-leaf cases checked');
});

if (failed > 0) { console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`); process.exit(1); }
console.log(`\nPASS: ${passed} tests (${'control blocks validated'})\n`);
