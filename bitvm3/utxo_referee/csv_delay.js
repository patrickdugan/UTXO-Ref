/**
 * The one encoder for a BIP68 relative block delay and the script number that
 * carries it. Every CSV leaf and nSequence in the tree imports these, so one delay
 * gives the same bytes in every leaf.
 *
 * A delay is a canonical integer (money.js toInt rules: a number, a bigint, or
 * digits with no sign, space, hex or exponent) in 1..65535. Zero is refused: a
 * zero-block CSV is satisfied at once, so it is never a timelock.
 */

const { toInt } = require('./money');

const MAX_CSV_BLOCKS = 0xffff;

// Minimal script-number push: OP_0, OP_1..OP_16, else little-endian with a sign byte.
function pushScriptNum(n) {
  if (n === 0) return Buffer.from([0x00]);
  if (n <= 16) return Buffer.from([0x50 + n]);
  const bytes = [];
  let v = n;
  while (v > 0) {
    bytes.push(v & 0xff);
    v >>= 8;
  }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00);
  return Buffer.concat([Buffer.from([bytes.length]), Buffer.from(bytes)]);
}

// BIP68 nSequence for a block delay: type bit 0 (blocks), disable bit 0 (enabled).
function csvSequence(csvDelay, field = 'csv delay') {
  const n = toInt(csvDelay, field, { signed: true, noun: 'integer block delay in 1..65535' });
  if (n < 1n || n > BigInt(MAX_CSV_BLOCKS)) throw new Error(`${field} must be an integer block delay in 1..65535`);
  return Number(n);
}

module.exports = {
  pushScriptNum,
  csvSequence
};
