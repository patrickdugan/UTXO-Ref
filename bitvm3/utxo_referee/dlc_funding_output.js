'use strict';

/**
 * Two-party DLC funding output.
 *
 * One Taproot output, no key path, two script leaves:
 *
 *   CET leaf     <A> OP_CHECKSIGVERIFY <B> OP_CHECKSIG
 *   refund leaf  <csv> OP_CHECKSEQUENCEVERIFY OP_DROP <A> OP_CHECKSIGVERIFY <B> OP_CHECKSIG
 *
 * A and B are the two parties' x-only keys in ascending order, so the script
 * and therefore the address are a function of the key set, not of who built
 * it. The internal key is a deterministic NUMS point: nobody can spend on the
 * key path, and a caller cannot substitute a key it controls.
 *
 * Every settlement therefore needs a signature from BOTH parties over the
 * BIP341 script-path sighash of the leaf it spends. A CET is completed from
 * the counterparty's adaptor signature plus the winner's own signature; the
 * refund additionally needs the committed relative delay to have passed.
 */

const crypto = require('crypto');
const ts = require('./tradelayer_taproot_script');
const { buildTaprootTree, controlBlockWithPath } = require('./tradelayer_taproot_tree');
const a = require('./tradelayer_dlc_adaptor_sig');

const KIND = 'utxoref_dlc_funding_output_v1';
const INTERNAL_KEY_POLICY = 'deterministic-nums-no-keypath-v1';
const NUMS_DOMAIN = 'UTXORef DLC funding NUMS internal key v1';
const MIN_REFUND_CSV_BLOCKS = 1;
const MAX_REFUND_CSV_BLOCKS = 0xffff;

const OP_CHECKSEQUENCEVERIFY = 0xb2;
const OP_DROP = 0x75;
const OP_PUSH32 = 0x20;
const OP_CHECKSIG = 0xac;
const OP_CHECKSIGVERIFY = 0xad;

let cachedInternalXonly = null;

function deriveDlcFundingInternalXonly() {
  if (cachedInternalXonly) return cachedInternalXonly;
  for (let counter = 0; counter < 1024; counter++) {
    const candidate = crypto.createHash('sha256').update(`${NUMS_DOMAIN}:${counter}`, 'utf8').digest();
    try {
      a.liftX(a.bufToBig(candidate));
      cachedInternalXonly = candidate.toString('hex');
      return cachedInternalXonly;
    } catch (_error) {
      // Roughly half of all x-coordinates are on the curve; try the next one.
    }
  }
  throw new Error('failed to derive the DLC funding NUMS internal key');
}

