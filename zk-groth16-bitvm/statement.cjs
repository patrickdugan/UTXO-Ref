'use strict';

// Stage 0: canonical statement bytes only. No proof or settlement authority.
const { createHash } = require('node:crypto');
const KIND = 'utxoref_l2_settlement_groth16_v0';
const DOMAIN = 'UTXOREF_L2_SETTLEMENT_GROTH16_V0\0';
const NETWORKS = Object.freeze({ 'bitcoin-regtest': 0, 'bitcoin-testnet4': 1 });
const HASH_FIELDS = Object.freeze([
  'chainGenesisHash', 'contractId', 'commitmentHash', 'assertionTxid',
  'settlementTxid', 'programHash', 'verifyingKeyHash', 'policyHash'
]);
const FIELDS = Object.freeze([
  'kind', 'version', 'network', ...HASH_FIELDS, 'epochId', 'assertionVout'
]);

function validateStatementV0(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('statement must be a plain object');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError('statement must be a plain object');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== FIELDS.length || keys.some(k => !FIELDS.includes(k))) {
    throw new TypeError('statement requires exactly the version 0 fields');
  }
  const result = {};
  for (const key of FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  if (result.kind !== KIND || result.version !== 0 || Object.is(result.version, -0)) {
    throw new TypeError('unsupported statement kind or version');
  }
  if (typeof result.network !== 'string' || !Object.hasOwn(NETWORKS, result.network)) {
    throw new TypeError('only bitcoin-regtest and bitcoin-testnet4 are supported');
  }
  for (const key of HASH_FIELDS) {
    if (typeof result[key] !== 'string' || !/^[0-9a-f]{64}$/.test(result[key])) {
      throw new TypeError(`${key} must be 32 bytes of lowercase hex`);
    }
  }
  if (typeof result.epochId !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(result.epochId)
      || BigInt(result.epochId) > 0xffffffffffffffffn) {
    throw new TypeError('epochId must be a canonical decimal u64 string');
  }
  if (!Number.isInteger(result.assertionVout) || Object.is(result.assertionVout, -0)
      || result.assertionVout < 0 || result.assertionVout > 0xffffffff) {
    throw new TypeError('assertionVout must be a u32 number');
  }
  return Object.freeze(result);
}

function encodeStatementV0(value) {
  const s = validateStatementV0(value);
  const version = Buffer.alloc(2);
  version.writeUInt16LE(0);
  const epoch = Buffer.alloc(8);
  epoch.writeBigUInt64LE(BigInt(s.epochId));
  const vout = Buffer.alloc(4);
  vout.writeUInt32LE(s.assertionVout);
  return Buffer.concat([
    Buffer.from(DOMAIN, 'ascii'), version, Buffer.from([NETWORKS[s.network]]),
    ...HASH_FIELDS.map(key => Buffer.from(s[key], 'hex')), epoch, vout
  ]);
}

function statementDigestV0(value) {
  return createHash('sha256').update(encodeStatementV0(value)).digest('hex');
}

function publicInputsV0(value) {
  const digest = statementDigestV0(value);
  // Two unsigned 128-bit big-endian limbs preserve all 256 digest bits.
  // Their order and range must also be enforced by the future circuit.
  return Object.freeze([
    BigInt(`0x${digest.slice(0, 32)}`).toString(),
    BigInt(`0x${digest.slice(32)}`).toString()
  ]);
}

function inspectStatementV0(value) {
  const statement = validateStatementV0(value);
  return Object.freeze({
    status: 'UNVERIFIED_STATEMENT_ONLY',
    proofVerified: false,
    settlementAuthorized: false,
    statement,
    digest: statementDigestV0(statement),
    publicInputs: publicInputsV0(statement)
  });
}

module.exports = Object.freeze({
  validateStatementV0, encodeStatementV0, statementDigestV0,
  publicInputsV0, inspectStatementV0
});
