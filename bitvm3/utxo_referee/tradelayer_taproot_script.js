/**
 * TradeLayer Taproot script-path (BIP341/BIP342) helpers
 *
 * Enough taproot script-tree machinery to enforce a referee predicate as a real
 * Bitcoin Script (tapscript) leaf and spend it on-chain via the script path:
 *  - tapleaf hash, tapbranch / merkle root
 *  - taproot output key with a script tree, control block
 *  - BIP341 script-path sighash (ext_flag = 1)
 *
 * Leaf hash, merkle root, output key, scriptPubKey, and control block are
 * validated against the published BIP341 wallet test vectors
 * (tradelayer_taproot_script.test.js).
 */

const {
  N, G, mod, pointMul, pointAdd, liftX, taggedHash, bytes32, bufToBig
} = require('./tradelayer_dlc_adaptor_sig');
const { sha256, varint } = require('./tradelayer_taproot');

const LEAF_VERSION_TAPSCRIPT = 0xc0;

function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function u64le(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return b; }
function pushScript(buf) { return Buffer.concat([varint(buf.length), buf]); }
function hasEvenY(point) { return mod(point.y, 2n) === 0n; }

function tapLeafHash(scriptHex, leafVersion = LEAF_VERSION_TAPSCRIPT) {
  const script = Buffer.from(scriptHex, 'hex');
  return taggedHash('TapLeaf', Buffer.concat([Buffer.from([leafVersion]), varint(script.length), script]));
}

function tapBranchHash(h1, h2) {
  const [a, b] = Buffer.compare(h1, h2) <= 0 ? [h1, h2] : [h2, h1];
  return taggedHash('TapBranch', Buffer.concat([a, b]));
}

// Build the merkle root from ordered leaf hashes (balanced pairing, BIP341).
function merkleRoot(leafHashes) {
  if (leafHashes.length === 1) return leafHashes[0];
  let level = leafHashes;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? tapBranchHash(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

function taprootTweakWithRoot(internalXonly, root) {
  const t = mod(bufToBig(taggedHash('TapTweak', Buffer.concat([internalXonly, root]))), N);
  const Pint = liftX(bufToBig(internalXonly));
  const Q = pointAdd(Pint, pointMul(G, t));
  return { tweak: t, Q, xonly: bytes32(Q.x), parity: hasEvenY(Q) ? 0 : 1 };
}

function taprootScriptPubKeyWithRoot(internalXonly, root) {
  return Buffer.concat([Buffer.from([0x51, 0x20]), taprootTweakWithRoot(internalXonly, root).xonly]);
}

function controlBlock(internalXonly, outputParity, leafVersion = LEAF_VERSION_TAPSCRIPT, merklePath = []) {
  return Buffer.concat([Buffer.from([leafVersion | outputParity]), internalXonly, ...merklePath]);
}

// BIP341 script-path sighash (SIGHASH_DEFAULT, ext_flag = 1).
function scriptPathSighash(txParsed, utxosSpent, inputIndex, leafHash) {
  const shaPrevouts = sha256(Buffer.concat(txParsed.vin.map((i) => i.outpoint)));
  const shaAmounts = sha256(Buffer.concat(utxosSpent.map((u) => u64le(u.amountSats))));
  const shaScriptPubkeys = sha256(Buffer.concat(utxosSpent.map((u) => pushScript(Buffer.from(u.scriptPubKey, 'hex')))));
  const shaSequences = sha256(Buffer.concat(txParsed.vin.map((i) => u32le(i.sequence))));
  const shaOutputs = sha256(Buffer.concat(txParsed.vout.map((o) => Buffer.concat([u64le(o.value), pushScript(o.script)]))));

  const preimage = Buffer.concat([
    Buffer.from([0x00]),            // epoch
    Buffer.from([0x00]),            // hash_type SIGHASH_DEFAULT
    u32le(txParsed.version),
    u32le(txParsed.locktime),
    shaPrevouts, shaAmounts, shaScriptPubkeys, shaSequences, shaOutputs,
    Buffer.from([0x02]),            // spend_type: ext_flag=1, no annex
    u32le(inputIndex),
    leafHash,                       // tapleaf hash
    Buffer.from([0x00]),            // key_version
    Buffer.from([0xff, 0xff, 0xff, 0xff]) // codesep_pos (none)
  ]);
  return taggedHash('TapSighash', preimage);
}

module.exports = {
  LEAF_VERSION_TAPSCRIPT,
  tapLeafHash,
  tapBranchHash,
  merkleRoot,
  taprootTweakWithRoot,
  taprootScriptPubKeyWithRoot,
  controlBlock,
  scriptPathSighash
};
