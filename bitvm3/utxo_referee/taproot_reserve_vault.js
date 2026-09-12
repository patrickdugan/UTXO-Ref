/**
 * Deterministic Taproot reserve-vault template used by BitAgent.
 *
 * The normal leaf requires operator and guardian signatures. The recovery
 * leaf requires the recovery key after a relative CSV delay.
 */

const crypto = require('crypto');
const ts = require('./tradelayer_taproot_script');
const { buildTaprootTree, controlBlockWithPath } = require('./tradelayer_taproot_tree');
const a = require('./tradelayer_dlc_adaptor_sig');

const OP_CHECKSEQUENCEVERIFY = 0xb2;
const OP_DROP = 0x75;
const OP_CHECKSIGVERIFY = 0xad;
const OP_CHECKSIG = 0xac;
const OP_PUSH32 = 0x20;

const DEFAULT_NETWORK = 'bitcoin-testnet4';
const DEFAULT_RECOVERY_CSV_DELAY = 2016;

function normalizeNetwork(network) {
  const n = String(network || DEFAULT_NETWORK).toLowerCase();
  if (n === 'testnet4' || n === 'bitcoin-testnet4' || n === 'btc-testnet4') return 'bitcoin-testnet4';
  if (n === 'test' || n === 'testnet' || n === 'bitcoin-testnet') return 'bitcoin-testnet';
  if (n === 'regtest' || n === 'bitcoin-regtest') return 'bitcoin-regtest';
  if (n === 'main' || n === 'mainnet' || n === 'bitcoin') return 'bitcoin';
  return n;
}

function assertHex(value, bytes, fieldName) {
  const text = String(value || '').toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(text)) {
    throw new Error(`${fieldName} must be ${bytes} bytes of hex`);
  }
  return text;
}

function assertXonly(value, fieldName) {
  const text = assertHex(value, 32, fieldName);
  try {
    a.liftX(a.bufToBig(Buffer.from(text, 'hex')));
  } catch (err) {
    throw new Error(`${fieldName} is not a valid x-only secp256k1 pubkey: ${err.message}`);
  }
  return text;
}

function pushScriptNum(n) {
  const value = Number(n);
  if (!Number.isInteger(value) || value < 0) throw new Error('script number must be a non-negative integer');
  if (value === 0) return Buffer.from([0x00]);
  if (value <= 16) return Buffer.from([0x50 + value]);
  const bytes = [];
  let v = value;
  while (v > 0) {
    bytes.push(v & 0xff);
    v >>= 8;
  }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00);
  return Buffer.concat([Buffer.from([bytes.length]), Buffer.from(bytes)]);
}

function csvSequence(csvDelay) {
  const n = Number(csvDelay);
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
    throw new Error('csv delay must be an integer block delay in 0..65535');
  }
  return n;
}

function deriveReserveVaultInternalXonly(network = DEFAULT_NETWORK) {
  const normalized = normalizeNetwork(network);
  for (let counter = 0; counter < 1024; counter++) {
    const candidate = crypto.createHash('sha256')
      .update(`UTXORef reserve vault NUMS internal key v1:${normalized}:${counter}`, 'utf8')
      .digest();
    try {
      a.liftX(a.bufToBig(candidate));
      return candidate.toString('hex');
    } catch (_err) {
      // Roughly half of all x coordinates are valid; continue deterministically.
    }
  }
  throw new Error('failed to derive reserve vault internal key');
}

function bindingPrefix(bindingHash) {
  if (bindingHash === undefined || bindingHash === null || bindingHash === '') return Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from([OP_PUSH32]),
    Buffer.from(assertHex(bindingHash, 32, 'bindingHash'), 'hex'),
    Buffer.from([OP_DROP])
  ]);
}

function buildImmediateLeafScript(operatorXonly, guardianXonly, bindingHash = null) {
  const operator = Buffer.from(assertXonly(operatorXonly, 'operatorXonly'), 'hex');
  const guardian = Buffer.from(assertXonly(guardianXonly, 'guardianXonly'), 'hex');
  return Buffer.concat([
    bindingPrefix(bindingHash),
    Buffer.from([OP_PUSH32]), operator,
    Buffer.from([OP_CHECKSIGVERIFY, OP_PUSH32]), guardian,
    Buffer.from([OP_CHECKSIG])
  ]).toString('hex');
}

function buildRecoveryLeafScript(recoveryXonly, recoveryCsvDelay = DEFAULT_RECOVERY_CSV_DELAY, bindingHash = null) {
  const recovery = Buffer.from(assertXonly(recoveryXonly, 'recoveryXonly'), 'hex');
  return Buffer.concat([
    bindingPrefix(bindingHash),
    pushScriptNum(csvSequence(recoveryCsvDelay)),
    Buffer.from([OP_CHECKSEQUENCEVERIFY, OP_DROP, OP_PUSH32]), recovery,
    Buffer.from([OP_CHECKSIG])
  ]).toString('hex');
}

function buildTaprootReserveVaultTemplate(input = {}) {
  const network = normalizeNetwork(input.network || DEFAULT_NETWORK);
  const operatorXonly = assertXonly(input.operatorXonly, 'operatorXonly');
  const guardianXonly = assertXonly(input.guardianXonly, 'guardianXonly');
  const recoveryXonly = assertXonly(input.recoveryXonly || operatorXonly, 'recoveryXonly');
  const bindingHash = input.bindingHash ? assertHex(input.bindingHash, 32, 'bindingHash') : null;
  const recoveryCsvDelay = csvSequence(input.recoveryCsvDelay ?? DEFAULT_RECOVERY_CSV_DELAY);
  const internalXonly = input.internalXonly
    ? assertXonly(input.internalXonly, 'internalXonly')
    : deriveReserveVaultInternalXonly(network);

  const immediateScript = buildImmediateLeafScript(operatorXonly, guardianXonly, bindingHash);
  const recoveryScript = buildRecoveryLeafScript(recoveryXonly, recoveryCsvDelay, bindingHash);
  const tree = buildTaprootTree([
    { kind: 'immediate-operator-guardian', scriptHex: immediateScript },
    { kind: 'recovery-operator-csv', scriptHex: recoveryScript }
  ]);
  const tweak = ts.taprootTweakWithRoot(Buffer.from(internalXonly, 'hex'), tree.root);
  const p2trScriptPubKey = ts.taprootScriptPubKeyWithRoot(Buffer.from(internalXonly, 'hex'), tree.root).toString('hex');

  const leaves = {};
  for (const leaf of tree.leaves) {
    leaves[leaf.kind] = {
      kind: leaf.kind,
      leafVersion: leaf.leafVersion,
      scriptHex: leaf.scriptHex,
      leafHash: leaf.leafHash.toString('hex'),
      controlBlock: controlBlockWithPath(
        Buffer.from(internalXonly, 'hex'), tweak.parity, leaf.leafVersion, leaf.path
      ).toString('hex')
    };
  }

  return {
    network,
    bindingHash,
    recoveryXonly,
    internalXonly,
    merkleRoot: tree.root.toString('hex'),
    p2trScriptPubKey,
    leaves,
    immediateLeaf: leaves['immediate-operator-guardian'],
    recoveryLeaf: leaves['recovery-operator-csv']
  };
}

module.exports = {
  DEFAULT_NETWORK,
  DEFAULT_RECOVERY_CSV_DELAY,
  normalizeNetwork,
  csvSequence,
  deriveReserveVaultInternalXonly,
  buildImmediateLeafScript,
  buildRecoveryLeafScript,
  buildTaprootReserveVaultTemplate
};
