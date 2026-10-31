'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const codec = require('./statement.cjs');
const vector = require('./fixtures/statement-v0.json');
const fresh = () => structuredClone(vector.statement);

function rejected(patch) {
  assert.throws(() => codec.encodeStatementV0({ ...fresh(), ...patch }));
}

test('independent golden bytes, digest and public inputs', () => {
  const s = fresh();
  assert.equal(codec.encodeStatementV0(s).toString('hex'), vector.encodedHex);
  assert.equal(codec.statementDigestV0(s), vector.digest);
  assert.deepEqual(codec.publicInputsV0(s), vector.publicInputs);
});

test('object key order does not affect canonical bytes', () => {
  const reversed = Object.fromEntries(Object.entries(fresh()).reverse());
  assert.equal(codec.statementDigestV0(reversed), vector.digest);
});

test('every hash binding changes the statement digest', () => {
  const s = fresh();
  for (const key of Object.keys(s).filter(k => /Hash$|Txid$|^contractId$/.test(k))) {
    const changed = { ...s, [key]: (s[key][0] === 'f' ? 'e' : 'f') + s[key].slice(1) };
    assert.notEqual(codec.statementDigestV0(changed), vector.digest, key);
  }
});

test('network, epoch and assertion index are bound', () => {
  for (const patch of [{ network: 'bitcoin-testnet4' }, { epochId: '8' }, { assertionVout: 2 }]) {
    assert.notEqual(codec.statementDigestV0({ ...fresh(), ...patch }), vector.digest);
  }
});

test('mainnet and unknown networks are rejected', () => {
  for (const network of ['bitcoin-mainnet', 'mainnet', '', 'toString', 0, null]) rejected({ network });
});

test('unknown versions and wrong kinds are rejected', () => {
  for (const version of [1, '0', false, null, -0]) rejected({ version });
  rejected({ kind: 'PaymentClaimV1' });
});

test('all hashes require exact lowercase hex strings', () => {
  const s = fresh();
  for (const key of Object.keys(s).filter(k => /Hash$|Txid$|^contractId$/.test(k))) {
    for (const bad of ['ab'.repeat(31), 'ab'.repeat(33), 'AB'.repeat(32), 'gg'.repeat(32), '', null, 0]) {
      rejected({ [key]: bad });
    }
  }
});

test('epoch strings cannot round, overflow or use alternate encodings', () => {
  for (const epochId of [7, 7n, true, '01', '+7', '-1', '7.0', '7e0', ' 7', '18446744073709551616', '9'.repeat(100)]) {
    rejected({ epochId });
  }
});

test('u64 boundaries and values above JavaScript safe integer round-trip exactly', () => {
  for (const epochId of ['0', '9007199254740993', '18446744073709551615']) {
    const bytes = codec.encodeStatementV0({ ...fresh(), epochId });
    assert.equal(bytes.readBigUInt64LE(bytes.length - 12).toString(), epochId);
  }
});

test('assertion index is a strict u32', () => {
  for (const assertionVout of [-1, -0, 0.5, '1', true, NaN, Infinity, 4294967296]) rejected({ assertionVout });
  for (const assertionVout of [0, 4294967295]) {
    const bytes = codec.encodeStatementV0({ ...fresh(), assertionVout });
    assert.equal(bytes.readUInt32LE(bytes.length - 4), assertionVout);
  }
});

test('missing or additional fields fail closed', () => {
  for (const key of Object.keys(fresh())) {
    const s = fresh();
    delete s[key];
    assert.throws(() => codec.encodeStatementV0(s), key);
  }
  rejected({ proofVerified: true });
  rejected({ settlementAuthorized: true });
  rejected({ typo: 'ignored?' });
});

test('invalid objects, symbols and accessors are rejected', () => {
  for (const value of [null, [], '', 0, new Date()]) {
    assert.throws(() => codec.encodeStatementV0(value));
  }
  const inherited = Object.create(fresh());
  assert.throws(() => codec.encodeStatementV0(inherited));
  const symbol = fresh();
  symbol[Symbol('hidden')] = true;
  assert.throws(() => codec.encodeStatementV0(symbol));
  const accessor = fresh();
  Object.defineProperty(accessor, 'epochId', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.throws(() => codec.encodeStatementV0(accessor), /data property/);
});

test('limbs preserve the full digest with explicit order', () => {
  const limbs = codec.publicInputsV0(fresh());
  for (const limb of limbs) assert.ok(BigInt(limb) >= 0n && BigInt(limb) < (1n << 128n));
  const reconstructed = limbs.map(x => BigInt(x).toString(16).padStart(32, '0')).join('');
  assert.equal(reconstructed, vector.digest);
});

test('returned buffers and source objects cannot mutate later encodings', () => {
  const source = fresh();
  const report = codec.inspectStatementV0(source);
  source.epochId = '100';
  const bytes = codec.encodeStatementV0(fresh());
  bytes.fill(0);
  assert.equal(report.statement.epochId, '7');
  assert.equal(codec.statementDigestV0(fresh()), vector.digest);
  assert.throws(() => { report.publicInputs[0] = '0'; }, TypeError);
});

test('successful inspection always remains unverified and unauthorized', () => {
  const report = codec.inspectStatementV0(fresh());
  assert.equal(report.status, 'UNVERIFIED_STATEMENT_ONLY');
  assert.equal(report.proofVerified, false);
  assert.equal(report.settlementAuthorized, false);
  assert.throws(() => { report.proofVerified = true; }, TypeError);
});