function requireXonly(value, fieldName) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${fieldName} must be lowercase 32-byte hex`);
  }
  try {
    a.liftX(a.bufToBig(Buffer.from(value, 'hex')));
  } catch (_error) {
    throw new Error(`${fieldName} is not a valid x-only secp256k1 public key`);
  }
  return value;
}

function normalizePartyPubkeyXs(values) {
  if (!Array.isArray(values) || values.length !== 2) {
    throw new Error('partyPubkeyXs must contain exactly two x-only public keys');
  }
  const keys = values.map((value, index) => requireXonly(value, `partyPubkeyXs[${index}]`));
  if (keys[0] === keys[1]) throw new Error('partyPubkeyXs must be two distinct keys');
  if (keys[0] > keys[1]) throw new Error('partyPubkeyXs must be sorted in ascending order');
  if (keys.includes(deriveDlcFundingInternalXonly())) {
    throw new Error('a party key must not equal the NUMS internal key');
  }
  return Object.freeze([keys[0], keys[1]]);
}

function sortPartyPubkeyXs(first, second) {
  return normalizePartyPubkeyXs([first, second].sort());
}

function normalizeRefundCsvBlocks(value) {
  if (!Number.isSafeInteger(value) || value < MIN_REFUND_CSV_BLOCKS || value > MAX_REFUND_CSV_BLOCKS) {
    throw new Error(`refundCsvBlocks must be an integer in ${MIN_REFUND_CSV_BLOCKS}..${MAX_REFUND_CSV_BLOCKS}`);
  }
  return value;
}

// Minimal script-number push for a positive block count.
function pushScriptNum(value) {
  if (value <= 16) return Buffer.from([0x50 + value]);
  const bytes = [];
  let remaining = value;
  while (remaining > 0) { bytes.push(remaining & 0xff); remaining >>= 8; }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00);
  return Buffer.concat([Buffer.from([bytes.length]), Buffer.from(bytes)]);
}

function twoOfTwo(partyPubkeyXs) {
  return Buffer.concat([
    Buffer.from([OP_PUSH32]), Buffer.from(partyPubkeyXs[0], 'hex'),
    Buffer.from([OP_CHECKSIGVERIFY, OP_PUSH32]), Buffer.from(partyPubkeyXs[1], 'hex'),
    Buffer.from([OP_CHECKSIG])
  ]);
}

function buildDlcCetLeafScript(partyPubkeyXs) {
  return twoOfTwo(normalizePartyPubkeyXs(partyPubkeyXs)).toString('hex');
}

function buildDlcRefundLeafScript(partyPubkeyXs, refundCsvBlocks) {
  const keys = normalizePartyPubkeyXs(partyPubkeyXs);
  return Buffer.concat([
    pushScriptNum(normalizeRefundCsvBlocks(refundCsvBlocks)),
    Buffer.from([OP_CHECKSEQUENCEVERIFY, OP_DROP]),
    twoOfTwo(keys)
  ]).toString('hex');
}

function buildDlcFundingOutput(input) {
  if (!input || typeof input !== 'object') throw new Error('DLC funding output arguments are required');
  const partyPubkeyXs = normalizePartyPubkeyXs(input.partyPubkeyXs);
  const refundCsvBlocks = normalizeRefundCsvBlocks(input.refundCsvBlocks);
  const internalXonly = deriveDlcFundingInternalXonly();
  if (input.internalXonly !== undefined && input.internalXonly !== internalXonly) {
    throw new Error('custom internal key is forbidden; the DLC funding output requires the deterministic NUMS key');
  }
  const tree = buildTaprootTree([
    { kind: 'cet', scriptHex: buildDlcCetLeafScript(partyPubkeyXs) },
    { kind: 'refund', scriptHex: buildDlcRefundLeafScript(partyPubkeyXs, refundCsvBlocks) }
  ]);
  const internal = Buffer.from(internalXonly, 'hex');
  const tweak = ts.taprootTweakWithRoot(internal, tree.root);
  const leaf = (kind) => {
    const found = tree.leaves.find((candidate) => candidate.kind === kind);
    return Object.freeze({
      kind,
      scriptHex: found.scriptHex,
      leafVersion: found.leafVersion,
      leafHash: found.leafHash.toString('hex'),
      controlBlock: controlBlockWithPath(internal, tweak.parity, found.leafVersion, found.path).toString('hex')
    });
  };
  return Object.freeze({
    kind: KIND,
    internalKeyPolicy: INTERNAL_KEY_POLICY,
    internalXonly,
    partyPubkeyXs,
    refundCsvBlocks,
    merkleRoot: tree.root.toString('hex'),
    outputKeyXonly: tweak.xonly.toString('hex'),
    scriptPubKeyHex: ts.taprootScriptPubKeyWithRoot(internal, tree.root).toString('hex'),
    cetLeaf: leaf('cet'),
    refundLeaf: leaf('refund')
  });
}

// The three fields a transaction-set `funding` object must carry in addition
// to its outpoint and value.
function dlcFundingFields(output) {
  return Object.freeze({
    scriptPubKeyHex: output.scriptPubKeyHex,
    partyPubkeyXs: output.partyPubkeyXs,
    refundCsvBlocks: output.refundCsvBlocks
  });
}

function settlementLeaf(output, executionType) {
  if (executionType === 'cet') return output.cetLeaf;
  if (executionType === 'refund') return output.refundLeaf;
  throw new Error('executionType must be cet or refund');
}

// BIP341 script-path sighash (SIGHASH_DEFAULT) for a settlement transaction
// spending the funding output through the given leaf.
function dlcSettlementSighash({ bip341Transaction, fundingValueSats, output, executionType }) {
  if (typeof fundingValueSats !== 'bigint') throw new Error('fundingValueSats must be a bigint');
  const leaf = settlementLeaf(output, executionType);
  return ts.scriptPathSighash(
    bip341Transaction,
    [{ amountSats: fundingValueSats, scriptPubKey: output.scriptPubKeyHex }],
    0,
    Buffer.from(leaf.leafHash, 'hex')
  );
}

// Witness stack for either leaf. The script checks A first, so A's signature
// must be on top of the stack when execution starts: [sigB, sigA, script, control].
function buildDlcSettlementWitness({ output, executionType, signatures }) {
  const leaf = settlementLeaf(output, executionType);
  const [first, second] = output.partyPubkeyXs;
  const pick = (key) => {
    const signature = signatures && signatures[key];
    if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) {
      throw new Error(`a 64-byte signature is required for party ${key}`);
    }
    return signature;
  };
  return Object.freeze([pick(second), pick(first), leaf.scriptHex, leaf.controlBlock]);
}

module.exports = {
  KIND,
  INTERNAL_KEY_POLICY,
  MIN_REFUND_CSV_BLOCKS,
  MAX_REFUND_CSV_BLOCKS,
  deriveDlcFundingInternalXonly,
  normalizePartyPubkeyXs,
  sortPartyPubkeyXs,
  normalizeRefundCsvBlocks,
  buildDlcCetLeafScript,
  buildDlcRefundLeafScript,
  buildDlcFundingOutput,
  dlcFundingFields,
  settlementLeaf,
  dlcSettlementSighash,
  buildDlcSettlementWitness
};
